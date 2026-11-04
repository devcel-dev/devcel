use crate::column::ColumnSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid;

#[derive(Serialize, Deserialize, Clone)]
pub struct Record {
    pub uuid: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub parent_uuid: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub min_version: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,

    // Store column values
    // Key: column name; value: actual value
    #[serde(serialize_with = "crate::ordered_map::serialize")]
    pub values: HashMap<String, String>,

    // Store interface-origin column values
    // Key: column UUID, not interface UUID; value: actual value
    #[serde(
        default,
        skip_serializing_if = "HashMap::is_empty",
        serialize_with = "crate::ordered_map::serialize"
    )]
    pub interface_values: HashMap<String, String>,

    #[serde(
        default,
        skip_serializing_if = "HashMap::is_empty",
        serialize_with = "crate::ordered_map::serialize"
    )]
    pub memo_texts: HashMap<String, String>,
}

impl Default for Record {
    fn default() -> Self {
        Self {
            uuid: uuid::Uuid::new_v4().to_string(),
            label: String::new(),
            parent_uuid: String::new(),
            min_version: 0,
            tags: Vec::new(),
            values: HashMap::new(),
            interface_values: HashMap::new(),
            memo_texts: HashMap::new(),
        }
    }
}

impl Record {
    pub fn new() -> Self {
        Self::default()
    }

    /// Localized presentation only. Never expose generated identity labels as
    /// headings, and never change persisted labels or UUID-valued cell contents.
    pub fn display_label_diagnostic(&self, source_index: usize) -> crate::types::Diagnostic {
        if self.label.is_empty()
            || self.label == self.uuid
            || self.label == format!("record_{}", self.uuid.replace('-', ""))
        {
            crate::types::Diagnostic::Code {
                code: "grid.defaultRowLabel".into(),
                params: serde_json::json!({ "number": source_index + 1 }),
            }
        } else {
            crate::types::Diagnostic::Text {
                text: self.label.clone(),
            }
        }
    }

    /// Get a column value by column name
    pub fn get_value(&self, column_name: &str) -> Option<&String> {
        self.values.get(column_name)
    }

    /// Write raw name-keyed storage with empty input clearing the key.
    /// Authoring edits must use set_cell_value with a column definition.
    pub fn set_value(&mut self, column_name: &str, value: String) {
        if value.is_empty() {
            self.values.remove(column_name);
        } else {
            self.values.insert(column_name.to_string(), value);
        }
    }

    /// Get an interface-origin column value by column UUID
    pub fn get_interface_value(&self, column_uuid: &str) -> Option<&String> {
        self.interface_values.get(column_uuid)
    }

    /// Write raw interface storage with empty input clearing the key.
    /// Authoring edits must use set_cell_value with a column definition.
    pub fn set_interface_value(&mut self, column_uuid: &str, value: String) {
        if value.is_empty() {
            self.interface_values.remove(column_uuid);
        } else {
            self.interface_values.insert(column_uuid.to_string(), value);
        }
    }

    /// Get a cell's stored value using its column definition (the canonical interface-aware path)
    ///
    /// This is the sole place that decides which map to read.
    /// Read ordinary columns from `values` (keyed by column name) and
    /// interface-origin columns from `interface_values` (keyed by column UUID).
    ///
    /// Note: do not fall back to default values. Some callers need to distinguish
    /// empty cells from defaults, so applying defaults is the caller's responsibility.
    pub fn get_cell_value(&self, column: &ColumnSchema) -> Option<&String> {
        if column.interface_origin.is_some() {
            self.interface_values
                .get(&column.uuid)
                .filter(|value| !value.is_empty())
        } else {
            self.values
                .get(&column.data_name)
                .filter(|value| !value.is_empty())
        }
    }

    /// Set a cell value using its column definition (the canonical interface-aware path)
    ///
    /// This is the sole place that decides which map to write.
    pub fn set_cell_value(&mut self, column: &ColumnSchema, value: String) {
        if value.is_empty() {
            self.remove_cell_value(column);
            return;
        }
        if column.interface_origin.is_some() {
            self.interface_values.insert(column.uuid.clone(), value);
        } else {
            self.values.insert(column.data_name.clone(), value);
        }
    }

    /// Remove a cell value using its column definition (the canonical interface-aware path)
    pub fn remove_cell_value(&mut self, column: &ColumnSchema) {
        if column.interface_origin.is_some() {
            self.interface_values.remove(&column.uuid);
        } else {
            self.values.remove(&column.data_name);
        }
    }
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}
