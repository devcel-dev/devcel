use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use toml;
use uuid;

use crate::change_detection::{ChangeDetector, ChangeType, SimpleVersionDetector};
use crate::commands::{Command, CommandData};
use crate::file_save_queue::FileBasedSaveQueueManager;
use crate::interface::{Interface, InterfaceRegistry};
use crate::table::{Table, TableData, TableMetadata, TableSchema};
use crate::types::{ProjectEntry, ProjectEntryType, TableReference};
use crate::{DevcelError, Result};
use std::sync::{Arc, Mutex};

/// A localized category and an untouched authored path or identity are separate data.
fn contextual_error(code: &str, context: impl serde::Serialize) -> DevcelError {
    crate::app_error::diagnostic(
        "grid.errorWithCause",
        serde_json::json!({
            "summary": crate::AppError::code(code, serde_json::json!({})),
            "error": context,
        }),
    )
}

pub struct Project {
    pub path: PathBuf,
    pub project_data: ProjectFileData,
    pub(crate) project_disk_baseline: Option<ProjectFileData>,
    pub tables_data: HashMap<PathBuf, Table>,
    pub(crate) table_catalog:
        Arc<Mutex<HashMap<PathBuf, crate::table_catalog::CachedCatalogEntry>>>,
    pub(crate) table_display_catalog:
        Arc<Mutex<HashMap<PathBuf, crate::table_catalog::CachedDisplayEntry>>>,
    pub(crate) formula_metadata_cache:
        Arc<Mutex<HashMap<PathBuf, crate::formula_context::CachedFormulaMetadata>>>,
    pub change_detector: Option<Box<dyn ChangeDetector>>,
    pub interface_registry: InterfaceRegistry,
    instance_id: String,
    pub(crate) interface_history: HashMap<uuid::Uuid, (Vec<Command>, Vec<Command>)>,
    interface_change_listener: Option<crate::file_save_queue::SaveListener>,
    /// Last loaded, successfully saved, or trusted-replicated file state.
    /// Keep this separate from editable registry objects: direct in-memory
    /// Interface edits are legitimate, but must not advance the disk CAS baseline.
    interface_disk_baselines: Mutex<HashMap<uuid::Uuid, Interface>>,
}

/// Brand default for new projects only; persisted custom colors are never rewritten.
pub const DEFAULT_PROJECT_HEADER_COLOR: &str = "#242A30";

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct ProjectFileData {
    pub project_name: String,
    pub project_description: String,
    pub uuid: String,
    pub color: String,
    #[serde(default)]
    pub tag_presets: Vec<String>,
}

impl Default for ProjectFileData {
    fn default() -> Self {
        Self {
            project_name: String::new(),
            project_description: String::new(),
            uuid: uuid::Uuid::new_v4().to_string(),
            color: DEFAULT_PROJECT_HEADER_COLOR.to_string(),
            tag_presets: Vec::new(),
        }
    }
}

impl ProjectFileData {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Project {
    /// A pending failed tag transaction must be recovered before further edits.
    pub fn ensure_tag_transactions_ready(&self) -> Result<()> {
        crate::project_tags::ensure_ready(self)
    }
    /// Notify a desktop integration only after a successful interface write.
    /// The callback must not access this Project synchronously (it is still locked).
    pub fn set_interface_change_listener(
        &mut self,
        listener: Option<crate::file_save_queue::SaveListener>,
    ) {
        self.interface_change_listener = listener;
    }

    pub fn notify_interface_change(&self, path: &Path) {
        if let Some(listener) = &self.interface_change_listener {
            listener(path);
        }
    }

    /// Preserve the live registry if a file is invalid or temporarily unreadable.
    pub fn reload_interfaces(&mut self) -> Result<()> {
        let previous = self.interface_registry.clone();
        if let Err(error) = self.load_interfaces() {
            self.interface_registry = previous;
            return Err(error);
        }
        Ok(())
    }

    pub fn get_project_name(&self) -> String {
        self.project_data.project_name.clone()
    }

    pub fn get_project_description(&self) -> String {
        self.project_data.project_description.clone()
    }

    pub fn get_project_path(&self) -> String {
        self.path.to_str().unwrap_or("").to_string()
    }

    /// Identifies this open session, including reopening the same project path.
    pub fn get_instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn get_project_header_color(&self) -> String {
        self.project_data.color.clone()
    }

