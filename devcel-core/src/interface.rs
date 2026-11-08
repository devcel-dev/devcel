use crate::app_error::{authoring_error, diagnostic};
use crate::column::ColumnSchema;
use crate::types::ValueType;
use crate::{AppError, DevcelError, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;
use uuid::Uuid;

/// Special resolutions-map key for inheritance conflicts
pub const EXTENDS_CONFLICT_KEY: &str = "(extends)";

/// Interface: defines the column structure that multiple tables must implement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interface {
    pub uuid: Uuid,
    pub name: String,
    pub current_version_id: Uuid,
    pub description: Option<String>,
    pub columns: Vec<ColumnSchema>,
    pub extends: Vec<Uuid>,
    #[serde(default)]
    pub metadata: InterfaceMetadata,

    /// GUID-based change history (DAG structure)
    #[serde(serialize_with = "crate::ordered_map::serialize")]
    pub history: HashMap<Uuid, InterfaceVersion>,
}

/// The interface authoring schema is independent of its content history IDs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InterfaceMetadata {
    #[serde(
        default = "crate::authoring_format::default_schema_version",
        deserialize_with = "crate::authoring_format::deserialize_schema_version",
        serialize_with = "crate::authoring_format::serialize_schema_version"
    )]
    pub schema_version: u32,
}

impl Default for InterfaceMetadata {
    fn default() -> Self {
        Self {
            schema_version: crate::authoring_format::CURRENT_SCHEMA_VERSION,
        }
    }
}

/// Interface version information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterfaceVersion {
    pub version_id: Uuid,
    pub parent_version_id: Option<Uuid>,
    pub timestamp: DateTime<Utc>,
    pub changes: Vec<InterfaceChange>,
    pub author: Option<String>,
    pub comment: Option<String>,
    pub merge_info: Option<MergeInfo>,
}

/// Merge information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeInfo {
    pub second_parent_id: Uuid,
    pub conflict_resolutions: Vec<ConflictResolution>,
    /// Changes from the second parent to the merge result
    /// Apply these when the history path reaches the merge through the second parent
    /// (The version's own changes are relative to the first parent)
    pub second_parent_changes: Vec<InterfaceChange>,
}

/// Conflict resolution information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictResolution {
    pub column_name: String,
    pub resolution_type: ResolutionType,
    pub description: String,
    /// Field-level conflicts for UI display
    pub field_conflicts: Vec<FieldConflict>,
}

/// Field-level conflict information
/// Used to display "This version: ... / Other version: ..."
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldConflict {
    /// Field identifier (type / required / default / constraints / configuration /
    /// input_validation / conditional_formatting / name / presence / extends)
    pub field: String,
    /// Display label, such as "Data type" or "Default value"
    pub field_label: String,
    /// Display string for our value (first parent)
    pub ours: String,
    /// Display string for their value (second parent)
    pub theirs: String,
}

/// Conflict resolution method
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResolutionType {
    TakeOurs,   // Use our changes
    TakeTheirs, // Use their changes
    Manual,     // Resolve manually
}

/// Interface changes
#[derive(Debug, Clone, Serialize, Deserialize)]
// This public serialized command API intentionally stores AddColumn by value.
// Boxing it would break downstream Rust callers without changing the persisted format.
#[allow(clippy::large_enum_variant)]
pub enum InterfaceChange {
    AddColumn {
        column: ColumnSchema,
    },
    RemoveColumn {
        column_name: String,
    },
    ModifyColumn {
        column_name: String,
        old_type: ValueType,
        new_type: ValueType,
    },
    ChangeRequired {
        column_name: String,
        required: bool,
    },
    ChangeDefault {
        column_name: String,
        new_default: Option<String>,
    },
    ChangeConstraints {
        column_name: String,
        new_constraints: Option<crate::column::ColumnConstraints>,
    },
    ChangeMinVersion {
        column_name: String,
        min_version: u32,
    },
    ChangeInputValidation {
        column_name: String,
        settings: Option<crate::cell_rules::InputValidationSettings>,
    },
    ChangeConditionalFormatting {
        column_name: String,
        formatting: Option<crate::cell_rules::ConditionalFormatting>,
    },
    /// Rename a column (tables rename it in place while preserving its UUID
    /// and record values)
    RenameColumn {
        old_name: String,
        new_name: String,
    },
    /// Change display metadata (update only fields set to Some)
    ModifyColumnMeta {
        column_name: String,
        display_name: Option<String>,
        tooltip: Option<String>,
        memo_text: Option<String>,
        style: Option<crate::column::ColumnStyle>,
    },
    /// Replace type-specific settings in place, preserving column UUID, values and order.
    ConfigureColumn {
        column_name: String,
        reference_config: Option<crate::ReferenceConfig>,
        curve_config: Option<crate::CurveConfig>,
        table_ref_config: Option<crate::TableRefConfig>,
        select_config: Option<crate::SelectConfig>,
    },
    /// Change the interface's own description
    ChangeDescription {
        new_description: Option<String>,
    },
    ModifyExtends {
        new_extends: Vec<Uuid>,
    },
    /// Change column order (an ordered list of data_name values).
    /// Determines definition order and the order applied to new tables.
    /// Existing tables maintain their own column order, so this does not forcibly reorder them.
    ReorderColumns {
        order: Vec<String>,
    },
    /// Replace named authoring choices without changing cell values or precision.
    ChangeColorSwatches {
        column_name: String,
        swatches: Vec<crate::ColorSwatch>,
    },
}

/// Interface registry: manages all interfaces in a project
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterfaceRegistry {
    /// UUID-to-path mapping
    uuid_to_path: HashMap<Uuid, String>,
    /// Manage interfaces by path (relative path -> Interface)
    interfaces: HashMap<String, Interface>,
    /// Dependency graph for circular-reference detection
    dependency_graph: HashMap<Uuid, HashSet<Uuid>>,
}

/// Table interface-implementation information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterfaceImplementation {
    pub interface_uuid: Uuid,
    pub synced_version_id: Uuid,
    pub last_sync_date: DateTime<Utc>,
    /// Effective version fingerprint (hash of this interface's and all ancestors' version IDs)
    /// Used to detect parent changes. None means not yet computed, such as immediately after duplication
    #[serde(default)]
    pub effective_fingerprint: Option<String>,
    /// Stable identities required at the last successful synchronization. Missing
    /// on legacy documents; use conservative history evidence until next sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_column_uuids: Option<Vec<String>>,
}

/// Interface conformance validation result
#[derive(Debug, Clone)]
pub struct InterfaceValidation {
    pub interface_uuid: Uuid,
    pub is_valid: bool,
    pub missing_columns: Vec<String>,
    pub type_mismatches: Vec<ColumnMismatch>,
    pub constraint_violations: Vec<ConstraintViolation>,
}

/// Column type mismatch information
#[derive(Debug, Clone)]
pub struct ColumnMismatch {
    pub column_name: String,
    pub expected_type: ValueType,
    pub actual_type: ValueType,
}

/// Constraint violation information
#[derive(Debug, Clone)]
pub struct ConstraintViolation {
    pub column_name: String,
    pub constraint_type: String,
    pub diagnostic: crate::types::Diagnostic,
    /// UUID of the violating record, used by the UI to jump to the cell
    pub record_uuid: Option<String>,
}

/// Change application result
#[derive(Debug, Default)]
pub struct ApplyResult {
    pub columns_added: Vec<String>,
    pub columns_to_remove: Vec<String>,
    pub type_changes: Vec<TypeChange>,
    pub metadata_changes: Vec<String>,
    pub warnings: Vec<String>,
}

/// Type change information
#[derive(Debug)]
pub struct TypeChange {
    pub column: String,
    pub from: ValueType,
    pub to: ValueType,
}

type InterfaceVersionState = (Vec<ColumnSchema>, Vec<Uuid>, Option<String>);

fn column_error(column: &str, error: DevcelError) -> DevcelError {
    diagnostic(
        "column.validation.inputError",
        json!({"context": column, "error": AppError::from(error)}),
    )
}

fn validate_column_id(id: &str) -> Result<()> {
    Uuid::parse_str(id).map_err(|error| {
        diagnostic(
            "error.storage.invalidColumnId",
            json!({"id": id, "error": error.to_string()}),
        )
    })?;
    Ok(())
}

impl Interface {
    /// Create an interface
    pub fn new(name: String, description: Option<String>) -> Self {
        let version_id = Uuid::new_v4();
        let mut history = HashMap::new();

        // Create the initial version
        let initial_version = InterfaceVersion {
            version_id,
            parent_version_id: None,
            timestamp: Utc::now(),
            changes: vec![InterfaceChange::ChangeDescription {
                new_description: description.clone(),
            }],
            author: Some("System".to_string()),
            comment: Some("Initial creation".to_string()),
            merge_info: None,
        };

        history.insert(version_id, initial_version);

        Self {
            uuid: Uuid::new_v4(),
            name,
            current_version_id: version_id,
            description,
            columns: Vec::new(),
            extends: Vec::new(),
            metadata: InterfaceMetadata::default(),
            history,
        }
    }

    /// Create a version
    /// Validate and apply changes sequentially to a simulated state;
    /// commit the version only when every change succeeds
    pub fn create_new_version(
        &mut self,
        mut changes: Vec<InterfaceChange>,
        author: Option<String>,
        comment: Option<String>,
    ) -> Result<Uuid> {
        // Validate and apply sequentially to the simulated state
        // (To handle adding a column and then modifying it within the same change list)
        let mut sim_columns = self.columns.clone();
        let mut sim_extends = self.extends.clone();
        let mut sim_description = self.description.clone();

        for change in &mut changes {
            // The normalized literal is part of the authoritative change itself,
            // so replay and snapshots always agree bit-for-bit.
            match change {
                InterfaceChange::AddColumn { column } => {
                    column.color_swatches =
                        crate::normalize_color_swatches(column.color_swatches.clone())?;
                    column.normalize_color_default()?;
                }
                InterfaceChange::ChangeColorSwatches { swatches, .. } => {
                    *swatches = crate::normalize_color_swatches(swatches.clone())?;
                }
                InterfaceChange::ChangeDefault {
                    column_name,
                    new_default,
                } => {
                    if let Some(column) = sim_columns
                        .iter()
                        .find(|column| &column.data_name == column_name)
                    {
                        if column.data_type.is_color() {
                            let mut candidate = column.clone();
                            candidate.default_value = new_default.clone().unwrap_or_default();
                            candidate.normalize_color_default()?;
                            *new_default = Some(candidate.default_value);
                        }
                    }
                }
                _ => {}
            }
            Self::validate_change_against(&sim_columns, change)?;
            Self::apply_change_to_state(
                &mut sim_columns,
                &mut sim_extends,
                &mut sim_description,
                change,
            )?;
        }

        // New rules validate the final candidate, never an intermediate type/default.
        // History remains authoritative: do not normalize fields outside its changes.
        Self::validate_rule_definitions(&sim_columns)?;

        // Create a version
        let new_version = InterfaceVersion {
            version_id: Uuid::new_v4(),
            parent_version_id: Some(self.current_version_id),
            timestamp: Utc::now(),
            changes,
            author,
            comment,
            merge_info: None,
        };

        let new_version_id = new_version.version_id;

        // Add to history and apply the validated simulation state
        self.history.insert(new_version_id, new_version);
        self.columns = sim_columns;
        self.extends = sim_extends;
        self.description = sim_description;
        self.current_version_id = new_version_id;

        Ok(new_version_id)
    }

    fn validate_rule_definitions(columns: &[ColumnSchema]) -> Result<()> {
        for column in columns {
            column.validate_color_storage_contract()?;
            if column.read_only {
                return Err(authoring_error(
                    "Change write protection in the table's column settings",
                ));
            }
            if column.conditional_formatting_override.is_some() {
                return Err(diagnostic("error.interface.tableFormatting", json!({})));
            }
            crate::cell_rules::validate_column_definition(column)?;
        }
        Ok(())
    }

    fn validate_merge_candidate(columns: &[ColumnSchema]) -> Result<()> {
        Self::validate_rule_definitions(columns)?;
        for column in columns {
            if !column.default_value.is_empty() {
                column
                    .validate_value(&column.default_value)
                    .map_err(|error| column_error(&column.data_name, error))?;
            }
        }
        Ok(())
    }

