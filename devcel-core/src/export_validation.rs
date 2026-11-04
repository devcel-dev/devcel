//! Shared export preflight. Unloaded tables are included; version filters apply
//! before per-table uniqueness/required/range/pattern checks.
use crate::{DevcelError, Project, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportIssue {
    pub table_uuid: String,
    pub table_name: String,
    pub column_name: String,
    pub record_uuid: Option<String>,
    pub kind: String,
    pub diagnostic: crate::types::Diagnostic,
}

/// Standalone table preflight uses already-resolved interface columns. Presentation
/// settings are deliberately absent from the exported data and its validation.
pub fn lint_table(data: &crate::TableData) -> Vec<ExportIssue> {
    let table = crate::Table {
        path: Default::default(),
        data: data.clone(),
        is_dirty: false,
        undo_history: Vec::new(),
        redo_history: Vec::new(),
    };
    let mut issues = Vec::new();
    for column in &data.schema.columns {
        for issue in table.check_column_constraints(column, column) {
            issues.push(ExportIssue {
                table_uuid: data.uuid.clone(),
                table_name: data.display_name.clone(),
                column_name: issue.column_name,
                record_uuid: issue.record_uuid,
                kind: issue.constraint_type,
                diagnostic: issue.diagnostic,
            });
        }
    }
    for issue in crate::cell_rules::table_issues(data) {
        issues.push(ExportIssue {
            table_uuid: data.uuid.clone(),
            table_name: data.display_name.clone(),
            column_name: issue.column_name,
            record_uuid: issue.record_uuid,
            kind: format!("input_{}", issue.kind),
            diagnostic: issue.diagnostic,
        });
    }
    issues
}

pub fn require_clean_table(data: &crate::TableData, allow_invalid: bool) -> Result<()> {
    let issues = lint_table(data);
    if issues.is_empty() || allow_invalid {
        return Ok(());
    }
    Err(export_error(&issues))
}

/// Validate one table against the same project contracts as LintProject, without loading others.
pub(crate) fn lint_project_table_with_evaluator(
    project: &Project,
    table: &crate::Table,
    version: Option<u32>,
    evaluator: &mut crate::cell_rules::FormulaEvaluator<'_>,
) -> Result<Vec<ExportIssue>> {
    lint_project_table_projected(
        project,
        table,
        version,
        &crate::tag_filter::TagFilter::default(),
        evaluator,
    )
}

fn lint_project_table_projected(
    project: &Project,
    table: &crate::Table,
    version: Option<u32>,
    filter: &crate::tag_filter::TagFilter,
    evaluator: &mut crate::cell_rules::FormulaEvaluator<'_>,
) -> Result<Vec<ExportIssue>> {
    let mut issues = Vec::new();
    let mut table = crate::Table {
        path: table.path.clone(),
        data: table.data.clone(),
        is_dirty: false,
        undo_history: Vec::new(),
        redo_history: Vec::new(),
    };
    if let Some(version) = version {
        // Keep hidden parent rows for inheritance and child-context formulas.
        // Validation iteration below projects only rows included in this release.
        // Keep every source column available to formula evaluation, while
        // skipping input rules on fields that are absent from this release.
        // This is a private validation copy; live data and metadata stay intact.
        for column in &mut table.data.schema.columns {
            if column.min_version > version {
                column.input_validation = None;
            }
        }
    }
    for column in &mut table.data.schema.columns {
        if !filter.includes_column(column, version) {
            column.input_validation = None;
        }
    }
    let included = |column: &crate::ColumnSchema| filter.includes_column(column, version);
    let table_uuid = table.data.uuid.clone();
    let table_name = table.data.display_name.clone();
    let mut add = |column_name: String,
                   record_uuid: Option<String>,
                   kind: String,
                   diagnostic: crate::types::Diagnostic| {
        issues.push(ExportIssue {
            table_uuid: table_uuid.clone(),
            table_name: table_name.clone(),
            column_name,
            record_uuid,
            kind,
            diagnostic,
        });
    };
    for issue in crate::cell_rules::table_issues_for_version(&table.data, evaluator, None, version)
        .expect("evaluation without cancellation cannot be cancelled")
    {
        add(
            issue.column_name,
            issue.record_uuid,
            format!("input_{}", issue.kind),
            issue.diagnostic,
        );
    }
    let inheritance = crate::table::InheritanceResolver::new(&table.data);
    for column in table.data.schema.columns.iter().filter(|c| included(c)) {
        if column
            .input_validation
            .as_ref()
            .is_some_and(|settings| !settings.rules.is_empty())
        {
            continue;
        }
        for record in table
            .data
            .records
            .iter()
            .filter(|r| version.is_none_or(|v| r.min_version <= v))
        {
            let value = match inheritance.input(record, column) {
                Ok(value) => value,
                Err(error) => {
                    add(
                        column.display_name.clone(),
                        Some(record.uuid.clone()),
                        "parent".into(),
                        crate::AppError::from(error).into_diagnostic(),
                    );
                    continue;
                }
            };
            if value.starts_with('=') {
                if let crate::types::FormulaResult::Error(error) =
                    evaluator(&table.data, column, record, value)
                {
                    add(
                        column.display_name.clone(),
                        Some(record.uuid.clone()),
                        "formula".into(),
                        error.diagnostic(),
                    );
                }
            }
        }
    }
    for column in table
        .data
        .schema
        .columns
        .iter()
        .filter(|c| c.interface_origin.is_none() && included(c))
    {
        for v in table.check_column_constraints_for_version(column, column, version) {
            add(
                v.column_name,
                v.record_uuid,
                v.constraint_type,
                v.diagnostic,
            );
        }
    }
    for id in table.data.interface_implementations.keys() {
        let Some(interface) = project.get_interface(id) else {
            add(
                String::new(),
                None,
                "missing_interface".into(),
                crate::types::Diagnostic::Code {
                    code: "interface.exportValidation.missingInterface".into(),
                    params: serde_json::json!({ "interface": id.to_string() }),
                },
            );
            continue;
        };
        let effective_columns = interface.get_effective_columns(&project.interface_registry)?;
        for definition in effective_columns
            .iter()
            .filter(|c| version.is_none_or(|v| c.min_version <= v))
        {
            let column =
                table.data.schema.columns.iter().find(|column| {
                    column.interface_origin.is_some() && column.uuid == definition.uuid
                });
            let Some(column) = column else {
                add(
                    definition.data_name.clone(),
                    None,
                    "missing_column".into(),
                    crate::types::Diagnostic::Code {
                        code: "interface.exportValidation.missingColumn".into(),
                        params: serde_json::json!({ "name": definition.data_name }),
                    },
                );
                continue;
            };
            if !included(column) {
                continue;
            }
            if column.data_type != definition.data_type {
                add(
                    definition.data_name.clone(),
                    None,
                    "column_type".into(),
                    crate::types::Diagnostic::Code {
                        code: "interface.exportValidation.columnType".into(),
                        params: serde_json::json!({
                            "name": definition.data_name,
                            "expectedType": format!("{:?}", definition.data_type),
                            "actualType": format!("{:?}", column.data_type),
                        }),
                    },
                );
            }
            for violation in table.check_column_constraints_for_version(definition, column, version)
            {
                add(
                    violation.column_name,
                    violation.record_uuid,
                    violation.constraint_type,
                    violation.diagnostic,
                );
            }
        }
    }
    Ok(issues)
}

/// Validate only retained output cells, while resolving inheritance and formulas
/// against the complete source. The private copy is never installed in Project.
pub(crate) fn lint_project_table_with_filters(
    project: &Project,
    table: &crate::Table,
    version: Option<u32>,
    filter: &crate::tag_filter::TagFilter,
    evaluator: &mut crate::cell_rules::FormulaEvaluator<'_>,
) -> Result<Vec<ExportIssue>> {
    if filter.is_empty() {
        return lint_project_table_with_evaluator(project, table, version, evaluator);
    }
    let mut projected = table.clone();
    projected
        .data
        .records
        .retain(|r| filter.includes_row(r, version));
    let inheritance = crate::table::InheritanceResolver::new(&table.data);
    let source_records: std::collections::HashMap<_, _> = table
        .data
        .records
        .iter()
        .map(|r| (r.uuid.as_str(), r))
        .collect();
    for record in &mut projected.data.records {
        let source = source_records[record.uuid.as_str()];
        for column in projected
            .data
            .schema
            .columns
            .iter()
            .filter(|c| filter.includes_column(c, version))
        {
            let input = inheritance.input(source, column)?;
            record.set_cell_value(column, input.to_owned());
        }
        record.parent_uuid.clear();
    }
    let mut source_evaluator = |_: &crate::TableData,
                                column: &crate::ColumnSchema,
                                record: &crate::Record,
                                formula: &str| {
        let source = source_records
            .get(record.uuid.as_str())
            .copied()
            .unwrap_or(record);
        evaluator(&table.data, column, source, formula)
    };
    lint_project_table_projected(project, &projected, version, filter, &mut source_evaluator)
}

pub fn lint_project(
    project: &mut Project,
    table_uuid: Option<&str>,
    version: Option<u32>,
) -> Result<Vec<ExportIssue>> {
    if let Some(id) = table_uuid {
        project.ensure_table_loaded_by_uuid(id)?;
    }
    let context = crate::formula_context::ProjectFormulaContext::new(project, version)?;
    let mut evaluator = |data: &crate::TableData,
                         column: &crate::ColumnSchema,
                         record: &crate::Record,
                         formula: &str| {
        context.evaluate_cell_with_override(data, column, record, formula)
    };
    let mut paths = std::collections::BTreeSet::new();
    if table_uuid.is_none() {
        for entry in project.get_project_entries()? {
            if entry.entry_type == crate::ProjectEntryType::Table {
                paths.insert(project.resolve_table_path(&std::path::PathBuf::from(entry.path))?);
            }
        }
    }
    paths.extend(
        project
            .tables_data
            .iter()
            .filter(|(_, table)| table_uuid.is_none_or(|id| id == table.data.uuid))
            .map(|(path, _)| path.clone()),
    );
    let mut issues = Vec::new();
    for path in paths {
        let unloaded;
        let table = if let Some(table) = project.tables_data.get(&path) {
            table
        } else {
            unloaded = crate::json_export::read_unloaded_export_table(project, &path)?;
            &unloaded
        };
        issues.extend(lint_project_table_with_evaluator(
            project,
            table,
            version,
            &mut evaluator,
        )?);
    }
    let mut seen = HashSet::new();
    issues.retain(|v| {
        seen.insert((
            v.table_uuid.clone(),
            v.column_name.clone(),
            v.record_uuid.clone(),
            v.kind.clone(),
            v.diagnostic.to_string(),
        ))
    });
    issues.sort_by(|a, b| {
        (&a.table_name, &a.column_name, &a.record_uuid, &a.kind).cmp(&(
            &b.table_name,
            &b.column_name,
            &b.record_uuid,
            &b.kind,
        ))
    });
    Ok(issues)
}

pub fn require_clean(
    project: &mut Project,
    table_uuid: Option<&str>,
    version: Option<u32>,
    allow_invalid: bool,
) -> Result<()> {
    let issues = lint_project(project, table_uuid, version)?;
    if issues.is_empty() || allow_invalid {
        return Ok(());
    }
    Err(export_error(&issues))
}

pub(crate) fn export_error(issues: &[ExportIssue]) -> DevcelError {
    let mut diagnostics = vec![crate::types::Diagnostic::Code {
        code: "error.export.constraints".into(),
        params: serde_json::json!({"count": issues.len()}),
    }];
    for issue in issues.iter().take(8) {
        diagnostics.push(crate::types::Diagnostic::Text {
            text: format!("{} / {}:", issue.table_name, issue.column_name),
        });
        diagnostics.push(issue.diagnostic.clone());
    }
    DevcelError::Diagnostics(diagnostics)
}
