//! On-demand schema discovery, plus an independent lightweight file-tree label index.
//! Records are deliberately absent from both the deserializer and the cache.
use crate::{DevcelError, Project, Result, TableData, TableMetadata, TableReference};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

#[derive(Clone)]
pub(crate) struct CatalogEntry {
    pub path: PathBuf,
    pub metadata: TableMetadata,
    data: TableData,
    pub interfaces: HashSet<uuid::Uuid>,
    pub reference_targets: HashSet<String>,
}

#[derive(Clone)]
pub(crate) struct CachedCatalogEntry {
    modified: SystemTime,
    length: u64,
    entry: CatalogEntry,
}

#[derive(Deserialize)]
struct CatalogDocument {
    uuid: String,
    display_name: String,
    description: String,
    metadata: TableMetadata,
    interface_implementations: HashMap<uuid::Uuid, crate::InterfaceImplementation>,
    schema: crate::TableSchema,
}

impl CatalogEntry {
    fn from_table(path: PathBuf, data: &TableData) -> Self {
        Self {
            path,
            metadata: data.metadata.clone(),
            data: TableData {
                uuid: data.uuid.clone(),
                display_name: data.display_name.clone(),
                description: data.description.clone(),
                metadata: data.metadata.clone(),
                interface_implementations: data.interface_implementations.clone(),
                schema: data.schema.clone(),
                records: Vec::new(),
            },
            interfaces: data
                .interface_implementations
                .values()
                .map(|i| i.interface_uuid)
                .collect(),
            reference_targets: data
                .schema
                .columns
                .iter()
                .filter_map(|c| {
                    c.reference_config
                        .as_ref()
                        .map(|r| r.target_table_uuid.clone())
                })
                .collect(),
        }
    }

    fn reference(&self) -> TableReference {
        TableReference {
            path: self.path.to_string_lossy().into_owned(),
            uuid: self.data.uuid.clone(),
            data_name: self.metadata.data_name.clone(),
            display_name: self.data.display_name.clone(),
        }
    }
}

/// A read-only, record-free capture. It cannot be saved as a Project/Table and
/// contains no project lock or borrowed state, so filesystem IO can run off-lock.
struct CatalogReader {
    project_path: PathBuf,
    loaded: HashMap<PathBuf, CatalogEntry>,
    cache: Arc<Mutex<HashMap<PathBuf, CachedCatalogEntry>>>,
}

