//! Output-only, exact-case tag projection shared by import, runtime export and codegen.
use crate::{ColumnSchema, Project, Record, Result, TableData};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TagFilter {
    #[serde(default)]
    pub row_include_tags: Vec<String>,
    #[serde(default)]
    pub row_exclude_tags: Vec<String>,
    #[serde(default)]
    pub column_include_tags: Vec<String>,
    #[serde(default)]
    pub column_exclude_tags: Vec<String>,
}
impl TagFilter {
    fn matches(tags: &[String], include: &[String], exclude: &[String]) -> bool {
        (include.is_empty() || include.iter().any(|tag| tags.contains(tag)))
            && !exclude.iter().any(|tag| tags.contains(tag))
    }
    pub fn includes_row(&self, row: &Record, version: Option<u32>) -> bool {
        version.is_none_or(|v| row.min_version <= v)
            && Self::matches(&row.tags, &self.row_include_tags, &self.row_exclude_tags)
    }
    pub fn includes_column(&self, column: &ColumnSchema, version: Option<u32>) -> bool {
        version.is_none_or(|v| column.min_version <= v)
            && Self::matches(
                &column.tags,
                &self.column_include_tags,
                &self.column_exclude_tags,
            )
    }
    pub fn is_empty(&self) -> bool {
        self.row_include_tags.is_empty()
            && self.row_exclude_tags.is_empty()
            && self.column_include_tags.is_empty()
            && self.column_exclude_tags.is_empty()
    }
}

/// Declared ancestry is only a candidate: the retained schema must still satisfy
/// every member of the canonical, versioned interface (interface tags do not project it).
pub fn projected_interface_ids(
    project: &Project,
    data: &TableData,
    version: Option<u32>,
    filter: &TagFilter,
) -> Result<Vec<String>> {
    let roots = data
        .interface_implementations
        .keys()
        .map(ToString::to_string)
        .collect();
    let candidates = crate::json_export::expanded_interface_ids(project, roots)?;
    let mut satisfied = Vec::new();
    for id in candidates {
        let uuid = uuid::Uuid::parse_str(&id).map_err(|error| {
            crate::app_error::diagnostic(
                "error.interface.invalidId",
                serde_json::json!({"id": id, "details": error.to_string()}),
            )
        })?;
        let interface = project
            .interface_registry
            .get_interface(&uuid)
            .ok_or_else(|| {
                crate::app_error::diagnostic(
                    "error.interface.missingId",
                    serde_json::json!({"id": id}),
                )
            })?;
        let members = interface.get_effective_columns(&project.interface_registry)?;
        if members
            .iter()
            .filter(|c| version.is_none_or(|v| c.min_version <= v))
            .all(|member| {
                data.schema.columns.iter().any(|column| {
                    filter.includes_column(column, version)
                        && column.uuid == member.uuid
                        && column.data_type == member.data_type
                        && column
                            .reference_config
                            .as_ref()
                            .map(|c| &c.target_table_uuid)
                            == member
                                .reference_config
                                .as_ref()
                                .map(|c| &c.target_table_uuid)
                        && column.table_ref_config == member.table_ref_config
                })
            })
        {
            satisfied.push(id);
        }
    }
    Ok(satisfied)
}

/// Lightweight retained identities; values/formula inputs never get projected.
#[derive(Default)]
pub(crate) struct RetainedIndex {
    rows: HashMap<String, HashSet<String>>,
    interfaces: HashMap<String, Vec<String>>,
}
impl RetainedIndex {
    pub fn add(
        &mut self,
        project: &Project,
        data: &TableData,
        version: Option<u32>,
        filter: &TagFilter,
    ) -> Result<()> {
        self.rows.insert(
            data.uuid.clone(),
            data.records
                .iter()
                .filter(|r| filter.includes_row(r, version))
                .map(|r| r.uuid.clone())
                .collect(),
        );
        self.interfaces.insert(
            data.uuid.clone(),
            projected_interface_ids(project, data, version, filter)?,
        );
        Ok(())
    }
    pub fn validate(&self, table: &crate::json_export::ExportTable) -> Result<()> {
        for column in &table.columns {
            for record in &table.records {
                let value = record
                    .values
                    .get(&column.name)
                    .map(String::as_str)
                    .or(column.default_value.as_deref())
                    .unwrap_or("");
                if value.is_empty() {
                    continue;
                }
                let valid = match column.data_type {
                    crate::ValueType::Reference => {
                        column.reference_config.as_ref().is_some_and(|config| {
                            self.rows
                                .get(&config.target_table_uuid)
                                .is_some_and(|rows| rows.contains(value))
                        })
                    }
                    crate::ValueType::TableRef => {
                        column.table_ref_config.as_ref().is_some_and(|config| {
                            self.interfaces
                                .get(value)
                                .is_some_and(|ids| ids.contains(&config.interface_uuid))
                        })
                    }
                    _ => true,
                };
                if !valid {
                    return Err(crate::app_error::diagnostic(
                        "error.export.referenceUnavailable",
                        serde_json::json!({"table": table.name, "tableId": table.uuid, "row": record.id, "column": column.name, "target": value}),
                    ));
                }
            }
        }
        Ok(())
    }
}