    /// Validate one change against the specified column state
    fn validate_change_against(columns: &[ColumnSchema], change: &InterfaceChange) -> Result<()> {
        let exists = |name: &str| columns.iter().any(|c| c.data_name == name);
        let require_exists = |name: &str| -> Result<()> {
            if exists(name) {
                Ok(())
            } else {
                Err(diagnostic(
                    "interface.dialog.missingColumn",
                    json!({"name": name}),
                ))
            }
        };

        match change {
            InterfaceChange::AddColumn { column } => {
                crate::validate_color_swatches(&column.color_swatches)?;
                crate::validate_data_name(&column.data_name)?;
                validate_column_id(&column.uuid)?;
                if columns.iter().any(|existing| existing.uuid == column.uuid) {
                    return Err(diagnostic(
                        "error.storage.duplicateColumnId",
                        json!({"id": column.uuid}),
                    ));
                }
                if column.data_name == EXTENDS_CONFLICT_KEY {
                    return Err(diagnostic(
                        "error.interface.reservedName",
                        json!({"name": EXTENDS_CONFLICT_KEY}),
                    ));
                }
                if exists(&column.data_name) {
                    return Err(column_error(
                        &column.data_name,
                        authoring_error("A column with the same name already exists"),
                    ));
                }
                // Validate default values against constraints and types at definition time
                if let Some(constraints) = &column.constraints {
                    Self::validate_constraints_definition(&column.data_name, constraints)?;
                    Self::validate_default_against_constraints(
                        &column.data_name,
                        &column.default_value,
                        constraints,
                    )?;
                }
            }
            InterfaceChange::RemoveColumn { column_name }
            | InterfaceChange::ChangeMinVersion { column_name, .. }
            | InterfaceChange::ChangeInputValidation { column_name, .. }
            | InterfaceChange::ChangeConditionalFormatting { column_name, .. } => {
                require_exists(column_name)?;
            }
            InterfaceChange::ModifyColumn { column_name, .. } => {
                require_exists(column_name)?;
            }
            InterfaceChange::ChangeRequired { column_name, .. } => {
                require_exists(column_name)?;
            }
            InterfaceChange::ChangeDefault {
                column_name,
                new_default,
            } => {
                require_exists(column_name)?;
                // Validate the new default value against existing constraints
                if let Some(col) = columns.iter().find(|c| &c.data_name == column_name) {
                    if let (Some(default), Some(constraints)) = (new_default, &col.constraints) {
                        Self::validate_default_against_constraints(
                            column_name,
                            default,
                            constraints,
                        )?;
                    }
                }
            }
            InterfaceChange::ChangeColorSwatches {
                column_name,
                swatches,
            } => {
                require_exists(column_name)?;
                crate::validate_color_swatches(swatches)?;
            }
            InterfaceChange::ChangeConstraints {
                column_name,
                new_constraints,
            } => {
                require_exists(column_name)?;
                if let Some(constraints) = new_constraints {
                    Self::validate_constraints_definition(column_name, constraints)?;
                    // Validate the existing default value against the new constraints
                    if let Some(col) = columns.iter().find(|c| &c.data_name == column_name) {
                        Self::validate_default_against_constraints(
                            column_name,
                            &col.default_value,
                            constraints,
                        )?;
                    }
                }
            }
            InterfaceChange::RenameColumn { old_name, new_name } => {
                require_exists(old_name)?;
                crate::utils::validate_data_name(new_name)
                    .map_err(|error| column_error(new_name, error))?;
                if old_name != new_name && exists(new_name) {
                    return Err(column_error(
                        new_name,
                        authoring_error("A column with the same name already exists"),
                    ));
                }
            }
            InterfaceChange::ModifyColumnMeta { column_name, .. } => {
                require_exists(column_name)?;
            }
            InterfaceChange::ConfigureColumn {
                column_name,
                reference_config,
                curve_config,
                table_ref_config,
                select_config,
            } => {
                require_exists(column_name)?;
                let column = columns
                    .iter()
                    .find(|c| &c.data_name == column_name)
                    .unwrap();
                if (reference_config.is_some() && column.data_type != ValueType::Reference)
                    || (curve_config.is_some() && column.data_type != ValueType::Curve)
                    || (table_ref_config.is_some() && column.data_type != ValueType::TableRef)
                    || (select_config.is_some() && column.data_type != ValueType::Select)
                {
                    return Err(authoring_error(
                        "The type does not match the additional settings",
                    ));
                }
                if curve_config
                    .as_ref()
                    .is_some_and(|c| !c.start_value.is_finite() || !c.end_value.is_finite())
                {
                    return Err(authoring_error("Curve endpoints must be finite values"));
                }
                if let Some(config) = select_config {
                    config.validate().map_err(authoring_error)?;
                }
            }
            InterfaceChange::ChangeDescription { .. } => {}
            InterfaceChange::ModifyExtends { .. } => {
                // Skip inheritance validation here because it requires the Registry
                // Circular references and similar checks are performed separately
            }
            InterfaceChange::ReorderColumns { .. } => {
                // Allow reordering a subset of existing columns; on application,
                // leave columns absent from order at the end in their original relative order
            }
        }
        Ok(())
    }

    /// Validate constraint definitions themselves (min <= max and valid regular expressions)
    fn validate_constraints_definition(
        column_name: &str,
        constraints: &crate::column::ColumnConstraints,
    ) -> Result<()> {
        if let (Some(min), Some(max)) = (constraints.min_value, constraints.max_value) {
            if min > max {
                return Err(column_error(
                    column_name,
                    authoring_error("The minimum must not exceed the maximum"),
                ));
            }
        }
        if let Some(pattern) = &constraints.pattern {
            regex::Regex::new(pattern).map_err(|error| {
                column_error(
                    column_name,
                    diagnostic("error.rulePattern", json!({"details": error.to_string()})),
                )
            })?;
        }
        Ok(())
    }

    /// Validate the default value against constraints
    /// (Empty defaults are excluded; Table validates record values)
    pub(crate) fn validate_default_against_constraints(
        column_name: &str,
        default_value: &str,
        constraints: &crate::column::ColumnConstraints,
    ) -> Result<()> {
        if default_value.is_empty() {
            return Ok(());
        }

        if let Ok(number) = default_value.parse::<f64>() {
            if let Some(min) = constraints.min_value {
                if number < min {
                    return Err(diagnostic(
                        "error.interface.defaultMinimum",
                        json!({"column": column_name, "value": default_value, "min": min}),
                    ));
                }
            }
            if let Some(max) = constraints.max_value {
                if number > max {
                    return Err(diagnostic(
                        "error.interface.defaultMaximum",
                        json!({"column": column_name, "value": default_value, "max": max}),
                    ));
                }
            }
        }

        if let Some(pattern) = &constraints.pattern {
            if let Ok(re) = regex::Regex::new(pattern) {
                if !re.is_match(default_value) {
                    return Err(diagnostic(
                        "error.interface.defaultPattern",
                        json!({"column": column_name, "value": default_value}),
                    ));
                }
            }
        }

        Ok(())
    }

    /// Apply one change to the specified state (columns, inheritance, and description)
    fn apply_change_to_state(
        columns: &mut Vec<ColumnSchema>,
        extends: &mut Vec<Uuid>,
        description: &mut Option<String>,
        change: &InterfaceChange,
    ) -> Result<()> {
        match change {
            InterfaceChange::AddColumn { column } => {
                Self::validate_change_against(columns, change)?;
                if columns.iter().any(|c| c.data_name == column.data_name) {
                    return Err(column_error(
                        &column.data_name,
                        authoring_error("A column with the same name already exists"),
                    ));
                }
                columns.push(column.clone());
            }
            InterfaceChange::RemoveColumn { column_name } => {
                columns.retain(|c| &c.data_name != column_name);
            }
            InterfaceChange::ModifyColumn {
                column_name,
                new_type,
                ..
            } => {
                if let Some(col) = columns.iter_mut().find(|c| &c.data_name == column_name) {
                    col.data_type = new_type.clone();
                }
            }
            InterfaceChange::ChangeRequired {
                column_name,
                required,
            } => {
                if let Some(col) = columns.iter_mut().find(|c| &c.data_name == column_name) {
                    col.required = Some(*required);
                }
            }
            InterfaceChange::ChangeDefault {
                column_name,
                new_default,
            } => {
                if let Some(col) = columns.iter_mut().find(|c| &c.data_name == column_name) {
                    col.default_value = new_default.clone().unwrap_or_default();
                }
            }
            InterfaceChange::ChangeColorSwatches {
                column_name,
                swatches,
            } => {
                crate::validate_color_swatches(swatches)?;
                if let Some(column) = columns
                    .iter_mut()
                    .find(|column| &column.data_name == column_name)
                {
                    column.color_swatches = swatches.clone();
                }
            }
            InterfaceChange::ChangeConstraints {
                column_name,
                new_constraints,
            } => {
                if let Some(col) = columns.iter_mut().find(|c| &c.data_name == column_name) {
                    col.constraints = new_constraints
                        .clone()
                        .filter(|constraints| !constraints.is_empty());
                }
            }
            InterfaceChange::ChangeMinVersion {
                column_name,
                min_version,
            } => {
                if let Some(col) = columns.iter_mut().find(|c| &c.data_name == column_name) {
                    col.min_version = *min_version;
                }
            }
            InterfaceChange::ChangeInputValidation {
                column_name,
                settings,
            } => {
                if let Some(col) = columns.iter_mut().find(|c| &c.data_name == column_name) {
                    col.input_validation = settings.clone();
                }
            }
            InterfaceChange::ChangeConditionalFormatting {
                column_name,
                formatting,
            } => {
                if let Some(col) = columns.iter_mut().find(|c| &c.data_name == column_name) {
                    col.conditional_formatting = formatting.clone();
                }
            }
            InterfaceChange::RenameColumn { old_name, new_name } => {
                if let Some(col) = columns.iter_mut().find(|c| &c.data_name == old_name) {
                    // Update the display name only when it matches the data name
                    // (Preserve custom display names set through ModifyColumnMeta)
                    if col.display_name == *old_name {
                        col.display_name = new_name.clone();
                    }
                    col.data_name = new_name.clone();
                }
            }
            InterfaceChange::ModifyColumnMeta {
                column_name,
                display_name,
                tooltip,
                memo_text,
                style,
            } => {
                if let Some(col) = columns.iter_mut().find(|c| &c.data_name == column_name) {
                    if let Some(display_name) = display_name {
                        col.display_name = display_name.clone();
                    }
                    if let Some(tooltip) = tooltip {
                        col.tooltip = tooltip.clone();
                    }
                    if let Some(memo_text) = memo_text {
                        col.memo_text = memo_text.clone();
                    }
                    if let Some(style) = style {
                        col.style = style.clone();
                    }
                }
            }
            InterfaceChange::ConfigureColumn {
                column_name,
                reference_config,
                curve_config,
                table_ref_config,
                select_config,
            } => {
                if let Some(column) = columns.iter_mut().find(|c| &c.data_name == column_name) {
                    column.reference_config = reference_config.clone();
                    column.curve_config = curve_config.clone();
                    column.table_ref_config = table_ref_config.clone();
                    column.select_config = select_config.clone();
                }
            }
            InterfaceChange::ChangeDescription { new_description } => {
                *description = new_description.clone();
            }
            InterfaceChange::ModifyExtends { new_extends } => {
                *extends = new_extends.clone();
            }
            InterfaceChange::ReorderColumns { order } => {
                // Sort according to order, retaining unlisted columns at the end in their original relative order
                // (sort_by_key is stable, so equal-ranked elements retain their relative order)
                columns.sort_by_key(|c| {
                    order
                        .iter()
                        .position(|n| n == &c.data_name)
                        .unwrap_or(usize::MAX)
                });
            }
        }
        Ok(())
    }

    /// Get the effective column list, including inherited columns
    pub fn get_effective_columns(&self, registry: &InterfaceRegistry) -> Result<Vec<ColumnSchema>> {
        let mut columns = Vec::new();

        // Add this interface's columns and set their origin
        for col in &self.columns {
            let mut c = col.clone();
            c.interface_origin = Some(self.uuid.to_string());
            c.interface_origin_name_fallback = Some(self.name.clone());
            columns.push(c);
        }

        // Add inherited columns
        for parent_uuid in &self.extends {
            if let Some(parent) = registry.get_interface(parent_uuid) {
                let parent_columns = parent.get_effective_columns(registry)?;
                for parent_col in parent_columns {
                    // Check duplicates (child wins: ignore a parent's column if the name already exists)
                    if !columns.iter().any(|c| c.data_name == parent_col.data_name) {
                        columns.push(parent_col);
                    }
                }
            } else {
                return Err(diagnostic(
                    "error.interface.missingId",
                    json!({"id": parent_uuid}),
                ));
            }
        }

        Ok(columns)
    }

    /// Reconstruct columns, inheritance, and description from the current version's history
    pub fn rebuild_current_columns(&mut self) -> Result<()> {
        let (columns, extends, description) = self.state_at_version(self.current_version_id)?;
        self.columns = columns;
        self.extends = extends;
        self.description = description;
        Ok(())
    }

    /// Return changes to apply for a path edge (previous version -> target version)
    /// Normally uses the target version's changes from its first parent;
    /// use second_parent_changes when reaching a merge through its second parent
    fn changes_for_edge(&self, previous: Uuid, target: Uuid) -> &[InterfaceChange] {
        if let Some(version) = self.history.get(&target) {
            if let Some(merge_info) = &version.merge_info {
                if merge_info.second_parent_id == previous {
                    return &merge_info.second_parent_changes;
                }
            }
            &version.changes
        } else {
            &[]
        }
    }