impl CatalogReader {
    fn read(self) -> Result<Vec<CatalogEntry>> {
        let root = self
            .project_path
            .parent()
            .ok_or_else(|| DevcelError::Project("Invalid project path".into()))?
            .join("Tables");
        let mut paths = Vec::new();
        find_table_paths(&root, &mut paths, true)?;
        paths.sort();
        let mut entries = Vec::with_capacity(paths.len());
        let mut inventory = HashSet::new();
        let mut ids = HashSet::new();
        for path in paths {
            inventory.insert(path.clone());
            let entry = if let Some(entry) = self.loaded.get(&path) {
                entry.clone()
            } else {
                let metadata = std::fs::metadata(&path).map_err(|e| catalog_error(&path, e))?;
                let modified = metadata.modified().map_err(|e| catalog_error(&path, e))?;
                let cached = self
                    .cache
                    .lock()
                    .map_err(|_| catalog_error(&path, "Could not acquire the table index lock"))?
                    .get(&path)
                    .filter(|cached| cached.modified == modified && cached.length == metadata.len())
                    .cloned();
                if let Some(cached) = cached {
                    cached.entry
                } else {
                    // Never hold either the Project or cache lock while reading/parsing.
                    let source =
                        std::fs::read_to_string(&path).map_err(|e| catalog_error(&path, e))?;
                    let document: CatalogDocument =
                        toml::from_str(&source).map_err(|e| catalog_error(&path, e))?;
                    let after = std::fs::metadata(&path).map_err(|e| catalog_error(&path, e))?;
                    if after.len() != metadata.len() || after.modified().ok() != Some(modified) {
                        return Err(catalog_error(
                            &path,
                            "The file changed while loading. Try again",
                        ));
                    }
                    let data = TableData {
                        uuid: document.uuid,
                        display_name: document.display_name,
                        description: document.description,
                        metadata: document.metadata,
                        interface_implementations: document.interface_implementations,
                        schema: document.schema,
                        records: Vec::new(),
                    };
                    let entry = CatalogEntry::from_table(path.clone(), &data);
                    self.cache
                        .lock()
                        .map_err(|_| {
                            catalog_error(&path, "Could not acquire the table index lock")
                        })?
                        .insert(
                            path.clone(),
                            CachedCatalogEntry {
                                modified,
                                length: metadata.len(),
                                entry: entry.clone(),
                            },
                        );
                    entry
                }
            };
            if entry.data.uuid.is_empty() || !ids.insert(entry.data.uuid.clone()) {
                return Err(catalog_error(&path, "Empty or duplicate table UUID"));
            }
            entries.push(entry);
        }
        self.cache
            .lock()
            .map_err(|_| catalog_error(&root, "Could not acquire the table index lock"))?
            .retain(|path, _| inventory.contains(path));
        // Loaded state is authoritative at capture time, including unsaved values
        // and an in-memory table that has not appeared in the disk inventory yet.
        for (path, entry) in self.loaded {
            if !inventory.contains(&path) {
                if !ids.insert(entry.data.uuid.clone()) {
                    return Err(catalog_error(&path, "Duplicate table UUID"));
                }
                entries.push(entry);
            }
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }
}

pub(crate) fn find_table_paths(
    directory: &Path,
    paths: &mut Vec<PathBuf>,
    strict: bool,
) -> Result<()> {
    fn unsupported(path: &Path) -> DevcelError {
        crate::app_error::diagnostic(
            "error.tableSourceType",
            serde_json::json!({"path":path.to_string_lossy()}),
        )
    }
    fn visit(directory: &Path, paths: &mut Vec<PathBuf>, strict: bool) -> Result<()> {
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if strict => return Err(catalog_error(directory, error)),
            Err(_) => return Ok(()),
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) if strict => return Err(catalog_error(directory, error)),
                Err(_) => continue,
            };
            let path = entry.path();
            if crate::internal_artifacts::is_internal_save_artifact(&path) {
                continue;
            }
            // DirEntry uses the directory's type information where available;
            // unlike Path::is_dir this neither follows links nor stats every file.
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(error) if strict => return Err(catalog_error(&path, error)),
                Err(_) => continue,
            };
            if kind.is_dir() {
                visit(&path, paths, strict)?;
            } else if kind.is_file() {
                if path.to_string_lossy().ends_with(".table.toml") {
                    paths.push(path);
                }
            } else if strict
                && (kind.is_symlink() || path.to_string_lossy().ends_with(".table.toml"))
            {
                return Err(unsupported(&path));
            }
        }
        Ok(())
    }
    // Check the Tables root itself without following a link. Missing Tables is
    // valid for an empty project; other strict errors remain failures, while
    // best-effort display discovery leaves affected names as filenames.
    match std::fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_dir() => visit(directory, paths, strict),
        Ok(_) if strict => Err(unsupported(directory)),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) if strict => Err(catalog_error(directory, error)),
        Err(_) => Ok(()),
    }
}

impl Project {
    fn catalog_reader(&self) -> CatalogReader {
        CatalogReader {
            project_path: self.path.clone(),
            loaded: self
                .tables_data
                .iter()
                .map(|(path, table)| {
                    (
                        path.clone(),
                        CatalogEntry::from_table(path.clone(), &table.data),
                    )
                })
                .collect(),
            cache: self.table_catalog.clone(),
        }
    }

