//! Optimized read model (Snapshot).
//!
//! Parse bundle JSON **once** to build native memory structures enabling
//! subsequent O(1), allocation-free value access:
//! - Concatenate strings into one pool; each cell references an (offset, len) span.
//! - Store numbers and booleans in typed fixed-length arrays for indexed access.
//! - Index record UUIDs to row indices using a HashMap (O(1)).

use crate::bundle::{Bundle, Manifest, ScalarKind};
use std::collections::{HashMap, HashSet};

/// Typed data for one column.
#[derive(Debug)]
pub enum ColumnData {
    /// String pool. `spans[row] = (offset, len)` identifies a substring in `pool`.
    Text {
        pool: String,
        spans: Vec<(u32, u32)>,
    },
    /// Integers (u8..i64 / u8..u64 normalized and stored as i64).
    Integer(Vec<i64>),
    /// Floating point.
    Float(Vec<f64>),
    /// Boolean.
    Boolean(Vec<bool>),
    Color32(Vec<crate::Color32>),
    ColorFloat(Vec<crate::ColorFloat>),
}

/// Column snapshot.
#[derive(Debug)]
pub struct ColumnSnapshot {
    pub name: String,
    pub kind: ScalarKind,
    pub data: ColumnData,
    /// Parse Curve values on load, also retaining raw strings in data.
    pub curves: Option<Vec<crate::curve::Curve>>,
    pub value_type: crate::bundle::RtValueType,
    pub table_ref_interface: Option<String>,
}

impl ColumnSnapshot {
    /// Get a string cell (text types only); return None for nontext types.
    #[inline]
    pub fn str_at(&self, row: usize) -> Option<&str> {
        match &self.data {
            ColumnData::Text { pool, spans } => {
                let (off, len) = *spans.get(row)?;
                let start = off as usize;
                let end = start + len as usize;
                pool.get(start..end)
            }
            _ => None,
        }
    }

    /// Color32 only. A mismatched column or missing row never coerces another type.
    pub fn color32_at(&self, row: usize) -> Option<crate::Color32> {
        match &self.data {
            ColumnData::Color32(values) => values.get(row).copied(),
            _ => None,
        }
    }

    /// ColorFloat only. HDR, negative RGB and transparent RGB remain unchanged.
    pub fn color_float_at(&self, row: usize) -> Option<crate::ColorFloat> {
        match &self.data {
            ColumnData::ColorFloat(values) => values.get(row).copied(),
            _ => None,
        }
    }

    /// Get a Curve cell (Curve type only).
    pub fn curve_at(&self, row: usize) -> Option<&crate::curve::Curve> {
        self.curves.as_ref()?.get(row)
    }

    /// Get an integer cell, converting Float/Bool and returning 0 for Text.
    #[inline]
    pub fn i64_at(&self, row: usize) -> i64 {
        match &self.data {
            ColumnData::Integer(v) => v.get(row).copied().unwrap_or(0),
            ColumnData::Float(v) => v.get(row).copied().unwrap_or(0.0) as i64,
            ColumnData::Boolean(v) => i64::from(v.get(row).copied().unwrap_or(false)),
            ColumnData::Text { .. } | ColumnData::Color32(_) | ColumnData::ColorFloat(_) => 0,
        }
    }

    /// Get a floating-point cell, converting Integer/Bool and returning 0.0 for Text.
    #[inline]
    pub fn f64_at(&self, row: usize) -> f64 {
        match &self.data {
            ColumnData::Float(v) => v.get(row).copied().unwrap_or(0.0),
            ColumnData::Integer(v) => v.get(row).copied().unwrap_or(0) as f64,
            ColumnData::Boolean(v) => {
                if v.get(row).copied().unwrap_or(false) {
                    1.0
                } else {
                    0.0
                }
            }
            ColumnData::Text { .. } | ColumnData::Color32(_) | ColumnData::ColorFloat(_) => 0.0,
        }
    }

