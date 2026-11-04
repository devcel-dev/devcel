//! Project-scoped formula queries. The identity index contains no schemas or rows.
//! The primary LRU retains four unopened dependencies. A second tier retains up
//! to eight shared parsed snapshots within a 16 MiB conservative payload budget.
//! Every primary miss still rereads the source; recursion never clones a table.
use crate::formula_diagnostics::FormulaDiagnostic;
use crate::formula_engine::{
    collections::{Kind, Value},
    Number,
};
use crate::formula_memory::{SourceBudget, SourceReservation, TypedTableBacking};
use crate::{
    ColumnSchema, FormulaEngine, FormulaError, FormulaResult, Project, Record, TableData,
    TableSchema,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::SystemTime;

/// An engine callback keeps query recursion on the same dependency stack.
pub trait FormulaQueryResolver {
    fn effective_input(
        &self,
        _engine: &mut FormulaEngine<'_>,
        _table_uuid: &str,
        record: &Record,
        column: &ColumnSchema,
    ) -> FormulaValue<String> {
        match record.get_cell_value(column).is_some() {
            true => Ok(record.get_cell_value(column).cloned().unwrap_or_default()),

            false if record.parent_uuid.is_empty() => Ok(column.default_value.clone()),
            _ => Err(FormulaError::InvalidReference(
                "Parent resolution requires a table context".into(),
            )),
        }
    }

    /// Hooks are invoked only for the outermost cell on an engine's dependency stack.
    fn begin_evaluation(&self) -> std::result::Result<(), FormulaError> {
        Ok(())
    }
    fn begin_collection_snapshot(&self, _engine: &mut FormulaEngine<'_>) -> FormulaValue<()> {
        Ok(())
    }
    fn end_evaluation(
        &self,
        _engine: &mut FormulaEngine<'_>,
    ) -> std::result::Result<(), FormulaError> {
        Ok(())
    }
    fn validate_typed_output(
        &self,
        _engine: &mut FormulaEngine<'_>,
        _value: &Value,
        _column: &ColumnSchema,
    ) -> FormulaValue<()> {
        Ok(())
    }

    fn evaluate_table(
        &self,
        _engine: &mut FormulaEngine<'_>,
        _argument: &crate::formula_engine::collections::Value,
    ) -> std::result::Result<crate::formula_engine::collections::Value, FormulaError> {
        Err(FormulaError::InvalidReference(
            "TABLE unavailable in this context".into(),
        ))
    }
    /// Follow one UUID-backed Reference field on the active dependency stack.
    fn evaluate_reference(
        &self,
        _engine: &mut FormulaEngine<'_>,
        _column: &ColumnSchema,
        _value: &str,
        _field: &str,
    ) -> FormulaValue<Value> {
        Err(FormulaError::InvalidReference(
            "Reference traversal is unavailable in this context".into(),
        ))
    }

    fn evaluate_query(
        &self,
        engine: &mut FormulaEngine<'_>,
        name: &str,
        args: &[String],
    ) -> FormulaValue<Value>;
}

type FormulaValue<T> = std::result::Result<T, FormulaError>;

const DEPENDENCY_TABLE_CACHE_CAPACITY: usize = 4;
// This second tier saves parsing only: every primary-LRU miss still reads and
// checks the file, even if its complete source matches a retained snapshot.
const PARSED_SNAPSHOT_CAPACITY: usize = 8;
const PARSED_SNAPSHOT_BYTE_BUDGET: usize = 16 * 1024 * 1024;

struct ParsedSnapshot {
    path: PathBuf,
    source: String,
    source_hash: [u8; 32],
    data: Arc<TableData>,
    retained_bytes: usize,
}

#[derive(Default)]
struct ParsedSnapshots {
    entries: VecDeque<ParsedSnapshot>,
    retained_bytes: usize,
}

// Reserve backing storage even when the entry deque is partly empty. Its
// capacity never exceeds eight because eviction happens before every push.
const PARSED_SNAPSHOT_CONTAINER_BYTES: usize = PARSED_SNAPSHOT_CAPACITY
    * std::mem::size_of::<ParsedSnapshot>()
    + std::mem::size_of::<ParsedSnapshots>()
    + 32;
const PARSED_SNAPSHOT_PAYLOAD_BUDGET: usize =
    PARSED_SNAPSHOT_BYTE_BUDGET - PARSED_SNAPSHOT_CONTAINER_BYTES;

impl ParsedSnapshots {
    fn take(&mut self, path: &Path) -> Option<ParsedSnapshot> {
        let position = self.entries.iter().position(|entry| entry.path == path)?;
        let entry = self.entries.remove(position).unwrap();
        self.retained_bytes -= entry.retained_bytes;
        Some(entry)
    }

    fn insert(
        &mut self,
        path: PathBuf,
        source: String,
        source_hash: [u8; 32],
        data: Arc<TableData>,
    ) {
        let Some(bytes) = retained_table_bytes(&data) else {
            return;
        };
        let bytes = bytes
            .saturating_add(source.capacity())
            .saturating_add(path.capacity())
            .saturating_add(std::mem::size_of::<ParsedSnapshot>())
            .saturating_add(64);
        if bytes > PARSED_SNAPSHOT_PAYLOAD_BUDGET {
            return;
        }
        while self.entries.len() >= PARSED_SNAPSHOT_CAPACITY
            || self.retained_bytes.saturating_add(bytes) > PARSED_SNAPSHOT_PAYLOAD_BUDGET
        {
            let old = self.entries.pop_front().unwrap();
            self.retained_bytes -= old.retained_bytes;
        }
        self.retained_bytes += bytes;
        self.entries.push_back(ParsedSnapshot {
            path,
            source,
            source_hash,
            data,
            retained_bytes: bytes,
        });
    }
}
// A conservative retained-payload weight, not a process-RSS promise. Account
// for capacities (not lengths), map bucket/control slack, and a small per-heap-
// allocation allowance. Complex schema graphs bypass the optional second tier
// rather than using an incomplete size estimate. Primary LRU entries retain
// their existing four-table limit, including tables too large for this budget.
fn retained_table_bytes(data: &TableData) -> Option<usize> {
    retained_table_bytes_for(data, false)
}

/// Conservative structural DTO weight for frontend snapshot admission. No JSON
/// serialization, source strings, rows or schemas are allocated by this walk.
pub fn table_snapshot_retained_bytes(data: &TableData) -> Option<usize> {
    retained_table_bytes_for(data, true)
}

fn retained_table_bytes_for(data: &TableData, include_rules: bool) -> Option<usize> {
    use std::mem::size_of;
    fn allocation(bytes: usize) -> usize {
        if bytes == 0 {
            0
        } else {
            bytes.saturating_add(32)
        }
    }
    fn string(value: &String) -> usize {
        allocation(value.capacity())
    }
    fn optional(value: &Option<String>) -> usize {
        value.as_ref().map_or(0, string)
    }
    fn strings(values: &Vec<String>) -> usize {
        values.iter().fold(
            allocation(values.capacity().saturating_mul(size_of::<String>())),
            |sum, value| sum.saturating_add(string(value)),
        )
    }
    fn map<K, V>(value: &HashMap<K, V>) -> usize {
        // HashMap::capacity excludes empty buckets. Twice that capacity safely
        // overestimates bucket count for the standard 7/8-load hash table; add
        // control bytes per bucket plus a control-group/allocation allowance.
        allocation(
            value
                .capacity()
                .saturating_mul(2)
                .saturating_mul(size_of::<(K, V)>().saturating_add(1)),
        )
    }
    fn cells(value: &HashMap<String, String>) -> usize {
        value.iter().fold(map(value), |sum, (key, value)| {
            sum.saturating_add(string(key))
                .saturating_add(string(value))
        })
    }
    fn style(value: &crate::cell_rules::CellStyle) -> usize {
        optional(&value.background_color).saturating_add(optional(&value.text_color))
    }
    fn formatting(value: &crate::cell_rules::ConditionalFormatting) -> usize {
        use crate::cell_rules::FormatCondition;
        value.rules.iter().fold(
            allocation(
                value
                    .rules
                    .capacity()
                    .saturating_mul(size_of::<crate::cell_rules::FormattingRule>()),
            ),
            |bytes, rule| {
                let condition = match &rule.condition {
                    FormatCondition::All
                    | FormatCondition::Empty
                    | FormatCondition::NotEmpty
                    | FormatCondition::Top { .. }
                    | FormatCondition::Bottom { .. } => 0,
                    FormatCondition::Equals { value }
                    | FormatCondition::NotEquals { value }
                    | FormatCondition::GreaterThan { value }
                    | FormatCondition::GreaterThanOrEqual { value }
                    | FormatCondition::LessThan { value }
                    | FormatCondition::LessThanOrEqual { value }
                    | FormatCondition::Contains { value }
                    | FormatCondition::NotContains { value } => string(value),
                    FormatCondition::Between {
                        min,
                        max,
                        low_color,
                        high_color,
                        out_of_range_color,
                    } => string(min)
                        .saturating_add(string(max))
                        .saturating_add(string(low_color))
                        .saturating_add(string(high_color))
                        .saturating_add(string(out_of_range_color)),
                    FormatCondition::ColorScale {
                        low_color,
                        high_color,
                    } => string(low_color).saturating_add(string(high_color)),
                };
                bytes
                    .saturating_add(string(&rule.id))
                    .saturating_add(style(&rule.style))
                    .saturating_add(condition)
            },
        )
    }
    if !include_rules && !data.interface_implementations.is_empty() {
        return None;
    }
    let metadata = &data.metadata;
    let mut bytes = size_of::<TableData>().saturating_add(2 * size_of::<usize>() + 32);
    for value in [
        &data.description,
        &data.uuid,
        &metadata.parent_uuid,
        &data.display_name,
        &metadata.data_name,
    ] {
        bytes = bytes.saturating_add(string(value));
    }
    bytes = bytes
        .saturating_add(map(&data.interface_implementations))
        .saturating_add(allocation(
            data.metadata
                .interface_order
                .capacity()
                .saturating_mul(size_of::<uuid::Uuid>()),
        ))
        .saturating_add(allocation(
            data.schema
                .columns
                .capacity()
                .saturating_mul(size_of::<ColumnSchema>()),
        ))
        .saturating_add(allocation(
            data.records.capacity().saturating_mul(size_of::<Record>()),
        ));
    for implementation in data.interface_implementations.values() {
        bytes = bytes.saturating_add(optional(&implementation.effective_fingerprint));
    }
    for column in &data.schema.columns {
        // Exhaustive field binding makes adding a schema field require an
        // explicit decision about its heap contribution or cache eligibility.
        let ColumnSchema {
            read_only: _,
            min_version: _,
            uuid,
            display_name,
            data_name,
            tooltip,
            data_type: _,
            tags,
            default_value,
            style,
            memo_text,
            reference_config,
            table_ref_config,
            curve_config: _,
            select_config,
            color_swatches,
            interface_origin,
            interface_origin_name_fallback,
            required: _,
            constraints,
            input_validation,
            conditional_formatting,
            conditional_formatting_override,
        } = column;
        if !include_rules
            && (input_validation.is_some()
                || conditional_formatting.is_some()
                || conditional_formatting_override.is_some())
        {
            return None;
        }
        for value in [
            uuid,
            display_name,
            data_name,
            tooltip,
            default_value,
            memo_text,
            &style.color,
        ] {
            bytes = bytes.saturating_add(string(value));
        }
        bytes = bytes
            .saturating_add(strings(tags))
            .saturating_add(optional(interface_origin))
            .saturating_add(optional(interface_origin_name_fallback));
        if let Some(config) = reference_config {
            bytes = bytes
                .saturating_add(string(&config.target_table_uuid))
                .saturating_add(optional(&config.display_column_uuid));
        }
        if let Some(config) = table_ref_config {
            bytes = bytes.saturating_add(string(&config.interface_uuid));
        }
        if let Some(config) = select_config {
            bytes = bytes.saturating_add(allocation(
                config
                    .options
                    .capacity()
                    .saturating_mul(size_of::<crate::types::SelectOption>()),
            ));
            for option in &config.options {
                bytes = bytes
                    .saturating_add(string(&option.value))
                    .saturating_add(string(&option.label));
            }
        }
        bytes = bytes.saturating_add(allocation(
            color_swatches
                .capacity()
                .saturating_mul(size_of::<crate::ColorSwatch>()),
        ));
        for swatch in color_swatches {
            bytes = bytes
                .saturating_add(string(&swatch.id))
                .saturating_add(string(&swatch.name))
                .saturating_add(string(&swatch.value));
        }
        if let Some(constraints) = constraints {
            bytes = bytes.saturating_add(optional(&constraints.pattern));
        }
        if let Some(settings) = input_validation {
            use crate::cell_rules::InputRule;
            bytes = bytes
                .saturating_add(string(&settings.message))
                .saturating_add(string(&settings.hint))
                .saturating_add(allocation(
                    settings
                        .rules
                        .capacity()
                        .saturating_mul(size_of::<InputRule>()),
                ));
            for rule in &settings.rules {
                bytes = bytes.saturating_add(match rule {
                    InputRule::Required | InputRule::Unique | InputRule::SelectChoices => 0,
                    InputRule::NumberRange { min, max } => {
                        optional(min).saturating_add(optional(max))
                    }
                    InputRule::Pattern { pattern } => string(pattern),
                });
            }
        }
        for settings in [conditional_formatting, conditional_formatting_override]
            .into_iter()
            .flatten()
        {
            bytes = bytes.saturating_add(formatting(settings));
        }
    }
    for row in &data.records {
        let Record {
            uuid,
            parent_uuid,
            label,
            min_version: _,
            tags,
            values,
            interface_values,
            memo_texts,
        } = row;
        bytes = bytes
            .saturating_add(string(uuid))
            .saturating_add(string(parent_uuid))
            .saturating_add(string(label))
            .saturating_add(strings(tags))
            .saturating_add(cells(values))
            .saturating_add(cells(interface_values))
            .saturating_add(cells(memo_texts));
    }
    Some(bytes)
}

// These are deterministic accounting weights, not allocator/RSS upper bounds.
// A 2,238,842-byte / 10k-row fixture reached approximately 63 MiB parse peak:
// the temporary typed-input reservation is 32 * source bytes (about 68.3 MiB).
// Collection-root metadata misses use the same temporary allowance. Scalar
// metadata/queries and engine-less export preparation use bounded source caches.
// Working reservations end after parsing; typed backings own retained guards.
const SOURCE_WORKING_WEIGHT: usize = 32;
const SNAPSHOT_INVENTORY_ENTRY_LIMIT: usize = 100_000;
type TypedSnapshotKey = (usize, String);
type TypedSnapshotCache = VecDeque<(TypedSnapshotKey, Arc<TypedTableBacking>)>;

struct InventoryBudget {
    entries: usize,
    pool: Option<Arc<SourceBudget>>,
    scratch: Vec<SourceReservation>,
    retained: Vec<SourceReservation>,
    retained_weight: usize,
}
impl InventoryBudget {
    fn new(pool: Option<Arc<SourceBudget>>) -> Self {
        Self {
            entries: 0,
            pool,
            scratch: Vec::new(),
            retained: Vec::new(),
            retained_weight: 0,
        }
    }

    fn charge(
        &mut self,
        engine: Option<&mut FormulaEngine<'_>>,
        entries: usize,
        bytes: usize,
        retained: bool,
    ) -> FormulaValue<()> {
        self.entries = self.entries.saturating_add(entries);
        if retained {
            self.retained_weight = self.retained_weight.saturating_add(bytes);
        }
        if self.pool.is_some() && self.entries > SNAPSHOT_INVENTORY_ENTRY_LIMIT {
            return Err(FormulaError::ExecutionLimit(
                "Formula typed inventory entry limit exceeded".into(),
            ));
        }
        if let Some(engine) = engine {
            engine.charge_work(entries.saturating_add(1), 0)?;
        }
        if let Some(pool) = &self.pool {
            if bytes != 0 {
                let reservation = pool.reserve(bytes).map_err(|_| {
                    FormulaError::ExecutionLimit(
                        "Formula typed inventory memory weight exceeded".into(),
                    )
                })?;
                if retained {
                    self.retained.push(reservation);
                } else {
                    self.scratch.push(reservation);
                }
            }
        }
        Ok(())
    }

    fn path(
        &mut self,
        engine: Option<&mut FormulaEngine<'_>>,
        path: &Path,
        entries: usize,
    ) -> FormulaValue<()> {
        // Discovery, normalized/canonical paths and container growth. These
        // scratch reservations are released when the index build finishes.
        self.charge(
            engine,
            entries,
            path.as_os_str().len().saturating_mul(4).saturating_add(512),
            false,
        )
    }

    fn retained_path(
        &mut self,
        engine: Option<&mut FormulaEngine<'_>>,
        path: &Path,
    ) -> FormulaValue<()> {
        self.charge(
            engine,
            0,
            path.as_os_str().len().saturating_mul(2).saturating_add(128),
            true,
        )
    }

    fn metadata(
        &mut self,
        engine: Option<&mut FormulaEngine<'_>>,
        metadata: &IdentityMetadata,
    ) -> FormulaValue<()> {
        self.names(
            engine,
            [&metadata.uuid, &metadata.data_name, &metadata.display_name],
        )
    }

    fn names(
        &mut self,
        engine: Option<&mut FormulaEngine<'_>>,
        names: [&str; 3],
    ) -> FormulaValue<()> {
        let source_bytes = names
            .iter()
            .fold(0usize, |bytes, name| bytes.saturating_add(name.len()));
        let uppercase_bytes = names
            .into_iter()
            .flat_map(|value| value.chars())
            .flat_map(char::to_uppercase)
            .fold(0usize, |bytes, ch| bytes.saturating_add(ch.len_utf8()));
        // Identity/cache strings and normalized search keys; fixed storage
        // includes TableIdentity, map buckets and per-name position vectors.
        self.charge(
            engine,
            0,
            source_bytes
                .saturating_mul(4)
                .saturating_add(uppercase_bytes.saturating_mul(2))
                .saturating_add(1024),
            true,
        )
    }
}

// Keep candidate positions bounded even when a formula key recursively queries
// another table. This is a transient scan buffer, not a value/index cache.
const QUERY_SCAN_CHUNK: usize = 256;

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    modified: SystemTime,
    length: u64,
}
impl FileStamp {
    fn read(path: &Path) -> FormulaValue<Self> {
        let metadata = std::fs::metadata(path).map_err(|e| source_error(path, e))?;
        Ok(Self {
            modified: metadata.modified().map_err(|e| source_error(path, e))?,
            length: metadata.len(),
        })
    }
}