    /// Capture only record-free headers while the caller holds its Project lock.
    /// The returned read-only job owns everything it needs and performs all
    /// filesystem discovery/parsing after that lock has been released. Callers
    /// must fence the result against their captured project session before use.
    pub fn get_table_catalog_reader(
        &self,
    ) -> impl FnOnce() -> Result<Vec<TableReference>> + Send + 'static {
        let reader = self.catalog_reader();
        move || Ok(reader.read()?.iter().map(CatalogEntry::reference).collect())
    }

    /// Synchronous core callers already own their Project access. GUI discovery
    /// should use get_table_catalog_reader to keep disk IO outside its lock.
    pub(crate) fn table_catalog_entries(&self) -> Result<Vec<CatalogEntry>> {
        let entries = self.catalog_reader().read()?;
        for entry in &entries {
            crate::Interface::validate_table_column_ids(&entry.data, &self.interface_registry)?;
        }
        Ok(entries)
    }

    /// All table choices, distinct from the deliberately loaded-only table list.
    pub fn get_table_catalog(&self) -> Result<Vec<TableReference>> {
        Ok(self
            .table_catalog_entries()?
            .iter()
            .map(CatalogEntry::reference)
            .collect())
    }

    /// Schema/interface discovery for pure previews. No record payload is
    /// returned, including for tables already open in the editor.
    pub fn get_table_catalog_data(&self) -> Result<Vec<TableData>> {
        Ok(self
            .table_catalog_entries()?
            .into_iter()
            .map(|entry| entry.data)
            .collect())
    }

    /// Read one dependency without changing the editor's loaded-table inventory.
    /// Live unsaved values are authoritative when the table is already open.
    pub fn read_table_data_by_uuid(&self, uuid: &str) -> Result<TableData> {
        if let Some(table) = self.find_table_by_uuid(uuid) {
            crate::Interface::validate_table_column_ids(&table.data, &self.interface_registry)?;
            return Ok(table.data.clone());
        }
        let path = self
            .table_catalog_entries()?
            .into_iter()
            .find(|entry| entry.data.uuid == uuid)
            .map(|entry| entry.path)
            .ok_or_else(|| DevcelError::NotFound(format!("Table {uuid} not found")))?;
        let source = std::fs::read_to_string(&path).map_err(|error| catalog_error(&path, error))?;
        let data: TableData = TableData::from_toml(&source)?;
        crate::Interface::validate_table_column_ids(&data, &self.interface_registry)?;
        if data.uuid != uuid {
            return Err(catalog_error(&path, "Table UUID changed while loading"));
        }
        Ok(data)
    }

    /// Load only the requested UUID; discovery never inserts unrelated records.
    pub fn ensure_table_loaded_by_uuid(&mut self, uuid: &str) -> Result<()> {
        if self.find_table_by_uuid(uuid).is_some() {
            return Ok(());
        }
        let path = self
            .table_catalog_entries()?
            .into_iter()
            .find(|entry| entry.data.uuid == uuid)
            .map(|entry| entry.path)
            .ok_or_else(|| DevcelError::NotFound(format!("Table {uuid} not found")))?;
        self.ensure_table_loaded_with_save_queue(&path, None, None)?;
        if self.find_table_by_uuid(uuid).is_none() {
            return Err(catalog_error(&path, "Table UUID changed while loading"));
        }
        Ok(())
    }

    /// Load the incoming-reference set for integrity/deletion checks, rather
    /// than interpreting an unopened dependent table as an absent reference.
    pub fn ensure_referencing_tables_loaded(&mut self, target_uuid: &str) -> Result<()> {
        self.ensure_table_loaded_by_uuid(target_uuid)?;
        let paths: Vec<_> = self
            .table_catalog_entries()?
            .into_iter()
            .filter(|entry| entry.reference_targets.contains(target_uuid))
            .map(|entry| entry.path)
            .collect();
        for path in paths {
            self.ensure_table_loaded_with_save_queue(&path, None, None)?;
        }
        Ok(())
    }

    /// Read-only interface candidate discovery with the same detached metadata
    /// reader. Only UUID ancestry is captured; version history and records are not.
    pub fn get_tables_for_interface_reader(
        &self,
        interface_uuid: uuid::Uuid,
    ) -> impl FnOnce() -> Result<Vec<TableReference>> + Send + 'static {
        let reader = self.catalog_reader();
        let interfaces: HashMap<uuid::Uuid, Vec<uuid::Uuid>> = self
            .interface_registry
            .get_all_interfaces()
            .into_iter()
            .map(|interface| (interface.uuid, interface.extends.clone()))
            .collect();
        move || {
            if !interfaces.contains_key(&interface_uuid) {
                return Err(DevcelError::NotFound(format!(
                    "Interface {interface_uuid} not found"
                )));
            }
            let mut result = Vec::new();
            for entry in reader.read()? {
                let mut pending: Vec<_> = entry.interfaces.iter().copied().collect();
                let mut seen = HashSet::new();
                while let Some(uuid) = pending.pop() {
                    if !seen.insert(uuid) {
                        continue;
                    }
                    if uuid == interface_uuid {
                        result.push(entry.reference());
                        break;
                    }
                    if let Some(parents) = interfaces.get(&uuid) {
                        pending.extend(parents.iter().copied());
                    }
                }
            }
            Ok(result)
        }
    }

    /// Includes inherited interface contracts, without opening every table.
    pub fn get_tables_for_interface(
        &self,
        interface_uuid: &uuid::Uuid,
    ) -> Result<Vec<TableReference>> {
        self.get_tables_for_interface_reader(*interface_uuid)()
    }

    pub fn ensure_interface_tables_loaded(&mut self, interface_uuid: &uuid::Uuid) -> Result<()> {
        for table in self.get_tables_for_interface(interface_uuid)? {
            self.ensure_table_loaded_by_uuid(&table.uuid)?;
        }
        Ok(())
    }
}