    pub fn create_project(
        name: &str,
        path: &str,
        description: &str,
        header_color: &str,
    ) -> Result<Self> {
        if name.is_empty() {
            return Err(DevcelError::Validation("project name is empty".to_string()));
        }
        if path.is_empty() {
            return Err(DevcelError::Diagnostics(vec![crate::AppError::code(
                "error.projectPathRequired",
                serde_json::json!({}),
            )
            .into_diagnostic()]));
        }

        let base_path = Path::new(path);
        let project_path = base_path.join(name);

        if !base_path.exists() {
            fs::create_dir_all(base_path).map_err(DevcelError::Io)?;
        }

        if !project_path.exists() {
            fs::create_dir_all(&project_path).map_err(DevcelError::Io)?;
        }

        // Check for an existing .devcelproj.toml file in the project directory
        if let Ok(entries) = fs::read_dir(&project_path) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.ends_with(".devcelproj.toml") {
                        return Err(DevcelError::Diagnostics(vec![crate::AppError::code(
                            "error.projectAlreadyExists",
                            serde_json::json!({ "path": project_path.to_string_lossy() }),
                        )
                        .into_diagnostic()]));
                    }
                }
            }
        }

        if !project_path.join("Tables").exists() {
            fs::create_dir_all(project_path.join("Tables")).map_err(DevcelError::Io)?;
        }

        let project_file = project_path.join(format!("{name}.devcelproj.toml"));

        fs::write(&project_file, "").map_err(DevcelError::Io)?;

        if !project_path.exists() {
            return Err(DevcelError::Diagnostics(vec![crate::AppError::code(
                "error.projectMissing",
                serde_json::json!({ "path": project_path.to_string_lossy() }),
            )
            .into_diagnostic()]));
        }

        let mut project = Self {
            path: project_file,
            project_data: ProjectFileData::new(),
            project_disk_baseline: None,
            tables_data: HashMap::new(),
            table_catalog: Arc::new(Mutex::new(HashMap::new())),
            table_display_catalog: Arc::new(Mutex::new(HashMap::new())),
            formula_metadata_cache: Arc::new(Mutex::new(HashMap::new())),
            change_detector: None,
            interface_registry: InterfaceRegistry::new(),
            instance_id: uuid::Uuid::new_v4().to_string(),
            interface_change_listener: None,
            interface_history: HashMap::new(),
            interface_disk_baselines: Mutex::new(HashMap::new()),
        };

        project.project_data.project_name = name.to_string();
        project.project_data.project_description = description.to_string();
        project.project_data.color = header_color.to_string();
        project.save_project()?;
        Ok(project)
    }

    pub fn open_project(path: &str) -> Result<Self> {
        if let Some(root) = Path::new(path).parent() {
            crate::tag_transaction_journal::recover(
                if root.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    root
                },
                Path::new(path),
            )?;
        }
        if !Path::new(path).exists() {
            return Err(DevcelError::Diagnostics(vec![crate::AppError::code(
                "error.projectMissing",
                serde_json::json!({ "path": path }),
            )
            .into_diagnostic()]));
        }

        let mut project = Self {
            path: Path::new(path).to_path_buf(),
            project_data: ProjectFileData::new(),
            project_disk_baseline: None,
            tables_data: HashMap::new(),
            table_catalog: Arc::new(Mutex::new(HashMap::new())),
            table_display_catalog: Arc::new(Mutex::new(HashMap::new())),
            formula_metadata_cache: Arc::new(Mutex::new(HashMap::new())),
            change_detector: None,
            interface_registry: InterfaceRegistry::new(),
            instance_id: uuid::Uuid::new_v4().to_string(),
            interface_change_listener: None,
            interface_history: HashMap::new(),
            interface_disk_baselines: Mutex::new(HashMap::new()),
        };

        match toml::from_str::<ProjectFileData>(
            &fs::read_to_string(&project.path).map_err(DevcelError::Io)?,
        ) {
            Ok(project_data) => {
                project.project_disk_baseline = Some(project_data.clone());
                project.project_data = project_data;
            }
            Err(e) => {
                return Err(DevcelError::Toml(e));
            }
        }

        // Load interfaces
        project.load_interfaces()?;

        // If table implementation information must be registered at initial load,
        // scan all tables here (the current implementation registers them during individual loads)

        Ok(project)
    }

    pub fn delete_project(&mut self) -> Result<()> {
        Ok(())
    }

    pub fn rename_project(&mut self, new_name: &str) -> Result<()> {
        self.project_data.project_name = new_name.to_string();
        Ok(())
    }

    pub fn save_project(&mut self) -> Result<()> {
        crate::project_tags::ensure_ready(self)?;
        // Pending dirty writers are checked before touching any file. A successfully
        // acknowledged command is already clean and does not request another approval.
        let mut files = vec![(
            self.path.clone(),
            toml::to_string(&self.project_data)
                .map_err(|e| {
                    crate::app_error::diagnostic(
                        "error.parse",
                        serde_json::json!({"details": e.to_string()}),
                    )
                })?
                .into_bytes(),
        )];
        let mut expected = HashMap::new();
        // Only initial creation may start from an absent/empty metadata file.
        // Read once: a second exists() check could otherwise miss a concurrent
        // deletion and accidentally drop the metadata dependency from the CAS set.
        let disk = match fs::read(&self.path) {
            Ok(disk) => Some(disk),
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && self.project_disk_baseline.is_none() =>
            {
                None
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(DevcelError::Validation(
                    "The project metadata changed on disk. Reload before saving".into(),
                ))
            }
            Err(error) => return Err(error.into()),
        };
        if let Some(disk) = disk {
            if disk.is_empty() {
                if self.project_disk_baseline.is_some() {
                    return Err(DevcelError::Validation(
                        "The project metadata changed on disk. Reload before saving".into(),
                    ));
                }
            } else {
                let persisted: ProjectFileData = toml::from_str(
                    std::str::from_utf8(&disk)
                        .map_err(|error| DevcelError::Validation(error.to_string()))?,
                )?;
                if persisted.tag_presets != self.project_data.tag_presets {
                    return Err(crate::project_tags::diagnostic(
                        "registryChangedOnDisk",
                        serde_json::json!({}),
                    ));
                }
                if self.project_disk_baseline.as_ref() != Some(&persisted) {
                    return Err(DevcelError::Validation(
                        "The project metadata changed on disk. Reload before saving".into(),
                    ));
                }
            }
            expected.insert(
                self.path.clone(),
                format!("raw:{}", crate::project_tags::raw_revision(&disk)),
            );
        }
        let mut saved = Vec::new();
        let mut deleted = crate::reference_integrity::DeletedRecords::new();
        for (path, table) in &self.tables_data {
            if table.is_dirty && path.exists() {
                let before: TableData = TableData::from_toml(&fs::read_to_string(path)?)?;
                crate::reference_integrity::collect_deleted(&before, &table.data, &mut deleted);
            }
        }
        let dirty: Vec<_> = self
            .tables_data
            .values()
            .filter(|table| table.is_dirty)
            .map(|table| table.data.clone())
            .collect();
        let dirty_refs: Vec<_> = dirty.iter().collect();
        let reads = crate::reference_integrity::validate_deletions(self, &deleted, &dirty_refs)?;
        for (path, revision) in reads {
            expected.entry(path).or_insert(revision);
        }
        let formula_context = crate::formula_context::ProjectFormulaContext::new(self, None)?;
        // A dirty sibling's persisted state belongs to the baseline. Keep only
        // its identity here; dependency reads remain bounded inside the context.
        let dirty_paths: Vec<_> = self
            .tables_data
            .iter()
            .filter(|(_, table)| table.is_dirty)
            .map(|(path, _)| path.clone())
            .collect();
        let before_context = crate::formula_context::ProjectFormulaContext::new_with_disk_baseline(
            self,
            None,
            &dirty_paths,
        )?;
        for (path, table) in &self.tables_data {
            if !table.is_dirty {
                continue;
            }
            let before = if path.exists() {
                let before: TableData = TableData::from_toml(&fs::read_to_string(path)?)?;
                expected.insert(path.clone(), crate::cell_rules::revision(&before));
                before
            } else {
                let mut empty = table.data.clone();
                empty.records.clear();
                empty
            };
            if path.exists() {
                crate::edit_controls::validate_transition(&before, &table.data, false)?;
                #[cfg(feature = "localization")]
                crate::plugin_resources::validate_authoring_transition(self, &before, &table.data)?;
            }
            let mut evaluate = |data: &TableData,
                                column: &crate::column::ColumnSchema,
                                record: &crate::record::Record,
                                formula: &str| {
                let context = if std::ptr::eq(data, &table.data) {
                    &formula_context
                } else {
                    &before_context
                };
                context.evaluate_cell_with_override(data, column, record, formula)
            };
            crate::cell_rules::validate_transition_with_evaluator(
                &self.project_data.uuid,
                &before,
                &table.data,
                None,
                &mut evaluate,
            )?;
            files.push((
                path.clone(),
                crate::table_storage::to_toml(&table.data)?.into_bytes(),
            ));
            saved.push(path.clone());
        }
        crate::table_mutation::persist_files(files, &expected, None)?;
        self.project_disk_baseline = Some(self.project_data.clone());
        for path in saved {
            self.tables_data.get_mut(&path).unwrap().is_dirty = false;
        }
        Ok(())
    }

    pub fn close_project(&mut self) -> Result<()> {
        self.save_project()?;
        Ok(())
    }

    // Helper method to generate a unique path
    fn generate_unique_path(&self, base_path: &Path) -> Result<PathBuf> {
        if !base_path.try_exists()? && !self.tables_data.contains_key(base_path) {
            return Ok(base_path.to_path_buf());
        }

        let parent = base_path.parent().unwrap_or(Path::new(""));
        let file_name = base_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("untitled");

        // Special handling for .table.toml files
        let (file_stem, extension) = if file_name.ends_with(".table.toml") {
            let stem = file_name.strip_suffix(".table.toml").unwrap_or("untitled");
            (stem, "table.toml")
        } else {
            let stem = base_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("untitled");
            let ext = base_path.extension().and_then(|s| s.to_str()).unwrap_or("");
            (stem, ext)
        };

        let mut counter = 1;
        loop {
            let new_name = if extension.is_empty() {
                format!("{file_stem}_{counter}")
            } else {
                format!("{file_stem}_{counter}.{extension}")
            };

            let new_path = parent.join(new_name);

            // Check filesystem existence
            if !new_path.try_exists()? {
                // Check duplicates in table data for table paths
                if extension != "table.toml" || !self.tables_data.contains_key(&new_path) {
                    return Ok(new_path);
                }
            }

            counter += 1;
            if counter > 1000 {
                // Prevent an infinite loop
                break;
            }
        }

        Err(crate::app_error::diagnostic(
            "error.path.nameExhausted",
            serde_json::json!({"path": base_path.to_string_lossy(), "count": 1000}),
        ))
    }

    // Helper method to get the Tables directory path
    fn get_tables_dir(&self) -> Result<PathBuf> {
        let project_root = self
            .path
            .parent()
            .ok_or_else(|| contextual_error("error.invalidPath", self.path.to_string_lossy()))?;
        Ok(project_root.join("Tables"))
    }

    // Convert frontend-relative paths to absolute paths inside the Tables directory
    pub fn resolve_table_path(&self, relative_path: &Path) -> Result<PathBuf> {
        crate::project_paths::resolve(&self.get_tables_dir()?, relative_path)
    }

    pub fn create_table(&mut self, path: PathBuf) -> Result<PathBuf> {
        crate::project_tags::ensure_ready(self)?;
        crate::utils::validate_table_path(&path)?;
        // Convert to a path inside the Tables directory
        let full_path = self.resolve_table_path(&path)?;

        // Generate a unique path
        let unique_path = self.generate_unique_path(&full_path)?;

        // Get the basename by removing the .table.toml extension.
        // Use it as the table identifier (data_name) and default display name.
        let base_name = unique_path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|name| name.strip_suffix(".table.toml").unwrap_or(name).to_string())
            .unwrap_or_else(|| "New table".to_string());

        // Create the new table data
        let table_data = TableData {
            uuid: uuid::Uuid::new_v4().to_string(),
            display_name: base_name.clone(),
            metadata: TableMetadata {
                schema_version: 1,
                interface_order: Vec::new(),
                initial_transposed: false,
                edit_permissions: Default::default(),
                parent_uuid: String::new(),
                data_name: base_name,
            },
            description: String::new(),
            schema: TableSchema {
                columns: Vec::new(),
            },
            records: Vec::new(),
            interface_implementations: HashMap::new(),
        };

        // Save as a TOML file
        let toml_string = crate::table_storage::to_toml(&table_data)?;

        if let Some(parent) = unique_path.parent() {
            fs::create_dir_all(parent).map_err(DevcelError::Io)?;
        }

        // Never truncate a file created by another process after name selection.
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&unique_path)?;
        if let Err(error) = file
            .write_all(toml_string.as_bytes())
            .and_then(|_| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&unique_path);
            return Err(DevcelError::Io(error));
        }

        // Add the table to memory
        self.tables_data.insert(
            unique_path.clone(),
            Table {
                path: unique_path.clone(),
                is_dirty: false,
                data: table_data,
                undo_history: Vec::new(),
                redo_history: Vec::new(),
            },
        );
        Ok(unique_path)
    }

    /// Save a standalone table. Project-dependent formulas cannot be resolved at
    /// this boundary and are reported as formula errors when rules evaluate them.
    /// Use `save_project` or the project mutation APIs for cross-table validation.
    pub fn save_table(table: &Table) -> Result<()> {
        let mut expected = HashMap::new();
        let before = if table.path.exists() {
            let before: TableData = TableData::from_toml(&fs::read_to_string(&table.path)?)?;
            expected.insert(table.path.clone(), crate::cell_rules::revision(&before));
            before
        } else {
            let mut empty = table.data.clone();
            empty.records.clear();
            empty
        };
        if table.path.exists() {
            crate::edit_controls::validate_transition(&before, &table.data, false)?;
        }
        crate::cell_rules::validate_transition("", &before, &table.data, None)?;
        crate::table_mutation::persist_tables(&[(&table.path, &table.data)], &expected, None)
    }

    pub fn delete_table(&mut self, path: PathBuf) -> Result<()> {
        crate::project_tags::ensure_ready(self)?;
        // Convert to a path inside the Tables directory
        let full_path = self.resolve_table_path(&path)?;

        if !full_path.exists() {
            return Err(DevcelError::NotFound("table file not found".to_string()));
        }
        self.ensure_table_deletable_at(&full_path)?;

        fs::remove_file(full_path.clone()).map_err(DevcelError::Io)?;

        if let Some(uuid) = self
            .tables_data
            .get(&full_path)
            .map(|table| table.data.uuid.clone())
        {
            self.clear_table_undo_redo_stacks(&uuid)?;
        }
        self.tables_data.remove(&full_path);
        Ok(())
    }

    fn ensure_table_deletable_at(&self, path: &Path) -> Result<()> {
        // Check live and persisted settings; neither stale memory nor an unloaded
        // table may erase a protected document. Invalid documents fail closed.
        let persisted = self.load_table_from_file(&path.to_path_buf())?;
        #[cfg(feature = "localization")]
        {
            let catalog = self.get_table_catalog()?;
            if let Some(registry) = catalog
                .iter()
                .find(|entry| entry.uuid == crate::plugin_resources::REGISTRY_UUID)
            {
                let mut live_tables = HashMap::new();
                let mut disk_tables = HashMap::new();
                for entry in &catalog {
                    let path = PathBuf::from(&entry.path);
                    let disk = self.load_table_from_file(&path)?;
                    let live = self.read_table_data_by_uuid(&entry.uuid)?;
                    disk_tables.insert(
                        path.clone(),
                        Table {
                            path: path.clone(),
                            data: disk,
                            is_dirty: false,
                            undo_history: vec![],
                            redo_history: vec![],
                        },
                    );
                    live_tables.insert(
                        path.clone(),
                        Table {
                            path,
                            data: live,
                            is_dirty: false,
                            undo_history: vec![],
                            redo_history: vec![],
                        },
                    );
                }
                let path = PathBuf::from(&registry.path);
                crate::plugin_resources::require_unregistered_table(
                    &live_tables[&path].data,
                    &persisted.uuid,
                    &live_tables,
                    &self.interface_registry,
                )?;
                crate::plugin_resources::require_unregistered_table(
                    &disk_tables[&path].data,
                    &persisted.uuid,
                    &disk_tables,
                    &self.interface_registry,
                )?;
            }
        }
        if let Some(table) = self.tables_data.get(path) {
            crate::edit_controls::require_table_deletable(&table.data)?;
        }
        crate::edit_controls::require_table_deletable(&persisted)?;
        Ok(())
    }

    pub fn move_table(&mut self, old_path: PathBuf, new_path: PathBuf) -> Result<PathBuf> {
        self.move_table_with_save_queue(old_path, new_path, None)
    }

    pub fn move_table_with_save_queue(
        &mut self,
        old_path: PathBuf,
        new_path: PathBuf,
        queue: Option<&Arc<FileBasedSaveQueueManager>>,
    ) -> Result<PathBuf> {
        crate::project_tags::ensure_ready(self)?;
        crate::utils::validate_table_path(&old_path)?;
        crate::utils::validate_table_path(&new_path)?;
        let source = self.resolve_table_path(&old_path)?;
        let requested = self.resolve_table_path(&new_path)?;
        if !self.tables_data.contains_key(&source) && source.exists() {
            // Preserve moving an unparseable document as a regular file. Loaded
            // tables still require the live revision and clean state below.
            let _ = self.load_table(&source);
        }
        let destination = if source == requested {
            source.clone()
        } else {
            self.generate_unique_path(&requested)?
        };
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        self.relocate_table_file(source, destination, queue)
    }

    /// Rename a table file in its current folder, retaining identity and history.
    pub fn rename_table_file(
        &mut self,
        path: &Path,
        new_name: &str,
        queue: Option<&Arc<FileBasedSaveQueueManager>>,
    ) -> Result<PathBuf> {
        let name = crate::utils::renamed_file_name(new_name, ".table.toml")?;
        let source = self.resolve_table_path(path)?;
        let destination = source.with_file_name(name);
        self.relocate_table_file(source, destination, queue)
    }

    /// Shared move/rename write boundary: never publish a new path until the
    /// atomic filesystem operation succeeds, and retire old queued snapshots.
    fn relocate_table_file(
        &mut self,
        source: PathBuf,
        destination: PathBuf,
        queue: Option<&Arc<FileBasedSaveQueueManager>>,
    ) -> Result<PathBuf> {
        crate::utils::validate_table_path(&source)?;
        crate::utils::validate_table_path(&destination)?;
        // Early existence check also rejects case-only aliases on a case-insensitive
        // filesystem before acquiring the same sidecar lock twice. NOREPLACE
        // remains the authoritative check for racing destination creation.
        if source != destination
            && (self.tables_data.contains_key(&destination) || destination.try_exists()?)
        {
            return Err(DevcelError::AlreadyExists(
                destination.display().to_string(),
            ));
        }
        let table = self.tables_data.get(&source);
        if table.is_some_and(|table| table.is_dirty) {
            return Err(DevcelError::Validation(
                "Save the table before moving or renaming it".into(),
            ));
        }
        let expected = table.map(|table| crate::cell_rules::revision(&table.data));
        let rename = || -> Result<()> {
            // Match the write boundary's lock order across processes. Destination
            // existence is finally enforced by the OS, not a check-then-rename.
            let mut paths = vec![&source, &destination];
            paths.sort();
            paths.dedup();
            let _locks = crate::write_locks::lock_files(
                paths.into_iter().map(|path| path.as_path()),
                false,
            )?;
            // Do not follow symlinks or rename a folder through a table command.
            if !fs::symlink_metadata(&source)?.file_type().is_file() {
                return Err(DevcelError::InvalidOperation(
                    "Not a regular table file".into(),
                ));
            }
            if let Some(expected) = &expected {
                let disk: TableData = TableData::from_toml(&fs::read_to_string(&source)?)?;
                if crate::cell_rules::revision(&disk) != *expected {
                    return Err(DevcelError::Validation(
                        "The table file was updated by another operation. Reload it".into(),
                    ));
                }
            }
            if source == destination {
                return Ok(());
            }
            crate::utils::rename_without_replace(&source, &destination)
        };
        if source == destination {
            rename()?;
            return Ok(source);
        }
        if let Some(queue) = queue {
            queue.rename_directly(&source, &destination, rename)?;
        } else {
            rename()?;
        }
        // All fallible file operations precede publication: a failed rename must
        // not remove the source from memory or lose its undo/redo stacks.
        if let Some(mut table) = self.tables_data.remove(&source) {
            table.path = destination.clone();
            self.tables_data.insert(destination.clone(), table);
        }
        Ok(destination)
    }

    pub fn load_table(&mut self, path: &PathBuf) -> Result<()> {
        self.load_table_with_save_queue(path, None)
    }

    /// UI discovery/opening only needs the live table, never a destructive reload.
    /// Explicit reload and remote file notifications keep their separate reload path.
    pub fn ensure_table_loaded_with_save_queue(
        &mut self,
        path: &PathBuf,
        expected_session: Option<&str>,
        save_queue: Option<&crate::file_save_queue::FileBasedSaveQueueManager>,
    ) -> Result<()> {
        if expected_session.is_some_and(|session| session != self.instance_id) {
            return Err(DevcelError::Validation(
                "project session changed".to_string(),
            ));
        }
        if self.tables_data.contains_key(path) {
            return Ok(());
        }
        self.load_table_with_save_queue(path, save_queue)
    }

    /// Load a table while accounting for the save queue
    pub fn load_table_with_save_queue(
        &mut self,
        path: &PathBuf,
        save_queue: Option<&crate::file_save_queue::FileBasedSaveQueueManager>,
    ) -> Result<()> {
        if !path.exists() {
            return Err(DevcelError::NotFound("table file not found".to_string()));
        }

        // Check whether a save is in progress when a save queue exists
        if let Some(queue) = save_queue {
            if queue.has_pending_saves_for_path_sync(path) {
                eprintln!("load_table - Skipping load for {path:?} - save pending");
                return Ok(());
            }
        }

        let table_data = self.load_table_from_file(path)?;

        if let Some(uuid) = self
            .tables_data
            .get(path)
            .map(|table| table.data.uuid.clone())
        {
            self.clear_table_undo_redo_stacks(&uuid)?;
        }
        // Clear undo/redo stacks for an existing table
        if let Some(existing_table) = self.tables_data.get_mut(path) {
            eprintln!("load_table - Table already in memory, updating from file: {path:?}");
            existing_table.data = table_data;
            existing_table.is_dirty = false;
            existing_table.undo_history.clear();
            existing_table.redo_history.clear();
        } else {
            // Add new tables
            self.tables_data.insert(
                path.clone(),
                Table {
                    path: path.clone(),
                    data: table_data,
                    is_dirty: false,
                    undo_history: Vec::new(),
                    redo_history: Vec::new(),
                },
            );
        }

        Ok(())
    }

    pub fn reload_table(&mut self, uuid: &str) -> Result<()> {
        self.reload_table_with_save_queue(uuid, None)
    }

    pub fn reload_table_with_save_queue(
        &mut self,
        uuid: &str,
        save_queue: Option<&crate::file_save_queue::FileBasedSaveQueueManager>,
    ) -> Result<()> {
        // Find the path first
        let table_path = self
            .tables_data
            .iter()
            .find(|(_, table)| table.data.uuid == uuid)
            .map(|(path, _)| path.clone());

        if table_path.is_none() || !table_path.as_ref().unwrap().exists() {
            return Err(DevcelError::NotFound("table file not found".to_string()));
        }

        if let Some(path) = table_path {
            // Check whether a save is in progress when a save queue exists
            if let Some(queue) = save_queue {
                if queue.has_pending_saves_for_path_sync(&path) {
                    eprintln!("reload_table - Skipping reload for {path:?} - save pending");
                    return Ok(());
                }
            }

            // Read the new table data
            let new_table_data = self.load_table_from_file(&path)?;

            self.clear_table_undo_redo_stacks(uuid)?;
            // Update the matching table
            if let Some(table) = self.tables_data.get_mut(&path) {
                table.data = new_table_data;
                table.is_dirty = false;
                // Clear the table's undo/redo stacks when reloading it
                table.undo_history.clear();
                table.redo_history.clear();
                return Ok(());
            }
        }

        Err(crate::app_error::authoring_error("table not found"))
    }

    fn load_table_from_file(&self, path: &PathBuf) -> Result<TableData> {
        // Discovery is regular-file-only, but callers can still supply an
        // explicit path. Reject links/devices/pipes before a potentially blocking read.
        if !fs::symlink_metadata(path)?.file_type().is_file() {
            return Err(crate::app_error::diagnostic(
                "error.tableSourceType",
                serde_json::json!({"path": path.to_string_lossy()}),
            ));
        }
        let text = fs::read_to_string(path).map_err(DevcelError::Io)?;
        let table_data = TableData::from_toml(&text)?;
        let candidate = Table {
            path: path.clone(),
            data: table_data,
            is_dirty: false,
            undo_history: Vec::new(),
            redo_history: Vec::new(),
        };
        Interface::validate_table_column_ids(&candidate.data, &self.interface_registry)?;
        crate::table_file_revision::remember_parsed(&text, &candidate.data);
        Ok(candidate.data)
    }

    pub fn get_project_entries(&self) -> Result<Vec<ProjectEntry>> {
        let mut entries = Vec::new();

        // No longer add the project file here
        // entries.push(ProjectEntry {
        //     path: absolute_path_to_project_path(self, &self.path).unwrap_or_default(),
        //     entry_type: ProjectEntryType::Project,
        // });

        fn modified_millis(path: &Path) -> Option<u64> {
            std::fs::metadata(path)
                .ok()?
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis()
                .try_into()
                .ok()
        }

        fn visit_dirs(
            project: &Project,
            dir: &Path,
            entries: &mut Vec<ProjectEntry>,
        ) -> std::io::Result<()> {
            let path = PathBuf::from(dir);
            let dir_relative_path =
                crate::utils::absolute_path_to_tables_relative_path(project, &path)
                    .unwrap_or_default();

            entries.push(ProjectEntry {
                modified: modified_millis(&path),
                name: path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string(),
                path: dir_relative_path,
                entry_type: ProjectEntryType::Directory,
                children: None,
                uuid: None,
            });

            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let path = entry.path();

                let kind = entry.file_type()?;
                if kind.is_dir() {
                    visit_dirs(project, &path, entries)?;
                } else if kind.is_file() {
                    // Internal save files are not project documents. Filter only the
                    // exact reserved filenames, retaining ordinary dotfiles and folders.
                    if crate::internal_artifacts::is_internal_save_artifact(&path) {
                        continue;
                    }
                    // Determine the type from the file extension
                    let entry_type = match path.extension().and_then(|s| s.to_str()) {
                        Some("toml") => {
                            // Check whether the filename ends with .devcelproj.toml
                            if path.to_string_lossy().ends_with(".devcelproj.toml") {
                                ProjectEntryType::Project
                            } else if path.to_string_lossy().ends_with(".table.toml") {
                                ProjectEntryType::Table
                            } else if path.to_string_lossy().ends_with(".interface.toml") {
                                ProjectEntryType::Interface
                            } else {
                                ProjectEntryType::Other
                            }
                        }
                        Some("md") => ProjectEntryType::Markdown,
                        _ => ProjectEntryType::Other,
                    };

                    let relative_path =
                        crate::utils::absolute_path_to_tables_relative_path(project, &path)
                            .unwrap_or_default();

                    // Get the UUID for interface entries
                    let uuid = if entry_type == ProjectEntryType::Interface {
                        // Read the UUID from the interface file
                        if let Ok(interface) =
                            project.interface_registry.load_interface_from_path(&path)
                        {
                            Some(interface.uuid.to_string())
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    entries.push(ProjectEntry {
                        modified: modified_millis(&path),
                        name: path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("")
                            .to_string(),
                        path: relative_path,
                        entry_type,
                        children: None,
                        uuid,
                    });
                }
            }
            Ok(())
        }

        // Start traversal at the Tables directory beside the devcelproj file
        let tables_directory_path = PathBuf::from(&self.path).parent().unwrap().join("Tables");

        // The tree is display discovery: omit unsupported sources rather than
        // following them. Preserve real directory IO failures for the caller.
        match fs::symlink_metadata(&tables_directory_path) {
            Ok(metadata) if metadata.file_type().is_dir() => {
                visit_dirs(self, &tables_directory_path, &mut entries).map_err(DevcelError::Io)?;
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(DevcelError::Io(error)),
        }

        entries.sort_by(|a, b| a.path.cmp(&b.path));

        Ok(entries)
    }

    pub fn get_loaded_tables_list(&self) -> Result<Vec<TableReference>> {
        let mut tables: Vec<TableReference> = self
            .tables_data
            .iter()
            .map(|(path, table)| TableReference {
                path: path.to_string_lossy().to_string(),
                uuid: table.data.uuid.clone(),
                data_name: table.data.display_name.clone(), // Use display_name as data_name.
                display_name: table.data.display_name.clone(),
            })
            .collect();

        // Sort by display name for stable ordering
        tables.sort_by(|a, b| a.display_name.cmp(&b.display_name));

        Ok(tables)
    }

    pub fn is_loaded_table(&self, path: &PathBuf) -> bool {
        self.tables_data.contains_key(path)
    }

    pub fn execute_command<T: CommandData + 'static>(
        &mut self,
        command_data: T,
        save_queue: Option<&Arc<FileBasedSaveQueueManager>>,
    ) -> Result<()> {
        self.execute_command_inner(command_data, save_queue, None)
    }

    /// Only the checked, synchronous table-mutation boundary can provide this
    /// opaque proof. Do not recalculate its identical before hash two more times.
    pub(crate) fn execute_verified_replacement(
        &mut self,
        mut command: crate::table_mutation::ReplaceTableCommand,
        verified: crate::table_mutation::VerifiedTableRevision,
        save_queue: Option<&Arc<FileBasedSaveQueueManager>>,
    ) -> Result<()> {
        let before = verified.bind(self, &mut command)?;
        self.execute_command_inner(command, save_queue, before)
    }

    fn execute_command_inner<T: CommandData + 'static>(
        &mut self,
        mut command_data: T,
        save_queue: Option<&Arc<FileBasedSaveQueueManager>>,
        verified_before: Option<(String, String)>,
    ) -> Result<()> {
        crate::project_tags::ensure_ready(self)?;
        let should_save = command_data.should_save();
        let mut targets = command_data.affected_tables(self);
        targets.sort();
        targets.dedup();
        let target_interface = command_data.get_interface_uuid();
        let acknowledgements: HashMap<_, _> = targets
            .iter()
            .filter_map(|uuid| {
                command_data
                    .validation_acknowledgement_for(uuid)
                    .map(|token| (uuid.clone(), token.to_owned()))
            })
            .collect();
        for uuid in &targets {
            self.ensure_table_loaded_by_uuid(uuid)?;
        }
        let previous: Vec<_> = self
            .tables_data
            .iter()
            .filter(|(_, t)| targets.contains(&t.data.uuid))
            .map(|(p, t)| (p.clone(), t.clone()))
            .collect();
        let mut expected_disk: HashMap<_, _> = previous
            .iter()
            .filter(|(_, table)| !table.is_dirty || acknowledgements.contains_key(&table.data.uuid))
            .map(|(path, table)| {
                let revision = verified_before
                    .as_ref()
                    .filter(|(uuid, _)| uuid == &table.data.uuid)
                    .map(|(_, revision)| revision.clone())
                    .unwrap_or_else(|| crate::cell_rules::revision(&table.data));
                (path.clone(), revision)
            })
            .collect();
        let result = (|| -> Result<()> {
            command_data.execute(self)?;
            let mut deleted = crate::reference_integrity::DeletedRecords::new();
            for (_, before) in &previous {
                if let Some(after) = self.find_table_by_uuid(&before.data.uuid) {
                    crate::reference_integrity::collect_deleted(
                        &before.data,
                        &after.data,
                        &mut deleted,
                    );
                }
            }
            let candidates: Vec<_> = targets
                .iter()
                .filter_map(|id| self.find_table_by_uuid(id).map(|table| table.data.clone()))
                .collect();
            let candidates_ref: Vec<_> = candidates.iter().collect();
            let reads =
                crate::reference_integrity::validate_deletions(self, &deleted, &candidates_ref)?;
            for (path, revision) in reads {
                expected_disk.entry(path).or_insert(revision);
            }
            for (path, before) in &previous {
                let after = self
                    .tables_data
                    .get(path)
                    .filter(|table| table.data.uuid == before.data.uuid)
                    .or_else(|| self.find_table_by_uuid(&before.data.uuid))
                    .ok_or_else(|| contextual_error("error.tableMissing", &before.data.uuid))?;
                crate::edit_controls::validate_transition(
                    &before.data,
                    &after.data,
                    command_data.is_edit_control_settings(),
                )?;
                #[cfg(feature = "localization")]
                crate::plugin_resources::validate_authoring_transition(
                    self,
                    &before.data,
                    &after.data,
                )?;
                crate::project_tags::validate_transition(
                    &self.project_data.tag_presets,
                    &before.data,
                    &after.data,
                )?;
            }
            let formula_context = crate::formula_context::ProjectFormulaContext::new(self, None)?;
            let before_tables: Vec<_> = previous.iter().map(|(_, table)| &table.data).collect();
            let before_context = crate::formula_context::ProjectFormulaContext::new_with_overrides(
                self,
                None,
                &before_tables,
            )?;
            for (_, before) in &previous {
                let after = self
                    .find_table_by_uuid(&before.data.uuid)
                    .ok_or_else(|| contextual_error("error.tableMissing", &before.data.uuid))?;
                // Adding a default-only row is intentionally non-blocking. The
                // saved row and its rule issues are immediately visible for inline
                // repair. This is not a bypass for edits, imports, or mixed writes.
                let validation_before = if command_data.allows_default_record_creation()
                    && crate::cell_rules::is_default_record_creation(&before.data, &after.data)
                {
                    &after.data
                } else {
                    &before.data
                };
                let mut evaluate = |data: &TableData,
                                    column: &crate::column::ColumnSchema,
                                    record: &crate::record::Record,
                                    formula: &str| {
                    let context = if std::ptr::eq(data, &after.data) {
                        &formula_context
                    } else {
                        &before_context
                    };
                    context.evaluate_cell_with_override(data, column, record, formula)
                };
                crate::cell_rules::validate_transition_with_evaluator(
                    &self.project_data.uuid,
                    validation_before,
                    &after.data,
                    acknowledgements.get(&before.data.uuid).map(String::as_str),
                    &mut evaluate,
                )?;
            }
            if should_save && !targets.is_empty() {
                let files: Vec<_> = self
                    .tables_data
                    .iter()
                    .filter(|(_, t)| targets.contains(&t.data.uuid))
                    .map(|(p, t)| (p.as_path(), &t.data))
                    .collect();
                crate::table_mutation::persist_tables(&files, &expected_disk, save_queue)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            for (path, table) in previous {
                self.tables_data.insert(path, table);
            }
            return Err(error);
        }
        let snapshots = previous
            .into_iter()
            .map(|(_, before)| {
                let uuid = before.data.uuid.clone();
                // Replacement commands already own these immutable states. For
                // all other commands, move the rollback data into history now
                // that persistence succeeded instead of cloning it once more.
                let snapshot = command_data
                    .shared_table_history_snapshot(&uuid)
                    .unwrap_or_else(|| crate::commands::TableHistorySnapshot {
                        before: Arc::new(before.data),
                        after: Arc::new(self.find_table_by_uuid(&uuid).unwrap().data.clone()),
                    });
                (uuid, snapshot)
            })
            .collect();
        let command = Command {
            data: Arc::new(std::sync::Mutex::new(command_data)),
            timestamp: SystemTime::now(),
            table_snapshots: Arc::new(snapshots),
            save_queue: save_queue.cloned(),
        };
        // No history or dirty transition is published until validation and all disk writes succeed.
        self.invalidate_related_table_history(&targets, false);
        for table in self.tables_data.values_mut() {
            if targets.contains(&table.data.uuid) {
                if should_save {
                    table.is_dirty = false;
                }
                table.undo_history.push(command.clone());
            }
        }
        if let Some(uuid) = target_interface {
            let (undo, redo) = self.interface_history.entry(uuid).or_default();
            undo.push(command);
            redo.clear();
        }
        Ok(())
    }

    // Transaction execution method: run multiple commands together
    pub fn execute_transaction<F>(
        &mut self,
        description: String,
        transaction_fn: F,
        save_queue: Option<&Arc<FileBasedSaveQueueManager>>,
    ) -> Result<()>
    where
        F: FnOnce(&mut crate::commands::TransactionCommand) -> Result<()>,
    {
        let mut transaction = crate::commands::TransactionCommand::new(description);

        // Build the transaction contents
        transaction_fn(&mut transaction)?;

        // Do not execute empty transactions
        if transaction.is_empty() {
            return Ok(());
        }

        // Execute the entire transaction as one command
        self.execute_command(transaction, save_queue)
    }

    /// General interface edits are undoable within this session. The version DAG
    /// remains persisted; creation/deletion are intentionally outside this scope.
    pub fn undo_interface_command(&mut self, interface_uuid: &str) -> Result<()> {
        self.replay_interface_command(interface_uuid, false)
    }

    pub fn redo_interface_command(&mut self, interface_uuid: &str) -> Result<()> {
        self.replay_interface_command(interface_uuid, true)
    }

    fn replay_interface_command(&mut self, interface_uuid: &str, redo: bool) -> Result<()> {
        let uuid = uuid::Uuid::parse_str(interface_uuid).map_err(|error| {
            crate::app_error::diagnostic(
                "error.interface.invalidId",
                serde_json::json!({"id": interface_uuid, "details": error.to_string()}),
            )
        })?;
        if self.get_interface(&uuid).is_none() {
            return Err(DevcelError::NotFound("Interface not found".into()));
        }
        let command = self
            .interface_history
            .get(&uuid)
            .and_then(|(undo, redo_history)| {
                if redo {
                    redo_history.last()
                } else {
                    undo.last()
                }
            })
            .cloned()
            .ok_or_else(|| {
                DevcelError::InvalidOperation(
                    if redo {
                        "No operation available to redo"
                    } else {
                        "No operation available to undo"
                    }
                    .into(),
                )
            })?;
        // Move history only after the command and its synchronous save succeed.
        let result = if redo {
            command.data.lock().unwrap().execute(self)
        } else {
            command.data.lock().unwrap().undo(self)
        };
        result?;
        let (undo, redo_history) = self.interface_history.get_mut(&uuid).unwrap();
        if redo {
            redo_history.pop();
            undo.push(command);
        } else {
            undo.pop();
            redo_history.push(command);
        }
        Ok(())
    }

    pub fn undo_command(&mut self, table_uuid: &str) -> Result<()> {
        self.replay_table_command(table_uuid, false)
    }

    pub fn redo_command(&mut self, table_uuid: &str) -> Result<()> {
        self.replay_table_command(table_uuid, true)
    }

    fn replay_table_command(&mut self, table_uuid: &str, redo: bool) -> Result<()> {
        crate::project_tags::ensure_ready(self)?;
        let table = self
            .tables_data
            .values()
            .find(|table| table.data.uuid == table_uuid)
            .ok_or_else(|| DevcelError::NotFound("The specified table was not found".into()))?;
        let history = if redo {
            &table.redo_history
        } else {
            &table.undo_history
        };
        let command = history.last().cloned().ok_or_else(|| {
            DevcelError::InvalidOperation(
                if redo {
                    "No operation available to redo"
                } else {
                    "No operation available to undo"
                }
                .into(),
            )
        })?;
        let targets = command.table_uuids();

        // Shared commands can move only when they are the next operation in every
        // participant. Never undo an older batch underneath another table's edit.
        for target in &targets {
            let table = self
                .tables_data
                .values()
                .find(|table| table.data.uuid == *target)
                .ok_or_else(|| {
                    DevcelError::InvalidOperation(
                        "The target table for the bulk operation is not loaded".into(),
                    )
                })?;
            let history = if redo {
                &table.redo_history
            } else {
                &table.undo_history
            };
            if !history
                .last()
                .is_some_and(|next| Arc::ptr_eq(&next.data, &command.data))
            {
                return Err(DevcelError::Diagnostics(vec![
                    crate::types::Diagnostic::Code {
                        code: "error.historyRelated".into(),
                        params: serde_json::json!({
                            "table": table.data.display_name,
                            "action": crate::types::Diagnostic::Code { code: if redo { "menu.redo" } else { "menu.undo" }.into(), params: serde_json::json!({}) }
                        }),
                    },
                ]));
            }
        }

        if command.table_snapshots.is_empty() {
            return Err(DevcelError::InvalidOperation(
                "No history is available for safe restoration".into(),
            ));
        }
        let mut files = Vec::new();
        let mut expected_disk = HashMap::new();
        for (uuid, snapshot) in command.table_snapshots.iter() {
            let table = self
                .find_table_by_uuid(uuid)
                .ok_or_else(|| contextual_error("error.tableMissing", uuid))?;
            let (expected, target) = if redo {
                (&snapshot.before, &snapshot.after)
            } else {
                (&snapshot.after, &snapshot.before)
            };
            if crate::cell_rules::revision(&table.data) != crate::cell_rules::revision(expected) {
                return Err(DevcelError::InvalidOperation(
                    "The table changed outside its history. Reload it".into(),
                ));
            }
            crate::edit_controls::validate_transition(
                &table.data,
                target,
                command.data.lock().unwrap().is_edit_control_settings(),
            )?;
            #[cfg(feature = "localization")]
            crate::plugin_resources::validate_authoring_transition(self, &table.data, target)?;
            expected_disk.insert(table.path.clone(), crate::cell_rules::revision(expected));
            files.push((table.path.clone(), target.as_ref().clone()));
        }
        let mut deleted = crate::reference_integrity::DeletedRecords::new();
        for (_, target) in &files {
            let current = &self.find_table_by_uuid(&target.uuid).unwrap().data;
            crate::reference_integrity::collect_deleted(current, target, &mut deleted);
        }
        let target_data: Vec<_> = files.iter().map(|(_, data)| data).collect();
        let reads = crate::reference_integrity::validate_deletions(self, &deleted, &target_data)?;
        for (path, revision) in reads {
            expected_disk.entry(path).or_insert(revision);
        }
        // Restore only the exact previously approved snapshot. Do not replay commands,
        // regenerate UUIDs, or request a second acknowledgement for historical warnings.
        let borrowed: Vec<_> = files
            .iter()
            .map(|(path, data)| (path.as_path(), data))
            .collect();
        crate::table_mutation::persist_tables(
            &borrowed,
            &expected_disk,
            command.save_queue.as_ref(),
        )?;
        for (_, data) in files {
            let table = self.find_table_by_uuid_mut(&data.uuid).unwrap();
            table.data = data;
            table.is_dirty = false;
        }
        for table in self.tables_data.values_mut() {
            if targets.contains(&table.data.uuid) {
                if redo {
                    table.redo_history.pop();
                    table.undo_history.push(command.clone());
                } else {
                    table.undo_history.pop();
                    table.redo_history.push(command.clone());
                }
            }
        }
        Ok(())
    }

    /// Clear the dependency closure, not just one copy of a shared command.
    /// Redo after a new edit must not replay any batch that depends on discarded work.
    fn invalidate_related_table_history(&mut self, table_uuids: &[String], include_undo: bool) {
        if table_uuids.is_empty() {
            return;
        }
        let mut affected: HashSet<String> = table_uuids.iter().cloned().collect();
        loop {
            let before = affected.len();
            for table in self.tables_data.values() {
                let history = table
                    .redo_history
                    .iter()
                    .chain(table.undo_history.iter().take(if include_undo {
                        table.undo_history.len()
                    } else {
                        0
                    }));
                for command in history {
                    let targets = command.table_uuids();
                    if affected.contains(&table.data.uuid)
                        || targets.iter().any(|target| affected.contains(target))
                    {
                        affected.insert(table.data.uuid.clone());
                        affected.extend(targets);
                    }
                }
            }
            if affected.len() == before {
                break;
            }
        }
        for table in self.tables_data.values_mut() {
            if affected.contains(&table.data.uuid) {
                table.redo_history.clear();
                if include_undo {
                    table.undo_history.clear();
                }
            }
        }
    }

    // Reload/deletion must also invalidate shared history in surviving tables.
    pub fn clear_table_undo_redo_stacks(&mut self, table_uuid: &str) -> Result<()> {
        if !self
            .tables_data
            .values()
            .any(|table| table.data.uuid == table_uuid)
        {
            return Err(DevcelError::NotFound(
                "The specified table was not found".into(),
            ));
        }
        self.invalidate_related_table_history(&[table_uuid.to_string()], true);
        Ok(())
    }

    // Directory operation methods
    pub fn create_directory(&mut self, path: PathBuf) -> Result<PathBuf> {
        crate::project_tags::ensure_ready(self)?;
        // Convert to a path inside the Tables directory
        let full_path = self.resolve_table_path(&path)?;

        // Generate a unique path
        let unique_path = self.generate_unique_path(&full_path)?;

        // Only the parents may already exist; a concurrent leaf creation is an error.
        if let Some(parent) = unique_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::create_dir(&unique_path)?;

        Ok(unique_path)
    }

    pub fn rename_directory(&mut self, old_path: PathBuf, new_name: &str) -> Result<PathBuf> {
        crate::project_tags::ensure_ready(self)?;
        // Convert to a path inside the Tables directory
        let full_old_path = self.resolve_table_path(&old_path)?;
        if fs::canonicalize(&full_old_path)? == fs::canonicalize(self.get_tables_dir()?)? {
            return Err(DevcelError::InvalidOperation(
                "Cannot modify the Tables root directory".into(),
            ));
        }

        // Check that the directory exists
        if !full_old_path.exists() {
            return Err(DevcelError::NotFound("Directory not found".to_string()));
        }

        if !full_old_path.is_dir() {
            return Err(DevcelError::InvalidOperation(
                "The specified path is not a directory".to_string(),
            ));
        }

        // Build the new path
        let parent = full_old_path.parent().ok_or(DevcelError::NotFound(
            "Parent directory not found".to_string(),
        ))?;
        let requested_new_path = self.resolve_table_path(&parent.join(new_name))?;

        // Generate a unique path
        let new_path = self.generate_unique_path(&requested_new_path)?;

        // Rename the directory
        fs::rename(&full_old_path, &new_path).map_err(DevcelError::Io)?;

        // Update loaded table paths
        let mut tables_to_update = Vec::new();
        for table_path in self.tables_data.keys() {
            if table_path.starts_with(&full_old_path) {
                let relative_path = table_path.strip_prefix(&full_old_path).map_err(|e| {
                    crate::app_error::diagnostic(
                        "error.invalidOperation",
                        serde_json::json!({"details": e.to_string()}),
                    )
                })?;
                let new_table_path = new_path.join(relative_path);
                tables_to_update.push((table_path.clone(), new_table_path));
            }
        }

        // Update the table path
        for (old_table_path, new_table_path) in tables_to_update {
            if let Some(mut table) = self.tables_data.remove(&old_table_path) {
                table.path = new_table_path.clone();
                self.tables_data.insert(new_table_path, table);
            }
        }

        Ok(new_path)
    }

    pub fn move_directory(&mut self, old_path: PathBuf, new_path: PathBuf) -> Result<PathBuf> {
        // Convert to a path inside the Tables directory
        let full_old_path = self.resolve_table_path(&old_path)?;
        if fs::canonicalize(&full_old_path)? == fs::canonicalize(self.get_tables_dir()?)? {
            return Err(DevcelError::InvalidOperation(
                "Cannot modify the Tables root directory".into(),
            ));
        }
        let full_new_path = self.resolve_table_path(&new_path)?;

        // Check that the directory exists
        if !full_old_path.exists() {
            return Err(DevcelError::NotFound(
                "Source directory not found".to_string(),
            ));
        }

        if !full_old_path.is_dir() {
            return Err(DevcelError::InvalidOperation(
                "The specified path is not a directory".to_string(),
            ));
        }

        // Generate a unique path
        let unique_new_path = self.generate_unique_path(&full_new_path)?;

        // Create the destination parent directory
        if let Some(parent) = unique_new_path.parent() {
            fs::create_dir_all(parent).map_err(DevcelError::Io)?;
        }

        // Move the directory
        fs::rename(&full_old_path, &unique_new_path).map_err(DevcelError::Io)?;

        // Update loaded table paths
        let mut tables_to_update = Vec::new();
        for table_path in self.tables_data.keys() {
            if table_path.starts_with(&full_old_path) {
                let relative_path = table_path.strip_prefix(&full_old_path).map_err(|e| {
                    crate::app_error::diagnostic(
                        "error.invalidOperation",
                        serde_json::json!({"details": e.to_string()}),
                    )
                })?;
                let new_table_path = unique_new_path.join(relative_path);
                tables_to_update.push((table_path.clone(), new_table_path));
            }
        }

        // Update the table path
        for (old_table_path, new_table_path) in tables_to_update {
            if let Some(mut table) = self.tables_data.remove(&old_table_path) {
                table.path = new_table_path.clone();
                self.tables_data.insert(new_table_path, table);
            }
        }

        Ok(unique_new_path)
    }

    pub fn delete_directory(&mut self, path: PathBuf) -> Result<()> {
        crate::project_tags::ensure_ready(self)?;
        // Convert to a path inside the Tables directory
        let full_path = self.resolve_table_path(&path)?;
        if fs::canonicalize(&full_path)? == fs::canonicalize(self.get_tables_dir()?)? {
            return Err(DevcelError::InvalidOperation(
                "Cannot modify the Tables root directory".into(),
            ));
        }

        // Check that the directory exists
        if !full_path.exists() {
            return Err(DevcelError::NotFound("Directory not found".to_string()));
        }

        if !full_path.is_dir() {
            return Err(DevcelError::InvalidOperation(
                "The specified path is not a directory".to_string(),
            ));
        }

        // Check every descendant before deleting any file or changing history.
        let mut pending = vec![full_path.clone()];
        let mut interface_paths = Vec::new();
        let mut table_paths = std::collections::BTreeSet::new();
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory)? {
                let entry = entry?;
                let kind = entry.file_type()?;
                if kind.is_dir() {
                    pending.push(entry.path());
                } else if kind.is_file()
                    && entry.file_name().to_string_lossy().ends_with(".table.toml")
                {
                    table_paths.insert(entry.path());
                } else if kind.is_file()
                    && entry
                        .file_name()
                        .to_string_lossy()
                        .ends_with(".interface.toml")
                {
                    interface_paths.push(entry.path());
                }
            }
        }
        table_paths.extend(
            self.tables_data
                .keys()
                .filter(|path| path.starts_with(&full_path))
                .cloned(),
        );
        for path in table_paths {
            self.ensure_table_deletable_at(&path)?;
        }

        for path in interface_paths {
            let interface: Interface = toml::from_str(&fs::read_to_string(path)?)
                .map_err(|error| DevcelError::Validation(error.to_string()))?;
            self.ensure_interface_deletable(&interface.uuid)?;
        }

        // Remove loaded tables
        let mut tables_to_remove = Vec::new();
        for table_path in self.tables_data.keys() {
            if table_path.starts_with(&full_path) {
                tables_to_remove.push(table_path.clone());
            }
        }

        fs::remove_dir_all(&full_path).map_err(DevcelError::Io)?;
        for table_path in tables_to_remove {
            if let Some(uuid) = self
                .tables_data
                .get(&table_path)
                .map(|table| table.data.uuid.clone())
            {
                self.clear_table_undo_redo_stacks(&uuid)?;
            }
            self.tables_data.remove(&table_path);
        }

        Ok(())
    }

    // === Change detection methods ===

    /// Set the change detector (switchable at runtime)
    pub fn set_change_detector(&mut self, detector: Box<dyn ChangeDetector>) {
        self.change_detector = Some(detector);
    }

    /// Use the default detector
    pub async fn use_default_change_detector(&mut self) -> Result<()> {
        let mut detector = Box::new(SimpleVersionDetector::new());
        let project_dir = self.path.parent().unwrap_or(Path::new("."));
        detector.initialize(project_dir, &self.instance_id).await?;
        self.change_detector = Some(detector);
        Ok(())
    }

    /// Record a change (call this for every mutation)
    pub async fn record_change(
        &mut self,
        change_type: ChangeType,
        affected_items: Vec<String>,
    ) -> Result<()> {
        if let Some(detector) = &mut self.change_detector {
            detector.record_change(change_type, affected_items).await?;
        }
        Ok(())
    }

    /// Get the current sequence ID
    pub fn get_current_sequence(&self) -> Option<crate::change_detection::SequenceId> {
        self.change_detector
            .as_ref()
            .map(|d| d.get_current_sequence())
    }

    /// Get changes after the specified sequence
    pub async fn get_changes_since(
        &self,
        since: &crate::change_detection::SequenceId,
    ) -> Result<Vec<crate::change_detection::ChangeEvent>> {
        if let Some(detector) = &self.change_detector {
            detector.get_changes_since(since).await
        } else {
            Ok(vec![])
        }
    }

    // === Interface management methods ===

    /// Add an interface
    pub fn add_interface(&mut self, interface: Interface) -> Result<()> {
        self.interface_registry.add_interface(interface)
    }

    /// Get an interface
    pub fn get_interface(&self, uuid: &uuid::Uuid) -> Option<&Interface> {
        self.interface_registry.get_interface(uuid)
    }

    /// Get a mutable interface reference
    pub fn get_interface_mut(&mut self, uuid: &uuid::Uuid) -> Option<&mut Interface> {
        self.interface_registry.get_interface_mut(uuid)
    }

    // Inspect loaded and persisted dependants before removing any contract file.
    // A lazy project must have the same protections as an opened settings table.
    fn ensure_interface_deletable(&self, id: &uuid::Uuid) -> Result<()> {
        let referenced = |data: &TableData| {
            data.interface_implementations.contains_key(id)
                || data.schema.columns.iter().any(|column| {
                    column.interface_origin.as_deref() == Some(id.to_string().as_str())
                        || column
                            .table_ref_config
                            .as_ref()
                            .is_some_and(|config| config.interface_uuid == id.to_string())
                })
        };
        let blocked = |name: &str| {
            crate::app_error::diagnostic(
                "error.referencedRowDelete",
                serde_json::json!({"table": name, "row": id.to_string(), "column": "interface"}),
            )
        };
        for interface in self.interface_registry.get_all_interfaces() {
            if interface.extends.contains(id) {
                return Err(blocked(&interface.name));
            }
        }
        for entry in self.get_table_catalog()? {
            let live = self.read_table_data_by_uuid(&entry.uuid)?;
            let disk = self.load_table_from_file(&PathBuf::from(&entry.path))?;
            if referenced(&live) || referenced(&disk) {
                return Err(blocked(&live.display_name));
            }
        }
        Ok(())
    }

    /// Remove an interface
    pub fn remove_interface(&mut self, uuid: &uuid::Uuid) -> Result<()> {
        self.ensure_interface_deletable(uuid)?;
        // Get the path from the registry
        let relative_path = self
            .interface_registry
            .get_interface_path(uuid)
            .ok_or_else(|| {
                crate::app_error::diagnostic(
                    "error.interface.missingId",
                    serde_json::json!({"id": uuid}),
                )
            })?
            .to_string();

        // Delete the file
        let file_path = self.resolve_table_path(&PathBuf::from(relative_path))?;
        let baselines = self.interface_disk_baselines.get_mut().map_err(|error| {
            crate::app_error::diagnostic(
                "error.interface.savedState",
                serde_json::json!({"details": error.to_string()}),
            )
        })?;

        if file_path.exists() {
            fs::remove_file(&file_path).map_err(DevcelError::Io)?;
        }

        self.interface_registry.remove_interface(uuid);
        baselines.remove(uuid);
        self.interface_history.remove(uuid);
        self.notify_interface_change(&file_path);
        Ok(())
    }

    /// Get the interface list
    pub fn list_interfaces(&self) -> Vec<&Interface> {
        self.interface_registry.get_all_interfaces()
    }

    /// Absorb a branch without moving HEAD, committing the file before replacing memory.
    pub fn import_interface_history(
        &mut self,
        uuid: &uuid::Uuid,
        source: &Interface,
    ) -> Result<usize> {
        let mut candidate = self
            .get_interface(uuid)
            .cloned()
            .ok_or_else(|| DevcelError::NotFound("Interface not found".into()))?;
        let previous = candidate.clone();
        let count = candidate.absorb_history(source)?;
        if count != 0 {
            self.save_interface_if_unchanged(&candidate, &previous)?;
            *self.get_interface_mut(uuid).unwrap() = candidate;
        }
        Ok(count)
    }

    /// Import a conflict-copy snapshot without deleting its source. A writer may
    /// append history at any point; retaining the file is the only safe cleanup
    /// policy without exclusive ownership of that external file.
    pub fn import_interface_history_file(
        &mut self,
        uuid: &uuid::Uuid,
        source_path: &Path,
    ) -> Result<usize> {
        self.import_interface_history_file_after_read(uuid, source_path, || {})
    }

    fn import_interface_history_file_after_read(
        &mut self,
        uuid: &uuid::Uuid,
        source_path: &Path,
        after_read: impl FnOnce(),
    ) -> Result<usize> {
        let source = Interface::load_from_file(source_path)?;
        after_read();
        self.import_interface_history(uuid, &source)
    }

    /// Save an interface, distinguishing local unsaved edits from disk conflicts.
    pub fn save_interface(&self, interface: &Interface) -> Result<()> {
        self.persist_interface(interface, None)
    }

    /// Compare the complete last-confirmed file state under a cross-process lock.
    /// `expected` is the operation's in-memory before-state, which may legitimately
    /// contain unsaved local edits. A tracked disk baseline takes precedence; the
    /// supplied state is only a conservative fallback for untracked callers.
    pub fn save_interface_if_unchanged(
        &self,
        interface: &Interface,
        expected: &Interface,
    ) -> Result<()> {
        if interface.uuid != expected.uuid {
            return Err(crate::app_error::diagnostic(
                "error.interface.identityImmutable",
                serde_json::json!({"expected": expected.uuid, "actual": interface.uuid}),
            ));
        }
        self.persist_interface(interface, Some(expected))
    }

    fn persist_interface(&self, interface: &Interface, expected: Option<&Interface>) -> Result<()> {
        // save_to_file validates the candidate once, after the disk CAS check.
        for column in &interface.columns {
            crate::cell_rules::validate_column_definition(column)?;
        }
        let relative_path = self
            .interface_registry
            .get_interface_path(&interface.uuid)
            .ok_or_else(|| {
                crate::app_error::diagnostic(
                    "error.interface.missingId",
                    serde_json::json!({"id": interface.uuid}),
                )
            })?;
        let path = self.resolve_table_path(&PathBuf::from(relative_path))?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut baselines = self.interface_disk_baselines.lock().map_err(|error| {
            crate::app_error::diagnostic(
                "error.interface.savedState",
                serde_json::json!({"details": error.to_string()}),
            )
        })?;
        let baseline = baselines.get(&interface.uuid).or(expected);
        Self::write_interface_file_if_unchanged(&path, interface, baseline)?;
        // Advance only after a successful atomic write. A rejected/failed save
        // leaves the previous baseline available for retry and conflict detection.
        baselines.insert(interface.uuid, interface.clone());
        drop(baselines);
        self.notify_interface_change(&path);
        Ok(())
    }

    fn write_interface_file_if_unchanged(
        path: &Path,
        interface: &Interface,
        expected: Option<&Interface>,
    ) -> Result<()> {
        let _lock = crate::write_locks::lock_file(path, false)?;
        if let Some(expected) = expected {
            let disk = Interface::load_from_file(path).map_err(|error| crate::app_error::diagnostic("error.interface.load", serde_json::json!({"path": path.to_string_lossy(), "error": crate::AppError::from(error).into_diagnostic()})))?;
            if serde_json::to_value(&disk)? != serde_json::to_value(expected)? {
                return Err(DevcelError::Validation(
                    "The interface file was updated by another operation. Reload it".into(),
                ));
            }
        } else if path.try_exists()? {
            // No confirmed baseline means creation, never permission to replace
            // an existing file belonging to a different or unloaded interface.
            return Err(crate::app_error::diagnostic(
                "error.alreadyExists",
                serde_json::json!({"details": path.to_string_lossy()}),
            ));
        }
        interface.save_to_file(path)?;
        Ok(())
    }

    /// Preserve local history only when the authoritative interface is unchanged.
    pub(crate) fn replace_replica_interfaces(&mut self, registry: InterfaceRegistry) {
        self.interface_history.retain(|uuid, _| {
            match (
                self.interface_registry.get_interface(uuid),
                registry.get_interface(uuid),
            ) {
                (Some(before), Some(after)) => {
                    serde_json::to_value(before).ok() == serde_json::to_value(after).ok()
                }
                _ => false,
            }
        });
        // Trusted snapshots are published only after the authoritative write.
        // If disk has advanced again, the next CAS still detects that difference.
        self.interface_disk_baselines = Mutex::new(
            registry
                .get_all_interfaces()
                .into_iter()
                .map(|interface| (interface.uuid, interface.clone()))
                .collect(),
        );
        self.interface_registry = registry;
    }

    /// Load an interface. Explicit reloads continue to adopt the disk version.
    pub fn load_interfaces(&mut self) -> Result<()> {
        let (registry, baselines) = self.read_interface_candidates()?;
        self.publish_interface_candidates(registry, baselines);
        Ok(())
    }

    /// Automatic source watching must not discard legitimate unsaved registry
    /// edits. Compare live and disk independently with the last-confirmed state.
    /// An unchanged disk keeps the entire live graph (including pending UUID
    /// additions/removals); concurrent disk edits are an explicit conflict.
    pub fn reload_interfaces_preserving_pending(&mut self) -> Result<()> {
        let (registry, disk) = self.read_interface_candidates()?;
        let baselines = self.interface_disk_baselines.lock().map_err(|error| {
            crate::app_error::diagnostic(
                "error.interface.savedState",
                serde_json::json!({"details": error.to_string()}),
            )
        })?;
        if !Self::interfaces_match_baseline(&self.interface_registry, &baselines)? {
            let disk_unchanged = Self::interfaces_match_baseline(&registry, &baselines)?;
            // A disk move is also a source change. For locally removed UUIDs
            // there is no live destination to replace, so the content baseline
            // remains authoritative until the explicit removal is persisted.
            let paths_unchanged =
                registry
                    .get_all_interfaces_with_paths()
                    .iter()
                    .all(|(path, interface)| {
                        self.interface_registry
                            .get_interface_path(&interface.uuid)
                            .is_none_or(|live_path| live_path == path.as_str())
                    });
            if disk_unchanged && paths_unchanged {
                return Ok(());
            }
            return Err(crate::app_error::diagnostic(
                "error.sourceConflict",
                serde_json::json!({"path": self.path.to_string_lossy()}),
            ));
        }
        drop(baselines);
        self.publish_interface_candidates(registry, disk);
        Ok(())
    }

    fn interfaces_match_baseline(
        registry: &InterfaceRegistry,
        baselines: &HashMap<uuid::Uuid, Interface>,
    ) -> Result<bool> {
        let interfaces = registry.get_all_interfaces();
        if interfaces.len() != baselines.len() {
            return Ok(false);
        }
        for interface in interfaces {
            let Some(baseline) = baselines.get(&interface.uuid) else {
                return Ok(false);
            };
            // Full definitions include versions, columns and extends; checking
            // only a description or version identifier could miss a local edit.
            if serde_json::to_value(interface)? != serde_json::to_value(baseline)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn read_interface_candidates(
        &self,
    ) -> Result<(InterfaceRegistry, HashMap<uuid::Uuid, Interface>)> {
        // Build both candidates before publishing either. Failed reloads keep
        // the complete live registry, history, and last-confirmed CAS baselines.
        let mut registry = crate::interface::InterfaceRegistry::new();
        let mut baselines = HashMap::new();

        let project_dir = self.path.parent().ok_or_else(|| {
            DevcelError::InvalidOperation("Could not get the project directory".to_string())
        })?;
        // Load interface files from the Tables directory too
        let tables_dir = project_dir.join("Tables");

        // Explicit and automatic reload share the same source boundary. Their
        // callers differ only in how unsaved in-memory changes are reconciled.
        let canonical_project = Some(fs::canonicalize(project_dir)?);
        fn source_link(metadata: &fs::Metadata) -> bool {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return true;
                }
            }
            metadata.file_type().is_symlink()
        }
        fn automatic_scan_root(path: &Path, project: &Path) -> Result<Option<PathBuf>> {
            let metadata = match fs::symlink_metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            if source_link(&metadata) || !metadata.is_dir() {
                return Err(crate::app_error::diagnostic(
                    "error.project.regularSource",
                    serde_json::json!({"path": path.display().to_string()}),
                ));
            }
            let canonical = fs::canonicalize(path)?;
            if !canonical.starts_with(project) {
                return Err(crate::app_error::diagnostic(
                    "error.project.outsideSource",
                    serde_json::json!({"path": path.display().to_string()}),
                ));
            }
            Ok(Some(canonical))
        }

        fn find_interface_files(
            dir: &Path,
            interfaces: &mut Vec<PathBuf>,
            scope: Option<&Path>,
            visited: &mut HashSet<PathBuf>,
        ) -> Result<()> {
            if let Some(scope) = scope {
                let metadata = fs::symlink_metadata(dir)?;
                if source_link(&metadata) {
                    return Ok(());
                }
                let canonical = fs::canonicalize(dir)?;
                if !canonical.starts_with(scope) {
                    return Err(crate::app_error::diagnostic(
                        "error.project.outsideSource",
                        serde_json::json!({"path": dir.display().to_string()}),
                    ));
                }
                if !visited.insert(canonical) {
                    return Ok(());
                }
            }
            for entry in fs::read_dir(dir).map_err(DevcelError::Io)? {
                let entry = entry.map_err(DevcelError::Io)?;
                let path = entry.path();
                let kind = entry.file_type()?;
                if scope.is_some() && source_link(&fs::symlink_metadata(&path)?) {
                    continue;
                }
                let directory = if scope.is_some() {
                    kind.is_dir()
                } else {
                    path.is_dir()
                };
                if directory {
                    find_interface_files(&path, interfaces, scope, visited)?;
                } else if path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".interface.toml"))
                {
                    if scope.is_some() && !kind.is_file() {
                        continue;
                    }
                    interfaces.push(path);
                }
            }
            Ok(())
        }

        let unsupported_directory = project_dir.join("interfaces");
        // A link at this unsupported location is unrelated to Tables; never
        // follow it merely to decide whether an unsupported file exists.
        let check_unsupported = fs::symlink_metadata(&unsupported_directory)
            .is_ok_and(|metadata| metadata.is_dir() && !source_link(&metadata));
        if check_unsupported {
            let scope = canonical_project
                .as_ref()
                .map(|root| automatic_scan_root(&unsupported_directory, root))
                .transpose()?
                .flatten();
            let mut unsupported_files = Vec::new();
            find_interface_files(
                &unsupported_directory,
                &mut unsupported_files,
                scope.as_deref(),
                &mut HashSet::new(),
            )?;
            if !unsupported_files.is_empty() {
                return Err(crate::app_error::diagnostic(
                    "error.project.legacyInterfaceLocation",
                    serde_json::json!({}),
                ));
            }
        }

        let scope = canonical_project
            .as_ref()
            .map(|root| automatic_scan_root(&tables_dir, root))
            .transpose()?
            .flatten();
        if scope.is_none() {
            return Ok((registry, baselines));
        }
        let mut interface_files = Vec::new();
        find_interface_files(
            &tables_dir,
            &mut interface_files,
            scope.as_deref(),
            &mut HashSet::new(),
        )?;

        for path in interface_files {
            if let Some(scope) = scope.as_deref() {
                // Recheck after discovery before the parser opens the file.
                let metadata = fs::symlink_metadata(&path)?;
                if source_link(&metadata)
                    || !metadata.is_file()
                    || !fs::canonicalize(&path)?.starts_with(scope)
                {
                    return Err(crate::app_error::diagnostic(
                        "error.project.sourceChanged",
                        serde_json::json!({"path": path.display().to_string()}),
                    ));
                }
            }
            eprintln!("Processing interface file: {:?}", path);
            let interface = Interface::load_from_file(&path).map_err(|error| crate::app_error::diagnostic("error.interface.load", serde_json::json!({"path": path.to_string_lossy(), "error": crate::AppError::from(error).into_diagnostic()})))?;
            let persisted = interface.clone();

            // Compute the path relative to the Tables directory
            let relative_path = path
                .strip_prefix(&tables_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            eprintln!(
                "Add interface {} to the registry (path: {})",
                interface.name, relative_path
            );
            baselines.insert(interface.uuid, persisted);
            registry.add_interface_with_path(relative_path, interface)?;
        }

        Ok((registry, baselines))
    }

    fn publish_interface_candidates(
        &mut self,
        registry: InterfaceRegistry,
        baselines: HashMap<uuid::Uuid, Interface>,
    ) {
        let previous_registry = &self.interface_registry;
        // External replacements must not be overwritten by stale local Undo.
        // An unchanged reload after our own save keeps the session history.
        self.interface_history.retain(|uuid, _| {
            match (
                previous_registry.get_interface(uuid),
                registry.get_interface(uuid),
            ) {
                (Some(before), Some(after)) => {
                    serde_json::to_value(before).ok() == serde_json::to_value(after).ok()
                }
                _ => false,
            }
        });
        self.interface_registry = registry;
        self.interface_disk_baselines = Mutex::new(baselines);
    }

    /// Apply an interface to a table
    pub fn apply_interface_to_table(
        &mut self,
        table_path: &Path,
        interface_uuid: &uuid::Uuid,
        auto_add_columns: bool,
    ) -> Result<()> {
        let path = self.resolve_table_path(table_path)?;
        self.ensure_table_loaded_with_save_queue(&path, None, None)?;
        self.execute_command(
            crate::commands::ApplyInterfaceCommand::new(path, *interface_uuid, auto_add_columns),
            None,
        )
    }

    // === Formula-related methods ===

    /// Set a record value with formula detection
    /// Sets a record value with formula detection
    pub fn set_record_value_with_formula(
        &mut self,
        table_uuid: &str,
        record_uuid: &str,
        column_name: &str,
        value: &str,
    ) -> Result<()> {
        self.set_record_value_with_formula_with_save_queue(
            table_uuid,
            record_uuid,
            column_name,
            value,
            None,
        )
    }

    pub fn set_record_value_with_formula_with_save_queue(
        &mut self,
        table_uuid: &str,
        record_uuid: &str,
        column_name: &str,
        value: &str,
        queue: Option<&Arc<FileBasedSaveQueueManager>>,
    ) -> Result<()> {
        self.ensure_table_loaded_by_uuid(table_uuid)?;
        let column_uuid = self
            .find_table_by_uuid(table_uuid)
            .and_then(|table| {
                table
                    .data
                    .schema
                    .columns
                    .iter()
                    .find(|c| c.uuid == column_name || c.data_name == column_name)
            })
            .map(|column| column.uuid.clone())
            .ok_or_else(|| crate::app_error::authoring_error("Column not found"))?;
        self.execute_command(
            crate::commands::SetRecordValueCommand::new(
                table_uuid.into(),
                record_uuid.into(),
                column_uuid,
                value.into(),
            ),
            queue,
        )
    }

    pub fn move_markdown_file(&mut self, old_path: &str, new_path: &str) -> Result<()> {
        crate::utils::validate_markdown_path(Path::new(old_path))?;
        crate::utils::validate_markdown_path(Path::new(new_path))?;

        let old_full_path = self.resolve_table_path(&PathBuf::from(old_path))?;
        let new_full_path = self.resolve_table_path(&PathBuf::from(new_path))?;

        if let Some(parent) = new_full_path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Move the file
        fs::rename(old_full_path, new_full_path)?;

        Ok(())
    }

    pub fn delete_markdown(&mut self, path: PathBuf) -> Result<()> {
        crate::utils::validate_markdown_path(&path)?;
        let full_path = self.resolve_table_path(&path)?;

        if !full_path.exists() {
            return Err(DevcelError::NotFound("markdown file not found".to_string()));
        }

        // Delete the file
        fs::remove_file(&full_path).map_err(DevcelError::Io)?;

        Ok(())
    }

    pub fn delete_interface(&mut self, path: PathBuf) -> Result<()> {
        crate::utils::validate_interface_path(&path)?;
        let full_path = self.resolve_table_path(&path)?;

        if !full_path.exists() {
            return Err(DevcelError::NotFound(
                "interface file not found".to_string(),
            ));
        }

        let stored: Interface = toml::from_str(&fs::read_to_string(&full_path)?)
            .map_err(|error| DevcelError::Validation(error.to_string()))?;
        self.ensure_interface_deletable(&stored.uuid)?;

        // Convert the path to a string
        let interface_path = path.to_string_lossy().to_string();

        let baselines = self.interface_disk_baselines.get_mut().map_err(|error| {
            crate::app_error::diagnostic(
                "error.interface.savedState",
                serde_json::json!({"details": error.to_string()}),
            )
        })?;

        // Delete the file
        fs::remove_file(&full_path).map_err(DevcelError::Io)?;

        if let Some(interface) = self
            .interface_registry
            .remove_interface_by_path(&interface_path)
        {
            baselines.remove(&interface.uuid);
            self.interface_history.remove(&interface.uuid);
        }
        self.notify_interface_change(&full_path);
        Ok(())
    }

    /// Rename only the interface file, preserving its symbol, UUID, versions,
    /// references and undo/redo history. Publish memory only after disk success.
    pub fn rename_interface_file(&mut self, old_path: &str, new_name: &str) -> Result<PathBuf> {
        crate::utils::validate_interface_path(Path::new(old_path))?;
        let name = crate::utils::renamed_file_name(new_name, ".interface.toml")?;
        let source = self.resolve_table_path(&PathBuf::from(old_path))?;
        let destination = source.with_file_name(name);
        let tables = self.get_tables_dir()?;
        let relative = |path: &Path| -> Result<String> {
            Ok(path
                .strip_prefix(&tables)
                .map_err(|_| {
                    crate::app_error::diagnostic(
                        "error.interface.outsideTables",
                        serde_json::json!({"path": path.to_string_lossy()}),
                    )
                })?
                .to_string_lossy()
                .into_owned())
        };
        // Registry keys are OS-native when loaded from disk. Resolve the existing
        // key instead of changing separators only on the lookup side (Windows).
        let old_relative = self
            .interface_registry
            .get_all_interfaces_with_paths()
            .into_iter()
            .find(|(registered, _)| {
                self.resolve_table_path(&PathBuf::from(registered))
                    .ok()
                    .as_ref()
                    == Some(&source)
            })
            .map(|(registered, _)| registered.clone())
            .ok_or_else(|| DevcelError::NotFound("Interface not found".into()))?;
        let new_relative = relative(&destination)?;
        let interface = self
            .interface_registry
            .get_interface_by_path(&old_relative)
            .ok_or_else(|| DevcelError::NotFound("Interface not found".into()))?;
        if source != destination
            && (self
                .interface_registry
                .get_interface_by_path(&new_relative)
                .is_some()
                || destination.try_exists()?)
        {
            return Err(DevcelError::AlreadyExists(
                destination.display().to_string(),
            ));
        }
        let expected = serde_json::to_value(interface)?;
        // Validate the new registry before the irreversible file operation.
        let mut registry = self.interface_registry.clone();
        if source != destination {
            let interface = registry.remove_interface_by_path(&old_relative).unwrap();
            registry.add_interface_with_path(new_relative, interface)?;
        }
        let mut paths = vec![&source, &destination];
        paths.sort();
        paths.dedup();
        let locks =
            crate::write_locks::lock_files(paths.into_iter().map(|path| path.as_path()), false)?;
        if !fs::symlink_metadata(&source)?.file_type().is_file() {
            return Err(DevcelError::InvalidOperation(
                "Not a regular interface file".into(),
            ));
        }
        let disk = Interface::load_from_file(&source).map_err(|error| crate::app_error::diagnostic("error.interface.load", serde_json::json!({"path": source.to_string_lossy(), "error": crate::AppError::from(error).into_diagnostic()})))?;
        if serde_json::to_value(disk)? != expected {
            return Err(crate::app_error::diagnostic(
                "error.sourceConflict",
                serde_json::json!({"path": source.to_string_lossy()}),
            ));
        }
        if source == destination {
            return Ok(source);
        }
        crate::utils::rename_without_replace(&source, &destination)?;
        self.interface_registry = registry;
        drop(locks);
        self.notify_interface_change(&destination);
        Ok(destination)
    }

    pub fn move_interface_file(&mut self, old_path: &str, new_path: &str) -> Result<()> {
        crate::utils::validate_interface_path(Path::new(old_path))?;
        crate::utils::validate_interface_path(Path::new(new_path))?;
        let old_full_path = self.resolve_table_path(&PathBuf::from(old_path))?;
        let new_full_path = self.resolve_table_path(&PathBuf::from(new_path))?;

        // Ensure the new path's parent directory exists
        if let Some(parent) = new_full_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }

        // Move the file
        fs::rename(old_full_path, &new_full_path)?;
        self.reload_interfaces()?;
        self.notify_interface_change(&new_full_path);

        Ok(())
    }

    /// Get a record value, returning formula strings unchanged
    /// Gets the value for a record (returns formula string as-is for formulas)
    pub fn get_record_value(
        &self,
        table_uuid: &str,
        record_uuid: &str,
        column_name: &str,
    ) -> Result<String> {
        // Find the table
        let table = self
            .tables_data
            .values()
            .find(|t| t.data.uuid == table_uuid)
            .ok_or_else(|| contextual_error("error.tableMissing", table_uuid))?;

        let record = table
            .data
            .records
            .iter()
            .find(|record| record.uuid == record_uuid)
            .ok_or_else(|| contextual_error("error.rowMissing", record_uuid))?;
        let column = table
            .data
            .schema
            .columns
            .iter()
            .find(|column| column.data_name == column_name)
            .ok_or_else(|| contextual_error("error.columnMissing", column_name))?;
        table
            .data
            .effective_cell_input(record, column)
            .map(str::to_owned)
    }

    // === Table lookup methods ===

    /// Find a table by UUID
    /// Find table by UUID
    pub fn find_table_by_uuid(&self, uuid: &str) -> Option<&Table> {
        self.tables_data
            .values()
            .find(|table| table.data.uuid == uuid)
    }

    /// Find a mutable table reference by UUID
    /// Find table by UUID (mutable reference)
    pub fn find_table_by_uuid_mut(&mut self, uuid: &str) -> Option<&mut Table> {
        self.tables_data
            .values_mut()
            .find(|table| table.data.uuid == uuid)
    }

    /// Return an iterator over all tables
    /// Return iterator over all tables
    pub fn iter_tables(&self) -> impl Iterator<Item = &Table> {
        self.tables_data.values()
    }

    /// Return a mutable iterator over all tables
    /// Return iterator over all tables (mutable)
    pub fn iter_tables_mut(&mut self) -> impl Iterator<Item = &mut Table> {
        self.tables_data.values_mut()
    }
}

