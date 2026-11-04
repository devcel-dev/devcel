//! Atomic editor boundary. Preview and save share the same Rust validation;
//! preview never loads into live state, writes files, or changes history.
use crate::cell_rules::{
    self, CellPresentation, ConditionalFormatting, InputValidationSettings, ValidationIssue,
    ValidationMode, ValidationReport,
};
use crate::commands::{CommandData, UpdateInterfaceCommand, INTERFACE_COLUMN_LOCKED_MSG};
use crate::edit_controls::normalize_tags_preserving_existing;
use crate::{
    ColumnSchema, CurveConfig, DevcelError, InterfaceChange, Project, ReferenceConfig, Result,
    SelectConfig, Table, TableData, TableRefConfig, ValueType,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorMode {
    Table,
    Interface,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EditorTarget {
    pub mode: EditorMode,
    pub target_uuid: String,
    #[serde(deserialize_with = "required_column_uuid")]
    pub column_uuid: Option<String>,
    pub insert_index: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EditorDraft {
    pub min_version: String,
    pub read_only: bool,
    pub name: String,
    /// Display label independent of the internal name. None retains the legacy wire contract.
    #[serde(default)]
    pub display_name: Option<String>,
    pub column_type: String,
    pub tooltip: String,
    pub memo_text: String,
    pub default_value: String,
    pub color: String,
    pub tags: Vec<String>,
    pub font_size: u32,
    pub reference_config: Option<ReferenceConfig>,
    pub curve_config: Option<CurveConfig>,
    pub table_ref_config: Option<TableRefConfig>,
    pub select_config: Option<SelectConfig>,
    pub color_swatches: Vec<crate::ColorSwatch>,
    #[serde(default)]
    pub input_validation: Option<InputValidationSettings>,
    #[serde(default)]
    pub conditional_formatting: Option<ConditionalFormatting>,
    #[serde(default)]
    pub conditional_formatting_override: Option<ConditionalFormatting>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EditorRequest {
    pub target: EditorTarget,
    pub draft: EditorDraft,
    pub expected_revision: Option<String>,
    /// UUID from load_column_editor for a new column; keeps warning previews stable.
    #[serde(default)]
    pub creation_uuid: Option<String>,
    #[serde(default)]
    pub acknowledgement: Option<String>,
    #[serde(default)]
    pub acknowledgements: BTreeMap<String, String>,
}

#[derive(Serialize)]
pub struct EditorContext {
    pub target: EditorTarget,
    pub name: String,
    pub column: ColumnSchema,
    pub revision: Option<String>,
    pub interface_owned: bool,
    pub origin_name: Option<String>,
    pub implementing_tables: Vec<String>,
}

#[derive(Default, Serialize)]
pub struct EditorPreview {
    /// Bounded, display-only locations for returned sample/diagnostic identities.
    pub locations: BTreeMap<String, EditorPreviewLocations>,
    pub type_changed: bool,
    pub total_values: usize,
    pub valid_count: usize,
    pub error_count: usize,
    pub changed_count: usize,
    pub empty_count: usize,
    pub samples: Vec<EditorSample>,
    pub errors: Vec<crate::types::Diagnostic>,
    /// All issues are counted, but only 20 diagnostic/sample rows are returned.
    pub input_issues: Vec<ValidationIssue>,
    pub input_issue_count: usize,
    pub reject_issue_count: usize,
    pub warning_issue_count: usize,
    pub input_reports: Vec<EditorInputReport>,
    pub presentation_samples: Vec<EditorPresentationSample>,
    /// Full-table ranking/uniqueness population, never the displayed sample size.
    pub population_count: usize,
    pub ranking_population_count: usize,
    pub definition_issues: Vec<crate::types::Diagnostic>,
}

#[derive(Serialize)]
pub struct EditorPreviewLocations {
    pub table_name: String,
    pub records: BTreeMap<String, crate::types::Diagnostic>,
}

#[derive(Serialize)]
pub struct EditorInputReport {
    pub table_uuid: String,
    pub report: ValidationReport,
}

#[derive(Serialize)]
pub struct EditorPresentationSample {
    pub table_uuid: String,
    pub record_uuid: String,
    pub column_uuid: String,
    pub presentation: CellPresentation,
}

#[derive(Serialize)]
pub struct EditorSample {
    pub table_uuid: Option<String>,
    pub record_uuid: Option<String>,
    pub source: String,
    pub original_value: String,
    pub converted_value: Option<String>,
    pub error: Option<crate::types::Diagnostic>,
}

#[derive(Debug, Serialize)]
pub struct EditorSaved {
    pub column_uuid: String,
}

fn validation(message: impl Into<String>) -> DevcelError {
    crate::app_error::authoring_error(message)
}

fn required_column_uuid<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    let id = Option::<String>::deserialize(deserializer)?;
    if let Some(id) = &id {
        uuid::Uuid::parse_str(id).map_err(serde::de::Error::custom)?;
    }
    Ok(id)
}

fn is_edit(target: &EditorTarget) -> bool {
    target.column_uuid.is_some()
}

fn selected<'a>(
    columns: &'a [ColumnSchema],
    target: &EditorTarget,
) -> Result<Option<&'a ColumnSchema>> {
    if !is_edit(target) {
        return Ok(None);
    }
    columns
        .iter()
        .find(|c| target.column_uuid.as_ref() == Some(&c.uuid))
        .map(Some)
        .ok_or_else(|| DevcelError::NotFound("Column not found. Reload the data".into()))
}

/// Read records only for the tables whose values are needed by this validation.
/// Other entries stay metadata-only; TableRef validation needs no record bodies.
fn validation_table_data(
    project: &Project,
    interface_uuid: Option<&str>,
    old_column: Option<&ColumnSchema>,
    reference_target: Option<&str>,
) -> Result<Vec<TableData>> {
    let mut tables = project.get_table_catalog_data()?;
    for table in &mut tables {
        let interface_affected = if let Some(id) = interface_uuid {
            table_implements(project, table, id)?
                || old_column.is_some_and(|old| {
                    table
                        .schema
                        .columns
                        .iter()
                        .any(|column| column.uuid == old.uuid)
                })
        } else {
            false
        };
        if interface_affected || reference_target == Some(table.uuid.as_str()) {
            *table = project.read_table_data_by_uuid(&table.uuid)?;
        }
    }
    tables.sort_by(|a, b| a.uuid.cmp(&b.uuid));
    Ok(tables)
}

pub fn load(project: &Project, target: &EditorTarget) -> Result<EditorContext> {
    load_context(project, target, true)
}

fn load_context(
    project: &Project,
    target: &EditorTarget,
    include_implementations: bool,
) -> Result<EditorContext> {
    let (name, old, revision) = match target.mode {
        EditorMode::Table => {
            let table = project.read_table_data_by_uuid(&target.target_uuid)?;
            let old = selected(&table.schema.columns, target)?.cloned();
            let revision = old
                .as_ref()
                .map(|column| {
                    serde_json::to_vec(column).map(|bytes| format!("{:x}", Sha256::digest(bytes)))
                })
                .transpose()?;
            (table.display_name.clone(), old, revision)
        }
        EditorMode::Interface => {
            let id = uuid::Uuid::parse_str(&target.target_uuid)
                .map_err(|e| validation(e.to_string()))?;
            let interface = project
                .get_interface(&id)
                .ok_or_else(|| DevcelError::NotFound("Interface not found".into()))?;
            let old = selected(&interface.columns, target)?.cloned();
            let revision = old
                .as_ref()
                .map(|_| interface.current_version_id.to_string());
            (interface.name.clone(), old, revision)
        }
    };
    let column = old.unwrap_or_else(|| ColumnSchema {
        data_type: ValueType::I32,
        ..ColumnSchema::default()
    });
    let origin_name = column
        .interface_origin
        .as_ref()
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .and_then(|id| project.get_interface(&id))
        .map(|i| i.name.clone())
        .or_else(|| column.interface_origin_name_fallback.clone());
    let implementing_tables =
        if include_implementations && matches!(target.mode, EditorMode::Interface) {
            let mut names = Vec::new();
            for table in project.get_table_catalog_data()? {
                if table_implements(project, &table, &target.target_uuid)?
                    || table.schema.columns.iter().any(|c| c.uuid == column.uuid)
                {
                    names.push(table.display_name.clone());
                }
            }
            names.sort();
            names
        } else {
            Vec::new()
        };
    Ok(EditorContext {
        target: target.clone(),
        name,
        interface_owned: column.interface_origin.as_ref().is_some_and(|origin| {
            matches!(target.mode, EditorMode::Table) || origin != &target.target_uuid
        }),
        column,
        revision,
        origin_name,
        implementing_tables,
    })
}

fn draft_column(
    project: &Project,
    request: &EditorRequest,
    context: &EditorContext,
) -> Result<ColumnSchema> {
    if request.expected_revision != context.revision {
        return Err(validation(
            "The column was updated by another operation. Reload the data",
        ));
    }
    let draft = &request.draft;
    if !draft.color.is_empty() && !crate::color::decorative_hex_color(&draft.color) {
        return Err(validation(
            "The column color must be empty or in #RRGGBB format",
        ));
    }
    // Table UI edits the display name; unchanged localized labels must not
    // rename the underlying data key or invoke data-name validation.
    let original_name = match request.target.mode {
        EditorMode::Table if draft.display_name.is_none() => &context.column.display_name,
        _ => &context.column.data_name,
    };
    let name_changed = !is_edit(&request.target) || &draft.name != original_name;
    if name_changed {
        crate::validate_data_name(&draft.name)?;
    }
    let mut column = context.column.clone();
    if !is_edit(&request.target) {
        if let Some(id) = &request.creation_uuid {
            uuid::Uuid::parse_str(id)
                .map_err(|_| validation("The new column ID is invalid. Reload the data"))?;
            let already_exists = match request.target.mode {
                EditorMode::Table => project
                    .read_table_data_by_uuid(&request.target.target_uuid)?
                    .schema
                    .columns
                    .iter()
                    .any(|c| &c.uuid == id),
                EditorMode::Interface => uuid::Uuid::parse_str(&request.target.target_uuid)
                    .ok()
                    .and_then(|id| project.get_interface(&id))
                    .is_some_and(|interface| interface.columns.iter().any(|c| &c.uuid == id)),
            };
            if already_exists {
                return Err(validation(
                    "A column with the same ID already exists. Reload the data",
                ));
            }
            column.uuid = id.clone();
        } else if request.acknowledgement.is_some() || !request.acknowledgements.is_empty() {
            return Err(validation(
                "To confirm warnings for the new column, reload the column settings and retry with the same column ID",
            ));
        }
    }
    let value_type =
        crate::operations::value_type_from_string(&draft.column_type).map_err(validation)?;
    // Content versions belong to the dedicated version editor, never a restored column draft.
    let structural_change = name_changed
        || value_type != column.data_type
        || draft.default_value != column.default_value
        || draft.reference_config != column.reference_config
        || draft.curve_config != column.curve_config
        || draft.table_ref_config != column.table_ref_config
        || draft.select_config != column.select_config
        || draft.color_swatches != column.color_swatches
        || draft.input_validation != column.input_validation
        || draft.conditional_formatting != column.conditional_formatting;
    if matches!(request.target.mode, EditorMode::Table)
        && context.interface_owned
        && structural_change
    {
        return Err(DevcelError::InvalidOperation(
            INTERFACE_COLUMN_LOCKED_MSG.into(),
        ));
    }
    if name_changed {
        if matches!(request.target.mode, EditorMode::Table)
            || !is_edit(&request.target)
            || column.display_name == column.data_name
        {
            column.display_name = draft.name.clone();
        }
        column.data_name = draft.name.clone();
    }
    {
        if let Some(display_name) = &draft.display_name {
            column.display_name = if display_name.trim().is_empty() {
                column.data_name.clone()
            } else {
                display_name.clone()
            };
        }
    }
    crate::validate_data_name(&column.data_name)?;
    if matches!(request.target.mode, EditorMode::Interface) && draft.read_only != column.read_only {
        return Err(validation(
            "Change write protection in the table's column settings",
        ));
    }
    column.read_only = draft.read_only;
    column.data_type = value_type;
    column.tooltip = draft.tooltip.clone();
    column.memo_text = draft.memo_text.clone();
    column.default_value = draft.default_value.clone();
    if !(matches!(request.target.mode, EditorMode::Table) && context.interface_owned) {
        column.normalize_color_default()?;
    }
    if !(6..=72).contains(&draft.font_size) {
        return Err(validation("Font size must be between 6 and 72"));
    }
    if matches!(request.target.mode, EditorMode::Interface)
        && normalize_tags_preserving_existing(&draft.tags, &column.tags) != column.tags
    {
        return Err(validation("Edit column tags in the table column settings"));
    }
    column.tags = normalize_tags_preserving_existing(&draft.tags, &column.tags);
    column.style.font_size = draft.font_size;
    column.style.color = draft.color.clone();
    column.reference_config = draft.reference_config.clone();
    column.curve_config = draft.curve_config.clone();
    column.table_ref_config = draft.table_ref_config.clone();
    column.select_config = draft.select_config.clone();
    column.color_swatches = crate::normalize_color_swatches(draft.color_swatches.clone())?;
    column.input_validation = draft.input_validation.clone();
    column.conditional_formatting = draft.conditional_formatting.clone();
    column.conditional_formatting_override = draft.conditional_formatting_override.clone();
    if column.conditional_formatting_override.is_some()
        && (!matches!(request.target.mode, EditorMode::Table) || !context.interface_owned)
    {
        return Err(validation(
            "Table-specific formatting can only be applied to interface-derived columns",
        ));
    }
    // Reject mismatched configuration instead of silently deleting unrelated settings.
    for (present, expected) in [
        (column.reference_config.is_some(), ValueType::Reference),
        (column.curve_config.is_some(), ValueType::Curve),
        (column.table_ref_config.is_some(), ValueType::TableRef),
        (column.select_config.is_some(), ValueType::Select),
    ] {
        if present && column.data_type != expected {
            return Err(validation(
                "The type does not match the additional settings",
            ));
        }
    }
    if let Some(config) = &column.curve_config {
        if !config.start_value.is_finite() || !config.end_value.is_finite() {
            return Err(validation("Curve endpoints must be finite values"));
        }
    }
    if let Some(config) = &column.select_config {
        config.validate().map_err(validation)?;
    }
    if let Some(config) = &column.table_ref_config {
        let id =
            uuid::Uuid::parse_str(&config.interface_uuid).map_err(|e| validation(e.to_string()))?;
        if project.get_interface(&id).is_none() {
            return Err(validation("Referenced interface not found"));
        }
    }
    if matches!(request.target.mode, EditorMode::Interface) && !is_edit(&request.target) {
        column.interface_origin = Some(request.target.target_uuid.clone());
        column.interface_origin_name_fallback = Some(context.name.clone());
    }
    Ok(column)
}

/// Decimal-value identity catches integer precision loss, float overflow, and
/// f32 truncation without rejecting harmless spelling such as 1.00 versus 1.
fn decimal_key(raw: &str) -> Option<(bool, String, i64)> {
    let raw = raw.trim();
    let negative = raw.starts_with('-');
    let raw = raw.trim_start_matches(['-', '+']);
    let mut parts = raw.split(['e', 'E']);
    let mantissa = parts.next()?;
    let exponent: i64 = parts.next().map(str::parse).transpose().ok()?.unwrap_or(0);
    if parts.next().is_some() {
        return None;
    }
    let mut halves = mantissa.split('.');
    let whole = halves.next()?;
    let fraction = halves.next().unwrap_or("");
    if halves.next().is_some() {
        return None;
    }
    let mut digits = format!("{whole}{fraction}");
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits = digits.trim_start_matches('0').to_string();
    if digits.is_empty() {
        return Some((false, "0".into(), 0));
    }
    let zeros = digits.len() - digits.trim_end_matches('0').len();
    digits.truncate(digits.len() - zeros);
    Some((
        negative,
        digits,
        exponent
            .checked_sub(fraction.len() as i64)?
            .checked_add(zeros as i64)?,
    ))
}

fn table_implements(project: &Project, table: &TableData, interface_uuid: &str) -> Result<bool> {
    let ids = crate::json_export::expanded_interface_ids(
        project,
        table
            .interface_implementations
            .keys()
            .map(ToString::to_string)
            .collect(),
    )?;
    Ok(ids.iter().any(|id| id == interface_uuid))
}

fn conversion_diagnostic(code: &str) -> crate::types::Diagnostic {
    crate::types::Diagnostic::Code {
        code: code.into(),
        params: serde_json::json!({}),
    }
}

fn convert_value(
    project: &Project,
    column: &ColumnSchema,
    value: &str,
    type_changed: bool,
    tables: &[TableData],
) -> std::result::Result<String, crate::types::Diagnostic> {
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.starts_with('=') {
        if type_changed {
            return Err(conversion_diagnostic(
                "column.conversion.formulaReviewRequired",
            ));
        }
        return Ok(value.into());
    }
    if column.data_type == ValueType::None {
        return Err(conversion_diagnostic("column.conversion.undefinedType"));
    }
    // The validator remains authoritative; the editor gives its type failure a
    // structured presentation instead of leaking a language-specific message.
    let converted =
        column
            .validate_value(&value.to_owned())
            .map_err(|_| crate::types::Diagnostic::Code {
                code: "column.conversion.invalidValue".into(),
                params: serde_json::json!({
                    "type": crate::operations::value_type_to_string(&column.data_type)
                }),
            })?;
    if matches!(column.data_type, ValueType::F32 | ValueType::F64)
        && (!converted.parse::<f64>().is_ok_and(f64::is_finite)
            || decimal_key(value) != decimal_key(&converted))
    {
        return Err(conversion_diagnostic("column.conversion.precisionLoss"));
    }
    if let Some(config) = &column.select_config {
        if !config.options.iter().any(|option| option.value == value) {
            return Err(conversion_diagnostic(
                "column.conversion.selectValueUnavailable",
            ));
        }
    }
    if column.data_type == ValueType::Reference {
        let config = column
            .reference_config
            .as_ref()
            .ok_or_else(|| conversion_diagnostic("column.conversion.referenceConfigMissing"))?;
        let table = tables
            .iter()
            .find(|t| t.uuid == config.target_table_uuid)
            .ok_or_else(|| conversion_diagnostic("column.conversion.referenceTableMissing"))?;
        if !table.records.iter().any(|r| r.uuid == value) {
            return Err(conversion_diagnostic(
                "column.conversion.referenceRecordMissing",
            ));
        }
    }
    if column.data_type == ValueType::TableRef {
        let config = column.table_ref_config.as_ref().ok_or_else(|| {
            conversion_diagnostic("column.conversion.tableReferenceConfigMissing")
        })?;
        let table = tables
            .iter()
            .find(|t| t.uuid == value)
            .ok_or_else(|| conversion_diagnostic("column.conversion.referenceTableMissing"))?;
        if !table_implements(project, table, &config.interface_uuid)
            .map_err(|error| crate::AppError::from(error).into_diagnostic())?
        {
            return Err(conversion_diagnostic(
                "column.conversion.referenceInterfaceNotImplemented",
            ));
        }
    }
    Ok(converted)
}

impl EditorPreview {
    fn value(
        &mut self,
        project: &Project,
        column: &ColumnSchema,
        raw: &str,
        table_uuid: Option<String>,
        record_uuid: Option<String>,
        tables: &[TableData],
    ) -> Option<String> {
        self.total_values += 1;
        if raw.is_empty() {
            self.empty_count += 1;
        }
        let (converted, error) =
            match convert_value(project, column, raw, self.type_changed, tables) {
                Ok(value) => {
                    self.valid_count += 1;
                    if value != raw {
                        self.changed_count += 1;
                    }
                    (Some(value), None)
                }
                Err(error) => {
                    self.error_count += 1;
                    (None, Some(error))
                }
            };
        let sample = EditorSample {
            table_uuid,
            source: if record_uuid.is_some() {
                "record"
            } else {
                "default"
            }
            .into(),
            record_uuid,
            original_value: raw.into(),
            converted_value: converted.clone(),
            error,
        };
        // Keep a bounded response, with failed values taking precedence over valid samples.
        if self.samples.len() < 20 {
            self.samples.push(sample);
        } else if sample.error.is_some() {
            if let Some(index) = self.samples.iter().rposition(|s| s.error.is_none()) {
                self.samples[index] = sample;
            }
        }
        converted
    }
}

struct Prepared {
    column: ColumnSchema,
    old: Option<ColumnSchema>,
    table_data: Option<TableData>,
    preview: EditorPreview,
}

fn prepare(project: &Project, request: &EditorRequest) -> Result<Prepared> {
    let context = load_context(project, &request.target, false)?;
    let old = is_edit(&request.target).then(|| context.column.clone());
    let mut column = draft_column(project, request, &context)?;
    if let Err(error) = cell_rules::normalize_column_rules(&mut column)
        .and_then(|_| cell_rules::validate_column_definition(&column))
    {
        let error = crate::AppError::from(error).into_diagnostic();
        return Ok(Prepared {
            column,
            old,
            table_data: None,
            preview: EditorPreview {
                errors: vec![error.clone()],
                definition_issues: vec![error],
                ..EditorPreview::default()
            },
        });
    }
    // Normalizing an editable override must not rewrite inherited base rules
    // through this otherwise non-structural edit.
    if matches!(request.target.mode, EditorMode::Table) && context.interface_owned {
        column.input_validation = context.column.input_validation.clone();
        column.conditional_formatting = context.column.conditional_formatting.clone();
    }
    let type_changed = old
        .as_ref()
        .is_some_and(|old| old.data_type != column.data_type);
    let revalidate_values = old.as_ref().is_some_and(|old| {
        type_changed
            || old.reference_config != column.reference_config
            || old.table_ref_config != column.table_ref_config
            || old.select_config != column.select_config
    });
    // Interface validation reads only affected implementations. References read
    // their one target; table-reference membership uses metadata alone.
    let validate_default = old
        .as_ref()
        .is_none_or(|old| revalidate_values || old.default_value != column.default_value);
    let tables = if matches!(request.target.mode, EditorMode::Interface)
        || ((revalidate_values || validate_default)
            && matches!(column.data_type, ValueType::Reference | ValueType::TableRef))
    {
        validation_table_data(
            project,
            matches!(request.target.mode, EditorMode::Interface)
                .then_some(request.target.target_uuid.as_str()),
            old.as_ref(),
            column.reference_config.as_ref().and_then(|config| {
                (revalidate_values || validate_default).then_some(config.target_table_uuid.as_str())
            }),
        )?
    } else {
        Vec::new()
    };
    if let Some(config) = column.reference_config.as_ref().filter(|_| {
        old.as_ref()
            .is_none_or(|old| revalidate_values || old.default_value != column.default_value)
    }) {
        let table = tables
            .iter()
            .find(|t| t.uuid == config.target_table_uuid)
            .ok_or_else(|| validation("The referenced table could not be found."))?;
        if config
            .display_column_uuid
            .as_ref()
            .is_some_and(|id| !table.schema.columns.iter().any(|c| &c.uuid == id))
        {
            return Err(validation("Referenced display column not found"));
        }
    }
    if old.is_none() || type_changed {
        if column.data_type == ValueType::Reference && column.reference_config.is_none() {
            return Err(validation("Specify the referenced table"));
        }
        if column.data_type == ValueType::TableRef && column.table_ref_config.is_none() {
            return Err(validation("Specify the referenced interface"));
        }
    }
    let mut preview = EditorPreview {
        type_changed,
        ..EditorPreview::default()
    };
    if old
        .as_ref()
        .is_none_or(|old| revalidate_values || old.default_value != column.default_value)
    {
        if let Some(value) =
            preview.value(project, &column, &column.default_value, None, None, &tables)
        {
            column.default_value = value;
        }
    }
    if old
        .as_ref()
        .is_none_or(|old| revalidate_values || old.default_value != column.default_value)
    {
        if let Some(constraints) = &column.constraints {
            if let Err(error) = crate::Interface::validate_default_against_constraints(
                &column.data_name,
                &column.default_value,
                constraints,
            ) {
                preview
                    .errors
                    .push(crate::AppError::from(error).into_diagnostic());
            }
        }
    }
    let mut interface_candidate = None;
    let table_data = match request.target.mode {
        EditorMode::Table => {
            let mut data = project.read_table_data_by_uuid(&request.target.target_uuid)?;
            if data.schema.columns.iter().any(|c| {
                c.data_name == column.data_name && old.as_ref().is_none_or(|old| old.uuid != c.uuid)
            }) {
                return Err(validation("A column with the same name already exists"));
            }
            if let Some(old) = &old {
                for record in &mut data.records {
                    let value = record.get_cell_value(old).cloned();
                    let converted = if revalidate_values {
                        preview.value(
                            project,
                            &column,
                            value.as_deref().unwrap_or(""),
                            Some(data.uuid.clone()),
                            Some(record.uuid.clone()),
                            &tables,
                        )
                    } else {
                        value.clone()
                    };
                    if old.data_name != column.data_name && old.interface_origin.is_none() {
                        // A stale orphan entry must never be overwritten by a rename.
                        if record.values.contains_key(&column.data_name) {
                            return Err(validation(
                                "Cannot rename because stored values already exist under the new name",
                            ));
                        }
                        record.values.remove(&old.data_name);
                    }
                    if value.is_some() && (revalidate_values || old.data_name != column.data_name) {
                        if let Some(converted) = converted {
                            record.set_cell_value(&column, converted);
                        }
                    }
                }
                let index = data
                    .schema
                    .columns
                    .iter()
                    .position(|c| c.uuid == old.uuid)
                    .unwrap();
                data.schema.columns[index] = column.clone();
            } else {
                if data
                    .records
                    .iter()
                    .any(|r| r.values.contains_key(&column.data_name))
                {
                    return Err(validation("Stored values with the same name already exist"));
                }
                let index = request
                    .target
                    .insert_index
                    .unwrap_or(data.schema.columns.len())
                    .min(data.schema.columns.len());
                data.schema.columns.insert(index, column.clone());
            }
            if revalidate_values
                || old
                    .as_ref()
                    .is_none_or(|old| old.default_value != column.default_value)
            {
                let candidate = Table {
                    path: Default::default(),
                    is_dirty: false,
                    data: data.clone(),
                    undo_history: Vec::new(),
                    redo_history: Vec::new(),
                };
                preview.errors.extend(
                    candidate
                        .check_column_constraints(&column, &column)
                        .into_iter()
                        .map(|v| v.diagnostic),
                );
            }
            Some(data)
        }
        EditorMode::Interface => {
            if revalidate_values {
                if let Some(old) = &old {
                    for table in &tables {
                        for table_column in
                            table.schema.columns.iter().filter(|c| c.uuid == old.uuid)
                        {
                            for record in &table.records {
                                let raw = record
                                    .get_cell_value(table_column)
                                    .map(String::as_str)
                                    .unwrap_or("");
                                preview.value(
                                    project,
                                    &column,
                                    raw,
                                    Some(table.uuid.clone()),
                                    Some(record.uuid.clone()),
                                    &tables,
                                );
                            }
                            let mut candidate_column = column.clone();
                            candidate_column.uuid = table_column.uuid.clone();
                            candidate_column.data_name = table_column.data_name.clone();
                            candidate_column.interface_origin =
                                table_column.interface_origin.clone();
                            let candidate_table = Table {
                                path: Default::default(),
                                data: table.clone(),
                                is_dirty: false,
                                undo_history: Vec::new(),
                                redo_history: Vec::new(),
                            };
                            preview.errors.extend(
                                candidate_table
                                    .check_column_constraints(&column, &candidate_column)
                                    .into_iter()
                                    .map(|v| v.diagnostic),
                            );
                        }
                    }
                }
            }
            let id = uuid::Uuid::parse_str(&request.target.target_uuid)
                .map_err(|e| validation(e.to_string()))?;
            let mut interface = project
                .get_interface(&id)
                .cloned()
                .ok_or_else(|| validation("Interface not found"))?;
            interface.create_new_version(
                interface_changes(
                    &interface.columns,
                    old.as_ref(),
                    &column,
                    request.target.insert_index,
                ),
                None,
                None,
            )?;
            interface_candidate = Some(interface);
            None
        }
    };
    match request.target.mode {
        EditorMode::Table => {
            let before = project.read_table_data_by_uuid(&request.target.target_uuid)?;
            if let Some(after) = &table_data {
                let changes_protection = old
                    .as_ref()
                    .is_some_and(|old| old.read_only != column.read_only);
                if changes_protection
                    && !crate::edit_controls::preserves_stored_cells(&before, after)
                {
                    return Err(validation(
                        "Save write-protection changes separately from cell-value conversions",
                    ));
                }
                crate::edit_controls::validate_transition(&before, after, changes_protection)?;
                let context = crate::formula_context::ProjectFormulaContext::new(project, None)?;
                let mut evaluate = |data: &TableData,
                                    column: &crate::ColumnSchema,
                                    record: &crate::Record,
                                    formula: &str| {
                    context.evaluate_cell_with_override(data, column, record, formula)
                };
                collect_rule_preview(
                    project,
                    &before,
                    after,
                    &column.uuid,
                    &mut preview,
                    &mut evaluate,
                )?;
            }
        }
        EditorMode::Interface => {
            if let Some(candidate) = &interface_candidate {
                let transitions = interface_candidates_from_tables(project, candidate, tables)?;
                let before_tables: Vec<_> = transitions.iter().map(|(before, _)| before).collect();
                let after_tables: Vec<_> = transitions.iter().map(|(_, after)| after).collect();
                let before_context =
                    crate::formula_context::ProjectFormulaContext::new_with_overrides(
                        project,
                        None,
                        &before_tables,
                    )?;
                let after_context =
                    crate::formula_context::ProjectFormulaContext::new_with_overrides(
                        project,
                        None,
                        &after_tables,
                    )?;
                let mut evaluate = |data: &TableData,
                                    column: &crate::ColumnSchema,
                                    record: &crate::Record,
                                    formula: &str| {
                    let context = if after_tables
                        .iter()
                        .any(|candidate| std::ptr::eq(*candidate, data))
                    {
                        &after_context
                    } else {
                        &before_context
                    };
                    context.evaluate_cell_with_override(data, column, record, formula)
                };
                for (before, after) in &transitions {
                    collect_rule_preview(
                        project,
                        before,
                        after,
                        &column.uuid,
                        &mut preview,
                        &mut evaluate,
                    )?;
                }
            }
        }
    }
    Ok(Prepared {
        column,
        old,
        table_data,
        preview,
    })
}

fn collect_rule_preview(
    project: &Project,
    before: &TableData,
    after: &TableData,
    column_uuid: &str,
    preview: &mut EditorPreview,
    evaluate: &mut cell_rules::FormulaEvaluator<'_>,
) -> Result<()> {
    let presentation = cell_rules::presentation_with_evaluator(after, evaluate);
    let issues: Vec<_> = cell_rules::table_issues_with_evaluator(after, evaluate)
        .into_iter()
        .filter(|issue| issue.column_uuid == column_uuid)
        .collect();
    preview.population_count += after.records.len();
    if let Some(column) = after
        .schema
        .columns
        .iter()
        .find(|column| column.uuid == column_uuid)
    {
        preview.ranking_population_count +=
            cell_rules::ranking_population_count_with_evaluator(after, column, evaluate);
    }
    preview.input_issue_count += issues.len();
    preview.reject_issue_count += issues
        .iter()
        .filter(|i| i.mode == ValidationMode::Reject)
        .count();
    preview.warning_issue_count += issues
        .iter()
        .filter(|i| i.mode == ValidationMode::Warn)
        .count();
    preview.input_issues.extend(
        issues
            .into_iter()
            .take(20usize.saturating_sub(preview.input_issues.len())),
    );
    preview
        .definition_issues
        .extend(presentation.definition_issues);
    for record in &after.records {
        if preview.presentation_samples.len() >= 20 {
            break;
        }
        if let Some(cell) = presentation
            .cells
            .get(&record.uuid)
            .and_then(|cells| cells.get(column_uuid))
        {
            preview.presentation_samples.push(EditorPresentationSample {
                table_uuid: after.uuid.clone(),
                record_uuid: record.uuid.clone(),
                column_uuid: column_uuid.into(),
                presentation: cell.clone(),
            });
        }
    }
    preview.input_reports.push(EditorInputReport {
        table_uuid: after.uuid.clone(),
        report: cell_rules::transition_report_with_evaluator(
            &project.project_data.uuid,
            before,
            after,
            evaluate,
        )?,
    });
    attach_preview_locations(after, preview);
    Ok(())
}

fn attach_preview_locations(table: &TableData, preview: &mut EditorPreview) {
    let table_uuid = &table.uuid;
    let mut requested = std::collections::HashSet::new();
    for sample in &preview.samples {
        if sample.table_uuid.as_ref() == Some(table_uuid) {
            if let Some(id) = &sample.record_uuid {
                requested.insert(id.as_str());
            }
        }
    }
    for sample in &preview.presentation_samples {
        if &sample.table_uuid == table_uuid {
            requested.insert(sample.record_uuid.as_str());
        }
    }
    for issue in preview.input_issues.iter().chain(
        preview
            .input_reports
            .iter()
            .flat_map(|entry| entry.report.issues.iter().take(20)),
    ) {
        if &issue.table_uuid != table_uuid {
            continue;
        }
        if let Some(id) = &issue.record_uuid {
            requested.insert(id.as_str());
        }
        requested.extend(issue.peers.iter().take(20).map(String::as_str));
    }
    let records = table
        .records
        .iter()
        .enumerate()
        .filter(|(_, row)| requested.contains(row.uuid.as_str()))
        .map(|(index, row)| (row.uuid.clone(), row.display_label_diagnostic(index)))
        .collect();
    preview.locations.insert(
        table_uuid.clone(),
        EditorPreviewLocations {
            table_name: table.display_name.clone(),
            records,
        },
    );
}

/// Pure projected synchronization, shared by GUI previews and every interface write API.
/// No live tables, files, histories or synchronization timestamps are changed.
pub fn interface_transition_candidates(
    project: &Project,
    candidate: &crate::Interface,
) -> Result<Vec<(TableData, TableData)>> {
    let tables = validation_table_data(project, Some(&candidate.uuid.to_string()), None, None)?;
    interface_candidates_from_tables(project, candidate, tables)
}

fn interface_candidates_from_tables(
    project: &Project,
    candidate: &crate::Interface,
    tables: Vec<TableData>,
) -> Result<Vec<(TableData, TableData)>> {
    let mut registry = project.interface_registry.clone();
    let current = registry
        .get_interface_mut(&candidate.uuid)
        .ok_or_else(|| validation("Interface not found"))?;
    *current = candidate.clone();
    candidate.check_circular_dependency(&registry, &mut std::collections::HashSet::new())?;
    let reaches = |registry: &crate::interface::InterfaceRegistry, roots: Vec<uuid::Uuid>| {
        let mut pending = roots;
        let mut visited = std::collections::HashSet::new();
        while let Some(id) = pending.pop() {
            if id == candidate.uuid {
                return true;
            }
            if visited.insert(id) {
                if let Some(interface) = registry.get_interface(&id) {
                    pending.extend(interface.extends.iter().copied());
                }
            }
        }
        false
    };
    let mut result = Vec::new();
    for before in tables {
        let mut roots: Vec<_> = before.interface_implementations.keys().copied().collect();
        roots.sort();
        if !reaches(&project.interface_registry, roots.clone())
            && !reaches(&registry, roots.clone())
        {
            continue;
        }
        let mut temporary = Table {
            path: Default::default(),
            data: before.clone(),
            is_dirty: false,
            undo_history: Vec::new(),
            redo_history: Vec::new(),
        };
        let affected: Vec<_> = roots
            .into_iter()
            .filter(|root| {
                reaches(&project.interface_registry, vec![*root]) || reaches(&registry, vec![*root])
            })
            .collect();
        temporary.data =
            crate::table_mutation::reconcile_interface_set(&temporary, &registry, &affected)?;
        // The command changes the interface definition. Sync bookkeeping is not
        // part of its proposed values and would make warning tokens nondeterministic.
        temporary.data.interface_implementations = before.interface_implementations.clone();
        temporary.data.metadata.interface_order = before.metadata.interface_order.clone();
        result.push((before, temporary.data));
    }
    Ok(result)
}

pub fn validate_interface_update(
    project: &Project,
    candidate: &crate::Interface,
    acknowledgements: &BTreeMap<String, String>,
) -> Result<()> {
    let transitions = interface_transition_candidates(project, candidate)?;
    if acknowledgements
        .keys()
        .any(|id| !transitions.iter().any(|(_, after)| &after.uuid == id))
    {
        return Err(validation(
            "The table structure changed after confirmation. Preview it again",
        ));
    }
    let before_candidates: Vec<_> = transitions.iter().map(|(before, _)| before).collect();
    let after_candidates: Vec<_> = transitions.iter().map(|(_, after)| after).collect();
    let before_context = crate::formula_context::ProjectFormulaContext::new_with_overrides(
        project,
        None,
        &before_candidates,
    )?;
    let after_context = crate::formula_context::ProjectFormulaContext::new_with_overrides(
        project,
        None,
        &after_candidates,
    )?;
    let mut evaluate =
        |data: &TableData, column: &crate::ColumnSchema, record: &crate::Record, formula: &str| {
            let context = if after_candidates
                .iter()
                .any(|candidate| std::ptr::eq(*candidate, data))
            {
                &after_context
            } else {
                &before_context
            };
            context.evaluate_cell_with_override(data, column, record, formula)
        };
    for (before, after) in &transitions {
        crate::edit_controls::validate_transition(before, after, false)?;
        cell_rules::validate_transition_with_evaluator(
            &project.project_data.uuid,
            before,
            after,
            acknowledgements.get(&after.uuid).map(String::as_str),
            &mut evaluate,
        )?;
    }
    Ok(())
}

fn interface_changes(
    columns: &[ColumnSchema],
    old: Option<&ColumnSchema>,
    column: &ColumnSchema,
    insert_index: Option<usize>,
) -> Vec<InterfaceChange> {
    let mut changes = Vec::new();
    if let Some(old) = old {
        if old.data_name != column.data_name {
            changes.push(InterfaceChange::RenameColumn {
                old_name: old.data_name.clone(),
                new_name: column.data_name.clone(),
            });
        }
        if old.data_type != column.data_type {
            changes.push(InterfaceChange::ModifyColumn {
                column_name: column.data_name.clone(),
                old_type: old.data_type.clone(),
                new_type: column.data_type.clone(),
            });
        }
        if old.input_validation != column.input_validation {
            changes.push(InterfaceChange::ChangeInputValidation {
                column_name: column.data_name.clone(),
                settings: column.input_validation.clone(),
            });
        }
        if old.min_version != column.min_version {
            changes.push(InterfaceChange::ChangeMinVersion {
                column_name: column.data_name.clone(),
                min_version: column.min_version,
            });
        }
        if old.conditional_formatting != column.conditional_formatting {
            changes.push(InterfaceChange::ChangeConditionalFormatting {
                column_name: column.data_name.clone(),
                formatting: column.conditional_formatting.clone(),
            });
        }
        if old.color_swatches != column.color_swatches {
            changes.push(InterfaceChange::ChangeColorSwatches {
                column_name: column.data_name.clone(),
                swatches: column.color_swatches.clone(),
            });
        }
        if old.default_value != column.default_value {
            changes.push(InterfaceChange::ChangeDefault {
                column_name: column.data_name.clone(),
                new_default: Some(column.default_value.clone()),
            });
        }
        if old.display_name != column.display_name
            || old.tooltip != column.tooltip
            || old.memo_text != column.memo_text
            || old.style != column.style
        {
            changes.push(InterfaceChange::ModifyColumnMeta {
                column_name: column.data_name.clone(),
                display_name: (old.display_name != column.display_name)
                    .then(|| column.display_name.clone()),
                tooltip: (old.tooltip != column.tooltip).then(|| column.tooltip.clone()),
                memo_text: (old.memo_text != column.memo_text).then(|| column.memo_text.clone()),
                style: (old.style != column.style).then(|| column.style.clone()),
            });
        }
        if old.reference_config != column.reference_config
            || old.curve_config != column.curve_config
            || old.table_ref_config != column.table_ref_config
            || old.select_config != column.select_config
        {
            changes.push(InterfaceChange::ConfigureColumn {
                column_name: column.data_name.clone(),
                reference_config: column.reference_config.clone(),
                curve_config: column.curve_config.clone(),
                table_ref_config: column.table_ref_config.clone(),
                select_config: column.select_config.clone(),
            });
        }
    } else {
        let mut order: Vec<_> = columns.iter().map(|c| c.data_name.clone()).collect();
        let index = insert_index.unwrap_or(order.len()).min(order.len());
        order.insert(index, column.data_name.clone());
        changes.push(InterfaceChange::AddColumn {
            column: column.clone(),
        });
        changes.push(InterfaceChange::ReorderColumns { order });
    }
    changes
}

pub fn preview(project: &Project, request: &EditorRequest) -> Result<EditorPreview> {
    Ok(prepare(project, request)?.preview)
}

fn require_valid(preview: &EditorPreview) -> Result<()> {
    if preview.error_count == 0 && preview.errors.is_empty() {
        return Ok(());
    }
    let mut diagnostics: Vec<crate::types::Diagnostic> = preview
        .samples
        .iter()
        .filter_map(|sample| sample.error.clone())
        .chain(preview.errors.iter().cloned())
        .take(8)
        .collect();
    diagnostics.insert(
        0,
        crate::types::Diagnostic::Code {
            code: "column.conversion.saveBlocked".into(),
            params: serde_json::json!({ "count": preview.error_count }),
        },
    );
    Err(DevcelError::Diagnostics(diagnostics))
}

pub fn save(
    project: &mut Project,
    request: EditorRequest,
    save_queue: Option<&std::sync::Arc<crate::file_save_queue::FileBasedSaveQueueManager>>,
) -> Result<EditorSaved> {
    if matches!(request.target.mode, EditorMode::Table) {
        project.ensure_table_loaded_by_uuid(&request.target.target_uuid)?;
    }
    // Recompute under the same project lock used for the write, even after a successful preview.
    let prepared = prepare(project, &request)?;
    require_valid(&prepared.preview)?;
    let column_uuid = prepared.column.uuid.clone();
    match request.target.mode {
        EditorMode::Table => project.execute_command(
            SaveTableColumnCommand {
                request,
                stable_uuid: column_uuid.clone(),
                before: None,
                after: None,
                edit_control_settings: false,
            },
            save_queue,
        )?,
        EditorMode::Interface => {
            let id = uuid::Uuid::parse_str(&request.target.target_uuid)
                .map_err(|e| validation(e.to_string()))?;
            let interface = project
                .get_interface(&id)
                .ok_or_else(|| validation("Interface not found"))?;
            let changes = interface_changes(
                &interface.columns,
                prepared.old.as_ref(),
                &prepared.column,
                request.target.insert_index,
            );
            project.execute_command(
                UpdateInterfaceCommand::new(id, changes, None, Some("Edit column settings".into()))
                    .with_validation_acknowledgements(request.acknowledgements.clone()),
                save_queue,
            )?;
        }
    }
    Ok(EditorSaved { column_uuid })
}

struct SaveTableColumnCommand {
    request: EditorRequest,
    stable_uuid: String,
    before: Option<TableData>,
    after: Option<TableData>,
    edit_control_settings: bool,
}
impl CommandData for SaveTableColumnCommand {
    fn is_edit_control_settings(&self) -> bool {
        self.edit_control_settings
    }

    fn execute(&mut self, project: &mut Project) -> Result<()> {
        if let Some(after) = &self.after {
            let table = project
                .find_table_by_uuid_mut(&self.request.target.target_uuid)
                .ok_or_else(|| validation("Table not found"))?;
            table.data = after.clone();
            table.is_dirty = true;
            return Ok(());
        }
        let prepared = prepare(project, &self.request)?;
        require_valid(&prepared.preview)?;
        let mut after = prepared
            .table_data
            .ok_or_else(|| validation("Table editing is required"))?;
        // Repeated preparation must not generate a second creation UUID.
        if prepared.old.is_none() {
            for column in &mut after.schema.columns {
                if column.uuid == prepared.column.uuid {
                    column.uuid = self.stable_uuid.clone();
                }
            }
        }
        let table = project
            .find_table_by_uuid_mut(&self.request.target.target_uuid)
            .ok_or_else(|| validation("Table not found"))?;
        self.edit_control_settings = prepared
            .old
            .as_ref()
            .is_some_and(|old| old.read_only != prepared.column.read_only)
            && crate::edit_controls::preserves_stored_cells(&table.data, &after);
        self.before = Some(table.data.clone());
        self.after = Some(after.clone());
        table.data = after;
        table.is_dirty = true;
        Ok(())
    }
    fn undo(&mut self, project: &mut Project) -> Result<()> {
        let before = self
            .before
            .as_ref()
            .ok_or_else(|| validation("No edit history is available"))?;
        let table = project
            .find_table_by_uuid_mut(&self.request.target.target_uuid)
            .ok_or_else(|| validation("Table not found"))?;
        table.data = before.clone();
        table.is_dirty = true;
        Ok(())
    }
    fn validation_acknowledgement(&self) -> Option<&str> {
        self.request.acknowledgement.as_deref()
    }
    fn get_table_uuid(&self) -> String {
        self.request.target.target_uuid.clone()
    }
}