fn catalog_error(path: &std::path::Path, error: impl std::fmt::Display) -> DevcelError {
    DevcelError::Diagnostics(vec![crate::types::Diagnostic::Code {
        code: "grid.errorWithCause".into(),
        params: serde_json::json!({ "summary": path.to_string_lossy(), "error": crate::AppError::technical(error) }),
    }])
}

#[derive(Clone)]
pub(crate) struct CachedDisplayEntry {
    modified: SystemTime,
    length: u64,
    reference: Option<TableReference>,
}

#[derive(Deserialize, serde::Serialize)]
struct DisplayDocument {
    uuid: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    metadata: DisplayMetadata,
}
#[derive(Default, Deserialize, serde::Serialize)]
struct DisplayMetadata {
    #[serde(default)]
    data_name: String,
}

/// The scanner retains root identity and metadata statements. Unrelated root values, section
/// bodies and comments are streamed without line-sized allocations. TOML owns
/// key decoding and final metadata validation; lexical state only finds complete
/// statement boundaries, including across input-buffer edges.
fn read_display_metadata(path: &Path) -> Result<DisplayDocument> {
    read_display_identity(std::fs::File::open(path)?)
}
fn read_display_identity(input: impl std::io::Read) -> Result<DisplayDocument> {
    use std::io::BufRead;
    #[derive(Clone, Copy)]
    enum Quote {
        None,
        Opening(u8, u8),
        Basic(u8, bool),
        Multi(u8, bool, u8),
    }
    struct Lex {
        quote: Quote,
        depth: usize,
        comment: bool,
    }
    impl Lex {
        // True only for an unquoted byte outside comments. Quote runs are
        // resolved on the next byte, so no lookahead or chunk-boundary copy is needed.
        fn outside(&mut self, byte: u8) -> bool {
            if self.comment {
                if byte == b'\n' {
                    self.comment = false;
                } else {
                    return false;
                }
            }
            loop {
                match self.quote {
                    Quote::Opening(delimiter, run) => {
                        if byte == delimiter {
                            self.quote = if run == 2 {
                                Quote::Multi(delimiter, false, 0)
                            } else {
                                Quote::Opening(delimiter, run + 1)
                            };
                            return false;
                        }
                        self.quote = if run == 2 {
                            Quote::None
                        } else {
                            Quote::Basic(delimiter, false)
                        };
                    }
                    Quote::Basic(delimiter, escaped) => {
                        self.quote = if escaped {
                            Quote::Basic(delimiter, false)
                        } else if delimiter == b'"' && byte == b'\\' {
                            Quote::Basic(delimiter, true)
                        } else if byte == delimiter {
                            Quote::None
                        } else {
                            self.quote
                        };
                        return false;
                    }
                    Quote::Multi(delimiter, escaped, run) => {
                        if escaped {
                            self.quote = Quote::Multi(delimiter, false, 0);
                            return false;
                        }
                        if byte == delimiter {
                            self.quote = Quote::Multi(delimiter, false, run.saturating_add(1));
                            return false;
                        }
                        if run >= 3 {
                            self.quote = Quote::None;
                            continue;
                        }
                        self.quote = Quote::Multi(delimiter, delimiter == b'"' && byte == b'\\', 0);
                        return false;
                    }
                    Quote::None => {
                        match byte {
                            b'#' => {
                                self.comment = true;
                                return false;
                            }
                            b'"' | b'\'' => {
                                self.quote = Quote::Opening(byte, 1);
                                return false;
                            }
                            b'[' | b'{' => self.depth += 1,
                            b']' | b'}' => self.depth = self.depth.saturating_sub(1),
                            _ => {}
                        }
                        return true;
                    }
                }
            }
        }
    }
    #[derive(Clone, Copy, PartialEq)]
    enum Statement {
        Start,
        Header,
        RootKey,
        Value,
    }
    fn metadata_header(statement: &str) -> bool {
        let trimmed = statement.trim();
        if matches!(trimmed, "[metadata]" | "[metadata.edit_permissions]") {
            return true;
        }
        if [
            "[schema]",
            "[[schema.columns]]",
            "[interface_implementations]",
            "[[records]]",
            "[records.values]",
            "[records.interface_values]",
            "[records.memo_texts]",
        ]
        .iter()
        .any(|prefix| {
            trimmed
                .strip_prefix(*prefix)
                .is_some_and(|tail| tail.trim().is_empty())
        }) {
            return false;
        }
        toml::from_str::<toml::Value>(trimmed)
            .ok()
            .is_some_and(|value| value.get("metadata").is_some())
    }
    fn utf8(bytes: &[u8]) -> std::io::Result<&str> {
        std::str::from_utf8(bytes)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }
    let mut input = std::io::BufReader::with_capacity(4096, input);
    if input.fill_buf()?.starts_with(&[0xef, 0xbb, 0xbf]) {
        input.consume(3);
    }
    let mut lex = Lex {
        quote: Quote::None,
        depth: 0,
        comment: false,
    };
    let mut statement = Statement::Start;
    let mut pending = Vec::<u8>::new();
    let mut header = String::new();
    let mut seen_section = false;
    let mut in_metadata = false;
    let mut retain = false;
    loop {
        let chunk = input.fill_buf()?;
        let eof = chunk.is_empty();
        let size = chunk.len();
        // A synthetic trailing newline also closes a valid EOF statement.
        let mut bytes = chunk.iter().copied().chain(eof.then_some(b'\n'));
        while let Some(mut byte) = bytes.next() {
            // Most ignored payload bytes are plain string content or comments.
            // Skip to the next lexical event without running the full state
            // machine per byte, retaining neither the bytes nor a whole line.
            let interesting = if lex.comment {
                Some((b'\n', None))
            } else if statement == Statement::Value && !retain {
                match lex.quote {
                    Quote::Basic(delimiter, false) | Quote::Multi(delimiter, false, 0) => {
                        Some((delimiter, (delimiter == b'"').then_some(b'\\')))
                    }
                    _ => None,
                }
            } else {
                None
            };
            if let Some((delimiter, escape)) = interesting {
                if byte != delimiter && Some(byte) != escape {
                    let Some(next) = bytes.find(|next| *next == delimiter || Some(*next) == escape)
                    else {
                        break;
                    };
                    byte = next;
                }
            }
            let was_comment = lex.comment;
            let outside = lex.outside(byte);
            if statement == Statement::Start {
                if was_comment || byte.is_ascii_whitespace() || byte == b'#' {
                    continue;
                }
                statement = if byte == b'[' {
                    Statement::Header
                } else if !seen_section {
                    Statement::RootKey
                } else {
                    Statement::Value
                };
                retain = statement != Statement::Value || in_metadata;
            }
            // Comments have no semantic content and may be arbitrarily long.
            if retain
                && !was_comment
                && !(outside && byte == b'\n')
                && !(lex.comment && byte == b'#')
            {
                pending.push(byte);
            }
            if statement == Statement::RootKey && outside && byte == b'=' {
                // Decode quoted/dotted/escaped keys using TOML itself, but do
                // not parse or retain any unrelated assignment value.
                let key = utf8(&pending)?.trim_end_matches('=').trim();
                retain = if matches!(
                    key,
                    "description"
                        | "interface_order"
                        | "interface_implementations"
                        | "schema"
                        | "records"
                ) {
                    false
                } else {
                    let mut probe = utf8(&pending)?.to_owned();
                    probe.push('0');
                    toml::from_str::<toml::Value>(&probe)
                        .ok()
                        .is_some_and(|value| {
                            value.get("metadata").is_some()
                                || value.get("uuid").is_some()
                                || value.get("display_name").is_some()
                        })
                };
                if !retain {
                    pending.clear();
                }
                statement = Statement::Value;
            }
            if outside && byte == b'\n' && lex.depth == 0 {
                if statement == Statement::Header {
                    let text = utf8(&pending)?;
                    let next_is_metadata = metadata_header(text);
                    if !next_is_metadata && (!seen_section || in_metadata) {
                        if let Ok(document) = toml::from_str::<DisplayDocument>(&header) {
                            return Ok(document);
                        }
                    }
                    seen_section = true;
                    in_metadata = next_is_metadata;
                    retain = next_is_metadata;
                }
                if retain {
                    header.push_str(utf8(&pending)?);
                    header.push('\n');
                    if !seen_section {
                        if let Ok(document) = toml::from_str::<DisplayDocument>(&header) {
                            if !document.uuid.is_empty() && !document.display_name.is_empty() {
                                return Ok(document);
                            }
                        }
                    }
                }
                pending.clear();
                statement = Statement::Start;
            }
        }
        if eof {
            break;
        }
        input.consume(size);
    }
    toml::from_str::<DisplayDocument>(&header).map_err(DevcelError::Toml)
}