    /// Apply changes from the specified version to the current version to a table
    pub fn apply_to_table(
        &self,
        table: &mut crate::table::Table,
        from_version: Uuid,
        registry: &InterfaceRegistry,
    ) -> Result<crate::interface::ApplyResult> {
        Self::validate_table_column_ids(&table.data, registry)?;
        let mut result = match self.find_path(from_version, self.current_version_id) {
            Ok(path) => {
                let mut result = ApplyResult::default();
                // Apply each version's changes along the path in sequence
                // When reaching a merge through the second parent, apply the changes from that parent
                for i in 1..path.len() {
                    for change in self.changes_for_edge(path[i - 1], path[i]) {
                        self.apply_single_change(table, change, &mut result)?;
                    }
                }
                result
            }
            Err(_) => {
                // If the source version is not an ancestor of the current HEAD (e.g. after history replacement),
                // fall back to reconcile as a history-independent recovery mechanism
                let mut result = self.reconcile_table(table, registry)?;
                result.warnings.push(
                    "The synchronization history could not be followed, so the table was rebuilt to match the current definition".to_string(),
                );
                result
            }
        };

        // Detect inherited parent changes using the effective fingerprint and reconcile if needed
        let fingerprint = self.effective_fingerprint(registry);
        let fingerprint_stale = table
            .data
            .interface_implementations
            .get(&self.uuid)
            .map(|info| info.effective_fingerprint.as_deref() != Some(fingerprint.as_str()))
            .unwrap_or(false);
        if fingerprint_stale {
            let reconcile_result = self.reconcile_table(table, registry)?;
            result.columns_added.extend(reconcile_result.columns_added);
            result
                .columns_to_remove
                .extend(reconcile_result.columns_to_remove);
            result.type_changes.extend(reconcile_result.type_changes);
            result
                .metadata_changes
                .extend(reconcile_result.metadata_changes);
            result.warnings.extend(reconcile_result.warnings);
        }

        // Update synchronization information
        if let Some(impl_info) = table.data.interface_implementations.get_mut(&self.uuid) {
            impl_info.synced_version_id = self.current_version_id;
            impl_info.last_sync_date = Utc::now();
            impl_info.effective_fingerprint = Some(fingerprint);
            impl_info.required_column_uuids = Some(
                self.get_effective_columns(registry)?
                    .iter()
                    .map(|column| column.uuid.clone())
                    .collect(),
            );
        }

        // Set the dirty flag if changes occurred
        if !result.columns_added.is_empty()
            || !result.columns_to_remove.is_empty()
            || !result.type_changes.is_empty()
            || !result.metadata_changes.is_empty()
        {
            table.mark_dirty();
        }

        Ok(result)
    }

    /// Compute the effective version fingerprint
    /// Deterministically derived from the current version IDs of this interface and all ancestors;
    /// used to detect inherited parent changes for automatic table synchronization
    pub fn effective_fingerprint(&self, registry: &InterfaceRegistry) -> String {
        use sha2::{Digest, Sha256};

        let mut ids = vec![self.current_version_id];
        let mut visited = HashSet::new();
        visited.insert(self.uuid);
        let mut stack: Vec<Uuid> = self.extends.clone();

        while let Some(parent_uuid) = stack.pop() {
            if !visited.insert(parent_uuid) {
                continue;
            }
            if let Some(parent) = registry.get_interface(&parent_uuid) {
                ids.push(parent.current_version_id);
                stack.extend(parent.extends.iter().copied());
            }
        }

        ids.sort();
        let mut hasher = Sha256::new();
        for id in ids {
            hasher.update(id.as_bytes());
        }
        format!("{:x}", hasher.finalize())
    }

    /// Whether the table needs synchronization with this interface
    pub fn table_needs_sync(
        &self,
        impl_info: &InterfaceImplementation,
        registry: &InterfaceRegistry,
    ) -> bool {
        impl_info.synced_version_id != self.current_version_id
            || impl_info.effective_fingerprint.as_deref()
                != Some(self.effective_fingerprint(registry).as_str())
    }

    pub(crate) fn validate_table_column_ids(
        data: &crate::table::TableData,
        registry: &InterfaceRegistry,
    ) -> Result<()> {
        // A per-call index avoids rescanning the same ancestor/history for every column.
        // It is never persisted, so a changed registry cannot reuse stale validation.
        let mut known_by_origin: HashMap<Uuid, HashSet<&str>> = HashMap::new();
        for column in &data.schema.columns {
            let Some(origin) = column.interface_origin.as_deref() else {
                continue;
            };
            let origin = Uuid::parse_str(origin).map_err(|error| {
                diagnostic(
                    "error.interface.invalidId",
                    json!({"id": origin, "details": error.to_string()}),
                )
            })?;
            if registry.get_interface(&origin).is_none() {
                continue;
            }
            let known = known_by_origin.entry(origin).or_insert_with(|| {
                let mut pending = vec![origin];
                let mut visited = HashSet::new();
                let mut known = HashSet::new();
                while let Some(id) = pending.pop() {
                    if !visited.insert(id) {
                        continue;
                    }
                    let Some(definition) = registry.get_interface(&id) else {
                        continue;
                    };
                    known.extend(
                        definition
                            .columns
                            .iter()
                            .map(|candidate| candidate.uuid.as_str()),
                    );
                    pending.extend(definition.extends.iter().copied());
                    for version in definition.history.values() {
                        for change in version.changes.iter().chain(
                            version
                                .merge_info
                                .iter()
                                .flat_map(|merge| merge.second_parent_changes.iter()),
                        ) {
                            match change {
                                InterfaceChange::AddColumn { column: candidate } => {
                                    known.insert(candidate.uuid.as_str());
                                }
                                InterfaceChange::ModifyExtends { new_extends } => {
                                    pending.extend(new_extends.iter().copied())
                                }
                                _ => {}
                            }
                        }
                    }
                }
                known
            });
            if !known.contains(column.uuid.as_str()) {
                return Err(diagnostic(
                    "error.interface.unknownColumnId",
                    json!({"column": column.data_name, "id": column.uuid}),
                ));
            }
        }
        Ok(())
    }

    /// An explicit interface type edit must use the same backend normalization
    /// as a table edit. Stage every conversion before changing any cell.
    fn normalize_changed_color_values(
        column: &ColumnSchema,
        records: &mut [crate::Record],
    ) -> Result<()> {
        let updates: Result<Vec<_>> = records
            .iter()
            .enumerate()
            .filter_map(|(index, record)| {
                record
                    .get_cell_value(column)
                    .filter(|value| !value.is_empty())
                    .map(|value| {
                        column
                            .validate_value(value)
                            .map(|value| (index, value))
                            .map_err(|error| diagnostic("error.storage.recordValue", json!({"record": record.uuid, "column": column.data_name, "error": AppError::from(error)})))
                    })
            })
            .collect();
        for (index, value) in updates? {
            records[index].set_cell_value(column, value);
        }
        Ok(())
    }

    fn apply_single_change(
        &self,
        table: &mut crate::table::Table,
        change: &InterfaceChange,
        result: &mut ApplyResult,
    ) -> Result<()> {
        match change {
            InterfaceChange::AddColumn { column } => {
                if !table.has_column(&column.data_name) {
                    // Add the column to the table
                    // Keep the interface definition's UUID as the stable column ID
                    // Regenerating it would orphan record values keyed by column UUID on every synchronization
                    let mut col_schema = column.clone();
                    // Record the interface origin
                    col_schema.interface_origin = Some(self.uuid.to_string());
                    // Also record the interface name as a fallback
                    col_schema.interface_origin_name_fallback = Some(self.name.clone());
                    table.data.schema.columns.push(col_schema);
                    result.columns_added.push(column.data_name.clone());
                }
            }
            InterfaceChange::RemoveColumn { column_name } => {
                // Apply removal only to interface-origin columns
                if let Some(col_index) = table
                    .data
                    .schema
                    .columns
                    .iter()
                    .position(|c| &c.data_name == column_name)
                {
                    let column = &table.data.schema.columns[col_index];
                    // Check whether the column originates from an interface
                    if let Some(origin) = &column.interface_origin {
                        if origin == &self.uuid.to_string() {
                            // Remove because it originates from this interface
                            let removed = table.data.schema.columns.remove(col_index);
                            for record in &mut table.data.records {
                                record.interface_values.remove(&removed.uuid);

                                record.memo_texts.remove(&removed.uuid);
                            }
                            result.columns_to_remove.push(column_name.clone());
                        } else {
                            // Do not remove because it originates from another interface
                            result.warnings.push(format!(
                                "Column {} was not deleted because it originated from another interface {}",
                                column_name, origin
                            ));
                        }
                    } else {
                        // Do not remove local columns
                        // However, strengthen the warning when a same-named column exists
                        eprintln!(
                            "Warning: column {} has no interface_origin (interface UUID: {})",
                            column_name, self.uuid
                        );
                        result.warnings.push(format!(
                            "Column {} was not deleted because it is not recognized as interface-derived. Run reconcile_table.",
                            column_name
                        ));
                    }
                } else {
                    // Do nothing if the column does not exist
                    eprintln!(
                        "Info: column {} does not exist in the table; deletion was skipped",
                        column_name
                    );
                }
            }
            InterfaceChange::ModifyColumn {
                column_name,
                old_type,
                new_type,
            } => {
                // Actually change the type of the column originating from this interface
                // (Values remain stored as strings, so they are not lost.
                // Values incompatible with the type appear as input-review validation issues)
                if let Some(col) = table.data.schema.columns.iter_mut().find(|c| {
                    &c.data_name == column_name
                        && c.interface_origin.as_deref() == Some(&self.uuid.to_string())
                }) {
                    if new_type.is_color() {
                        let mut target = col.clone();
                        target.data_type = new_type.clone();
                        Self::normalize_changed_color_values(&target, &mut table.data.records)?;
                    }
                    col.data_type = new_type.clone();
                    result.type_changes.push(TypeChange {
                        column: column_name.clone(),
                        from: old_type.clone(),
                        to: new_type.clone(),
                    });
                }
            }
            InterfaceChange::ChangeRequired {
                column_name,
                required,
            } => {
                if let Some(col) = table.data.schema.columns.iter_mut().find(|c| {
                    &c.data_name == column_name
                        && c.interface_origin.as_deref() == Some(&self.uuid.to_string())
                }) {
                    col.required = Some(*required);
                    result.metadata_changes.push(format!(
                        "Change the required flag for {} to {}",
                        column_name,
                        if *required { "true" } else { "false" }
                    ));
                }
            }
            InterfaceChange::ChangeDefault {
                column_name,
                new_default,
            } => {
                if let Some(col) = table.data.schema.columns.iter_mut().find(|c| {
                    &c.data_name == column_name
                        && c.interface_origin.as_deref() == Some(&self.uuid.to_string())
                }) {
                    col.default_value = new_default.clone().unwrap_or_default();
                    result
                        .metadata_changes
                        .push(format!("Change the default value for {}", column_name));
                }
            }
            InterfaceChange::ChangeColorSwatches {
                column_name,
                swatches,
            } => {
                crate::validate_color_swatches(swatches)?;
                if let Some(column) = table.data.schema.columns.iter_mut().find(|column| {
                    &column.data_name == column_name
                        && column.interface_origin.as_deref() == Some(&self.uuid.to_string())
                }) {
                    column.color_swatches = swatches.clone();
                    result
                        .metadata_changes
                        .push(format!("Change the color swatch for {}", column_name));
                }
            }
            InterfaceChange::ChangeConstraints {
                column_name,
                new_constraints,
            } => {
                if let Some(col) = table.data.schema.columns.iter_mut().find(|c| {
                    &c.data_name == column_name
                        && c.interface_origin.as_deref() == Some(&self.uuid.to_string())
                }) {
                    col.constraints = new_constraints
                        .clone()
                        .filter(|constraints| !constraints.is_empty());
                    result
                        .metadata_changes
                        .push(format!("Change constraints for {}", column_name));
                }
            }
            InterfaceChange::ChangeMinVersion {
                column_name,
                min_version,
            } => {
                if let Some(col) = table.data.schema.columns.iter_mut().find(|c| {
                    &c.data_name == column_name
                        && c.interface_origin.as_deref() == Some(&self.uuid.to_string())
                }) {
                    col.min_version = *min_version;
                    result
                        .metadata_changes
                        .push(format!("Change the version for {}", column_name));
                }
            }
            InterfaceChange::ChangeInputValidation {
                column_name,
                settings,
            } => {
                if let Some(col) = table.data.schema.columns.iter_mut().find(|c| {
                    &c.data_name == column_name
                        && c.interface_origin.as_deref() == Some(&self.uuid.to_string())
                }) {
                    col.input_validation = settings.clone();
                    result
                        .metadata_changes
                        .push(format!("Change input rules for {}", column_name));
                }
            }
            InterfaceChange::ChangeConditionalFormatting {
                column_name,
                formatting,
            } => {
                if let Some(col) = table.data.schema.columns.iter_mut().find(|c| {
                    &c.data_name == column_name
                        && c.interface_origin.as_deref() == Some(&self.uuid.to_string())
                }) {
                    col.conditional_formatting = formatting.clone();
                    // The table's explicit override is intentionally preserved.
                    result
                        .metadata_changes
                        .push(format!("Change conditional formatting for {}", column_name));
                }
            }
            InterfaceChange::RenameColumn { old_name, new_name } => {
                // Rename this interface-origin column in place
                // Preserving the column UUID also preserves record values keyed by it
                if let Some(col) = table.data.schema.columns.iter_mut().find(|c| {
                    &c.data_name == old_name
                        && c.interface_origin.as_deref() == Some(&self.uuid.to_string())
                }) {
                    if col.display_name == *old_name {
                        col.display_name = new_name.clone();
                    }
                    col.data_name = new_name.clone();
                    result
                        .metadata_changes
                        .push(format!("Rename column from {} to {}", old_name, new_name));
                }
            }
            InterfaceChange::ModifyColumnMeta {
                column_name,
                display_name,
                tooltip,
                memo_text,
                style,
            } => {
                if let Some(col) = table.data.schema.columns.iter_mut().find(|c| {
                    &c.data_name == column_name
                        && c.interface_origin.as_deref() == Some(&self.uuid.to_string())
                }) {
                    if let Some(display_name) = display_name {
                        col.display_name = display_name.clone();
                    }
                    if let Some(tooltip) = tooltip {
                        col.tooltip = tooltip.clone();
                    }
                    if let Some(memo_text) = memo_text {
                        col.memo_text = memo_text.clone();
                    }
                    if let Some(style) = style {
                        col.style = style.clone();
                    }
                    result
                        .metadata_changes
                        .push(format!("Change display information for {}", column_name));
                }
            }
            InterfaceChange::ConfigureColumn {
                column_name,
                reference_config,
                curve_config,
                table_ref_config,
                select_config,
            } => {
                if let Some(column) = table.data.schema.columns.iter_mut().find(|c| {
                    &c.data_name == column_name
                        && c.interface_origin.as_deref() == Some(&self.uuid.to_string())
                }) {
                    column.reference_config = reference_config.clone();
                    column.curve_config = curve_config.clone();
                    column.table_ref_config = table_ref_config.clone();
                    column.select_config = select_config.clone();
                    result
                        .metadata_changes
                        .push(format!("Change type settings for {}", column_name));
                }
            }
            InterfaceChange::ChangeDescription { .. } => {
                // Changing the interface's own description does not affect table structure
            }
            InterfaceChange::ModifyExtends { .. } => {
                // Inheritance changes do not directly affect table structure (handled by reconcile_table)
                // Still retain the change in the record
                result
                    .metadata_changes
                    .push("The inheritance relationship changed".to_string());
            }
            InterfaceChange::ReorderColumns { .. } => {
                // Each table maintains its own column order and can freely reorder columns.
                // Reordering an interface affects only definition order and initial application order;
                // it does not forcibly reorder existing tables.
            }
        }
        Ok(())
    }