#[cfg(test)]
mod history_file_tests {
    use super::*;
    use crate::interface::InterfaceChange;
    use std::sync::{Arc, Barrier};
    #[test]
    fn concurrent_conflict_copy_append_survives_snapshot_import() {
        let directory = tempfile::tempdir().unwrap();
        let mut project = Project::create_project(
            "ImportBarrier",
            directory.path().to_str().unwrap(),
            "",
            "#123456",
        )
        .unwrap();
        let base = Interface::new("Stats".into(), None);
        let id = base.uuid;
        project
            .interface_registry
            .add_interface_with_path("Stats.interface.toml".into(), base.clone())
            .unwrap();
        base.save_to_file(
            &project
                .path
                .parent()
                .unwrap()
                .join("Tables/Stats.interface.toml"),
        )
        .unwrap();
        let mut source = base.clone();
        source
            .create_new_version(
                vec![InterfaceChange::ChangeDescription {
                    new_description: Some("first snapshot".into()),
                }],
                None,
                None,
            )
            .unwrap();
        let snapshot_head = source.current_version_id;
        let path = directory.path().join("Stats-conflict.interface.toml");
        source.save_to_file(&path).unwrap();
        let read = Arc::new(Barrier::new(2));
        let written = Arc::new(Barrier::new(2));
        let writer = {
            let read = read.clone();
            let written = written.clone();
            let path = path.clone();
            std::thread::spawn(move || {
                read.wait();
                source
                    .create_new_version(
                        vec![InterfaceChange::ChangeDescription {
                            new_description: Some("concurrent append".into()),
                        }],
                        None,
                        None,
                    )
                    .unwrap();
                source.save_to_file(&path).unwrap();
                let head = source.current_version_id;
                written.wait();
                head
            })
        };
        assert_eq!(
            project
                .import_interface_history_file_after_read(&id, &path, || {
                    read.wait();
                    written.wait();
                })
                .unwrap(),
            1
        );
        let appended = writer.join().unwrap();
        let saved = Interface::load_from_file(&path).unwrap();
        assert_eq!(saved.current_version_id, appended);
        assert!(saved.history.contains_key(&snapshot_head));
        assert!(!project
            .get_interface(&id)
            .unwrap()
            .history
            .contains_key(&appended));
        assert_eq!(
            project.import_interface_history_file(&id, &path).unwrap(),
            1
        );
        assert!(project
            .get_interface(&id)
            .unwrap()
            .history
            .contains_key(&appended));
        assert!(path.is_file());
    }
}