impl Project {
    /// Best-effort labels for the file tree, separate from strict schema/reference
    /// discovery. A malformed file remains visible with its filename; it cannot
    /// erase labels for unrelated files or populate the loaded-table inventory.
    pub fn get_table_display_catalog_reader(
        &self,
    ) -> impl FnOnce() -> Result<Vec<TableReference>> + Send + 'static {
        let root = self.path.parent().map(|path| path.join("Tables"));
        let loaded: HashMap<_, _> = self
            .tables_data
            .iter()
            .map(|(path, table)| {
                (
                    path.clone(),
                    TableReference {
                        path: path.to_string_lossy().into_owned(),
                        uuid: table.data.uuid.clone(),
                        data_name: table.data.metadata.data_name.clone(),
                        display_name: table.data.display_name.clone(),
                    },
                )
            })
            .collect();
        let cache = self.table_display_catalog.clone();
        move || {
            let root = root.ok_or_else(|| DevcelError::Project("Invalid project path".into()))?;
            let mut paths = Vec::new();
            find_table_paths(&root, &mut paths, false)?;
            paths.extend(loaded.keys().cloned());
            paths.sort();
            paths.dedup();
            let inventory: HashSet<_> = paths.iter().cloned().collect();
            let mut result = Vec::new();
            for path in paths {
                if let Some(reference) = loaded.get(&path) {
                    result.push(reference.clone());
                    continue;
                }
                let Ok(metadata) = std::fs::metadata(&path) else {
                    continue;
                };
                let Ok(modified) = metadata.modified() else {
                    continue;
                };
                let cached = cache
                    .lock()
                    .map_err(|_| catalog_error(&path, "Could not acquire the table index lock"))?
                    .get(&path)
                    .filter(|entry| entry.modified == modified && entry.length == metadata.len())
                    .cloned();
                let reference = if let Some(entry) = cached {
                    entry.reference
                } else {
                    let parsed = match read_display_metadata(&path) {
                        Ok(metadata) => Some(metadata),
                        // A lock/permission/temporary IO failure need not change
                        // mtime or length when repaired. Do not cache it forever.
                        Err(DevcelError::Io(_)) => continue,
                        Err(_) => None,
                    };
                    let reference =
                        parsed
                            .filter(|metadata| !metadata.uuid.is_empty())
                            .map(|metadata| TableReference {
                                path: path.to_string_lossy().into_owned(),
                                uuid: metadata.uuid,
                                data_name: metadata.metadata.data_name,
                                display_name: metadata.display_name,
                            });
                    let Ok(after) = std::fs::metadata(&path) else {
                        continue;
                    };
                    if after.len() != metadata.len() || after.modified().ok() != Some(modified) {
                        continue;
                    }
                    cache
                        .lock()
                        .map_err(|_| {
                            catalog_error(&path, "Could not acquire the table index lock")
                        })?
                        .insert(
                            path,
                            CachedDisplayEntry {
                                modified,
                                length: metadata.len(),
                                reference: reference.clone(),
                            },
                        );
                    reference
                };
                if let Some(reference) = reference {
                    result.push(reference);
                }
            }
            cache
                .lock()
                .map_err(|_| catalog_error(&root, "Could not acquire the table index lock"))?
                .retain(|path, _| inventory.contains(path));
            Ok(result)
        }
    }
}