    pub(crate) fn historical_column_ids(&self, registry: &InterfaceRegistry) -> HashSet<String> {
        let mut result = HashSet::new();
        let mut seen = HashSet::new();
        let mut pending = vec![self.uuid];
        while let Some(id) = pending.pop() {
            if !seen.insert(id) {
                continue;
            }
            let interface = if id == self.uuid {
                Some(self)
            } else {
                registry.get_interface(&id)
            };
            let Some(interface) = interface else { continue };
            result.extend(interface.columns.iter().map(|column| column.uuid.clone()));
            pending.extend(interface.extends.iter().copied());
            for version in interface.history.values() {
                for change in version.changes.iter().chain(
                    version
                        .merge_info
                        .iter()
                        .flat_map(|merge| merge.second_parent_changes.iter()),
                ) {
                    match change {
                        InterfaceChange::AddColumn { column } => {
                            result.insert(column.uuid.clone());
                        }
                        InterfaceChange::ModifyExtends { new_extends } => {
                            pending.extend(new_extends.iter().copied())
                        }
                        _ => {}
                    }
                }
            }
        }
        result
    }

    pub(crate) fn required_ids(
        table: &crate::table::TableData,
        id: &Uuid,
        registry: &InterfaceRegistry,
    ) -> HashSet<String> {
        let Some(implementation) = table.interface_implementations.get(id) else {
            return HashSet::new();
        };
        if let Some(ids) = &implementation.required_column_uuids {
            return ids.iter().cloned().collect();
        }
        let Some(interface) = registry.get_interface(id) else {
            return table
                .schema
                .columns
                .iter()
                .filter(|column| column.interface_origin.is_some())
                .map(|column| column.uuid.clone())
                .collect();
        };
        // Old files have no identity snapshot. A confirmed current fingerprint
        // proves the effective definition; do not resurrect every historical ID.
        if !interface.table_needs_sync(implementation, registry) {
            if let Ok(columns) = interface.get_effective_columns(registry) {
                return columns.into_iter().map(|column| column.uuid).collect();
            }
        }
        // A direct historical definition is also exact. Ancestor HEADs at an
        // older sync cannot be reconstructed from the child's version alone;
        // conservatively retain those identities until the pending set is synced.
        if let Ok((columns, parents, _)) =
            interface.state_at_version(implementation.synced_version_id)
        {
            if parents.is_empty() {
                return columns.into_iter().map(|column| column.uuid).collect();
            }
        }
        interface.historical_column_ids(registry)
    }

    pub(crate) fn check_shared_update(
        &self,
        table: &crate::table::Table,
        columns: &[ColumnSchema],
        registry: &InterfaceRegistry,
    ) -> Result<()> {
        for (id, implementation) in &table.data.interface_implementations {
            if *id == self.uuid {
                continue;
            }
            let Some(other) = registry.get_interface(id) else {
                return Err(authoring_error("A required interface is missing"));
            };
            if !other.table_needs_sync(implementation, registry) {
                continue;
            }
            let required = Self::required_ids(&table.data, id, registry);
            for definition in columns
                .iter()
                .filter(|column| required.contains(&column.uuid))
            {
                if let Some(existing) = table
                    .data
                    .schema
                    .columns
                    .iter()
                    .find(|column| column.uuid == definition.uuid)
                {
                    if existing.data_name != definition.data_name
                        || !Self::columns_equivalent(existing, definition)
                    {
                        return Err(authoring_error("Shared interface fields have pending changes. Synchronize the table's pending interfaces together"));
                    }
                }
            }
        }
        Ok(())
    }

    /// Preview ambiguous human-readable names against the accumulated selection.
    /// Shared ancestor identities are one field, even if first applied by a sibling.
    pub fn column_name_collisions(
        &self,
        existing: &[ColumnSchema],
        registry: &InterfaceRegistry,
    ) -> Result<Vec<String>> {
        let mut collisions: Vec<_> = self
            .get_effective_columns(registry)?
            .into_iter()
            .filter(|incoming| {
                existing.iter().any(|column| {
                    column.data_name == incoming.data_name && column.uuid != incoming.uuid
                })
            })
            .map(|column| column.data_name)
            .collect();
        collisions.sort();
        collisions.dedup();
        Ok(collisions)
    }

