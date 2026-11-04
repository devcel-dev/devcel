//! Runtime bundle JSON contract (deserialization only).
//!
//! Lightweight runtime type definitions for JSON emitted by devcel-core's
//! `export_runtime_bundle`. Avoids a dependency on devcel-core and its tokio,
//! P2P, and command machinery; only the export JSON **format contract** is mirrored here.
//! The contract is versioned by `manifest.schema_version`, making drift detectable.

use serde::Deserialize;
use std::collections::HashMap;

/// Bundle schema version understood by the runtime.
/// Must match `RUNTIME_SCHEMA_VERSION` in devcel-core.
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// Complete runtime distribution bundle.
#[derive(Debug, Clone, Deserialize)]
pub struct Bundle {
    pub manifest: Manifest,
    pub project_name: String,
    pub tables: Vec<BundleTable>,
}

/// Bundle metadata used for hot-reload decisions.
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    #[serde(default)]
    pub content_version: Option<u32>,
    pub content_hash: String,
    pub data_revision: u64,
    pub generated_at: String,
    pub mode: String,
}

/// One table in the bundle.
#[derive(Debug, Clone, Deserialize)]
pub struct BundleTable {
    pub uuid: String,
    #[serde(default)]
    pub interfaces: Vec<String>,
    pub name: String,
    pub columns: Vec<BundleColumn>,
    pub records: Vec<BundleRecord>,
}

/// Column definition in the bundle.
#[derive(Debug, Clone, Deserialize)]
pub struct BundleColumn {
    pub name: String,
    pub data_type: RtValueType,
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub curve_config: Option<crate::curve::CurveConfig>,
    #[serde(default)]
    pub table_ref_config: Option<TableRefConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TableRefConfig {
    pub interface_uuid: String,
}

/// One bundle record. All values are strings; formulas and defaults are resolved by the exporter.
#[derive(Debug, Clone, Deserialize)]
pub struct BundleRecord {
    pub id: String,
    pub values: HashMap<String, String>,
}

/// Value types corresponding to devcel-core's `ValueType`.
/// Accept only canonical type names emitted by the official exporter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum RtValueType {
    None,
    String,
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    U64,
    I64,
    F32,
    F64,
    Boolean,
    Color32,
    ColorFloat,
    Select,
    DateTime,
    Curve,
    Reference,
    TableRef,
}

/// Canonical scalar kinds used by the runtime to store values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalarKind {
    /// Stored in the string pool
    Text,
    /// Integer, stored as i64
    Integer,
    /// Floating point, stored as f64
    Float,
    /// Boolean
    Boolean,
    Color32,
    ColorFloat,
}

impl RtValueType {
    /// Return the scalar kind used to store this type inside the runtime.
    pub fn scalar_kind(&self) -> ScalarKind {
        match self {
            RtValueType::None
            | RtValueType::String
            | RtValueType::Select
            | RtValueType::DateTime
            | RtValueType::Curve
            | RtValueType::Reference
            | RtValueType::TableRef => ScalarKind::Text,
            RtValueType::U8
            | RtValueType::I8
            | RtValueType::U16
            | RtValueType::I16
            | RtValueType::U32
            | RtValueType::I32
            | RtValueType::U64
            | RtValueType::I64 => ScalarKind::Integer,
            RtValueType::F32 | RtValueType::F64 => ScalarKind::Float,
            RtValueType::Boolean => ScalarKind::Boolean,
            RtValueType::Color32 => ScalarKind::Color32,
            RtValueType::ColorFloat => ScalarKind::ColorFloat,
        }
    }
}

impl Bundle {
    /// Validate even before a same-hash reload fast path. Ambiguous identities must
    /// never silently overwrite index entries or produce an incomplete database.
    pub fn validate(&self) -> Result<(), String> {
        self.validate_with_colors(|_, _, table, column| {
            if matches!(
                column.data_type,
                RtValueType::Color32 | RtValueType::ColorFloat
            ) {
                for raw in column.default_value.iter().chain(
                    table
                        .records
                        .iter()
                        .filter_map(|record| record.values.get(&column.name)),
                ) {
                    match column.data_type {
                        RtValueType::Color32 => {
                            crate::Color32::parse(raw)?;
                        }
                        RtValueType::ColorFloat => {
                            crate::ColorFloat::parse(raw)?;
                        }
                        _ => unreachable!(),
                    }
                }
            }
            Ok(())
        })
    }

    // Snapshot construction consumes decoded colors from this same validation pass.
    pub(crate) fn validate_with_colors(
        &self,
        mut validate_colors: impl FnMut(usize, usize, &BundleTable, &BundleColumn) -> Result<(), String>,
    ) -> Result<(), String> {
        use std::collections::HashSet;
        if self.manifest.schema_version != SUPPORTED_SCHEMA_VERSION {
            return Err(format!(
                "Unsupported schema version {} (supported: {})",
                self.manifest.schema_version, SUPPORTED_SCHEMA_VERSION
            ));
        }
        if self.manifest.content_hash.is_empty() {
            return Err("content_hash is empty".into());
        }
        if self.manifest.generated_at.is_empty() {
            return Err("generated_at is empty".into());
        }
        if !matches!(self.manifest.mode.as_str(), "full" | "minimal") {
            return Err("mode must be full or minimal".into());
        }
        let mut names = HashSet::new();
        let mut table_ids = HashSet::new();
        for (ti, table) in self.tables.iter().enumerate() {
            if table.uuid.is_empty() || !table_ids.insert(&table.uuid) {
                return Err(format!("Empty or duplicate table UUID: {}", table.uuid));
            }
            if table.interfaces.iter().any(String::is_empty) {
                return Err(format!("Empty interface UUID: {}", table.name));
            }
            if table.name.is_empty() || !names.insert(&table.name) {
                return Err(format!("Empty or duplicate table name: {}", table.name));
            }
            let mut columns = HashSet::new();
            for (ci, column) in table.columns.iter().enumerate() {
                if column
                    .table_ref_config
                    .as_ref()
                    .is_some_and(|c| c.interface_uuid.is_empty())
                {
                    return Err(format!(
                        "Empty TableRef interface UUID: {}.{}",
                        table.name, column.name
                    ));
                }
                validate_colors(ti, ci, table, column)?;
                if column.name.is_empty() || !columns.insert(&column.name) {
                    return Err(format!(
                        "Empty or duplicate column name: {}.{}",
                        table.name, column.name
                    ));
                }
            }
            let mut ids = HashSet::new();
            for record in &table.records {
                if record.id.is_empty() || !ids.insert(&record.id) {
                    return Err(format!(
                        "Empty or duplicate record ID: {}.{}",
                        table.name, record.id
                    ));
                }
            }
        }
        Ok(())
    }
}