    /// Get a boolean cell: Integer != 0, Float != 0.0, and false for Text.
    #[inline]
    pub fn bool_at(&self, row: usize) -> bool {
        match &self.data {
            ColumnData::Boolean(v) => v.get(row).copied().unwrap_or(false),
            ColumnData::Integer(v) => v.get(row).copied().unwrap_or(0) != 0,
            ColumnData::Float(v) => v.get(row).copied().unwrap_or(0.0) != 0.0,
            ColumnData::Text { .. } | ColumnData::Color32(_) | ColumnData::ColorFloat(_) => false,
        }
    }
}

/// Snapshot of one table.
#[derive(Debug)]
pub struct TableSnapshot {
    pub uuid: String,
    pub interfaces: HashSet<String>,
    pub name: String,
    pub columns: Vec<ColumnSnapshot>,
    column_index: HashMap<String, usize>,
    pub row_count: usize,
    pub row_ids: Vec<String>,
    id_index: HashMap<String, usize>,
}

impl TableSnapshot {
    /// Column-name-to-index lookup (O(1)).
    #[inline]
    pub fn column_index(&self, name: &str) -> Option<usize> {
        self.column_index.get(name).copied()
    }

    /// Record-UUID-to-row-index lookup (O(1)).
    #[inline]
    pub fn row_by_id(&self, id: &str) -> Option<usize> {
        self.id_index.get(id).copied()
    }

    /// Get a column.
    #[inline]
    pub fn column(&self, col: usize) -> Option<&ColumnSnapshot> {
        self.columns.get(col)
    }
}

/// Project-wide snapshot (immutable view).
#[derive(Debug)]
pub struct Snapshot {
    pub manifest: Manifest,
    pub project_name: String,
    pub tables: Vec<TableSnapshot>,
    table_index: HashMap<String, usize>,
    table_uuid_index: HashMap<String, usize>,
}

impl Snapshot {
    /// Table-name-to-index lookup (O(1)).
    #[inline]
    pub fn table_index(&self, name: &str) -> Option<usize> {
        self.table_index.get(name).copied()
    }

    /// Table-UUID-to-index lookup, without fallback to names.
    pub fn table_by_uuid(&self, uuid: &str) -> Option<usize> {
        self.table_uuid_index.get(uuid).copied()
    }

    /// Resolve a TableRef cell and check interfaces required by both bundle settings and generated code.
    /// Return None for empty cells, unresolved UUIDs, missing metadata, or type/interface mismatches.
    pub fn resolve_table_ref(
        &self,
        table: usize,
        row: usize,
        col: usize,
        required: &str,
    ) -> Option<usize> {
        let column = self.table(table)?.column(col)?;
        if column.value_type != crate::bundle::RtValueType::TableRef {
            return None;
        }
        let target = self.table_by_uuid(column.str_at(row)?)?;
        let target_table = self.table(target)?;
        if !required.is_empty() && !target_table.interfaces.contains(required) {
            return None;
        }
        if let Some(interface) = &column.table_ref_interface {
            if !target_table.interfaces.contains(interface) {
                return None;
            }
        }
        Some(target)
    }

    /// Get a table.
    #[inline]
    pub fn table(&self, table: usize) -> Option<&TableSnapshot> {
        self.tables.get(table)
    }

    /// This snapshot's content hash for hot-reload checks.
    #[inline]
    pub fn content_hash(&self) -> &str {
        &self.manifest.content_hash
    }

    /// Build a snapshot from a bundle JSON string.
    pub fn from_json(json: &str) -> Result<Snapshot, String> {
        let bundle: Bundle =
            serde_json::from_str(json).map_err(|e| format!("Failed to parse bundle JSON: {e}"))?;
        Snapshot::from_bundle(bundle)
    }