#[derive(Clone, PartialEq, Eq)]
struct SourceFingerprint {
    stamp: FileStamp,
    hash: [u8; 32],
}

/// Retain validity evidence, never schemas, records or parsed source strings.
/// Native callers bind this evidence to their own session/window/root identity.
/// A new observation rereads every persisted source, including loaded tables:
/// watcher delivery and modification timestamps are not proof of unchanged bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct FormulaSnapshotValidity {
    canonical_root: PathBuf,
    inventory_hash: [u8; 32],
    loaded_hash: Option<[u8; 32]>,
    interfaces_hash: Option<[u8; 32]>,
    sources: Vec<(PathBuf, SourceFingerprint)>,
}

impl FormulaSnapshotValidity {
    pub fn same_persisted_sources(&self, other: &Self) -> bool {
        self.canonical_root == other.canonical_root
            && self.inventory_hash == other.inventory_hash
            && self.sources == other.sources
    }

    /// A trusted prior observation allows reconciliation to skip unchanged disk
    /// bytes even when legitimate in-memory edits have advanced a live revision.
    pub fn source_unchanged(&self, current: &Self, path: &Path) -> bool {
        if self.canonical_root != current.canonical_root {
            return false;
        }
        let Ok(path) = absolute_normalized(path) else {
            return false;
        };
        match (
            self.source_fingerprint(&path),
            current.source_fingerprint(&path),
        ) {
            (Some(before), Some(after)) => before == after,
            _ => false,
        }
    }

    fn source_fingerprint(&self, path: &Path) -> Option<&SourceFingerprint> {
        self.sources
            .binary_search_by(|(source, _)| source.as_path().cmp(path))
            .ok()
            .map(|index| &self.sources[index].1)
    }

    pub fn interface_sources_unchanged(&self, current: &Self) -> bool {
        self.canonical_root == current.canonical_root
            && self
                .sources
                .iter()
                .filter(|(path, _)| path.to_string_lossy().ends_with(".interface.toml"))
                .eq(current
                    .sources
                    .iter()
                    .filter(|(path, _)| path.to_string_lossy().ends_with(".interface.toml")))
    }

    /// Conservative retained-payload accounting; this is not an RSS guarantee.
    pub fn retained_bytes(&self) -> usize {
        self.sources.iter().fold(
            std::mem::size_of::<Self>()
                .saturating_add(self.canonical_root.capacity())
                .saturating_add(
                    self.sources
                        .capacity()
                        .saturating_mul(std::mem::size_of::<(PathBuf, SourceFingerprint)>()),
                )
                .saturating_add(64),
            |bytes, (path, _)| bytes.saturating_add(path.capacity()).saturating_add(32),
        )
    }
}

const VALIDITY_INVENTORY_BYTE_BUDGET: usize = 4 * 1024 * 1024;