#[cfg(test)]
mod display_metadata_stream_tests {
    use super::*;
    use std::io::{Cursor, Read};
    struct Counted<'a> {
        input: Cursor<Vec<u8>>,
        count: &'a std::cell::Cell<usize>,
    }
    impl Read for Counted<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let n = self.input.read(out)?;
            self.count.set(self.count.get() + n);
            Ok(n)
        }
    }
    #[test]
    fn identity_stops_before_large_description_and_records() {
        let data = crate::cell_rules::canonical_revision_tests::full_table();
        let mut data = data.clone();
        data.description = "x".repeat(8 * 1024 * 1024);
        let source = crate::table_storage::to_toml(&data).unwrap();
        assert!(source.starts_with("uuid = "));
        let name = source.find("\ndisplay_name = ").unwrap();
        let description = source.find("\ndescription = ").unwrap();
        assert!(name < description);
        let count = std::cell::Cell::new(0);
        let start = std::time::Instant::now();
        let result = read_display_identity(Counted {
            input: Cursor::new(source.into_bytes()),
            count: &count,
        })
        .unwrap();
        assert_eq!(result.uuid, data.uuid);
        assert_eq!(result.display_name, data.display_name);
        assert!(count.get() <= 4096, "read {} bytes", count.get());
        eprintln!(
            "IDENTITY_READ bytes={} elapsed={:?}",
            count.get(),
            start.elapsed()
        );
    }
    #[test]
    fn bom_comments_quoted_newlines_and_missing_name_fallback() {
        for pad in [0, 4090, 4095] {
            let source=format!("\u{feff}#{}\n\"uuid\" = 'id'\n'display_name' = \"line\\nname\"\ndescription = 'ignored'\n", "x".repeat(pad));
            let result = read_display_identity(Cursor::new(source)).unwrap();
            assert_eq!(result.uuid, "id");
            assert_eq!(result.display_name, "line\nname");
        }
        let source="uuid='id'\ndisplay_name=''\ndescription=\"\"\"long\n[metadata]\nnot a section\"\"\"\n[metadata]\ndata_name='internal'\n[[records]]\nuuid='row'\n";
        let result = read_display_identity(Cursor::new(source)).unwrap();
        assert_eq!(result.metadata.data_name, "internal");
        assert!(
            read_display_identity(Cursor::new("[metadata]\nuuid='old'\ndisplay_name='old'\n"))
                .is_err()
        );
    }
    #[test]
    fn empty_name_fallback_scans_description_but_not_records() {
        let description = "x".repeat(32 * 1024);
        let source = format!("uuid='id'\ndisplay_name=''\ndescription='{}'\n[metadata]\ndata_name='internal'\n[[records]]\nuuid='row'\n[records.values]\npayload='{}'\n", description, "x".repeat(1024 * 1024));
        let count = std::cell::Cell::new(0);
        let result = read_display_identity(Counted {
            input: Cursor::new(source.into_bytes()),
            count: &count,
        })
        .unwrap();
        assert_eq!(result.metadata.data_name, "internal");
        assert!(count.get() > 32768);
        assert!(
            count.get() <= 32768 + 4096,
            "unexpected record scan: {}",
            count.get()
        );
        eprintln!("EMPTY_NAME_FALLBACK bytes={}", count.get());
        let missing =
            read_display_identity(Cursor::new("uuid='id'\n[metadata]\ndata_name='internal'\n"))
                .unwrap();
        assert!(missing.display_name.is_empty());
        assert_eq!(missing.metadata.data_name, "internal");
    }
}