    /// Build a snapshot from a parsed bundle.
    pub fn from_bundle(bundle: Bundle) -> Result<Snapshot, String> {
        let mut colors = HashMap::new();
        bundle.validate_with_colors(|ti, ci, table, col| {
            let data = match col.data_type.scalar_kind() {
                ScalarKind::Color32 => {
                    let default = col
                        .default_value
                        .as_deref()
                        .map(crate::Color32::parse)
                        .transpose()?
                        .unwrap_or_default();
                    let mut values = Vec::with_capacity(table.records.len());
                    for rec in &table.records {
                        values.push(match rec.values.get(&col.name) {
                            Some(raw) => crate::Color32::parse(raw)?,
                            None => default,
                        });
                    }
                    ColumnData::Color32(values)
                }
                ScalarKind::ColorFloat => {
                    let default = col
                        .default_value
                        .as_deref()
                        .map(crate::ColorFloat::parse)
                        .transpose()?
                        .unwrap_or_default();
                    let mut values = Vec::with_capacity(table.records.len());
                    for rec in &table.records {
                        values.push(match rec.values.get(&col.name) {
                            Some(raw) => crate::ColorFloat::parse(raw)?,
                            None => default,
                        });
                    }
                    ColumnData::ColorFloat(values)
                }
                _ => return Ok(()),
            };
            colors.insert((ti, ci), data);
            Ok(())
        })?;

        let mut tables = Vec::with_capacity(bundle.tables.len());
        let mut table_index = HashMap::with_capacity(bundle.tables.len());
        let mut table_uuid_index = HashMap::with_capacity(bundle.tables.len());

        for (ti, table) in bundle.tables.into_iter().enumerate() {
            table_index.insert(table.name.clone(), ti);
            table_uuid_index.insert(table.uuid.clone(), ti);

            let row_count = table.records.len();

            // Row UUIDs and indices
            let mut row_ids = Vec::with_capacity(row_count);
            let mut id_index = HashMap::with_capacity(row_count);
            for (ri, rec) in table.records.iter().enumerate() {
                row_ids.push(rec.id.clone());
                id_index.insert(rec.id.clone(), ri);
            }

            // Build typed arrays for each column
            let mut columns = Vec::with_capacity(table.columns.len());
            let mut column_index = HashMap::with_capacity(table.columns.len());

            for (ci, col) in table.columns.iter().enumerate() {
                column_index.insert(col.name.clone(), ci);
                let kind = col.data_type.scalar_kind();

                let data = match kind {
                    ScalarKind::Text => {
                        let mut pool = String::new();
                        let mut spans = Vec::with_capacity(row_count);
                        for rec in &table.records {
                            let s = rec
                                .values
                                .get(&col.name)
                                .map(String::as_str)
                                .or(col.default_value.as_deref())
                                .unwrap_or("");
                            let off = pool.len() as u32;
                            let len = s.len() as u32;
                            pool.push_str(s);
                            spans.push((off, len));
                        }
                        ColumnData::Text { pool, spans }
                    }
                    ScalarKind::Color32 | ScalarKind::ColorFloat => {
                        colors.remove(&(ti, ci)).expect("validated color column")
                    }
                    ScalarKind::Integer => ColumnData::Integer(
                        decode_values(table.records.iter(), col, |raw| {
                            parse_int(raw, col.data_type)
                        })
                        .map_err(|e| format!("{}.{}: {e}", table.name, col.name))?,
                    ),
                    ScalarKind::Float => ColumnData::Float(
                        decode_values(table.records.iter(), col, |raw| {
                            let value = if raw.trim().is_empty() {
                                0.0
                            } else {
                                raw.trim()
                                    .parse::<f64>()
                                    .map_err(|_| format!("Invalid number {raw}"))?
                            };
                            if !value.is_finite()
                                || (col.data_type == crate::bundle::RtValueType::F32
                                    && !(value as f32).is_finite())
                            {
                                return Err("Non-finite number".into());
                            }
                            Ok(value)
                        })
                        .map_err(|e| format!("{}.{}: {e}", table.name, col.name))?,
                    ),
                    ScalarKind::Boolean => ColumnData::Boolean(
                        decode_values(table.records.iter(), col, |raw| {
                            let raw = raw.trim();
                            if !raw.is_empty()
                                && !raw.eq_ignore_ascii_case("true")
                                && !raw.eq_ignore_ascii_case("false")
                            {
                                return Err(format!("Invalid boolean {raw}"));
                            }
                            Ok(raw.eq_ignore_ascii_case("true"))
                        })
                        .map_err(|e| format!("{}.{}: {e}", table.name, col.name))?,
                    ),
                };

                let curves = if col.data_type == crate::bundle::RtValueType::Curve {
                    // Validate config even in empty tables; reuse the decoded empty cell.
                    let empty = crate::curve::Curve::parse("", col.curve_config.as_ref())
                        .map_err(|e| format!("{}.{}: {e}", table.name, col.name))?;
                    let mut default: Option<crate::curve::Curve> = None;
                    let mut curves = Vec::with_capacity(row_count);
                    for rec in &table.records {
                        let parse = |raw: &str| {
                            if raw.is_empty() {
                                Ok(empty.clone())
                            } else {
                                crate::curve::Curve::parse(raw, col.curve_config.as_ref())
                            }
                        };
                        let curve = if let Some(raw) = rec.values.get(&col.name) {
                            parse(raw)
                        } else if let Some(value) = &default {
                            Ok(value.clone())
                        } else {
                            parse(col.default_value.as_deref().unwrap_or("")).inspect(|value| {
                                default = Some(value.clone());
                            })
                        }
                        .map_err(|e| format!("{}.{}[{}]: {e}", table.name, col.name, rec.id))?;
                        curves.push(curve);
                    }
                    Some(curves)
                } else {
                    None
                };
                columns.push(ColumnSnapshot {
                    name: col.name.clone(),
                    kind,
                    data,
                    curves,
                    value_type: col.data_type,
                    table_ref_interface: col
                        .table_ref_config
                        .as_ref()
                        .map(|c| c.interface_uuid.clone()),
                });
            }

            tables.push(TableSnapshot {
                uuid: table.uuid,
                interfaces: table.interfaces.into_iter().collect(),
                name: table.name,
                columns,
                column_index,
                row_count,
                row_ids,
                id_index,
            });
        }

        Ok(Snapshot {
            manifest: bundle.manifest,
            project_name: bundle.project_name,
            tables,
            table_index,
            table_uuid_index,
        })
    }
}