fn hash_framed(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

struct ValidityHashWriter(Sha256);
impl std::io::Write for ValidityHashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct CachedDependencySource {
    path: PathBuf,
    fingerprint: SourceFingerprint,
    observed_in_root: Cell<bool>,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
struct IdentityMetadata {
    uuid: String,
    data_name: String,
    display_name: String,
}
impl IdentityMetadata {
    fn of(data: &TableData) -> Self {
        Self {
            uuid: data.uuid.clone(),
            data_name: data.metadata.data_name.clone(),
            display_name: data.display_name.clone(),
        }
    }
}

/// This project-owned cache deliberately stores only three identity strings and
/// a file stamp. Every new query context rechecks the inventory and file stamps.
#[derive(Clone)]
pub(crate) struct CachedFormulaMetadata {
    stamp: FileStamp,
    source_hash: [u8; 32],
    metadata: IdentityMetadata,
}

#[derive(Deserialize)]
struct MetadataDocument {
    uuid: String,
    display_name: String,
    metadata: NameMetadata,
}
#[derive(Deserialize)]
struct NameMetadata {
    data_name: String,
}

struct TableIdentity {
    path: PathBuf,
    live_path: Option<PathBuf>,
    metadata: IdentityMetadata,
    stamp: Option<FileStamp>,
    source_hash: Option<[u8; 32]>,
}

#[derive(Default)]
struct IdentityIndex {
    canonical_root: PathBuf,
    _memory: Vec<SourceReservation>,
    retained_weight: usize,
    tables: Vec<TableIdentity>,
    uuids: HashMap<String, usize>,
    data_names: HashMap<String, Vec<usize>>,
    display_names: HashMap<String, Vec<usize>>,
}
impl IdentityIndex {
    fn insert(&mut self, table: TableIdentity) -> FormulaValue<()> {
        let uuid = table.metadata.uuid.to_uppercase();
        if uuid.is_empty() || self.uuids.contains_key(&uuid) {
            return Err(FormulaError::InvalidReference(format!(
                "Empty or duplicate table UUID: {}",
                table.metadata.uuid
            )));
        }
        let index = self.tables.len();
        self.uuids.insert(uuid, index);
        self.data_names
            .entry(table.metadata.data_name.to_uppercase())
            .or_default()
            .push(index);
        self.display_names
            .entry(table.metadata.display_name.to_uppercase())
            .or_default()
            .push(index);
        self.tables.push(table);
        Ok(())
    }

    fn resolve(&self, name: &str, overrides: &[&TableData]) -> FormulaValue<String> {
        let key = name.to_uppercase();
        // A preview's metadata replaces its live counterpart, including names.
        let overridden: HashSet<_> = overrides
            .iter()
            .map(|data| data.uuid.to_uppercase())
            .collect();
        for priority in 0..3 {
            let candidates: Vec<usize> = match priority {
                0 => self.uuids.get(&key).copied().into_iter().collect(),
                1 => self.data_names.get(&key).cloned().unwrap_or_default(),
                _ => self.display_names.get(&key).cloned().unwrap_or_default(),
            };
            let mut found: Option<&str> = None;
            for root in overrides {
                let value = match priority {
                    0 => &root.uuid,
                    1 => &root.metadata.data_name,
                    _ => &root.display_name,
                };
                if value.to_uppercase() == key {
                    if found.is_some() {
                        return Err(FormulaError::InvalidReference(format!(
                            "Ambiguous table reference: {name}"
                        )));
                    }
                    found = Some(&root.uuid);
                }
            }
            for candidate in candidates {
                let uuid = self.tables[candidate].metadata.uuid.as_str();
                if overridden.contains(&uuid.to_uppercase()) {
                    continue;
                }
                if found.is_some() {
                    return Err(FormulaError::InvalidReference(format!(
                        "Ambiguous table reference: {name}"
                    )));
                }
                found = Some(uuid);
            }
            if let Some(uuid) = found {
                return Ok(uuid.to_owned());
            }
        }
        Err(FormulaError::InvalidReference(format!(
            "Table not found in this project: {name}"
        )))
    }
}

/// Borrow live project state without cloning its loaded tables. Construction is
/// lightweight: only the first LOOKUP/COUNTIF/SUMIF discovers the identity index.
/// UI uses `None` (all content versions); exports pass their target version.
pub struct ProjectFormulaContext<'p> {
    inheritance_inputs: RefCell<HashMap<(String, usize), crate::table::InputResolutionCache>>,
    project: &'p Project,
    target_version: Option<u32>,
    overrides: Vec<&'p TableData>,
    disk_baseline_paths: HashSet<PathBuf>,
    index: RefCell<Option<FormulaValue<IdentityIndex>>>,
    dependency: RefCell<VecDeque<Arc<TableData>>>,
    // Typed backings also remain reserved while the primary dependency cache keeps
    // their raw Arc alive. The separate parsed tier has its own 16 MiB bound.
    dependency_backings: RefCell<Vec<Arc<TypedTableBacking>>>,
    dependency_sources: RefCell<HashMap<usize, CachedDependencySource>>,
    observed_sources: RefCell<HashMap<PathBuf, SourceFingerprint>>,
    observed_source_changed: Cell<bool>,
    strict_snapshot: Cell<bool>,
    parsed_snapshots: RefCell<ParsedSnapshots>,
    // Strong copies are needed only for lazy typed rows. Four copies are shared
    // across callbacks; immutable project and preview tables remain borrowed by
    // all ordinary query paths. They never survive an evaluation boundary.
    typed_snapshots: RefCell<TypedSnapshotCache>,
    inventory_pool: RefCell<Option<Arc<SourceBudget>>>,
    snapshot_depth: Cell<usize>,
    cancellation: RefCell<Option<Arc<AtomicBool>>>,
    active_cancellation: RefCell<Option<Arc<AtomicBool>>>,
    last_diagnostic: RefCell<Option<FormulaDiagnostic>>,
}

impl<'p> ProjectFormulaContext<'p> {
    fn inherited_input(
        &self,
        data: &TableData,
        row: &Record,
        column: &ColumnSchema,
    ) -> FormulaValue<String> {
        let key = (data.uuid.clone(), data as *const TableData as usize);
        let mut caches = self.inheritance_inputs.borrow_mut();
        if caches.len() > DEPENDENCY_TABLE_CACHE_CAPACITY && !caches.contains_key(&key) {
            caches.clear();
        }
        caches
            .entry(key)
            .or_default()
            .input(data, row, column)
            .map_err(FormulaError::from)
    }
    pub fn new(project: &'p Project, target_version: Option<u32>) -> crate::Result<Self> {
        Ok(Self {
            inheritance_inputs: RefCell::new(HashMap::new()),
            project,
            target_version,
            overrides: Vec::new(),
            disk_baseline_paths: HashSet::new(),
            index: RefCell::new(None),
            dependency: RefCell::new(VecDeque::new()),
            dependency_backings: RefCell::new(Vec::new()),
            dependency_sources: RefCell::new(HashMap::new()),
            observed_sources: RefCell::new(HashMap::new()),
            observed_source_changed: Cell::new(false),
            strict_snapshot: Cell::new(false),
            parsed_snapshots: RefCell::new(ParsedSnapshots::default()),
            typed_snapshots: RefCell::new(VecDeque::new()),
            inventory_pool: RefCell::new(None),
            snapshot_depth: Cell::new(0),
            cancellation: RefCell::new(None),
            active_cancellation: RefCell::new(None),
            last_diagnostic: RefCell::new(None),
        })
    }

    /// Detailed context for the most recent cell evaluation, if it failed.
    pub fn last_diagnostic(&self) -> Option<FormulaDiagnostic> {
        self.last_diagnostic.borrow().clone()
    }

    /// Format the latest cell error without changing its public error category.
    pub fn format_error(&self, error: &FormulaError) -> String {
        self.last_diagnostic.borrow().as_ref().map_or_else(
            || format!("{error:?}"),
            |diagnostic| diagnostic.format_error(error),
        )
    }

    /// Attach display-only context at UI/export boundaries. Typed evaluation
    /// callers continue to receive the original error category unchanged.
    pub(crate) fn with_diagnostic_display(&self, result: FormulaResult) -> FormulaResult {
        match result {
            FormulaResult::Error(error)
                if !matches!(error, FormulaError::Cancelled)
                    && self.last_diagnostic.borrow().is_some() =>
            {
                FormulaResult::Error(FormulaError::EvaluationContext {
                    context: self.format_error(&error),
                    source: Box::new(error),
                })
            }
            result => result,
        }
    }

    /// Bind cancellation to the caller's one active presentation request.
    pub fn set_cancellation(&self, cancellation: Option<Arc<AtomicBool>>) {
        *self.cancellation.borrow_mut() = cancellation;
    }

    /// Fresh bounded source/loaded-state evidence for authoritative GUI reuse.
    /// Errors make reuse unavailable; they must never be interpreted as equality.
    /// Loaded state is borrowed by this context and cannot change; later
    /// freshness checks only need snapshot_sources, not repeated live hashing.
    pub fn snapshot_validity(&self) -> FormulaValue<FormulaSnapshotValidity> {
        self.snapshot_validity_with_sources(self.snapshot_sources()?)
    }

    /// Fresh persisted inventory/bytes only. A caller holding the same project
    /// guard can recheck sources without rehashing unchanged loaded table data.
    pub fn snapshot_sources(&self) -> FormulaValue<FormulaSnapshotValidity> {
        self.check_cancelled()?;
        let project_root = self
            .project
            .path
            .parent()
            .ok_or_else(|| FormulaError::InvalidReference("Invalid project path".into()))?;
        let project_scope = std::fs::canonicalize(project_root)
            .map_err(|error| source_error(project_root, error))?;
        let tables_root = absolute_normalized(&project_root.join("Tables"))?;
        let mut inventory = Sha256::new();
        let mut paths = Vec::new();
        let mut directories = Vec::new();
        let mut pending = vec![tables_root.clone()];
        let mut entries = 0usize;
        let mut path_weight = 0usize;
        let mut charge = |path: &Path| -> FormulaValue<()> {
            entries = entries.saturating_add(1);
            path_weight = path_weight
                .saturating_add(path.as_os_str().len().saturating_mul(4))
                .saturating_add(256);
            if entries > SNAPSHOT_INVENTORY_ENTRY_LIMIT
                || path_weight > VALIDITY_INVENTORY_BYTE_BUDGET
            {
                Err(FormulaError::ExecutionLimit(
                    "Formula snapshot validity inventory limit exceeded".into(),
                ))
            } else {
                Ok(())
            }
        };
        let canonical_root = match std::fs::symlink_metadata(&tables_root) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                let root = std::fs::canonicalize(&tables_root)
                    .map_err(|error| source_error(&tables_root, error))?;
                if !root.starts_with(&project_scope) {
                    return Err(source_error(
                        &tables_root,
                        "Tables directory escapes this project",
                    ));
                }
                inventory.update([1]);
                root
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                pending.clear();
                inventory.update([0]);
                tables_root.clone()
            }
            Ok(_) => {
                return Err(source_error(
                    &tables_root,
                    "Linked or invalid Tables directory",
                ))
            }
            Err(error) => return Err(source_error(&tables_root, error)),
        };
        while let Some(directory) = pending.pop() {
            self.check_cancelled()?;
            charge(&directory)?;
            let metadata = std::fs::symlink_metadata(&directory)
                .map_err(|error| source_error(&directory, error))?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(source_error(
                    &directory,
                    "Linked or invalid source directory",
                ));
            }
            let canonical = std::fs::canonicalize(&directory)
                .map_err(|error| source_error(&directory, error))?;
            if !canonical.starts_with(&canonical_root) {
                return Err(source_error(
                    &directory,
                    "Source directory escapes this project",
                ));
            }
            directories.push(directory.clone());
            for entry in
                std::fs::read_dir(&directory).map_err(|error| source_error(&directory, error))?
            {
                self.check_cancelled()?;
                let path = entry
                    .map_err(|error| source_error(&directory, error))?
                    .path();
                charge(&path)?;
                let metadata =
                    std::fs::symlink_metadata(&path).map_err(|error| source_error(&path, error))?;
                if metadata.is_dir() && !metadata.file_type().is_symlink() {
                    pending.push(path);
                } else if (path.to_string_lossy().ends_with(".table.toml")
                    || path.to_string_lossy().ends_with(".interface.toml"))
                    && !crate::internal_artifacts::is_internal_save_artifact(&path)
                {
                    if !metadata.is_file() || metadata.file_type().is_symlink() {
                        return Err(source_error(&path, "Linked or invalid formula source"));
                    }
                    ensure_scoped_path(&path, &canonical_root)?;
                    paths.push(path);
                } else if metadata.file_type().is_symlink() {
                    // The watcher cannot safely reconcile linked directories.
                    return Err(source_error(&path, "Linked source inventory entry"));
                }
            }
        }
        directories.sort();
        for directory in directories {
            hash_framed(&mut inventory, directory.as_os_str().as_encoded_bytes());
        }
        paths.sort();
        let mut sources = Vec::with_capacity(paths.len());
        for path in paths {
            self.check_cancelled()?;
            let stamp = FileStamp::read(&path)?;
            let hash = self.hash_source(&path, &stamp, None)?;
            hash_framed(&mut inventory, path.as_os_str().as_encoded_bytes());
            sources.push((path, SourceFingerprint { stamp, hash }));
        }
        let evidence = FormulaSnapshotValidity {
            canonical_root,
            inventory_hash: inventory.finalize().into(),
            loaded_hash: None,
            interfaces_hash: None,
            sources,
        };
        if evidence.retained_bytes() > VALIDITY_INVENTORY_BYTE_BUDGET {
            return Err(FormulaError::ExecutionLimit(
                "Formula retained validity evidence limit exceeded".into(),
            ));
        }
        Ok(evidence)
    }

    /// Complete a just-observed source ledger with live revisions/interfaces.
    /// Keep the same authoritative project guard from source observation through
    /// evaluation and final source confirmation. This adds no persisted reread.
    pub fn snapshot_validity_with_sources(
        &self,
        mut evidence: FormulaSnapshotValidity,
    ) -> FormulaValue<FormulaSnapshotValidity> {
        self.check_cancelled()?;
        let mut loaded = Sha256::new();
        if self.project.tables_data.len() > SNAPSHOT_INVENTORY_ENTRY_LIMIT {
            return Err(FormulaError::ExecutionLimit(
                "Formula loaded validity inventory limit exceeded".into(),
            ));
        }
        let mut live: Vec<_> = self.project.tables_data.iter().collect();
        live.sort_by_key(|(a, _)| *a);
        for (path, table) in live {
            self.check_cancelled()?;
            hash_framed(&mut loaded, path.as_os_str().as_encoded_bytes());
            hash_framed(&mut loaded, table.data.uuid.as_bytes());
            hash_framed(
                &mut loaded,
                crate::cell_rules::revision(&table.data).as_bytes(),
            );
        }
        let mut interfaces = self
            .project
            .interface_registry
            .get_all_interfaces_with_paths();
        if interfaces.len() > SNAPSHOT_INVENTORY_ENTRY_LIMIT {
            return Err(FormulaError::ExecutionLimit(
                "Formula interface validity inventory limit exceeded".into(),
            ));
        }
        interfaces.sort_by_key(|(a, _)| *a);
        let mut interface_hash = Sha256::new();
        for (path, interface) in interfaces {
            self.check_cancelled()?;
            hash_framed(&mut interface_hash, path.as_bytes());
            let mut writer = ValidityHashWriter(Sha256::new());
            serde_json::to_writer(&mut writer, interface)
                .map_err(|error| source_error(&self.project.path, error))?;
            hash_framed(&mut interface_hash, &writer.0.finalize());
        }
        self.check_cancelled()?;
        evidence.loaded_hash = Some(loaded.finalize().into());
        evidence.interfaces_hash = Some(interface_hash.finalize().into());
        Ok(evidence)
    }

    fn check_cancelled(&self) -> FormulaValue<()> {
        if self
            .cancellation
            .borrow()
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
            || self
                .active_cancellation
                .borrow()
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            Err(FormulaError::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Pin project inventory and persisted sources for an entire export. Cell
    /// evaluations nest inside this boundary without replacing its snapshot.
    pub fn begin_snapshot(&self) -> FormulaValue<()> {
        self.check_cancelled()?;
        self.begin_evaluation_snapshot();
        if let Err(error) = self
            .activate_collection_snapshot(None)
            .and_then(|()| self.ensure_index(None))
        {
            self.snapshot_depth.set(self.snapshot_depth.get() - 1);
            if self.snapshot_depth.get() == 0 {
                self.clear_snapshot_sources();
                self.observed_sources.borrow_mut().clear();
                self.observed_source_changed.set(false);
                self.strict_snapshot.set(false);
                *self.active_cancellation.borrow_mut() = None;
            }
            return Err(error);
        }
        Ok(())
    }

    /// Reject a successful result when its source inventory or bytes changed.
    /// The borrowed live project, overrides, schema and target version cannot
    /// mutate while this context exists. Disk sources need explicit checking.
    pub fn finish_snapshot(&self) -> FormulaValue<()> {
        self.finish_snapshot_with_engine(None)
    }

    fn finish_snapshot_with_engine(
        &self,
        engine: Option<&mut FormulaEngine<'_>>,
    ) -> FormulaValue<()> {
        let depth = self.snapshot_depth.get();
        if depth == 0 {
            return Err(FormulaError::DataChanged(
                "Formula snapshot is not active".into(),
            ));
        }
        self.snapshot_depth.set(depth - 1);
        if depth != 1 {
            return Ok(());
        }
        let result = if self.strict_snapshot.get() {
            self.validate_snapshot(engine)
        } else {
            Ok(())
        };
        if self.strict_snapshot.replace(false) {
            self.clear_snapshot_sources();
        }
        self.observed_sources.borrow_mut().clear();
        self.observed_source_changed.set(false);
        *self.active_cancellation.borrow_mut() = None;
        result
    }

    fn clear_snapshot_sources(&self) {
        self.dependency.borrow_mut().clear();
        self.dependency_sources.borrow_mut().clear();
        self.dependency_backings.borrow_mut().clear();
        self.typed_snapshots.borrow_mut().clear();
        *self.index.borrow_mut() = None;
        *self.inventory_pool.borrow_mut() = None;
    }

    fn begin_evaluation_snapshot(&self) {
        if self.snapshot_depth.get() == 0 {
            self.inheritance_inputs.borrow_mut().clear();
            // Scalar-only roots retain the established small caches. Upgrade
            // lazily if any selected dependency reaches collection evaluation.
            self.observed_sources.borrow_mut().clear();
            self.observed_source_changed.set(false);
            self.strict_snapshot.set(false);
            // At most the four primary entries. Reusing an immutable backing
            // within this root cannot introduce a new source fingerprint.
            for source in self.dependency_sources.borrow().values() {
                source.observed_in_root.set(false);
            }
        }
        self.snapshot_depth.set(self.snapshot_depth.get() + 1);
    }

    fn activate_collection_snapshot(
        &self,
        engine: Option<&mut FormulaEngine<'_>>,
    ) -> FormulaValue<()> {
        if self.strict_snapshot.replace(true) {
            return Ok(());
        }
        let previous_root = if self.observed_sources.borrow().is_empty() {
            None
        } else {
            self.index
                .borrow()
                .as_ref()
                .and_then(|index| index.as_ref().ok())
                .map(|index| index.canonical_root.clone())
        };
        self.clear_snapshot_sources();
        if self.observed_source_changed.get() {
            return Err(FormulaError::DataChanged(
                "Formula sources changed before collection evaluation".into(),
            ));
        }
        if self.observed_sources.borrow().is_empty() {
            return Ok(());
        }
        // A dependency can materialize collections after a scalar prefix
        // has already consumed cached rows. Match those exact earlier bytes to
        // the new strict snapshot instead of silently combining revisions.
        self.ensure_index(engine)?;
        let index = self.index.borrow();
        let index = index.as_ref().unwrap().as_ref().map_err(Clone::clone)?;
        if previous_root.is_some_and(|root| root != index.canonical_root) {
            return Err(FormulaError::DataChanged(
                "Formula project source scope changed before collection evaluation".into(),
            ));
        }
        for (path, observed) in self.observed_sources.borrow().iter() {
            let stable = index.tables.iter().any(|table| {
                table.path == *path
                    && table.stamp.as_ref() == Some(&observed.stamp)
                    && table.source_hash == Some(observed.hash)
            });
            if !stable {
                return Err(source_changed(path));
            }
        }
        // Keep the small ledger until root end so its shared-memory charge
        // corresponds to a live allocation throughout this evaluation.
        Ok(())
    }

    fn observe_dependency(
        &self,
        engine: &mut FormulaEngine<'_>,
        data: &Arc<TableData>,
    ) -> FormulaValue<()> {
        if self.strict_snapshot.get() {
            return Ok(());
        }
        let sources = self.dependency_sources.borrow();
        let Some(source) = sources.get(&(Arc::as_ptr(data) as usize)) else {
            return Ok(());
        };
        if source.observed_in_root.get() {
            return Ok(());
        }
        let mut observed = self.observed_sources.borrow_mut();
        if let Some(previous) = observed.get(&source.path) {
            if previous != &source.fingerprint {
                self.observed_source_changed.set(true);
            }
        } else {
            // Each unique source is retained once; repeated reads reuse the
            // existing entry without cloning its path or consuming more bytes.
            engine.charge_work(
                0,
                source
                    .path
                    .as_os_str()
                    .len()
                    .saturating_mul(2)
                    .saturating_add(256),
            )?;
            observed.insert(source.path.clone(), source.fingerprint.clone());
        }
        source.observed_in_root.set(true);
        Ok(())
    }

    fn validate_snapshot(&self, engine: Option<&mut FormulaEngine<'_>>) -> FormulaValue<()> {
        self.check_cancelled()?;
        let baseline = self.index.borrow();
        let Some(Ok(baseline)) = baseline.as_ref() else {
            return Ok(());
        };
        let current = self.build_index(engine).map_err(|error| match error {
            FormulaError::Cancelled | FormulaError::ExecutionLimit(_) => error,
            _ => FormulaError::DataChanged(format!(
                "Formula project sources changed during evaluation: {error:?}"
            )),
        })?;
        let stable = baseline.canonical_root == current.canonical_root
            && baseline.tables.len() == current.tables.len()
            && baseline.tables.iter().zip(&current.tables).all(|(a, b)| {
                a.path == b.path
                    && a.live_path == b.live_path
                    && a.metadata == b.metadata
                    && a.stamp == b.stamp
                    && a.source_hash == b.source_hash
            });
        if stable {
            Ok(())
        } else {
            Err(FormulaError::DataChanged(
                "Formula project sources changed during evaluation".into(),
            ))
        }
    }

    /// Borrow pending transaction tables, including newly created identities.
    pub fn new_with_overrides(
        project: &'p Project,
        target_version: Option<u32>,
        overrides: &[&'p TableData],
    ) -> crate::Result<Self> {
        let mut context = Self::new(project, target_version)?;
        let mut ids = HashSet::new();
        for data in overrides {
            if !ids.insert(data.uuid.to_uppercase()) {
                return Err(crate::DevcelError::Validation(
                    "Duplicate formula override table UUID".into(),
                ));
            }
        }
        context.overrides = overrides.to_vec();
        Ok(context)
    }

    /// Compare a multi-table save against its persisted baseline, without
    /// keeping every old table in memory. The per-cell root override still wins.
    pub fn new_with_disk_baseline(
        project: &'p Project,
        target_version: Option<u32>,
        paths: &[PathBuf],
    ) -> crate::Result<Self> {
        let mut context = Self::new(project, target_version)?;
        context.disk_baseline_paths = paths
            .iter()
            .map(|path| absolute_normalized(path))
            .collect::<FormulaValue<_>>()
            .map_err(|error| crate::DevcelError::Validation(format!("{error:?}")))?;
        Ok(context)
    }

    /// Project-aware presentation for native GUI callers outside this crate.
    pub fn presentation(&self, data: &TableData) -> crate::cell_rules::TablePresentation {
        match self.presentation_cancellable(data) {
            Ok(result) => result,
            // Keep this established presentation API. A batch source conflict
            // marks every formula as failed instead of returning mixed values.
            Err(error) => {
                crate::cell_rules::presentation_with_evaluator(data, &mut |_, _, _, _| {
                    FormulaResult::Error(error.clone())
                })
            }
        }
    }

    /// A cancelled presentation has no usable partial rows or cell values.
    pub fn presentation_cancellable(
        &self,
        data: &TableData,
    ) -> FormulaValue<crate::cell_rules::TablePresentation> {
        self.check_cancelled()?;
        self.begin_evaluation_snapshot();
        if let Err(error) = self.activate_collection_snapshot(None) {
            let _ = self.finish_snapshot();
            return Err(error);
        }
        let cancellation = self.cancellation.borrow().clone();
        let result = crate::cell_rules::presentation_with_evaluator_cancellable(
            data,
            &mut |data, column, record, formula| {
                let result = self.evaluate_cell_with_override(data, column, record, formula);
                self.with_diagnostic_display(result)
            },
            cancellation.as_deref(),
        );
        let finish = self.finish_snapshot();
        match (result, finish) {
            (_, Err(error)) | (Err(error), _) => Err(error),
            (Ok(result), Ok(())) => Ok(result),
        }
    }

    pub fn evaluate_cell(
        &self,
        formula: &str,
        column: &ColumnSchema,
        record: &Record,
        schema: &TableSchema,
        table_uuid: &str,
    ) -> FormulaResult {
        let mut engine = FormulaEngine::with_context(self, table_uuid);
        engine.set_cancellation(self.cancellation.borrow().clone());
        let result = engine.evaluate_column(formula, column, record, schema);
        *self.last_diagnostic.borrow_mut() = engine.take_diagnostic();
        result
    }

    /// A transition/preview root is borrowed for this evaluation only. Querying
    /// that same table uses its candidate rows, not the project's older live copy.
    pub fn evaluate_cell_with_override(
        &self,
        data: &TableData,
        column: &ColumnSchema,
        record: &Record,
        formula: &str,
    ) -> FormulaResult {
        let view = FormulaView {
            context: self,
            root: data,
        };
        let mut engine = FormulaEngine::with_context(&view, &data.uuid);
        engine.set_cancellation(self.cancellation.borrow().clone());
        let result = engine.evaluate_column(formula, column, record, &data.schema);
        *self.last_diagnostic.borrow_mut() = engine.take_diagnostic();
        result
    }

    fn ensure_index(&self, mut engine: Option<&mut FormulaEngine<'_>>) -> FormulaValue<()> {
        if let Some(engine) = engine.as_ref() {
            *self.active_cancellation.borrow_mut() = engine.cancellation_token();
        }
        if self.index.borrow().is_none() {
            *self.index.borrow_mut() = Some(self.build_index(engine.as_deref_mut()));
        }
        if let Some(engine) = engine.filter(|engine| engine.requires_collection_budget()) {
            self.adopt_index_budget(engine)?;
        }
        match self.index.borrow().as_ref().unwrap() {
            Ok(_) => Ok(()),
            Err(error) => Err(error.clone()),
        }
    }

    fn adopt_index_budget(&self, engine: &mut FormulaEngine<'_>) -> FormulaValue<()> {
        let mut index = self.index.borrow_mut();
        let Some(Ok(index)) = index.as_mut() else {
            return Ok(());
        };
        let previous = self.inventory_pool.borrow().clone();
        let limit = engine.limits().allocated_bytes;
        if previous.as_ref().is_some_and(|pool| {
            pool.limit() == limit
                && index
                    ._memory
                    .first()
                    .is_some_and(|memory| memory.uses_budget(pool))
        }) {
            return Ok(());
        }
        engine.charge_work(1, 0)?;
        let pool = previous
            .filter(|pool| pool.limit() == limit)
            .unwrap_or_else(|| Arc::new(SourceBudget::new(limit)));
        // A prebuilt/export index has no live discovery scratch. Adopt only
        // its still-retained identities, names, paths and normalized keys.
        let memory = pool.reserve(index.retained_weight).map_err(|_| {
            FormulaError::ExecutionLimit("Formula retained inventory memory weight exceeded".into())
        })?;
        index._memory = vec![memory];
        *self.inventory_pool.borrow_mut() = Some(pool);
        Ok(())
    }

    fn build_index(
        &self,
        mut engine: Option<&mut FormulaEngine<'_>>,
    ) -> FormulaValue<IdentityIndex> {
        let project_root = self
            .project
            .path
            .parent()
            .ok_or_else(|| FormulaError::InvalidReference("Invalid project path".into()))?;
        let tables_root = absolute_normalized(&project_root.join("Tables"))?;
        let canonical_root = if tables_root.exists() {
            std::fs::canonicalize(&tables_root).map_err(|e| source_error(&tables_root, e))?
        } else {
            tables_root.clone()
        };
        let canonical_project_root =
            std::fs::canonicalize(project_root).map_err(|e| source_error(project_root, e))?;
        if !canonical_root.starts_with(&canonical_project_root) {
            return Err(source_error(
                &tables_root,
                "Tables directory escapes this project",
            ));
        }
        let pool = if let Some(engine) = engine
            .as_ref()
            .filter(|engine| engine.requires_collection_budget())
        {
            let mut pool = self.inventory_pool.borrow_mut();
            Some(Arc::clone(pool.get_or_insert_with(|| {
                Arc::new(SourceBudget::new(engine.limits().allocated_bytes))
            })))
        } else {
            None
        };
        let mut inventory = InventoryBudget::new(pool);
        inventory.path(engine.as_deref_mut(), &tables_root, 1)?;
        let mut paths = HashSet::new();
        let mut visited = HashSet::new();
        let mut pending = vec![tables_root.clone()];
        while let Some(directory) = pending.pop() {
            self.check_cancelled()?;
            if !directory.exists() {
                continue;
            }
            let canonical =
                std::fs::canonicalize(&directory).map_err(|e| source_error(&directory, e))?;
            if !canonical.starts_with(&canonical_root) {
                return Err(source_error(
                    &directory,
                    "Table directory escapes this project",
                ));
            }
            if visited.contains(&canonical) {
                continue;
            }
            inventory.path(engine.as_deref_mut(), &canonical, 0)?;
            visited.insert(canonical);
            for entry in std::fs::read_dir(&directory).map_err(|e| source_error(&directory, e))? {
                self.check_cancelled()?;
                let path = entry.map_err(|e| source_error(&directory, e))?.path();
                inventory.charge(engine.as_deref_mut(), 1, 0, false)?;
                if path.is_dir() {
                    inventory.path(engine.as_deref_mut(), &path, 0)?;
                    pending.push(path);
                } else if path.to_string_lossy().ends_with(".table.toml")
                    && !crate::internal_artifacts::is_internal_save_artifact(&path)
                {
                    let canonical =
                        std::fs::canonicalize(&path).map_err(|e| source_error(&path, e))?;
                    if !canonical.starts_with(&canonical_root) {
                        return Err(source_error(&path, "Table source escapes this project"));
                    }
                    inventory.path(engine.as_deref_mut(), &path, 0)?;
                    paths.insert(absolute_normalized(&path)?);
                }
            }
        }
        let mut live = HashMap::new();
        for (original_path, table) in &self.project.tables_data {
            self.check_cancelled()?;
            inventory.charge(engine.as_deref_mut(), 1, 0, false)?;
            let path = absolute_normalized(original_path)?;
            if self.disk_baseline_paths.contains(&path) {
                continue;
            }
            if !path.starts_with(&tables_root) {
                // Files opened from another project cannot become query targets.
                continue;
            }
            ensure_scoped_path(&path, &canonical_root)?;
            inventory.path(engine.as_deref_mut(), &path, 0)?;
            paths.insert(path.clone());
            live.insert(path, (original_path, &table.data));
        }
        // Charge all duplicate path storage before allocating the sorted list.
        for path in &paths {
            inventory.path(engine.as_deref_mut(), path, 0)?;
        }
        self.project
            .formula_metadata_cache
            .lock()
            .map_err(|_| source_error(&tables_root, "Formula metadata cache lock failed"))?
            .retain(|path, _| paths.contains(path));
        let mut sorted: Vec<_> = paths.iter().cloned().collect();
        sorted.sort();
        inventory.retained_path(engine.as_deref_mut(), &canonical_root)?;
        let mut index = IdentityIndex {
            canonical_root,
            ..IdentityIndex::default()
        };
        for path in sorted {
            self.check_cancelled()?;
            inventory.retained_path(engine.as_deref_mut(), &path)?;
            if let Some((original_path, data)) = live.get(&path) {
                // Compute the weight from borrowed names before cloning them.
                inventory.names(
                    engine.as_deref_mut(),
                    [&data.uuid, &data.metadata.data_name, &data.display_name],
                )?;
                let metadata = IdentityMetadata::of(data);
                index.insert(TableIdentity {
                    path,
                    live_path: Some((*original_path).clone()),
                    metadata,
                    stamp: None,
                    source_hash: None,
                })?;
                continue;
            }
            let stamp = FileStamp::read(&path)?;
            // A same-size save may restore the timestamp. A hash of freshly
            // read bytes protects both name resolution and parsed-cache reuse.
            let source_hash = if self.strict_snapshot.get() {
                Some(self.hash_source(&path, &stamp, engine.as_deref_mut())?)
            } else {
                None
            };
            if FileStamp::read(&path)? != stamp {
                return Err(source_changed(&path));
            }
            let cached = {
                let cache = self
                    .project
                    .formula_metadata_cache
                    .lock()
                    .map_err(|_| source_error(&path, "Formula metadata cache lock failed"))?;
                if let Some(cached) = cache.get(&path).filter(|cached| {
                    cached.stamp == stamp
                        && source_hash.is_none_or(|hash| cached.source_hash == hash)
                }) {
                    inventory.metadata(engine.as_deref_mut(), &cached.metadata)?;
                    Some(cached.clone())
                } else {
                    None
                }
            };
            let metadata = if let Some(cached) = cached {
                cached.metadata
            } else {
                // The metadata parser still scans the complete TOML. Protect
                // its temporary peak for typed roots before allocating input;
                // scalar queries and export setup use their bounded source caches.
                let _working = if let Some(engine) = engine
                    .as_deref_mut()
                    .filter(|engine| engine.requires_collection_budget())
                {
                    Some(
                        engine.reserve_source_memory(
                            usize::try_from(stamp.length)
                                .unwrap_or(usize::MAX)
                                .saturating_mul(SOURCE_WORKING_WEIGHT),
                        )?,
                    )
                } else {
                    None
                };
                let source = self.read_source(&path, &stamp, engine.as_deref_mut())?;
                let actual_hash: [u8; 32] = Sha256::digest(source.as_bytes()).into();
                if source_hash.is_some_and(|hash| hash != actual_hash) {
                    return Err(source_changed(&path));
                }
                let document: MetadataDocument =
                    toml::from_str(&source).map_err(|e| source_error(&path, e))?;
                if FileStamp::read(&path)? != stamp {
                    return Err(source_changed(&path));
                }
                let identity = IdentityMetadata {
                    uuid: document.uuid,
                    display_name: document.display_name,
                    data_name: document.metadata.data_name,
                };
                inventory.metadata(engine.as_deref_mut(), &identity)?;
                self.project
                    .formula_metadata_cache
                    .lock()
                    .map_err(|_| source_error(&path, "Formula metadata cache lock failed"))?
                    .insert(
                        path.clone(),
                        CachedFormulaMetadata {
                            stamp: stamp.clone(),
                            source_hash: actual_hash,
                            metadata: identity.clone(),
                        },
                    );
                identity
            };
            index.insert(TableIdentity {
                path,
                live_path: None,
                metadata,
                stamp: Some(stamp),
                source_hash,
            })?;
        }
        self.project
            .formula_metadata_cache
            .lock()
            .map_err(|_| source_error(&tables_root, "Formula metadata cache lock failed"))?
            .retain(|path, _| paths.contains(path));
        index.retained_weight = inventory.retained_weight;
        index._memory = std::mem::take(&mut inventory.retained);
        Ok(index)
    }

    /// Hashing cached metadata never requires retaining a full table source.
    /// Every read checks cancellation and growth, including cache hits with
    /// deliberately restored timestamps.
    fn hash_source(
        &self,
        path: &Path,
        stamp: &FileStamp,
        mut engine: Option<&mut FormulaEngine<'_>>,
    ) -> FormulaValue<[u8; 32]> {
        let mut source = std::fs::File::open(path).map_err(|error| source_error(path, error))?;
        let mut buffer = [0u8; 64 * 1024];
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        loop {
            self.check_cancelled()?;
            if let Some(engine) = engine.as_deref_mut() {
                engine.charge_work(1, 0)?;
            }
            let read = source
                .read(&mut buffer)
                .map_err(|error| source_error(path, error))?;
            if read == 0 {
                break;
            }
            total = total.saturating_add(read as u64);
            if total > stamp.length {
                return Err(source_changed(path));
            }
            hasher.update(&buffer[..read]);
        }
        if total != stamp.length || FileStamp::read(path)? != *stamp {
            return Err(source_changed(path));
        }
        Ok(hasher.finalize().into())
    }

    fn read_source(
        &self,
        path: &Path,
        stamp: &FileStamp,
        mut engine: Option<&mut FormulaEngine<'_>>,
    ) -> FormulaValue<String> {
        let length = usize::try_from(stamp.length).map_err(|_| {
            FormulaError::ExecutionLimit("Formula table source is too large".into())
        })?;
        let mut source = std::fs::File::open(path).map_err(|error| source_error(path, error))?;
        let mut output = Vec::new();
        output
            .try_reserve_exact(length)
            .map_err(|_| FormulaError::ExecutionLimit("Formula source allocation failed".into()))?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            self.check_cancelled()?;
            if let Some(engine) = engine.as_deref_mut() {
                engine.charge_work(1, 0)?;
            }
            let read = source
                .read(&mut buffer)
                .map_err(|error| source_error(path, error))?;
            if read == 0 {
                break;
            }
            if output.len().saturating_add(read) > length {
                return Err(source_changed(path));
            }
            output.extend_from_slice(&buffer[..read]);
        }
        if output.len() != length || FileStamp::read(path)? != *stamp {
            return Err(source_changed(path));
        }
        String::from_utf8(output).map_err(|error| source_error(path, error))
    }

    fn resolve_table(
        &self,
        engine: &mut FormulaEngine<'_>,
        name: &str,
        root: Option<&TableData>,
    ) -> FormulaValue<String> {
        self.ensure_index(Some(engine))?;
        let mut overrides = Vec::with_capacity(self.overrides.len() + usize::from(root.is_some()));
        if let Some(root) = root {
            overrides.push(root);
        }
        overrides.extend(
            self.overrides
                .iter()
                .copied()
                .filter(|data| root.is_none_or(|root| !root.uuid.eq_ignore_ascii_case(&data.uuid))),
        );
        self.index
            .borrow()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()
            .resolve(name, &overrides)
    }

    fn with_table<T>(
        &self,
        engine: &mut FormulaEngine<'_>,
        uuid: &str,
        root: Option<&TableData>,
        read: impl FnOnce(&TableData, &mut FormulaEngine<'_>) -> FormulaValue<T>,
    ) -> FormulaValue<T> {
        self.with_table_mode(engine, uuid, root, false, read)
    }

    fn with_typed_table<T>(
        &self,
        engine: &mut FormulaEngine<'_>,
        uuid: &str,
        root: Option<&TableData>,
        read: impl FnOnce(&TableData, &mut FormulaEngine<'_>) -> FormulaValue<T>,
    ) -> FormulaValue<T> {
        self.with_table_mode(engine, uuid, root, true, read)
    }

    fn with_table_mode<T>(
        &self,
        engine: &mut FormulaEngine<'_>,
        uuid: &str,
        root: Option<&TableData>,
        typed_input: bool,
        read: impl FnOnce(&TableData, &mut FormulaEngine<'_>) -> FormulaValue<T>,
    ) -> FormulaValue<T> {
        *self.active_cancellation.borrow_mut() = engine.cancellation_token();
        engine.charge_work(1, 0)?;
        self.check_cancelled()?;
        if let Some(data) = root.filter(|data| data.uuid.eq_ignore_ascii_case(uuid)) {
            return read(data, engine);
        }
        if let Some(data) = self
            .overrides
            .iter()
            .find(|data| data.uuid.eq_ignore_ascii_case(uuid))
        {
            return read(data, engine);
        }
        self.ensure_index(Some(engine))?;
        let (path, live_path, stamp, source_hash) = {
            let index = self.index.borrow();
            let index = index.as_ref().unwrap().as_ref().unwrap();
            let position = index.uuids.get(&uuid.to_uppercase()).ok_or_else(|| {
                FormulaError::InvalidReference(format!("Unknown dependency table: {uuid}"))
            })?;
            let table = &index.tables[*position];
            (
                table.path.clone(),
                table.live_path.clone(),
                table.stamp.clone(),
                table.source_hash,
            )
        };
        // Resolve through the indexed project path, never a UUID-only search:
        // an independently opened foreign table may happen to reuse this UUID.
        if let Some(path) = live_path {
            let table = self
                .project
                .tables_data
                .get(&path)
                .ok_or_else(|| source_error(&path, "Live dependency disappeared"))?;
            return read(&table.data, engine);
        }
        if self.strict_snapshot.get() {
            let current = FileStamp::read(&path).map_err(|_| source_changed(&path))?;
            if stamp.as_ref().is_some_and(|stamp| *stamp != current) {
                return Err(source_changed(&path));
            }
        }
        let cached = {
            let mut dependency = self.dependency.borrow_mut();
            dependency
                .iter()
                .position(|data| data.uuid.eq_ignore_ascii_case(uuid))
                .and_then(|position| dependency.remove(position))
        };
        let data = if let Some(data) = cached {
            data
        } else {
            if self.dependency.borrow().len() == DEPENDENCY_TABLE_CACHE_CAPACITY {
                if let Some(evicted) = self.dependency.borrow_mut().pop_front() {
                    self.dependency_sources
                        .borrow_mut()
                        .remove(&(Arc::as_ptr(&evicted) as usize));
                }
                self.prune_dependency_backings();
            }
            let before = FileStamp::read(&path)?;
            if self.strict_snapshot.get() && stamp.as_ref().is_some_and(|stamp| *stamp != before) {
                return Err(source_changed(&path));
            }
            // A long-lived scalar context rereads updated sources on a primary
            // miss. Revalidate containment before that read: a replaced symlink
            // must never turn an indexed project path into a foreign source.
            {
                let index = self.index.borrow();
                let index = index.as_ref().unwrap().as_ref().map_err(Clone::clone)?;
                ensure_scoped_path(&path, &index.canonical_root)?;
            }
            // Materialized row inputs reserve their parser working memory.
            // Scalar queries use the bounded dependency and parsed-snapshot
            // caches. Drop returns this temporary reservation on every
            // error/cancel and after successful transfer to the bounded caches.
            let _working = if typed_input {
                let bytes = usize::try_from(before.length)
                    .unwrap_or(usize::MAX)
                    .saturating_mul(SOURCE_WORKING_WEIGHT);
                Some(engine.reserve_source_memory(bytes)?)
            } else {
                None
            };
            let source = self.read_source(&path, &before, Some(engine))?;
            let cached = self.parsed_snapshots.borrow_mut().take(&path);
            let exact_match = cached
                .as_ref()
                .is_some_and(|cached| cached.source == source);
            // Only freshly read exact bytes authorize cache reuse. Matching
            // snapshots already carry the digest of these immutable bytes.
            let actual_hash = if exact_match {
                cached.as_ref().unwrap().source_hash
            } else {
                <[u8; 32]>::from(Sha256::digest(source.as_bytes()))
            };
            if source_hash.is_some_and(|hash| hash != actual_hash) {
                return Err(source_changed(&path));
            }
            let data = if exact_match {
                cached.unwrap().data
            } else {
                Arc::new(
                    TableData::from_toml(&source)
                        .map_err(|error| structured_source_error(&path, error))?,
                )
            };
            if FileStamp::read(&path)? != before || !data.uuid.eq_ignore_ascii_case(uuid) {
                return Err(source_changed(&path));
            }
            crate::Interface::validate_table_column_ids(&data, &self.project.interface_registry)
                .map_err(|error| structured_source_error(&path, error))?;
            self.dependency_sources.borrow_mut().insert(
                Arc::as_ptr(&data) as usize,
                CachedDependencySource {
                    path: path.clone(),
                    observed_in_root: Cell::new(false),
                    fingerprint: SourceFingerprint {
                        stamp: before,
                        hash: actual_hash,
                    },
                },
            );
            self.parsed_snapshots
                .borrow_mut()
                .insert(path, source, actual_hash, Arc::clone(&data));
            data
        };
        self.dependency.borrow_mut().push_back(Arc::clone(&data));
        self.observe_dependency(engine, &data)?;
        read(&data, engine)
    }

    fn prune_dependency_backings(&self) {
        let dependency = self.dependency.borrow();
        self.dependency_backings.borrow_mut().retain(|backing| {
            dependency
                .iter()
                .any(|data| Arc::ptr_eq(data, &backing.data))
        });
    }

    fn retain_dependency_backing(&self, backing: &Arc<TypedTableBacking>) {
        if self
            .dependency
            .borrow()
            .iter()
            .any(|data| Arc::ptr_eq(data, &backing.data))
        {
            let mut backings = self.dependency_backings.borrow_mut();
            // A new root rebinds the same bytes to its current pool. Rows which
            // still own the previous backing keep that old reservation alive.
            backings.retain(|old| !Arc::ptr_eq(&old.data, &backing.data));
            backings.push(Arc::clone(backing));
        }
    }

    /// Materialize a shared lazy-row backing only once for each live/preview
    /// table while it remains in the small typed LRU. Disk tables already own
    /// the Arc used by the existing dependency cache and require no deep copy.
    fn shared_table(
        &self,
        engine: &mut FormulaEngine<'_>,
        uuid: &str,
        root: Option<&TableData>,
    ) -> FormulaValue<Arc<TypedTableBacking>> {
        let pool = engine.source_budget();
        let mut existing = None;
        let mut owned = None;
        let mut key = None;
        self.with_typed_table(engine, uuid, root, |data, _engine| {
            let pointer = (data as *const TableData as usize, data.uuid.clone());
            key = Some(pointer.clone());
            let cached = {
                let mut cache = self.typed_snapshots.borrow_mut();
                cache
                    .iter()
                    .position(|(key, _)| *key == pointer)
                    .and_then(|position| cache.remove(position))
            };
            if let Some((key, cached)) = cached {
                if cached.uses_budget(&pool) {
                    self.typed_snapshots
                        .borrow_mut()
                        .push_back((key, Arc::clone(&cached)));
                    existing = Some(cached);
                } else {
                    // The same context can outlive a root engine, including a
                    // new root configured with a smaller limit. Reuse bytes,
                    // but reserve them against the new root's distinct pool.
                    owned = Some(Arc::clone(&cached.data));
                }
            } else {
                owned = self
                    .dependency
                    .borrow()
                    .iter()
                    .find(|cached| std::ptr::eq(cached.as_ref(), data))
                    .cloned();
            }
            Ok(())
        })?;
        if let Some(existing) = existing {
            self.retain_dependency_backing(&existing);
            return Ok(existing);
        }
        // Evict before reservation, so dead cached backings return their weight.
        if self.typed_snapshots.borrow().len() == DEPENDENCY_TABLE_CACHE_CAPACITY {
            self.typed_snapshots.borrow_mut().pop_front();
        }
        let bytes = match &owned {
            Some(data) => table_clone_bytes(data)?,
            None => self.with_typed_table(engine, uuid, root, |data, _| table_clone_bytes(data))?,
        };
        let reservation = engine.reserve_source_memory(bytes)?;
        let data = if let Some(data) = owned {
            data
        } else {
            self.with_typed_table(engine, uuid, root, |data, _| Ok(Arc::new(data.clone())))?
        };
        let backing = Arc::new(TypedTableBacking::new(data, reservation));
        self.retain_dependency_backing(&backing);
        self.typed_snapshots
            .borrow_mut()
            .push_back((key.unwrap(), Arc::clone(&backing)));
        Ok(backing)
    }

    fn validate_table_ref(&self, data: &TableData, column: &ColumnSchema) -> FormulaValue<()> {
        if column.data_type != crate::ValueType::TableRef {
            return Err(FormulaError::TypeError(
                "TABLE requires a String or TableRef".into(),
            ));
        }
        let config = column.table_ref_config.as_ref().ok_or_else(|| {
            FormulaError::InvalidReference("TableRef interface configuration is missing".into())
        })?;
        let required = uuid::Uuid::parse_str(&config.interface_uuid).map_err(|_| {
            FormulaError::InvalidReference("Invalid TableRef interface UUID".into())
        })?;
        if self
            .project
            .interface_registry
            .get_interface(&required)
            .is_none()
        {
            return Err(FormulaError::InvalidReference(
                "TableRef interface does not exist".into(),
            ));
        }
        let ids = crate::json_export::expanded_interface_ids(
            self.project,
            data.interface_implementations
                .keys()
                .map(ToString::to_string)
                .collect(),
        )
        .map_err(FormulaError::from)?;
        if !ids
            .iter()
            .any(|id| uuid::Uuid::parse_str(id).ok() == Some(required))
        {
            return Err(FormulaError::InvalidReference(format!(
                "Table '{}' does not implement the TableRef interface",
                data.metadata.data_name
            )));
        }
        crate::Interface::validate_table_column_ids(data, &self.project.interface_registry)
            .map_err(FormulaError::from)
    }

    fn table(
        &self,
        engine: &mut FormulaEngine<'_>,
        argument: &Value,
        root: Option<&TableData>,
    ) -> FormulaValue<Value> {
        engine.charge_work(1, 0)?;
        let (uuid, reference) = match argument {
            Value::String(name) => (
                self.resolve_table(engine, name, root).inspect_err(|_| {
                    if uuid::Uuid::parse_str(name).is_ok() {
                        engine.record_cell_diagnostic(name, None, None, "TABLE");
                    }
                })?,
                None,
            ),
            Value::TableReference { column, value } => {
                let uuid = uuid::Uuid::parse_str(value)
                    .map_err(|_| {
                        FormulaError::InvalidReference("Empty or invalid TableRef UUID".into())
                    })?
                    .to_string();
                (
                    self.resolve_table(engine, &uuid, root).inspect_err(|_| {
                        engine.record_cell_diagnostic(&uuid, None, None, "TABLE");
                    })?,
                    Some(column.as_ref()),
                )
            }
            _ => {
                return Err(FormulaError::TypeError(
                    "TABLE requires a table name/UUID String or a typed TableRef".into(),
                ))
            }
        };
        let result = (|| {
            self.with_typed_table(engine, &uuid, root, |data, _engine| {
                if let Some(column) = reference {
                    self.validate_table_ref(data, column)?;
                }
                crate::Interface::validate_table_column_ids(data, &self.project.interface_registry)
                    .map_err(FormulaError::from)?;
                Ok(data.records.len())
            })?;
            engine.charge_work(0, 0)?;
            // Only retained rows count toward the input collection limit; excluded
            // content-version rows still count as scan work and check cancellation.
            let included = self.with_typed_table(engine, &uuid, root, |data, _engine| {
                let mut included = 0usize;
                for row in &data.records {
                    _engine.charge_work(1, 0).inspect_err(|_| {
                        _engine.record_cell_diagnostic(&uuid, Some(&row.uuid), None, "TABLE");
                    })?;
                    if self
                        .target_version
                        .is_none_or(|version| row.min_version <= version)
                    {
                        included += 1;
                    }
                }
                Ok(included)
            })?;
            engine.charge_collection_items(included)?;
            if included == 0 {
                return Ok(Value::Collection(
                    Arc::new(Vec::new()),
                    Some(Arc::new(Kind::Row(uuid.clone()))),
                ));
            }
            let data = self.shared_table(engine, &uuid, root)?;
            let mut rows = Vec::with_capacity(included);
            for (index, row) in data.records.iter().enumerate() {
                engine.charge_work(1, 0).inspect_err(|_| {
                    engine.record_cell_diagnostic(&uuid, Some(&row.uuid), None, "TABLE");
                })?;
                if self
                    .target_version
                    .is_none_or(|version| row.min_version <= version)
                {
                    rows.push(Value::Row {
                        data: Arc::clone(&data),
                        index,
                    });
                }
            }
            Ok(Value::Collection(
                Arc::new(rows),
                Some(Arc::new(Kind::Row(data.uuid.clone()))),
            ))
        })();
        if result.is_err() {
            engine.record_cell_diagnostic(&uuid, None, None, "TABLE");
        }
        result
    }

    fn reference(
        &self,
        engine: &mut FormulaEngine<'_>,
        column: &ColumnSchema,
        value: &str,
        field: &str,
        root: Option<&TableData>,
    ) -> FormulaValue<Value> {
        engine.charge_work(1, 0)?;
        if column.data_type != crate::ValueType::Reference {
            return Err(FormulaError::InvalidReference(
                "Field traversal requires a Reference".into(),
            ));
        }
        let config = column.reference_config.as_ref().ok_or_else(|| {
            FormulaError::InvalidReference("Reference configuration is missing".into())
        })?;
        let table_uuid = uuid::Uuid::parse_str(&config.target_table_uuid)
            .map_err(|_| FormulaError::InvalidReference("Invalid reference table UUID".into()))?
            .to_string();
        let result = (|| {
            let row_uuid = uuid::Uuid::parse_str(value).map_err(|_| {
                FormulaError::InvalidReference("Empty or invalid reference row UUID".into())
            })?;
            let (next_column, literal, position) =
                self.with_table(engine, &table_uuid, root, |data, _engine| {
                    let mut found = None;
                    for (index, row) in data.records.iter().enumerate() {
                        _engine.charge_work(1, 0)?;
                        if uuid::Uuid::parse_str(&row.uuid).ok() == Some(row_uuid) {
                            if found.is_some() {
                                return Err(FormulaError::InvalidReference(
                                    "Duplicate referenced row UUID".into(),
                                ));
                            }
                            found = Some(index);
                        }
                    }
                    let index = found.ok_or_else(|| {
                        FormulaError::InvalidReference("Referenced row not found".into())
                    })?;
                    let row = &data.records[index];
                    if self
                        .target_version
                        .is_some_and(|version| row.min_version > version)
                    {
                        return Err(FormulaError::InvalidReference(
                            "Referenced row is unavailable at this content version".into(),
                        ));
                    }
                    let next =
                        FormulaEngine::named_column(&data.schema, field).inspect_err(|_| {
                            _engine.record_cell_diagnostic(
                                &table_uuid,
                                Some(&row.uuid),
                                None,
                                "Reference",
                            );
                        })?;
                    let literal = match cell_input(next, row) {
                        CellInput::Literal(value) => Some(value.into_owned()),
                        CellInput::Formula => None,
                    };
                    Ok((next.clone(), literal, index))
                })?;
            let converted = (|| {
                let selected = if let Some(value) = literal {
                    value
                } else {
                    let data = self.shared_table(engine, &table_uuid, root)?;
                    cell_value(
                        engine,
                        &table_uuid,
                        &next_column,
                        &data.records[position],
                        &data.schema,
                    )?
                };
                let selected = crate::formula_engine::formula_operand(&next_column, selected)?;
                engine.charge_work(1, selected.len())?;
                engine.typed_scalar(&next_column, selected)
            })();
            if converted.is_err() {
                engine.record_cell_diagnostic(
                    &table_uuid,
                    Some(value),
                    Some(&next_column.uuid),
                    "Reference",
                );
            }
            converted
        })();
        if result.is_err() {
            let row = uuid::Uuid::parse_str(value).ok().map(|_| value);
            engine.record_cell_diagnostic(&table_uuid, row, None, "Reference");
        }
        result
    }

    fn validate_output(
        &self,
        engine: &mut FormulaEngine<'_>,
        value: &Value,
        column: &ColumnSchema,
        root: Option<&TableData>,
    ) -> FormulaValue<()> {
        match value {
            Value::TableReference {
                column: source,
                value,
            } => {
                if column.data_type != crate::ValueType::TableRef {
                    return Err(FormulaError::TypeError(
                        "TableRef output requires a TableRef column".into(),
                    ));
                }
                if value.is_empty() {
                    return Ok(());
                }
                let uuid = uuid::Uuid::parse_str(value)
                    .map_err(|_| {
                        FormulaError::InvalidReference("Invalid TableRef output UUID".into())
                    })?
                    .to_string();
                self.with_table(engine, &uuid, root, |data, _engine| {
                    self.validate_table_ref(data, source)?;
                    self.validate_table_ref(data, column)
                })
                .inspect_err(|_| {
                    engine.record_cell_diagnostic(&uuid, None, None, "TableRef output");
                })
            }
            Value::Reference {
                column: source,
                value,
            } => {
                if column.data_type != crate::ValueType::Reference {
                    return Err(FormulaError::TypeError(
                        "Reference output requires a Reference column".into(),
                    ));
                }
                let target = |column: &ColumnSchema| -> FormulaValue<uuid::Uuid> {
                    column
                        .reference_config
                        .as_ref()
                        .and_then(|config| uuid::Uuid::parse_str(&config.target_table_uuid).ok())
                        .ok_or_else(|| {
                            FormulaError::InvalidReference(
                                "Invalid Reference output configuration".into(),
                            )
                        })
                };
                let table = target(source)?;
                if table != target(column)? {
                    return Err(FormulaError::TypeError(
                        "Reference output target table does not match the destination".into(),
                    ));
                }
                if value.is_empty() {
                    return Ok(());
                }
                let row_id = uuid::Uuid::parse_str(value).map_err(|_| {
                    FormulaError::InvalidReference("Invalid Reference output row UUID".into())
                })?;
                let table_uuid = table.to_string();
                self.with_table(engine, &table_uuid, root, |data, _engine| {
                    _engine.charge_work(data.records.len(), 0)?;
                    let mut rows = data
                        .records
                        .iter()
                        .filter(|row| uuid::Uuid::parse_str(&row.uuid).ok() == Some(row_id));
                    let row = rows.next().ok_or_else(|| {
                        FormulaError::InvalidReference("Reference output row does not exist".into())
                    })?;
                    if rows.next().is_some()
                        || self
                            .target_version
                            .is_some_and(|version| row.min_version > version)
                    {
                        return Err(FormulaError::InvalidReference(
                            "Reference output row is not available at this content version".into(),
                        ));
                    }
                    Ok(())
                })
                .inspect_err(|_| {
                    engine.record_cell_diagnostic(
                        &table_uuid,
                        Some(value),
                        None,
                        "Reference output",
                    );
                })
            }
            _ => Ok(()),
        }
    }

    fn query(
        &self,
        engine: &mut FormulaEngine<'_>,
        name: &str,
        args: &[String],
        root: Option<&TableData>,
    ) -> FormulaValue<Value> {
        let required = if name == "COUNTIF" { 3 } else { 4 };
        if args.len() != required {
            return Err(FormulaError::ArgumentError(format!(
                "{name} requires exactly {required} arguments"
            )));
        }
        let uuid = self
            .resolve_table(engine, &args[0], root)
            .inspect_err(|_| {
                if uuid::Uuid::parse_str(&args[0]).is_ok() {
                    engine.record_cell_diagnostic(&args[0], None, None, name);
                }
            })?;
        let result = (|| {
            let (schema, count) = self.with_table(engine, &uuid, root, |data, _engine| {
                Ok((data.schema.clone(), data.records.len()))
            })?;
            let key_column = resolve_column(&schema, &args[1])?;
            let value_column = if name == "COUNTIF" {
                None
            } else {
                Some(resolve_column(&schema, &args[3])?)
            };
            let mut found = None;
            let mut matches = 0usize;
            let mut sum = Number::Integer(0);
            for start in (0..count).step_by(QUERY_SCAN_CHUNK) {
                let end = start.saturating_add(QUERY_SCAN_CHUNK).min(count);
                engine.charge_work(end - start, 0)?;
                let candidates = self.with_table(engine, &uuid, root, |data, _engine| {
                    let rows = data.records.get(start..end).ok_or_else(|| {
                        FormulaError::InvalidReference(
                            "Dependency population changed during evaluation".into(),
                        )
                    })?;
                    Ok(rows
                        .iter()
                        .enumerate()
                        .filter_map(|(offset, row)| {
                            if self
                                .target_version
                                .is_some_and(|version| row.min_version > version)
                            {
                                return None;
                            }
                            // Literal, nonmatching keys cannot recurse or fail. Inspect
                            // them while borrowing the table instead of cloning every
                            // record (all its cell maps) for each independent LOOKUP.
                            match cell_input(key_column, row) {
                                CellInput::Literal(value) if value.as_ref() != args[2] => None,
                                _ => Some(start + offset),
                            }
                        })
                        .collect::<Vec<_>>())
                })?;
                let trailing_literals =
                    candidates.last().is_some_and(|position| position + 1 < end);
                for position in candidates {
                    // Release the table cache borrow before evaluating: a nested query
                    // is free to evict it. At most this one row lives on each stack frame.
                    let row = self.with_table(engine, &uuid, root, |data, _engine| {
                        let row = data.records.get(position).ok_or_else(|| {
                            FormulaError::InvalidReference(
                                "Dependency population changed during evaluation".into(),
                            )
                        })?;
                        Ok(self
                            .target_version
                            .is_none_or(|version| row.min_version <= version)
                            .then(|| QueryRow::capture(key_column, value_column, row)))
                    })?;
                    let Some(row) = row else {
                        continue;
                    };
                    let key = row
                        .key(engine, &uuid, key_column, &schema)
                        .inspect_err(|_| {
                            row.record_diagnostic(engine, &uuid, key_column, name);
                        })?;
                    // Criteria are literal, case-sensitive strings. No comparison prefix
                    // or wildcard language is implied by COUNTIF/SUMIF.
                    if key != args[2] {
                        continue;
                    }
                    matches += 1;
                    if name == "LOOKUP" {
                        if matches > 1 {
                            row.record_diagnostic(engine, &uuid, key_column, name);
                            return Err(FormulaError::InvalidReference(format!(
                                "LOOKUP matched multiple records in table '{}'",
                                args[0]
                            )));
                        }
                        found = Some(row);
                    } else if name == "SUMIF" {
                        let subtotal = (|| {
                            let value = row.value(engine, &uuid, value_column.unwrap(), &schema)?;
                            let number = if matches!(
                                value_column.unwrap().data_type,
                                crate::ValueType::F32 | crate::ValueType::F64
                            ) {
                                Number::finite(value.parse::<f64>().map_err(|_| {
                                    FormulaError::TypeError("SUMIF value must be numeric".into())
                                })?)?
                            } else {
                                Number::required(&value)?
                            };
                            sum.binary(number, '+')
                        })();
                        sum = subtotal.inspect_err(|_| {
                            row.record_diagnostic(engine, &uuid, value_column.unwrap(), name);
                        })?;
                    }
                }
                if trailing_literals {
                    // A candidate's formula may have evicted this dependency. The
                    // original scan touched it again for the remaining literal rows;
                    // preserve that reload/stamp check and final LRU ordering.
                    self.with_table(engine, &uuid, root, |data, _engine| {
                        data.records.get(end - 1).map(|_| ()).ok_or_else(|| {
                            FormulaError::InvalidReference(
                                "Dependency population changed during evaluation".into(),
                            )
                        })
                    })?;
                }
            }
            match name {
                "LOOKUP" => {
                    let row = found.ok_or_else(|| {
                        FormulaError::InvalidReference(format!(
                            "LOOKUP matched no records in table '{}'",
                            args[0]
                        ))
                    })?;
                    let column = value_column.unwrap();
                    let result = (|| {
                        let value = row.value(engine, &uuid, column, &schema)?;
                        let value = crate::formula_engine::formula_operand(column, value)?;
                        engine.typed_scalar(column, value)
                    })();
                    result.inspect_err(|_| {
                        row.record_diagnostic(engine, &uuid, column, name);
                    })
                }
                "COUNTIF" => Ok(Value::Number(Number::Integer(matches as i128))),
                "SUMIF" => Ok(Value::Number(sum)),
                _ => Err(FormulaError::FunctionNotFound(name.into())),
            }
        })();
        if result.is_err() {
            engine.record_cell_diagnostic(&uuid, None, None, name);
        }
        result
    }
}

impl FormulaQueryResolver for ProjectFormulaContext<'_> {
    fn effective_input(
        &self,
        engine: &mut FormulaEngine<'_>,
        uuid: &str,
        record: &Record,
        column: &ColumnSchema,
    ) -> FormulaValue<String> {
        self.with_table(engine, uuid, None, |data, _| {
            self.inherited_input(data, record, column)
        })
    }

    fn begin_evaluation(&self) -> FormulaValue<()> {
        self.check_cancelled()?;
        self.begin_evaluation_snapshot();
        Ok(())
    }
    fn begin_collection_snapshot(&self, engine: &mut FormulaEngine<'_>) -> FormulaValue<()> {
        self.activate_collection_snapshot(Some(engine))
    }
    fn end_evaluation(&self, engine: &mut FormulaEngine<'_>) -> FormulaValue<()> {
        self.finish_snapshot_with_engine(Some(engine))
    }
    fn validate_typed_output(
        &self,
        engine: &mut FormulaEngine<'_>,
        value: &Value,
        column: &ColumnSchema,
    ) -> FormulaValue<()> {
        self.validate_output(engine, value, column, None)
    }

    fn evaluate_table(
        &self,
        engine: &mut FormulaEngine<'_>,
        argument: &Value,
    ) -> FormulaValue<Value> {
        self.table(engine, argument, None)
    }
    fn evaluate_reference(
        &self,
        engine: &mut FormulaEngine<'_>,
        column: &ColumnSchema,
        value: &str,
        field: &str,
    ) -> FormulaValue<Value> {
        self.reference(engine, column, value, field, None)
    }

    fn evaluate_query(
        &self,
        engine: &mut FormulaEngine<'_>,
        name: &str,
        args: &[String],
    ) -> FormulaValue<Value> {
        self.query(engine, name, args, None)
    }
}

struct FormulaView<'a, 'p> {
    context: &'a ProjectFormulaContext<'p>,
    root: &'a TableData,
}
impl FormulaQueryResolver for FormulaView<'_, '_> {
    fn effective_input(
        &self,
        engine: &mut FormulaEngine<'_>,
        uuid: &str,
        record: &Record,
        column: &ColumnSchema,
    ) -> FormulaValue<String> {
        self.context
            .with_table(engine, uuid, Some(self.root), |data, _| {
                self.context.inherited_input(data, record, column)
            })
    }

    fn begin_evaluation(&self) -> FormulaValue<()> {
        self.context.begin_evaluation()
    }
    fn begin_collection_snapshot(&self, engine: &mut FormulaEngine<'_>) -> FormulaValue<()> {
        self.context.begin_collection_snapshot(engine)
    }
    fn end_evaluation(&self, engine: &mut FormulaEngine<'_>) -> FormulaValue<()> {
        self.context.end_evaluation(engine)
    }
    fn validate_typed_output(
        &self,
        engine: &mut FormulaEngine<'_>,
        value: &Value,
        column: &ColumnSchema,
    ) -> FormulaValue<()> {
        self.context
            .validate_output(engine, value, column, Some(self.root))
    }

    fn evaluate_table(
        &self,
        engine: &mut FormulaEngine<'_>,
        argument: &Value,
    ) -> FormulaValue<Value> {
        self.context.table(engine, argument, Some(self.root))
    }
    fn evaluate_reference(
        &self,
        engine: &mut FormulaEngine<'_>,
        column: &ColumnSchema,
        value: &str,
        field: &str,
    ) -> FormulaValue<Value> {
        self.context
            .reference(engine, column, value, field, Some(self.root))
    }

    fn evaluate_query(
        &self,
        engine: &mut FormulaEngine<'_>,
        name: &str,
        args: &[String],
    ) -> FormulaValue<Value> {
        self.context.query(engine, name, args, Some(self.root))
    }
}

fn resolve_column<'a>(schema: &'a TableSchema, name: &str) -> FormulaValue<&'a ColumnSchema> {
    for priority in 0..3 {
        let mut matches = schema.columns.iter().filter(|column| {
            let value = match priority {
                0 => &column.uuid,
                1 => &column.data_name,
                _ => &column.display_name,
            };
            crate::formula_engine::names_equal(value, name)
        });
        if let Some(column) = matches.next() {
            if matches.next().is_some() {
                return Err(FormulaError::InvalidReference(format!(
                    "Ambiguous column reference: {name}"
                )));
            }
            return Ok(column);
        }
    }
    Err(FormulaError::InvalidReference(format!(
        "Column not found: {name}"
    )))
}

// Literal query rows need only the key and selected value. Formula-backed
// cells retain one owned row so evaluation can safely recurse through the LRU.
enum QueryRow {
    Literal {
        key: String,
        value: Option<String>,
        row_uuid: Option<uuid::Uuid>,
    },
    Formula(Box<Record>),
}

impl QueryRow {
    fn capture(
        key_column: &ColumnSchema,
        value_column: Option<&ColumnSchema>,
        row: &Record,
    ) -> Self {
        if let CellInput::Literal(key) = cell_input(key_column, row) {
            let value = match value_column.map(|column| cell_input(column, row)) {
                Some(CellInput::Literal(value)) => Some(value.into_owned()),
                Some(CellInput::Formula) => return Self::Formula(Box::new(row.clone())),
                None => None,
            };
            Self::Literal {
                key: key.into_owned(),
                value,
                // Preserve the selected immutable identity through later LRU
                // eviction without cloning a String on the successful path.
                row_uuid: uuid::Uuid::parse_str(&row.uuid).ok(),
            }
        } else {
            Self::Formula(Box::new(row.clone()))
        }
    }

    fn record_diagnostic(
        &self,
        engine: &mut FormulaEngine<'_>,
        table_uuid: &str,
        column: &ColumnSchema,
        operation: &str,
    ) {
        let row_uuid = match self {
            Self::Formula(row) => Some(Cow::Borrowed(row.uuid.as_str())),
            Self::Literal { row_uuid, .. } => row_uuid.map(|uuid| Cow::Owned(uuid.to_string())),
        };
        engine.record_cell_diagnostic(
            table_uuid,
            row_uuid.as_deref(),
            Some(&column.uuid),
            operation,
        );
    }

    fn key(
        &self,
        engine: &mut FormulaEngine<'_>,
        uuid: &str,
        column: &ColumnSchema,
        schema: &TableSchema,
    ) -> FormulaValue<String> {
        match self {
            Self::Literal { key, .. } => Ok(key.clone()),
            Self::Formula(row) => cell_value(engine, uuid, column, row, schema),
        }
    }

    fn value(
        &self,
        engine: &mut FormulaEngine<'_>,
        uuid: &str,
        column: &ColumnSchema,
        schema: &TableSchema,
    ) -> FormulaValue<String> {
        match self {
            Self::Literal { value, .. } => {
                Ok(value.as_ref().expect("value column was captured").clone())
            }
            Self::Formula(row) => cell_value(engine, uuid, column, row, schema),
        }
    }
}

enum CellInput<'a> {
    Literal(Cow<'a, str>),
    Formula,
}

/// One source for query-key and dependent-cell default/None semantics.
fn cell_input<'a>(column: &'a ColumnSchema, record: &'a Record) -> CellInput<'a> {
    if column.data_type == crate::ValueType::None {
        return CellInput::Literal(Cow::Borrowed(""));
    }
    // The empty formula sentinel disables the literal fast path for inherited
    // rows. Its actual input is resolved by cell_value in the table context.
    if record.get_cell_value(column).is_none() && !record.parent_uuid.is_empty() {
        return CellInput::Formula;
    }
    let value = match record.get_cell_value(column).is_some() {
        true => record
            .get_cell_value(column)
            .map(String::as_str)
            .unwrap_or(""),
        _ => column.default_value.as_str(),
    };
    if value.starts_with('=') {
        CellInput::Formula
    } else if value.is_empty() {
        CellInput::Literal(Cow::Owned(column.data_type.default_value()))
    } else {
        CellInput::Literal(Cow::Borrowed(value))
    }
}

fn cell_value(
    engine: &mut FormulaEngine<'_>,
    table_uuid: &str,
    column: &ColumnSchema,
    record: &Record,
    schema: &TableSchema,
) -> FormulaValue<String> {
    let input = engine.effective_input(table_uuid, record, column)?;
    if column.data_type == crate::ValueType::None {
        return Ok(String::new());
    }
    if input.starts_with('=') {
        engine
            .evaluate_column_in_table(table_uuid, &input, column, record, schema)
            .into_result()
    } else if input.is_empty() {
        Ok(column.data_type.default_value())
    } else {
        Ok(input)
    }
}

fn ensure_scoped_path(path: &Path, canonical_root: &Path) -> FormulaValue<()> {
    // Pending in-memory files may not exist yet. Resolve their nearest existing
    // ancestor too, so a missing file below an escaping symlink is not admitted.
    let mut ancestor = path;
    let mut suffix = Vec::new();
    while std::fs::symlink_metadata(ancestor).is_err() {
        if let Some(name) = ancestor.file_name() {
            suffix.push(name.to_owned());
        }
        ancestor = ancestor
            .parent()
            .ok_or_else(|| source_error(path, "Invalid table path"))?;
    }
    let mut canonical = std::fs::canonicalize(ancestor).map_err(|e| source_error(path, e))?;
    for component in suffix.into_iter().rev() {
        canonical.push(component);
    }
    if !canonical.starts_with(canonical_root) {
        return Err(source_error(path, "Live table source escapes this project"));
    }
    Ok(())
}

fn absolute_normalized(path: &Path) -> FormulaValue<PathBuf> {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|e| source_error(path, e))?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    Ok(normalized)
}

fn structured_source_error(path: &Path, error: crate::DevcelError) -> FormulaError {
    FormulaError::Structured(Box::new(crate::AppError::code(
        "grid.errorWithCause",
        serde_json::json!({ "summary": path.to_string_lossy(), "error": crate::AppError::from(error).into_diagnostic() }),
    ).into_diagnostic()))
}

fn source_error(path: &Path, error: impl std::fmt::Display) -> FormulaError {
    FormulaError::InvalidReference(format!(
        "Cannot read formula table '{}': {error}",
        path.display()
    ))
}

fn source_changed(path: &Path) -> FormulaError {
    FormulaError::DataChanged(format!("Formula table source changed: {}", path.display()))
}

fn table_clone_bytes(data: &TableData) -> FormulaValue<usize> {
    if let Some(bytes) = retained_table_bytes(data) {
        return Ok(bytes);
    }
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, data)
        .map_err(|error| FormulaError::TypeError(error.to_string()))?;
    Ok(counter.0.saturating_mul(8))
}
