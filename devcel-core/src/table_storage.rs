//! Use the standard TOML serializer in small pieces, rather than retaining its
//! document tree for every record at once. Root identity precedes description and metadata.
use crate::{Record, TableData};
use serde::Serialize;

fn serialize_error(error: toml::ser::Error) -> crate::DevcelError {
    crate::app_error::diagnostic(
        "error.parse",
        serde_json::json!({"details": error.to_string()}),
    )
}

// Keep these fields aligned with TableData. The records array is emitted below;
// an empty table still needs its explicit, required `records = []` root field.
#[derive(Serialize)]
struct Header<'a> {
    uuid: &'a str,
    display_name: &'a str,
    description: &'a str,
    metadata: &'a crate::table::TableMetadata,
    #[serde(serialize_with = "crate::ordered_map::serialize")]
    interface_implementations:
        &'a std::collections::HashMap<uuid::Uuid, crate::interface::InterfaceImplementation>,
    schema: &'a crate::table::TableSchema,
    #[serde(skip_serializing_if = "Option::is_none")]
    records: Option<&'a [Record]>,
}
impl<'a> Header<'a> {
    fn new(data: &'a TableData, empty_records: bool) -> Self {
        // Exhaustive destructuring makes adding a storage field a compile-time
        // reminder to include it here rather than silently omitting it.
        let TableData {
            uuid,
            display_name,
            description,
            metadata,
            interface_implementations,
            schema,
            records: _,
        } = data;
        Self {
            uuid,
            display_name,
            description,
            metadata,
            interface_implementations,
            schema,
            records: empty_records.then_some(&[]),
        }
    }
}

#[derive(Serialize)]
struct RecordChunk<'a> {
    records: &'a [Record],
}

pub(crate) fn to_toml(data: &TableData) -> crate::Result<String> {
    data.validate_storage_contract()?;
    for column in &data.schema.columns {
        crate::validate_color_swatches(&column.color_swatches)?;
    }
    // Reject invalid stored RGBA rather than allowing save/reload to disagree.
    // Input normalization belongs to mutations, before history is committed.
    for column in data
        .schema
        .columns
        .iter()
        .filter(|column| column.data_type.is_color())
    {
        column.validate_color_storage_contract()?;
        for record in &data.records {
            if let Some(value) = record.get_cell_value(column) {
                column.validate_color_storage_value(value)?;
            }
        }
    }
    let mut text =
        toml::to_string(&Header::new(data, data.records.is_empty())).map_err(serialize_error)?;
    for record in &data.records {
        text.push('\n');
        text.push_str(
            &toml::to_string(&RecordChunk {
                records: std::slice::from_ref(record),
            })
            .map_err(serialize_error)?,
        );
    }
    Ok(text)
}

/// Preserve the existing typed TOML normalization used by the semantic CAS
/// cache, without constructing a second whole-table TOML Value tree. A failure
/// leaves the cache cold; the ordinary on-disk parser remains authoritative.
pub(crate) fn normalize(data: &TableData) -> crate::Result<TableData> {
    let header = toml::Value::try_from(Header::new(data, true)).map_err(serialize_error)?;
    let mut normalized = TableData::from_toml_value(header)?;
    normalized.records.reserve(data.records.len());
    for record in &data.records {
        let value = toml::Value::try_from(record).map_err(serialize_error)?;
        normalized.records.push(value.try_into()?);
    }
    normalized.validate_storage_contract()?;
    Ok(normalized)
}