/// Normalize a string to i64; also try u64 to handle unsigned values above i64's maximum.
#[inline]
fn parse_int(raw: &str, kind: crate::bundle::RtValueType) -> Result<i64, String> {
    use crate::bundle::RtValueType::*;
    let raw = raw.trim();
    let t = if raw.is_empty() { "0" } else { raw };
    let invalid = || format!("Invalid integer or value outside the {kind:?} range: {raw}");
    match kind {
        U8 => t.parse::<u8>().map(i64::from).map_err(|_| invalid()),
        I8 => t.parse::<i8>().map(i64::from).map_err(|_| invalid()),
        U16 => t.parse::<u16>().map(i64::from).map_err(|_| invalid()),
        I16 => t.parse::<i16>().map(i64::from).map_err(|_| invalid()),
        U32 => t.parse::<u32>().map(i64::from).map_err(|_| invalid()),
        I32 => t.parse::<i32>().map(i64::from).map_err(|_| invalid()),
        U64 => t.parse::<u64>().map(|n| n as i64).map_err(|_| invalid()),
        I64 => t.parse::<i64>().map_err(|_| invalid()),
        _ => Err(invalid()),
    }
}

// Missing-cell defaults are decoded lazily once per column. An unused invalid
// numeric default remains unused, preserving the existing validation contract.
fn decode_values<'a, T: Clone>(
    records: impl Iterator<Item = &'a crate::bundle::BundleRecord>,
    col: &crate::bundle::BundleColumn,
    parse: impl Fn(&str) -> Result<T, String>,
) -> Result<Vec<T>, String> {
    let mut default: Option<T> = None;
    let mut values = Vec::with_capacity(records.size_hint().0);
    for rec in records {
        let value = if let Some(raw) = rec.values.get(&col.name) {
            parse(raw)?
        } else if let Some(value) = &default {
            value.clone()
        } else {
            let value = parse(col.default_value.as_deref().unwrap_or(""))?;
            default = Some(value.clone());
            value
        };
        values.push(value);
    }
    Ok(values)
}