    /// Fully align the table with the current interface definition
    pub fn reconcile_table(
        &self,
        table: &mut crate::table::Table,
        registry: &InterfaceRegistry,
    ) -> Result<ApplyResult> {
        let mut result = ApplyResult::default();

        Self::validate_table_column_ids(&table.data, registry)?;
        eprintln!(
            "=== Starting reconcile_table: {} (UUID: {}) ===",
            self.name, self.uuid
        );
        eprintln!(
            "Existing columns in table: {}",
            table.data.schema.columns.len()
        );

        // Output the state of every column
        for (index, col) in table.data.schema.columns.iter().enumerate() {
            eprintln!(
                "  Column[{}]: {} (origin: {:?}, fallback: {:?})",
                index, col.data_name, col.interface_origin, col.interface_origin_name_fallback
            );
        }

        // Get effective columns, including inheritance
        let effective_columns = self.get_effective_columns(registry)?;
        eprintln!(
            "Effective columns (including inherited): {}",
            effective_columns.len()
        );

        let previous_required = Self::required_ids(&table.data, &self.uuid, registry);
        let retained_by_others: HashSet<_> = table
            .data
            .interface_implementations
            .keys()
            .filter(|id| **id != self.uuid)
            .flat_map(|id| Self::required_ids(&table.data, id, registry))
            .collect();
        self.check_shared_update(table, &effective_columns, registry)?;

        // Names belong to stable identities, regardless of which sibling first
        // caused the shared ancestor field to be materialized.
        for table_column in &mut table.data.schema.columns {
            if table_column.interface_origin.is_some() {
                if let Some(definition) = effective_columns
                    .iter()
                    .find(|column| column.uuid == table_column.uuid)
                {
                    if table_column.data_name != definition.data_name {
                        table_column.data_name = definition.data_name.clone();
                        result.metadata_changes.push(format!(
                            "Synchronize the column name for {}",
                            definition.data_name
                        ));
                    }
                }
            }
        }

        // 1. Collect all columns originating from related interfaces
        let mut interface_origin_columns: Vec<(usize, String)> = Vec::new();
        for (index, table_column) in table.data.schema.columns.iter().enumerate() {
            if let Some(origin) = &table_column.interface_origin {
                if previous_required.contains(&table_column.uuid) {
                    eprintln!(
                        "  Found column from a related interface: {} (origin: {}, index: {})",
                        table_column.data_name, origin, index
                    );
                    interface_origin_columns.push((index, table_column.data_name.clone()));
                }
            }
        }
        eprintln!(
            "Columns from related interfaces: {}",
            interface_origin_columns.len()
        );

        // 2. Remove columns no longer present in the current interface
        let mut columns_to_remove = Vec::new();
        for (index, data_name) in &interface_origin_columns {
            let exists_in_interface = effective_columns
                .iter()
                .any(|ic| ic.uuid == table.data.schema.columns[*index].uuid);

            if !exists_in_interface
                && !retained_by_others.contains(&table.data.schema.columns[*index].uuid)
            {
                eprintln!(
                    "  Marked for deletion: {} (not in the interface)",
                    data_name
                );
                columns_to_remove.push(*index);
                result.columns_to_remove.push(data_name.clone());
            }
        }

        // Remove in reverse index order to avoid shifting subsequent indices
        columns_to_remove.sort_unstable_by(|a, b| b.cmp(a));
        for index in columns_to_remove {
            let removed = table.data.schema.columns.remove(index);
            for record in &mut table.data.records {
                record.interface_values.remove(&removed.uuid);

                record.memo_texts.remove(&removed.uuid);
            }
        }

        // 3. Add interface-defined columns only when missing

        // Collect columns originating from this interface and insert them in the correct positions
        let mut new_interface_columns = Vec::new();

        for interface_column in &effective_columns {
            // Check for a column with the same data_name originating from this interface
            let already_exists = table.data.schema.columns.iter().any(|column| {
                column.interface_origin.is_some() && column.uuid == interface_column.uuid
            });

            if !already_exists {
                eprintln!(
                    "  Added: {} (origin: {:?})",
                    interface_column.data_name, interface_column.interface_origin
                );
                // Add missing columns to the insertion list
                // Keep the interface definition's UUID as the stable column ID
                let mut col_schema = interface_column.clone();

                // get_effective_columns already sets interface_origin, but verify it
                if col_schema.interface_origin.is_none() {
                    col_schema.interface_origin = Some(self.uuid.to_string());
                    col_schema.interface_origin_name_fallback = Some(self.name.clone());
                }

                new_interface_columns.push(col_schema);
                result
                    .columns_added
                    .push(interface_column.data_name.clone());
            } else {
                eprintln!("  Skipped: {} (already exists)", interface_column.data_name);
            }
        }

        // Add new columns together, preserving interface definition order
        table.data.schema.columns.extend(new_interface_columns);

        // 4. Synchronize existing column fields with the effective definition
        // (Reconciliation ensures full alignment, including types, required flags, defaults,
        // constraints, and display metadata, enabling recovery when no synchronization path exists)
        for interface_column in &effective_columns {
            if let Some(table_col) = table.data.schema.columns.iter_mut().find(|column| {
                column.interface_origin.is_some() && column.uuid == interface_column.uuid
            }) {
                if table_col.data_type != interface_column.data_type {
                    if interface_column.data_type.is_color() {
                        Self::normalize_changed_color_values(
                            interface_column,
                            &mut table.data.records,
                        )?;
                    }
                    result.type_changes.push(TypeChange {
                        column: interface_column.data_name.clone(),
                        from: table_col.data_type.clone(),
                        to: interface_column.data_type.clone(),
                    });
                    table_col.data_type = interface_column.data_type.clone();
                }
                if table_col.min_version != interface_column.min_version {
                    table_col.min_version = interface_column.min_version;
                    result.metadata_changes.push(format!(
                        "Synchronize the version for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.input_validation != interface_column.input_validation {
                    table_col.input_validation = interface_column.input_validation.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize input rules for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.conditional_formatting != interface_column.conditional_formatting {
                    table_col.conditional_formatting =
                        interface_column.conditional_formatting.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize conditional formatting for {}",
                        interface_column.data_name
                    ));
                }
                // conditional_formatting_override belongs to this table and is never reconciled.
                if table_col.required != interface_column.required {
                    table_col.required = interface_column.required;
                    result.metadata_changes.push(format!(
                        "Synchronize the required flag for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.color_swatches != interface_column.color_swatches {
                    table_col.color_swatches = interface_column.color_swatches.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize the color swatch for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.default_value != interface_column.default_value {
                    table_col.default_value = interface_column.default_value.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize the default value for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.constraints != interface_column.constraints {
                    table_col.constraints = interface_column.constraints.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize constraints for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.display_name != interface_column.display_name {
                    table_col.display_name = interface_column.display_name.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize the display name for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.tooltip != interface_column.tooltip {
                    table_col.tooltip = interface_column.tooltip.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize the tooltip for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.memo_text != interface_column.memo_text {
                    table_col.memo_text = interface_column.memo_text.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize the detailed description for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.style != interface_column.style {
                    table_col.style = interface_column.style.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize the display style for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.reference_config != interface_column.reference_config {
                    table_col.reference_config = interface_column.reference_config.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize reference settings for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.table_ref_config != interface_column.table_ref_config {
                    table_col.table_ref_config = interface_column.table_ref_config.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize table reference settings for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.select_config != interface_column.select_config {
                    table_col.select_config = interface_column.select_config.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize select options for {}",
                        interface_column.data_name
                    ));
                }
                if table_col.curve_config != interface_column.curve_config {
                    table_col.curve_config = interface_column.curve_config.clone();
                    result.metadata_changes.push(format!(
                        "Synchronize curve settings for {}",
                        interface_column.data_name
                    ));
                }
            }
        }

        // 5. Each table maintains its own column order and can freely reorder columns,
        //    preserving mixed ordering of interface-origin and local columns.
        //    Step 3 already appended new columns. Do not forcibly reorder here.

        eprintln!(
            "=== Finished reconcile_table: added={}, deleted={} ===",
            result.columns_added.len(),
            result.columns_to_remove.len()
        );
        eprintln!("Final column count: {}", table.data.schema.columns.len());
        for (i, col) in table.data.schema.columns.iter().enumerate() {
            eprintln!(
                "  [{}] {} (origin: {:?})",
                i, col.data_name, col.interface_origin
            );
        }

        // Update synchronization information, including the effective fingerprint for detecting parent changes
        let fingerprint = self.effective_fingerprint(registry);
        if let Some(impl_info) = table.data.interface_implementations.get_mut(&self.uuid) {
            impl_info.synced_version_id = self.current_version_id;
            impl_info.last_sync_date = Utc::now();
            impl_info.effective_fingerprint = Some(fingerprint);
            impl_info.required_column_uuids = Some(
                self.get_effective_columns(registry)?
                    .iter()
                    .map(|column| column.uuid.clone())
                    .collect(),
            );
        }

        // Set the dirty flag if changes occurred
        if !result.columns_added.is_empty()
            || !result.columns_to_remove.is_empty()
            || !result.type_changes.is_empty()
            || !result.metadata_changes.is_empty()
        {
            table.mark_dirty();
        }

        Ok(result)
    }

    /// Remove (detach) an interface from the table
    pub fn remove_from_table(&self, table: &mut crate::table::Table) -> Result<ApplyResult> {
        let mut result = ApplyResult::default();

        eprintln!(
            "Removing interface '{}' from table '{}'",
            self.name, table.data.display_name
        );
        eprintln!("Interface UUID: {}", self.uuid);

        let previous_required: HashSet<_> = table
            .data
            .interface_implementations
            .get(&self.uuid)
            .and_then(|implementation| implementation.required_column_uuids.clone())
            .map(|ids| ids.into_iter().collect())
            .unwrap_or_else(|| {
                table
                    .data
                    .schema
                    .columns
                    .iter()
                    .filter(|column| {
                        column.interface_origin.as_deref() == Some(&self.uuid.to_string())
                            || table.data.interface_implementations.len() == 1
                                && column.interface_origin.is_some()
                    })
                    .map(|column| column.uuid.clone())
                    .collect()
            });
        let unknown_remaining =
            table
                .data
                .interface_implementations
                .iter()
                .any(|(id, implementation)| {
                    *id != self.uuid && implementation.required_column_uuids.is_none()
                });
        let retained: HashSet<_> = table
            .data
            .interface_implementations
            .iter()
            .filter(|(id, _)| **id != self.uuid)
            .flat_map(|(_, implementation)| {
                implementation
                    .required_column_uuids
                    .iter()
                    .flatten()
                    .cloned()
            })
            .collect();
        let mut columns_to_remove = Vec::new();
        for (index, column) in table.data.schema.columns.iter().enumerate() {
            if column.interface_origin.is_some()
                && previous_required.contains(&column.uuid)
                && !retained.contains(&column.uuid)
                && !unknown_remaining
            {
                columns_to_remove.push(index);
                result.columns_to_remove.push(column.data_name.clone());
            }
        }

        eprintln!("Columns to remove: {:?}", result.columns_to_remove);

        // Remove in reverse index order to avoid shifting subsequent indices
        for index in columns_to_remove.into_iter().rev() {
            eprintln!("Removing column at index {}", index);
            let removed_column = table.data.schema.columns.remove(index);

            // Remove corresponding values from records too
            // Interface-origin column values are in interface_values, keyed by column UUID
            // (Stable column IDs would otherwise resurrect old values when the interface is reapplied)
            let column_uuid = removed_column.uuid.to_string();
            for record in &mut table.data.records {
                record.interface_values.remove(&column_uuid);

                record.memo_texts.remove(&column_uuid);
            }
        }

        // Remove interface implementation information
        table.data.interface_implementations.remove(&self.uuid);
        table
            .data
            .metadata
            .interface_order
            .retain(|id| *id != self.uuid);
        for column in &mut table.data.schema.columns {
            if column.interface_origin.as_deref() == Some(&self.uuid.to_string()) {
                let mut owners: Vec<_> = table
                    .data
                    .interface_implementations
                    .iter()
                    .filter(|(_, implementation)| {
                        implementation
                            .required_column_uuids
                            .as_ref()
                            .is_some_and(|ids| ids.contains(&column.uuid))
                    })
                    .map(|(id, _)| *id)
                    .collect();
                owners.sort();
                if let Some(owner) = owners.first() {
                    column.interface_origin = Some(owner.to_string());
                    column.interface_origin_name_fallback = None;
                }
            }
        }

        eprintln!("Removed interface implementation info for '{}'", self.name);

        // Set the dirty flag if changes occurred
        if !result.columns_to_remove.is_empty() {
            table.mark_dirty();
            eprintln!("Table marked as dirty");
        }

        Ok(result)
    }

    /// Find a path from the specified version to the current version
    pub fn find_path(&self, from: Uuid, to: Uuid) -> Result<Vec<Uuid>> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut parent_map = HashMap::new();

        queue.push_back(from);
        visited.insert(from);

        while let Some(current) = queue.pop_front() {
            if current == to {
                return Ok(self.reconstruct_path(&parent_map, from, to));
            }

            // Find child versions
            for (id, version) in &self.history {
                if let Some(parent) = version.parent_version_id {
                    if parent == current && !visited.contains(id) {
                        visited.insert(*id);
                        parent_map.insert(*id, current);
                        queue.push_back(*id);
                    }
                }

                // Include the second parent of merges
                if let Some(merge_info) = &version.merge_info {
                    if merge_info.second_parent_id == current && !visited.contains(id) {
                        visited.insert(*id);
                        parent_map.insert(*id, current);
                        queue.push_back(*id);
                    }
                }
            }
        }

        Err(diagnostic(
            "error.interface.historyPath",
            json!({"from": from, "to": to}),
        ))
    }

    /// Reconstruct the path
    fn reconstruct_path(
        &self,
        parent_map: &HashMap<Uuid, Uuid>,
        from: Uuid,
        to: Uuid,
    ) -> Vec<Uuid> {
        let mut path = vec![to];
        let mut current = to;

        while current != from {
            if let Some(&parent) = parent_map.get(&current) {
                path.push(parent);
                current = parent;
            } else {
                break;
            }
        }

        path.reverse();
        path
    }

    /// List branch heads (versions with no children)
    /// Two or more heads indicate divergent history requiring a merge
    pub fn get_branch_heads(&self) -> Vec<Uuid> {
        let mut has_child: HashSet<Uuid> = HashSet::new();
        for version in self.history.values() {
            if let Some(parent) = version.parent_version_id {
                has_child.insert(parent);
            }
            if let Some(merge_info) = &version.merge_info {
                has_child.insert(merge_info.second_parent_id);
            }
        }

        let mut heads: Vec<Uuid> = self
            .history
            .keys()
            .filter(|id| !has_child.contains(id))
            .copied()
            .collect();
        // Use stable timestamp order, breaking ties by UUID
        heads.sort_by_key(|id| {
            self.history
                .get(id)
                .map(|v| (v.timestamp, v.version_id))
                .unwrap_or((Utc::now(), *id))
        });
        heads
    }

    /// Collect all ancestors of a version, including itself
    fn collect_ancestors(&self, version_id: Uuid) -> HashSet<Uuid> {
        let mut result = HashSet::new();
        let mut stack = vec![version_id];

        while let Some(current) = stack.pop() {
            if !result.insert(current) {
                continue;
            }
            if let Some(version) = self.history.get(&current) {
                if let Some(parent) = version.parent_version_id {
                    stack.push(parent);
                }
                if let Some(merge_info) = &version.merge_info {
                    stack.push(merge_info.second_parent_id);
                }
            }
        }

        result
    }

    /// Find the nearest common ancestor
    fn find_common_ancestor(&self, v1: Uuid, v2: Uuid) -> Result<Uuid> {
        let ancestors2 = self.collect_ancestors(v2);
        let ancestors1 = self.collect_ancestors(v1);
        let common: HashSet<_> = ancestors1.intersection(&ancestors2).copied().collect();
        let parents = |id: &Uuid| -> Vec<Uuid> {
            self.history
                .get(id)
                .map(|version| {
                    version
                        .parent_version_id
                        .into_iter()
                        .chain(version.merge_info.iter().map(|info| info.second_parent_id))
                        .collect()
                })
                .unwrap_or_default()
        };
        let mut dominated = HashSet::new();
        let mut stack: Vec<_> = common.iter().flat_map(parents).collect();
        while let Some(id) = stack.pop() {
            if dominated.insert(id) {
                stack.extend(parents(&id));
            }
        }
        // Preserve deterministic traversal among incomparable maximal bases, but
        // never prefer an older ancestor merely because a merge edge is shorter.
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(v1);

        while let Some(current) = queue.pop_front() {
            if !visited.insert(current) {
                continue;
            }
            if common.contains(&current) && !dominated.contains(&current) {
                return Ok(current);
            }
            if let Some(version) = self.history.get(&current) {
                if let Some(parent) = version.parent_version_id {
                    queue.push_back(parent);
                }
                if let Some(merge_info) = &version.merge_info {
                    queue.push_back(merge_info.second_parent_id);
                }
            }
        }

        Err(diagnostic(
            "error.interface.historyAncestor",
            json!({"ours": v1, "theirs": v2}),
        ))
    }

    /// Restore columns, inheritance, and description from a version's first-parent chain.
    /// Each version stores changes relative to its first parent.
    fn state_at_version(&self, version_id: Uuid) -> Result<InterfaceVersionState> {
        let mut chain = Vec::new();
        let mut visited = HashSet::new();
        let mut current = version_id;
        loop {
            if !visited.insert(current) {
                return Err(diagnostic(
                    "error.interface.historyCycle",
                    json!({"version": current}),
                ));
            }
            let version = self.history.get(&current).ok_or_else(|| {
                diagnostic(
                    "error.interface.historyVersion",
                    json!({"version": current}),
                )
            })?;
            if version.version_id != current {
                return Err(diagnostic(
                    "error.interface.historyIdentity",
                    json!({"key": current, "version": version.version_id}),
                ));
            }
            chain.push(version);
            match version.parent_version_id {
                Some(parent) => current = parent,
                None => {
                    if !matches!(
                        version.changes.first(),
                        Some(InterfaceChange::ChangeDescription { .. })
                    ) {
                        return Err(diagnostic(
                            "error.interface.historyInitial",
                            json!({"version": current}),
                        ));
                    }
                    break;
                }
            }
        }
        let mut columns = Vec::new();
        let mut extends = Vec::new();
        let mut description = None;
        for version in chain.into_iter().rev() {
            for (index, change) in version.changes.iter().enumerate() {
                Self::apply_change_to_state(&mut columns, &mut extends, &mut description, change)
                    .map_err(|error| diagnostic("error.interface.historyChange", json!({
                        "version": version.version_id, "index": index + 1, "error": AppError::from(error)
                    })))?;
            }
        }
        Ok((columns, extends, description))
    }

    /// Compare columns using only fields significant to merge decisions
    fn columns_equivalent(a: &ColumnSchema, b: &ColumnSchema) -> bool {
        a.min_version == b.min_version
            && a.data_type == b.data_type
            && a.required.unwrap_or(false) == b.required.unwrap_or(false)
            && a.default_value == b.default_value
            && a.color_swatches == b.color_swatches
            && Self::normalized_constraints(a) == Self::normalized_constraints(b)
            && Self::configuration_equal(a, b)
            && a.input_validation == b.input_validation
            && a.conditional_formatting == b.conditional_formatting
    }

    fn configuration_equal(a: &ColumnSchema, b: &ColumnSchema) -> bool {
        a.reference_config == b.reference_config
            && a.curve_config == b.curve_config
            && a.table_ref_config == b.table_ref_config
            && a.select_config == b.select_config
    }

    fn normalized_constraints(col: &ColumnSchema) -> Option<crate::column::ColumnConstraints> {
        col.constraints
            .clone()
            .filter(|constraints| !constraints.is_empty())
    }

    /// Compute changes between two states as a list of InterfaceChange values
    /// Match columns by UUID first (stable column ID); matching UUIDs with different names
    /// are detected as RenameColumn changes, preserving record values
    /// Return changes in sequentially applicable order: remove, rename, edit fields, add
    fn diff_states(
        from_columns: &[ColumnSchema],
        from_extends: &[Uuid],
        from_description: &Option<String>,
        to_columns: &[ColumnSchema],
        to_extends: &[Uuid],
        to_description: &Option<String>,
    ) -> Vec<InterfaceChange> {
        let mut changes = Vec::new();

        // Column UUID is the only identity across history.
        let mut matched: Vec<(usize, usize)> = Vec::new(); // (from_idx, to_idx)
        let mut from_used = vec![false; from_columns.len()];
        let mut to_used = vec![false; to_columns.len()];

        for (ti, to_col) in to_columns.iter().enumerate() {
            if let Some(fi) = from_columns
                .iter()
                .position(|f| f.uuid == to_col.uuid && !f.uuid.is_empty())
            {
                if !from_used[fi] {
                    matched.push((fi, ti));
                    from_used[fi] = true;
                    to_used[ti] = true;
                }
            }
        }
        // 1. Remove unmatched columns from the source
        for (fi, from_col) in from_columns.iter().enumerate() {
            if !from_used[fi] {
                changes.push(InterfaceChange::RemoveColumn {
                    column_name: from_col.data_name.clone(),
                });
            }
        }

        // 2. Rename in a safe order to avoid name collisions; resolve cycles with temporary names
        let mut occupied: HashSet<String> = matched
            .iter()
            .map(|(fi, _)| from_columns[*fi].data_name.clone())
            .collect();
        let mut pending: Vec<(String, String)> = matched
            .iter()
            .filter(|(fi, ti)| from_columns[*fi].data_name != to_columns[*ti].data_name)
            .map(|(fi, ti)| {
                (
                    from_columns[*fi].data_name.clone(),
                    to_columns[*ti].data_name.clone(),
                )
            })
            .collect();
        let mut temp_counter = 0;
        while !pending.is_empty() {
            if let Some(pos) = pending.iter().position(|(_, new)| !occupied.contains(new)) {
                let (old, new) = pending.remove(pos);
                occupied.remove(&old);
                occupied.insert(new.clone());
                changes.push(InterfaceChange::RenameColumn {
                    old_name: old,
                    new_name: new,
                });
            } else {
                // Resolve name-swap cycles using a temporary name
                let (old, new) = pending.remove(0);
                let mut temp;
                loop {
                    temp = format!("__rename_tmp_{}", temp_counter);
                    temp_counter += 1;
                    if !occupied.contains(&temp) {
                        break;
                    }
                }
                occupied.remove(&old);
                occupied.insert(temp.clone());
                changes.push(InterfaceChange::RenameColumn {
                    old_name: old,
                    new_name: temp.clone(),
                });
                pending.push((temp, new));
            }
        }

        // 3. Change fields, referring to columns by their renamed names
        for (fi, ti) in &matched {
            let from_col = &from_columns[*fi];
            let to_col = &to_columns[*ti];
            let column_name = to_col.data_name.clone();

            if from_col.data_type != to_col.data_type {
                changes.push(InterfaceChange::ModifyColumn {
                    column_name: column_name.clone(),
                    old_type: from_col.data_type.clone(),
                    new_type: to_col.data_type.clone(),
                });
            }
            if from_col.required.unwrap_or(false) != to_col.required.unwrap_or(false) {
                changes.push(InterfaceChange::ChangeRequired {
                    column_name: column_name.clone(),
                    required: to_col.required.unwrap_or(false),
                });
            }
            if from_col.color_swatches != to_col.color_swatches {
                changes.push(InterfaceChange::ChangeColorSwatches {
                    column_name: column_name.clone(),
                    swatches: to_col.color_swatches.clone(),
                });
            }
            if from_col.default_value != to_col.default_value {
                changes.push(InterfaceChange::ChangeDefault {
                    column_name: column_name.clone(),
                    new_default: if to_col.default_value.is_empty() {
                        None
                    } else {
                        Some(to_col.default_value.clone())
                    },
                });
            }
            if Self::normalized_constraints(from_col) != Self::normalized_constraints(to_col) {
                changes.push(InterfaceChange::ChangeConstraints {
                    column_name: column_name.clone(),
                    new_constraints: Self::normalized_constraints(to_col),
                });
            }

            if from_col.min_version != to_col.min_version {
                changes.push(InterfaceChange::ChangeMinVersion {
                    column_name: column_name.clone(),
                    min_version: to_col.min_version,
                });
            }
            if from_col.input_validation != to_col.input_validation {
                changes.push(InterfaceChange::ChangeInputValidation {
                    column_name: column_name.clone(),
                    settings: to_col.input_validation.clone(),
                });
            }
            if from_col.conditional_formatting != to_col.conditional_formatting {
                changes.push(InterfaceChange::ChangeConditionalFormatting {
                    column_name: column_name.clone(),
                    formatting: to_col.conditional_formatting.clone(),
                });
            }

            if from_col.reference_config != to_col.reference_config
                || from_col.curve_config != to_col.curve_config
                || from_col.table_ref_config != to_col.table_ref_config
                || from_col.select_config != to_col.select_config
            {
                changes.push(InterfaceChange::ConfigureColumn {
                    column_name: column_name.clone(),
                    reference_config: to_col.reference_config.clone(),
                    curve_config: to_col.curve_config.clone(),
                    table_ref_config: to_col.table_ref_config.clone(),
                    select_config: to_col.select_config.clone(),
                });
            }

            // Display metadata differences
            // Account for display names following a rename when they matched the data name
            let from_display_after_rename = if from_col.display_name == from_col.data_name {
                to_col.data_name.clone()
            } else {
                from_col.display_name.clone()
            };
            let display_diff = from_display_after_rename != to_col.display_name;
            let tooltip_diff = from_col.tooltip != to_col.tooltip;
            let memo_diff = from_col.memo_text != to_col.memo_text;
            let style_diff = from_col.style != to_col.style;
            if display_diff || tooltip_diff || memo_diff || style_diff {
                changes.push(InterfaceChange::ModifyColumnMeta {
                    column_name,
                    display_name: display_diff.then(|| to_col.display_name.clone()),
                    tooltip: tooltip_diff.then(|| to_col.tooltip.clone()),
                    memo_text: memo_diff.then(|| to_col.memo_text.clone()),
                    style: style_diff.then(|| to_col.style.clone()),
                });
            }
        }

        // 4. Add unmatched columns from the target
        for (ti, to_col) in to_columns.iter().enumerate() {
            if !to_used[ti] {
                changes.push(InterfaceChange::AddColumn {
                    column: to_col.clone(),
                });
            }
        }

        if from_extends != to_extends {
            changes.push(InterfaceChange::ModifyExtends {
                new_extends: to_extends.to_vec(),
            });
        }

        if from_description != to_description {
            changes.push(InterfaceChange::ChangeDescription {
                new_description: to_description.clone(),
            });
        }

        changes
    }

    /// Generate display strings for values used in merge decisions
    fn describe_field_value(field: &str, col: &ColumnSchema) -> String {
        match field {
            "min_version" => col.min_version.to_string(),
            "name" => col.data_name.clone(),
            "type" => format!("{:?}", col.data_type),
            "input_validation" => serde_json::to_string(&col.input_validation).unwrap_or_default(),
            "conditional_formatting" => {
                serde_json::to_string(&col.conditional_formatting).unwrap_or_default()
            }
            "color_swatches" => serde_json::to_string(&col.color_swatches).unwrap_or_default(),
            "configuration" => serde_json::to_string(&(
                &col.reference_config,
                &col.curve_config,
                &col.table_ref_config,
                &col.select_config,
            ))
            .unwrap_or_default(),
            "required" => if col.required.unwrap_or(false) {
                "Required"
            } else {
                "Optional"
            }
            .to_string(),
            "default" => {
                if col.default_value.is_empty() {
                    "(none)".to_string()
                } else {
                    format!("「{}」", col.default_value)
                }
            }
            "constraints" => match Self::normalized_constraints(col) {
                None => "(none)".to_string(),
                Some(c) => {
                    let mut parts = Vec::new();
                    if c.unique.unwrap_or(false) {
                        parts.push("Disallow duplicate values".to_string());
                    }
                    match (c.min_value, c.max_value) {
                        (Some(min), Some(max)) => parts.push(format!("{}〜{}", min, max)),
                        (Some(min), None) => parts.push(format!("At least {}", min)),
                        (None, Some(max)) => parts.push(format!("At most {}", max)),
                        (None, None) => {}
                    }
                    if c.pattern.is_some() {
                        parts.push("Format specified".to_string());
                    }
                    parts.join("、")
                }
            },
            _ => String::new(),
        }
    }

    /// Three-way merge result
    /// Columns, inheritance, and description reflect the merged state; conflicts contains all detected conflicts;
    /// unresolved contains descriptions of conflicts without a specified resolution
    ///
    /// Match columns by UUID first and automatically merge fields using a three-way comparison.
    /// A conflict occurs only when both sides change the same field to different values;
    /// resolutions (column name -> resolution method) apply only to conflicting fields
    #[allow(clippy::type_complexity)]
    fn compute_merge(
        &self,
        ours: Uuid,
        theirs: Uuid,
        resolutions: &HashMap<String, ResolutionType>,
    ) -> Result<(
        Vec<ColumnSchema>,
        Vec<Uuid>,
        Option<String>,
        Vec<ConflictResolution>,
        Vec<String>,
    )> {
        let ancestor = self.find_common_ancestor(ours, theirs)?;
        let (anc_columns, anc_extends, anc_description) = self.state_at_version(ancestor)?;
        let (our_columns, our_extends, our_description) = self.state_at_version(ours)?;
        let (their_columns, their_extends, their_description) = self.state_at_version(theirs)?;

        let mut merged_columns: Vec<ColumnSchema> = Vec::new();
        let mut conflicts: Vec<ConflictResolution> = Vec::new();
        let mut unresolved: Vec<String> = Vec::new();

        // Pair only identical UUIDs; same-name independent identities conflict below.
        struct Slot {
            anc: Option<usize>,
            ours: Option<usize>,
            theirs: Option<usize>,
        }
        let mut slots: Vec<Slot> = Vec::new();
        let mut their_used = vec![false; their_columns.len()];
        let find_anc = |col: &ColumnSchema| -> Option<usize> {
            anc_columns.iter().position(|a| a.uuid == col.uuid)
        };

        for (oi, our_col) in our_columns.iter().enumerate() {
            let ti = their_columns
                .iter()
                .position(|t| t.uuid == our_col.uuid)
                .filter(|ti| !their_used[*ti]);
            if let Some(ti) = ti {
                their_used[ti] = true;
            }
            slots.push(Slot {
                anc: find_anc(our_col),
                ours: Some(oi),
                theirs: ti,
            });
        }
        for (ti, their_col) in their_columns.iter().enumerate() {
            if !their_used[ti] {
                slots.push(Slot {
                    anc: find_anc(their_col),
                    ours: None,
                    theirs: Some(ti),
                });
            }
        }

        // Whether a column, including its name, changed from the ancestor
        let changed_from = |a: &ColumnSchema, c: &ColumnSchema| -> bool {
            !Self::columns_equivalent(a, c) || a.data_name != c.data_name
        };

        for slot in &slots {
            let anc = slot.anc.map(|i| &anc_columns[i]);
            let our = slot.ours.map(|i| &our_columns[i]);
            let their = slot.theirs.map(|i| &their_columns[i]);

            match (our, their) {
                (Some(our_col), Some(their_col)) => {
                    // Field-level three-way merge
                    let fields: [(&str, &str); 10] = [
                        ("min_version", "Version"),
                        ("name", "Column name"),
                        ("type", "Data type"),
                        ("required", "Required"),
                        ("default", "Default value"),
                        ("color_swatches", "Color swatch"),
                        ("constraints", "Constraints"),
                        ("configuration", "Type settings"),
                        ("input_validation", "Input rules"),
                        ("conditional_formatting", "Conditional formatting"),
                    ];

                    let field_equal = |field: &str, a: &ColumnSchema, b: &ColumnSchema| -> bool {
                        match field {
                            "min_version" => a.min_version == b.min_version,
                            "name" => a.data_name == b.data_name,
                            "type" => a.data_type == b.data_type,
                            "required" => {
                                a.required.unwrap_or(false) == b.required.unwrap_or(false)
                            }
                            "default" => a.default_value == b.default_value,
                            "color_swatches" => a.color_swatches == b.color_swatches,
                            "configuration" => Self::configuration_equal(a, b),
                            "input_validation" => a.input_validation == b.input_validation,
                            "conditional_formatting" => {
                                a.conditional_formatting == b.conditional_formatting
                            }
                            "constraints" => {
                                Self::normalized_constraints(a) == Self::normalized_constraints(b)
                            }
                            _ => true,
                        }
                    };

                    // Start from our side and apply the winning value for each field
                    let mut merged = our_col.clone();
                    let mut field_conflicts: Vec<FieldConflict> = Vec::new();

                    // Use our column name as the resolution key, matching the name shown in the UI
                    let resolution_key = our_col.data_name.clone();
                    let take_theirs_for_conflicts = matches!(
                        resolutions.get(&resolution_key),
                        Some(ResolutionType::TakeTheirs)
                    );

                    for (field, label) in fields {
                        if field_equal(field, our_col, their_col) {
                            continue; // Both sides agree: retain our base value
                        }
                        let ours_changed = anc.is_none_or(|a| !field_equal(field, a, our_col));
                        let theirs_changed = anc.is_none_or(|a| !field_equal(field, a, their_col));

                        let winner_is_theirs = if ours_changed && theirs_changed {
                            // Both sides changed the same field differently: conflict
                            field_conflicts.push(FieldConflict {
                                field: field.to_string(),
                                field_label: label.to_string(),
                                ours: Self::describe_field_value(field, our_col),
                                theirs: Self::describe_field_value(field, their_col),
                            });
                            take_theirs_for_conflicts
                        } else {
                            // Only one side changed: that side wins
                            theirs_changed
                        };

                        if winner_is_theirs {
                            match field {
                                "min_version" => merged.min_version = their_col.min_version,
                                "name" => {
                                    if merged.display_name == merged.data_name {
                                        merged.display_name = their_col.data_name.clone();
                                    }
                                    merged.data_name = their_col.data_name.clone();
                                }
                                "configuration" => {
                                    merged.reference_config = their_col.reference_config.clone();
                                    merged.curve_config = their_col.curve_config.clone();
                                    merged.table_ref_config = their_col.table_ref_config.clone();
                                    merged.select_config = their_col.select_config.clone();
                                }
                                "input_validation" => {
                                    merged.input_validation = their_col.input_validation.clone()
                                }
                                "conditional_formatting" => {
                                    merged.conditional_formatting =
                                        their_col.conditional_formatting.clone()
                                }
                                "type" => merged.data_type = their_col.data_type.clone(),
                                "required" => merged.required = their_col.required,
                                "default" => merged.default_value = their_col.default_value.clone(),
                                "color_swatches" => {
                                    merged.color_swatches = their_col.color_swatches.clone()
                                }
                                "constraints" => {
                                    merged.constraints = Self::normalized_constraints(their_col)
                                }
                                _ => {}
                            }
                        }
                    }

                    // Automatically merge display metadata: the changed side wins, or ours if both changed;
                    // do not treat this as a conflict
                    let meta_ours_unchanged = anc.is_some_and(|a| {
                        a.display_name == our_col.display_name
                            && a.tooltip == our_col.tooltip
                            && a.memo_text == our_col.memo_text
                            && a.style == our_col.style
                    });
                    if meta_ours_unchanged {
                        merged.tooltip = their_col.tooltip.clone();
                        merged.memo_text = their_col.memo_text.clone();
                        merged.style = their_col.style.clone();
                        if their_col.display_name != their_col.data_name {
                            merged.display_name = their_col.display_name.clone();
                        }
                    }

                    if !field_conflicts.is_empty() {
                        let description = format!(
                            "{} was changed to different values in both versions",
                            field_conflicts
                                .iter()
                                .map(|f| f.field_label.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        );
                        let resolution = match resolutions.get(&resolution_key) {
                            Some(r @ (ResolutionType::TakeOurs | ResolutionType::TakeTheirs)) => {
                                r.clone()
                            }
                            _ => {
                                unresolved.push(format!("{}: {}", resolution_key, description));
                                ResolutionType::Manual
                            }
                        };
                        conflicts.push(ConflictResolution {
                            column_name: resolution_key,
                            resolution_type: resolution,
                            description,
                            field_conflicts,
                        });
                    }

                    merged_columns.push(merged);
                }
                (Some(our_col), None) => {
                    match anc {
                        None => {
                            // Column added on our side
                            merged_columns.push(our_col.clone());
                        }
                        Some(a) if !changed_from(a, our_col) => {
                            // Ours unchanged, theirs deleted: accept deletion (do nothing)
                        }
                        Some(_) => {
                            // Ours changed, theirs deleted: presence conflict
                            let resolution_key = our_col.data_name.clone();
                            let field_conflicts = vec![FieldConflict {
                                field: "presence".to_string(),
                                field_label: "Column presence".to_string(),
                                ours: "Modify and keep".to_string(),
                                theirs: "Remove".to_string(),
                            }];
                            let description =
                                "Modified in one version and deleted in the other".to_string();
                            match resolutions.get(&resolution_key) {
                                Some(ResolutionType::TakeOurs) => {
                                    merged_columns.push(our_col.clone());
                                    conflicts.push(ConflictResolution {
                                        column_name: resolution_key,
                                        resolution_type: ResolutionType::TakeOurs,
                                        description,
                                        field_conflicts,
                                    });
                                }
                                Some(ResolutionType::TakeTheirs) => {
                                    conflicts.push(ConflictResolution {
                                        column_name: resolution_key,
                                        resolution_type: ResolutionType::TakeTheirs,
                                        description,
                                        field_conflicts,
                                    });
                                }
                                _ => {
                                    unresolved.push(format!("{}: {}", resolution_key, description));
                                    conflicts.push(ConflictResolution {
                                        column_name: resolution_key,
                                        resolution_type: ResolutionType::Manual,
                                        description,
                                        field_conflicts,
                                    });
                                }
                            }
                        }
                    }
                }
                (None, Some(their_col)) => {
                    match anc {
                        None => {
                            // Column added on their side
                            merged_columns.push(their_col.clone());
                        }
                        Some(a) if !changed_from(a, their_col) => {
                            // Theirs unchanged, ours deleted: accept deletion (do nothing)
                        }
                        Some(_) => {
                            // Ours deleted, theirs changed: presence conflict
                            let resolution_key = their_col.data_name.clone();
                            let field_conflicts = vec![FieldConflict {
                                field: "presence".to_string(),
                                field_label: "Column presence".to_string(),
                                ours: "Remove".to_string(),
                                theirs: "Modify and keep".to_string(),
                            }];
                            let description =
                                "Deleted in one version and modified in the other".to_string();
                            match resolutions.get(&resolution_key) {
                                Some(ResolutionType::TakeOurs) => {
                                    conflicts.push(ConflictResolution {
                                        column_name: resolution_key,
                                        resolution_type: ResolutionType::TakeOurs,
                                        description,
                                        field_conflicts,
                                    });
                                }
                                Some(ResolutionType::TakeTheirs) => {
                                    merged_columns.push(their_col.clone());
                                    conflicts.push(ConflictResolution {
                                        column_name: resolution_key,
                                        resolution_type: ResolutionType::TakeTheirs,
                                        description,
                                        field_conflicts,
                                    });
                                }
                                _ => {
                                    unresolved.push(format!("{}: {}", resolution_key, description));
                                    conflicts.push(ConflictResolution {
                                        column_name: resolution_key,
                                        resolution_type: ResolutionType::Manual,
                                        description,
                                        field_conflicts,
                                    });
                                }
                            }
                        }
                    }
                }
                (None, None) => {}
            }
        }

        // Different identities that converge on one data name require an explicit choice.
        let merged_order = merged_columns.clone();
        let mut by_name: std::collections::BTreeMap<String, Vec<ColumnSchema>> =
            std::collections::BTreeMap::new();
        for column in merged_columns.drain(..) {
            by_name
                .entry(column.data_name.clone())
                .or_default()
                .push(column);
        }
        let mut selected_ids = HashSet::new();
        for (name, candidates) in by_name {
            if candidates.len() == 1 {
                selected_ids.insert(candidates[0].uuid.clone());
                continue;
            }
            let ours = candidates
                .iter()
                .find(|candidate| {
                    our_columns
                        .iter()
                        .any(|column| column.uuid == candidate.uuid && column.data_name == name)
                })
                .unwrap_or(&candidates[0]);
            let theirs = candidates
                .iter()
                .find(|candidate| candidate.uuid != ours.uuid)
                .unwrap();
            let description = "Columns with the same name have different UUIDs".to_string();
            let resolution = match resolutions.get(&name) {
                Some(resolution @ (ResolutionType::TakeOurs | ResolutionType::TakeTheirs)) => {
                    resolution.clone()
                }
                _ => {
                    unresolved.push(format!("{name}: {description}"));
                    ResolutionType::Manual
                }
            };
            selected_ids.insert(if matches!(resolution, ResolutionType::TakeTheirs) {
                theirs.uuid.clone()
            } else {
                ours.uuid.clone()
            });
            conflicts.push(ConflictResolution {
                column_name: name,
                resolution_type: resolution,
                description,
                field_conflicts: vec![FieldConflict {
                    field: "identity".into(),
                    field_label: "Column UUID".into(),
                    ours: ours.uuid.clone(),
                    theirs: theirs.uuid.clone(),
                }],
            });
        }
        // Keep original order while applying the identity choice.
        for column in &merged_order {
            if selected_ids.remove(&column.uuid) {
                // The three-way merged version of a surviving column was collected above.
                merged_columns.push(column.clone());
            }
        }

        // Three-way merge of inheritance lists
        let merged_extends = if our_extends == their_extends {
            our_extends.clone()
        } else if our_extends == anc_extends {
            their_extends.clone()
        } else if their_extends == anc_extends {
            our_extends.clone()
        } else {
            let description =
                "The inheritance relationship was changed differently in both versions".to_string();
            let field_conflicts = vec![FieldConflict {
                field: "extends".to_string(),
                field_label: "Inheritance".to_string(),
                ours: format!("{} inherited interfaces", our_extends.len()),
                theirs: format!("{} inherited interfaces", their_extends.len()),
            }];
            match resolutions.get(EXTENDS_CONFLICT_KEY) {
                Some(ResolutionType::TakeOurs) => {
                    conflicts.push(ConflictResolution {
                        column_name: EXTENDS_CONFLICT_KEY.to_string(),
                        resolution_type: ResolutionType::TakeOurs,
                        description,
                        field_conflicts,
                    });
                    our_extends.clone()
                }
                Some(ResolutionType::TakeTheirs) => {
                    conflicts.push(ConflictResolution {
                        column_name: EXTENDS_CONFLICT_KEY.to_string(),
                        resolution_type: ResolutionType::TakeTheirs,
                        description,
                        field_conflicts,
                    });
                    their_extends.clone()
                }
                _ => {
                    unresolved.push(format!("{}: {}", EXTENDS_CONFLICT_KEY, description));
                    conflicts.push(ConflictResolution {
                        column_name: EXTENDS_CONFLICT_KEY.to_string(),
                        resolution_type: ResolutionType::Manual,
                        description,
                        field_conflicts,
                    });
                    our_extends.clone()
                }
            }
        };

        // Display metadata uses the changed side; concurrent edits keep ours.
        // Recording the result on both parent edges makes replay path-independent.
        let merged_description = if our_description == anc_description {
            their_description
        } else {
            our_description
        };
        Ok((
            merged_columns,
            merged_extends,
            merged_description,
            conflicts,
            unresolved,
        ))
    }

    /// Preview merge conflicts without changing history
    pub fn preview_merge_conflicts(
        &self,
        ours: Uuid,
        theirs: Uuid,
    ) -> Result<Vec<ConflictResolution>> {
        self.validate_merge_targets(ours, theirs)?;

        // No conflicts when a fast-forward is possible
        if self.collect_ancestors(theirs).contains(&ours) {
            return Ok(Vec::new());
        }

        let (_, _, _, conflicts, _) = self.compute_merge(ours, theirs, &HashMap::new())?;
        Ok(conflicts)
    }

    /// Preview changes a merge would apply to the current state without changing history
    /// Calculate unresolved conflicts as if our side were chosen
    pub fn preview_merge_changes(
        &self,
        ours: Uuid,
        theirs: Uuid,
        resolutions: &HashMap<String, ResolutionType>,
    ) -> Result<Vec<InterfaceChange>> {
        self.validate_merge_targets(ours, theirs)?;

        // For a fast-forward, use a simple diff against the merge target
        if self.collect_ancestors(theirs).contains(&ours) {
            let (their_columns, their_extends, their_description) =
                self.state_at_version(theirs)?;
            Self::validate_rule_definitions(&their_columns)?;
            let (our_columns, our_extends, our_description) = self.state_at_version(ours)?;
            return Ok(Self::diff_states(
                &our_columns,
                &our_extends,
                &our_description,
                &their_columns,
                &their_extends,
                &their_description,
            ));
        }

        let (merged_columns, merged_extends, merged_description, _, _) =
            self.compute_merge(ours, theirs, resolutions)?;
        Self::validate_merge_candidate(&merged_columns)?;
        let (our_columns, our_extends, our_description) = self.state_at_version(ours)?;
        Ok(Self::diff_states(
            &our_columns,
            &our_extends,
            &our_description,
            &merged_columns,
            &merged_extends,
            &merged_description,
        ))
    }

    /// Preview restoring content from a specified point without changing history
    pub fn preview_revert(&self, target: Uuid) -> Result<Vec<InterfaceChange>> {
        let (target_columns, target_extends, target_description) = self.state_at_version(target)?;
        let mut changes = Self::diff_states(
            &self.columns,
            &self.extends,
            &self.description,
            &target_columns,
            &target_extends,
            &target_description,
        );
        // Compare column order after applying the diff too. Restored deleted columns are appended,
        // so restore their original positions for deletion/addition changes as well as reorder-only history.
        // Do not affect merge order or implementing tables' custom column orders.
        let mut restored_columns = self.columns.clone();
        let mut restored_extends = self.extends.clone();
        let mut restored_description = self.description.clone();
        for change in &changes {
            Self::apply_change_to_state(
                &mut restored_columns,
                &mut restored_extends,
                &mut restored_description,
                change,
            )?;
        }
        let target_order: Vec<String> = target_columns
            .iter()
            .map(|column| column.data_name.clone())
            .collect();
        if restored_columns
            .iter()
            .map(|column| &column.data_name)
            .ne(target_order.iter())
        {
            changes.push(InterfaceChange::ReorderColumns {
                order: target_order,
            });
        }
        Ok(changes)
    }

    /// Restore content from a specified point
    /// Append a **new version** restoring that content instead of rewinding HEAD
    /// (History always moves forward, preserving synchronization paths for implementing tables)
    pub fn revert_to_version(
        &mut self,
        target: Uuid,
        author: Option<String>,
        comment: Option<String>,
    ) -> Result<Uuid> {
        if target == self.current_version_id {
            return Err(diagnostic("error.interface.unchanged", json!({})));
        }
        let changes = self.preview_revert(target)?;
        if changes.is_empty() {
            return Err(diagnostic("error.interface.unchanged", json!({})));
        }

        let comment = comment.or_else(|| {
            self.history.get(&target).map(|v| {
                format!(
                    "Restore contents from {}",
                    v.timestamp.format("%Y/%m/%d %H:%M")
                )
            })
        });

        self.create_new_version(changes, author, comment)
    }

    /// Validate merge targets
    fn validate_merge_targets(&self, ours: Uuid, theirs: Uuid) -> Result<()> {
        if ours == theirs {
            return Err(diagnostic("error.interface.mergeSame", json!({})));
        }
        if !self.history.contains_key(&ours) {
            return Err(diagnostic(
                "error.interface.historyVersion",
                json!({"version": ours}),
            ));
        }
        if !self.history.contains_key(&theirs) {
            return Err(diagnostic(
                "error.interface.historyVersion",
                json!({"version": theirs}),
            ));
        }
        if self.collect_ancestors(ours).contains(&theirs) {
            return Err(diagnostic("error.interface.mergeIncluded", json!({})));
        }
        Ok(())
    }

    /// Merge divergent histories
    /// Create a merge version with ours as the first parent and theirs as the second, then update HEAD
    /// Resolve conflicts through resolutions (column name -> resolution method).
    /// Return an error if unresolved conflicts remain
    pub fn merge_branches(
        &mut self,
        ours: Uuid,
        theirs: Uuid,
        resolutions: &HashMap<String, ResolutionType>,
        author: Option<String>,
        comment: Option<String>,
    ) -> Result<Uuid> {
        self.validate_merge_targets(ours, theirs)?;

        // If ours is an ancestor of theirs, complete with a fast-forward
        if self.collect_ancestors(theirs).contains(&ours) {
            let (columns, _, _) = self.state_at_version(theirs)?;
            Self::validate_rule_definitions(&columns)?;
            self.current_version_id = theirs;
            self.rebuild_current_columns()?;
            return Ok(theirs);
        }

        let (merged_columns, merged_extends, merged_description, conflicts, unresolved) =
            self.compute_merge(ours, theirs, resolutions)?;

        if !unresolved.is_empty() {
            return Err(diagnostic(
                "error.interface.mergeUnresolved",
                json!({
                    "columns": conflicts.iter().filter(|conflict| conflict.resolution_type == ResolutionType::Manual)
                        .map(|conflict| conflict.column_name.as_str()).collect::<Vec<_>>().join(" / ")
                }),
            ));
        }

        Self::validate_merge_candidate(&merged_columns)?;
        let (our_columns, our_extends, our_description) = self.state_at_version(ours)?;
        let (their_columns, their_extends, their_description) = self.state_at_version(theirs)?;

        let first_parent_changes = Self::diff_states(
            &our_columns,
            &our_extends,
            &our_description,
            &merged_columns,
            &merged_extends,
            &merged_description,
        );
        let second_parent_changes = Self::diff_states(
            &their_columns,
            &their_extends,
            &their_description,
            &merged_columns,
            &merged_extends,
            &merged_description,
        );

        let merge_version = InterfaceVersion {
            version_id: Uuid::new_v4(),
            parent_version_id: Some(ours),
            timestamp: Utc::now(),
            changes: first_parent_changes,
            author,
            comment: comment.or_else(|| {
                Some(format!(
                    "Merge versions {} and {}",
                    &ours.to_string()[..8],
                    &theirs.to_string()[..8]
                ))
            }),
            merge_info: Some(MergeInfo {
                second_parent_id: theirs,
                conflict_resolutions: conflicts,
                second_parent_changes,
            }),
        };

        let merge_id = merge_version.version_id;
        self.history.insert(merge_id, merge_version);
        self.current_version_id = merge_id;

        // Reconstruct the merged column state
        self.rebuild_current_columns()?;

        Ok(merge_id)
    }

    /// Import unknown version history from another copy of the same interface
    /// (Prepares for merging histories diverged through file synchronization or edits in another instance)
    /// Return the number of imported versions without changing HEAD
    pub fn absorb_history(&mut self, other: &Interface) -> Result<usize> {
        if self.uuid != other.uuid {
            return Err(diagnostic(
                "error.interface.historyOwner",
                json!({"ours": self.uuid, "theirs": other.uuid}),
            ));
        }

        // Validate parent existence before importing to prevent partial failures from corrupting history
        for version in other.history.values() {
            if let Some(parent) = version.parent_version_id {
                if !self.history.contains_key(&parent) && !other.history.contains_key(&parent) {
                    return Err(diagnostic(
                        "error.interface.historyParent",
                        json!({"version": version.version_id, "parent": parent}),
                    ));
                }
            }
        }

        let mut absorbed = 0;
        for (version_id, version) in &other.history {
            if !self.history.contains_key(version_id) {
                self.history.insert(*version_id, version.clone());
                absorbed += 1;
            }
        }

        Ok(absorbed)
    }

    /// Check circular references
    pub fn check_circular_dependency(
        &self,
        registry: &InterfaceRegistry,
        visited: &mut HashSet<String>,
    ) -> Result<()> {
        if visited.contains(&self.name) {
            return Err(diagnostic(
                "error.interface.inheritanceCycle",
                json!({"name": self.name}),
            ));
        }

        visited.insert(self.name.clone());

        for parent_uuid in &self.extends {
            if let Some(parent) = registry.get_interface(parent_uuid) {
                parent.check_circular_dependency(registry, visited)?;
            }
        }

        visited.remove(&self.name);
        Ok(())
    }

    /// Check duplicate column names
    pub fn validate_columns(&self) -> Result<()> {
        let mut column_names = HashSet::new();
        let mut column_ids = HashSet::new();
        for column in &self.columns {
            crate::validate_data_name(&column.data_name)?;
            validate_column_id(&column.uuid)?;
            if !column_ids.insert(&column.uuid) {
                return Err(diagnostic(
                    "error.storage.duplicateColumnId",
                    json!({"id": column.uuid}),
                ));
            }
            if !column_names.insert(&column.data_name) {
                return Err(column_error(
                    &column.data_name,
                    authoring_error("A column with the same name already exists"),
                ));
            }
        }

        Ok(())
    }

    /// Validate the authoritative history without changing or repairing any state.
    pub fn validate_storage_contract(&self) -> Result<()> {
        self.validate_columns()?;
        for column in &self.columns {
            column.validate_color_storage_contract()?;
        }
        // Validate every saved branch, including changes later overwritten or
        // removed; a future revert/merge must not reveal an invalid palette.
        for version in self.history.values() {
            for change in version.changes.iter().chain(
                version
                    .merge_info
                    .iter()
                    .flat_map(|merge| merge.second_parent_changes.iter()),
            ) {
                match change {
                    InterfaceChange::AddColumn { column } => {
                        crate::validate_color_swatches(&column.color_swatches)
                    }
                    InterfaceChange::ChangeColorSwatches { swatches, .. } => {
                        crate::validate_color_swatches(swatches)
                    }
                    _ => Ok(()),
                }?;
            }
        }
        let (historical_columns, historical_extends, historical_description) =
            self.state_at_version(self.current_version_id)?;
        if serde_json::to_value(&self.columns)? != serde_json::to_value(&historical_columns)? {
            return Err(diagnostic(
                "error.interface.historySnapshot",
                json!({"field": AppError::code("grid.filterSort.column", json!({}))}),
            ));
        }
        if self.extends != historical_extends {
            return Err(diagnostic(
                "error.interface.historySnapshot",
                json!({"field": AppError::code("interface.conflict.extendsLabel", json!({}))}),
            ));
        }
        if self.description != historical_description {
            return Err(diagnostic(
                "error.interface.historySnapshot",
                json!({"field": AppError::code("interface.description", json!({}))}),
            ));
        }
        Ok(())
    }

    /// Serialize a validated document using the same format as ordinary file saves.
    /// Staged multi-file transactions must use this rather than a host TOML version.
    pub fn to_document_toml(&self) -> Result<String> {
        self.validate_storage_contract()?;
        toml::to_string_pretty(self)
            .map_err(|error| diagnostic("error.parse", json!({"details": error.to_string()})))
    }

    /// Save to a file
    pub fn save_to_file(&self, path: &Path) -> Result<()> {
        let toml_string = self.to_document_toml()?;

        crate::utils::write_atomic(path, toml_string.as_bytes())?;

        Ok(())
    }

    /// Load from a file
    pub fn load_from_file(path: &Path) -> Result<Self> {
        // Match project discovery and table opens: never read a final-path
        // symlink, pipe or device as a document.
        if !fs::symlink_metadata(path)?.file_type().is_file() {
            return Err(diagnostic(
                "error.tableSourceType",
                json!({"path": path.to_string_lossy()}),
            ));
        }
        let content = fs::read_to_string(path)?;

        let interface: Self = toml::from_str(&content)?;

        interface.validate_storage_contract()?;
        Ok(interface)
    }
}

impl Default for InterfaceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl InterfaceRegistry {
    pub fn new() -> Self {
        Self {
            uuid_to_path: HashMap::new(),
            interfaces: HashMap::new(),
            dependency_graph: HashMap::new(),
        }
    }

    pub fn add_interface(&mut self, interface: Interface) -> Result<()> {
        // Use the name as the default path for a new interface
        let path = format!("{}.interface.toml", interface.name);
        self.add_interface_with_path(path, interface)
    }

    pub fn add_interface_with_path(&mut self, path: String, interface: Interface) -> Result<()> {
        // Check circular references
        let mut visited = HashSet::new();
        interface.check_circular_dependency(self, &mut visited)?;

        // Update the UUID-to-path mapping
        self.uuid_to_path.insert(interface.uuid, path.clone());

        // Store by path, replacing any existing entry
        self.interfaces.insert(path, interface);
        self.update_dependency_graph();
        Ok(())
    }

    pub fn get_interface(&self, uuid: &Uuid) -> Option<&Interface> {
        // Get the path by UUID, then retrieve the interface at that path
        if let Some(path) = self.uuid_to_path.get(uuid) {
            self.interfaces.get(path)
        } else {
            None
        }
    }

    pub fn get_interface_by_path(&self, path: &str) -> Option<&Interface> {
        self.interfaces.get(path)
    }

    pub fn get_interface_mut(&mut self, uuid: &Uuid) -> Option<&mut Interface> {
        // Get the path by UUID, then retrieve the interface at that path
        if let Some(path) = self.uuid_to_path.get(uuid).cloned() {
            self.interfaces.get_mut(&path)
        } else {
            None
        }
    }

    pub fn get_interface_mut_by_path(&mut self, path: &str) -> Option<&mut Interface> {
        self.interfaces.get_mut(path)
    }

    pub fn get_all_interfaces(&self) -> Vec<&Interface> {
        self.interfaces.values().collect()
    }

    pub fn get_all_interfaces_with_paths(&self) -> Vec<(&String, &Interface)> {
        self.interfaces.iter().collect()
    }

    /// Get an interface's file path by UUID
    pub fn get_interface_path(&self, uuid: &Uuid) -> Option<&str> {
        // Get the path by UUID
        self.uuid_to_path.get(uuid).map(|s| s.as_str())
    }

    pub fn remove_interface(&mut self, uuid: &Uuid) -> Option<Interface> {
        // Get the path by UUID
        if let Some(path) = self.uuid_to_path.get(uuid).cloned() {
            // Remove the interface
            if let Some(interface) = self.interfaces.remove(&path) {
                // Remove the UUID-to-path mapping
                self.uuid_to_path.remove(uuid);

                // Update the dependency graph
                self.update_dependency_graph();

                return Some(interface);
            }
        }
        None
    }

    pub fn remove_interface_by_path(&mut self, path: &str) -> Option<Interface> {
        // Remove the interface
        if let Some(interface) = self.interfaces.remove(path) {
            let uuid = interface.uuid;

            // Remove the UUID-to-path mapping
            self.uuid_to_path.remove(&uuid);

            // Update the dependency graph
            self.update_dependency_graph();

            return Some(interface);
        }
        None
    }

    fn update_dependency_graph(&mut self) {
        self.dependency_graph.clear();

        for interface in self.interfaces.values() {
            let mut deps: HashSet<Uuid> = HashSet::new();
            for extend_uuid in &interface.extends {
                deps.insert(*extend_uuid);
            }
            self.dependency_graph.insert(interface.uuid, deps);
        }
    }

    /// Load an interface from a path for temporary use
    pub fn load_interface_from_path(&self, path: &std::path::Path) -> Result<Interface> {
        Interface::load_from_file(path)
    }
}