impl TableData {
    /// Serialize using the canonical sparse authoring format used by project saves.
    pub fn to_toml(&self) -> crate::Result<String> {
        to_toml(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunked_toml_matches_standard_serialization_and_normalization() {
        let original = crate::cell_rules::canonical_revision_tests::full_table();
        for count in [0, 1, 2, 17] {
            let mut data = original.clone();
            let row = data.records[0].clone();
            data.records = (0..count)
                .map(|n| {
                    let mut record = row.clone();
                    record.uuid = uuid::Uuid::new_v4().to_string();
                    record.label = format!("行 {n} \"quotes\"\n\t\\ 🧪");
                    record.tags = vec!["".into(), "日本語\r\n".into()];
                    if n % 2 == 0 {
                        record.values.clear();
                        record.interface_values.clear();
                        record.memo_texts.clear();
                    }
                    record
                })
                .collect();
            let old = toml::to_string(&data).unwrap();
            let new = to_toml(&data).unwrap();
            // Both the ordinary serializer (plugin resource persistence) and
            // chunked saves must place all metadata before schema/record bodies.
            for text in [&old, &new] {
                let metadata = text.find("\n[metadata]\n").unwrap();
                let permissions = text.find("\n[metadata.edit_permissions]\n").unwrap();
                for section in ["\n[schema]\n", "\n[[schema.columns]]\n", "\n[[records]]\n"] {
                    if let Some(body) = text.find(section) {
                        assert!(
                            metadata < permissions && permissions < body,
                            "metadata must precede payload: {section}"
                        );
                    }
                }
            }
            let old_data: TableData = toml::from_str(&old).unwrap();
            let new_data: TableData = toml::from_str(&new).unwrap();
            assert_eq!(
                serde_json::to_value(&old_data).unwrap(),
                serde_json::to_value(&new_data).unwrap()
            );
            let old_normalized: TableData =
                toml::Value::try_from(&data).unwrap().try_into().unwrap();
            assert_eq!(
                serde_json::to_value(old_normalized).unwrap(),
                serde_json::to_value(normalize(&data).unwrap()).unwrap()
            );
            assert_eq!(
                crate::cell_rules::revision(&old_data),
                crate::cell_rules::revision(&new_data)
            );
            println!(
                "CHUNK_EQUIVALENCE rows={count} old_bytes={} new_bytes={} byte_equal={}",
                old.len(),
                new.len(),
                old == new
            );
        }
    }
    #[test]
    fn sparse_save_preserves_nonempty_parents_and_multiline_string_whitespace() {
        let mut data = crate::cell_rules::canonical_revision_tests::full_table();
        let text = "first\n\n\n  indented\n# not a TOML comment\nlast  ";
        data.description = text.into();
        data.records[0].label = text.into();
        for parent in ["", " ", "00000000-0000-0000-0000-000000000000"] {
            data.metadata.parent_uuid = parent.into();
            data.records[0].parent_uuid = parent.into();
            if !parent.is_empty() {
                let mut parent_record = data.records[0].clone();
                parent_record.uuid = parent.into();
                parent_record.parent_uuid.clear();
                data.records.push(parent_record);
            }
            let output = to_toml(&data).unwrap();
            let parsed: toml::Value = toml::from_str(&output).unwrap();
            for value in [&parsed["metadata"], &parsed["records"][0]] {
                if parent.is_empty() {
                    assert!(value.get("parent_uuid").is_none());
                } else {
                    assert_eq!(value["parent_uuid"].as_str(), Some(parent));
                }
            }
            let loaded: TableData = toml::from_str(&output).unwrap();
            assert_eq!(loaded.description, text);
            assert_eq!(loaded.records[0].label, text);
            assert_eq!(
                serde_json::to_value(&loaded).unwrap(),
                serde_json::to_value(&data).unwrap()
            );
            assert_eq!(to_toml(&loaded).unwrap(), output);
            if !parent.is_empty() {
                data.records.pop();
            }
        }
    }

    #[test]
    fn unordered_storage_maps_are_stable_across_fresh_hash_seeds() {
        let mut data = crate::cell_rules::canonical_revision_tests::full_table();
        let mut column = data.schema.columns[1].clone();
        column.uuid = uuid::Uuid::from_u128(99).to_string();
        for record in &mut data.records {
            record
                .interface_values
                .insert(column.uuid.clone(), "second inherited cell".into());
        }
        data.schema.columns.push(column);
        let expected = to_toml(&data).unwrap();
        let value = serde_json::to_value(&data).unwrap();
        for _ in 0..10 {
            // JSON objects decode into fresh, independently seeded HashMaps.
            data = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(to_toml(&data).unwrap(), expected);
            let decoded: TableData = toml::from_str(&expected).unwrap();
            assert_eq!(to_toml(&decoded).unwrap(), expected);
            assert_eq!(serde_json::to_value(decoded).unwrap(), value);
        }
        data.records.clear();
        data.schema.columns.clear();
        let empty = to_toml(&data).unwrap();
        let decoded: TableData = toml::from_str(&empty).unwrap();
        assert_eq!(to_toml(&decoded).unwrap(), empty);
    }
}
