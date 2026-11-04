//! The current error contract shared by native commands, RPC and SDKs.
//! Variants are transported as data; text never doubles as an encoded error.
use crate::{cell_rules::ValidationReport, types::Diagnostic, DevcelError};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AppError {
    Code {
        code: String,
        params: serde_json::Value,
    },
    Text {
        text: String,
    },
    InputValidation {
        report: ValidationReport,
    },
    Diagnostics {
        diagnostics: Vec<Diagnostic>,
    },
}

impl AppError {
    pub fn code(code: impl Into<String>, params: serde_json::Value) -> Self {
        Self::Code {
            code: code.into(),
            params,
        }
    }

    /// Keep nested structured failures intact in single-diagnostic APIs.
    pub fn into_diagnostic(self) -> Diagnostic {
        match self {
            Self::Code { code, params } => Diagnostic::Code { code, params },
            Self::Text { text } => Diagnostic::Text { text },
            Self::Diagnostics { mut diagnostics } if diagnostics.len() == 1 => {
                diagnostics.remove(0)
            }
            other => Diagnostic::Code {
                code: "error.invalidData".into(),
                params: serde_json::json!({ "details": other }),
            },
        }
    }

    /// A message produced by an application validator, not a user or plugin.
    pub fn owned(message: impl Into<String>) -> Self {
        authoring_error(message).into()
    }

    /// Low-level library/OS details retain their literal content under a localized summary.
    pub fn technical(error: impl std::fmt::Display) -> Self {
        Self::code(
            "error.command",
            serde_json::json!({ "details": error.to_string() }),
        )
    }

    /// For genuinely free-form errors, never for converting an existing AppError.
    pub fn text(text: impl std::fmt::Display) -> Self {
        Self::Text {
            text: text.to_string(),
        }
    }
}

pub(crate) fn diagnostic(code: impl Into<String>, params: serde_json::Value) -> DevcelError {
    DevcelError::Diagnostics(vec![Diagnostic::Code {
        code: code.into(),
        params,
    }])
}

/// Static authoring diagnostics use semantic codes at their source. Call only
/// for application-owned validation messages, never plugin/user-authored text.
/// Unknown diagnostic details remain intact rather than being guessed from text.
pub(crate) fn authoring_error(message: impl Into<String>) -> DevcelError {
    let message = message.into();
    // The accepted spellings below are produced by core validators. User rule
    // messages have their own Diagnostic::Text variant and never enter here.
    let missing_kind = match message.as_str() {
        "Directory not found"
        | "Source directory not found"
        | "Parent directory not found"
        | "Project root directory not found" => Some("file.kind.folder"),
        "markdown file not found" => Some("file.kind.markdown"),
        _ => None,
    };
    if let Some(kind) = missing_kind {
        return diagnostic(
            "error.notFound",
            serde_json::json!({"details": AppError::code(kind, serde_json::json!({}))}),
        );
    }
    let scalar_type = match message.as_str() {
        "Invalid value type. Enter a U8 value." => Some("U8"),
        "Invalid value type. Enter an I8 value." => Some("I8"),
        "Invalid value type. Enter a U16 value." => Some("U16"),
        "Invalid value type. Enter an I16 value." => Some("I16"),
        "Invalid value type. Enter a U32 value." => Some("U32"),
        "Invalid value type. Enter an I32 value." => Some("I32"),
        "Invalid value type. Enter a U64 value." => Some("U64"),
        "Invalid value type. Enter an I64 value." => Some("I64"),
        "Invalid value type. Enter a finite F32 value." => Some("F32"),
        "Invalid value type. Enter a finite F64 value." => Some("F64"),
        "Invalid value type. Enter a Bool value." => Some("Boolean"),
        "Color32 must be an RGBA JSON array of four integers from 0 to 255" => Some("Color32"),
        "ColorFloat channels must be finite f32 values"
        | "ColorFloat alpha must be between 0 and 1"
        | "ColorFloat must be an RGBA JSON array of four finite numbers"
        | "ColorFloat requires finite RGB and alpha between 0 and 1" => Some("ColorFloat"),
        "The reference value must be a valid UUID." => Some("Reference"),
        "The table reference must be a valid table UUID." => Some("TableRef"),
        _ => None,
    };
    if let Some(kind) = scalar_type {
        return DevcelError::Diagnostics(vec![Diagnostic::Code {
            code: "column.conversion.invalidValue".into(),
            params: serde_json::json!({ "type": kind }),
        }]);
    }
    if message == "Font size must be between 6 and 72" {
        return DevcelError::Diagnostics(vec![Diagnostic::Code {
            code: "error.validation.numberRange".into(),
            params: serde_json::json!({ "min": "6", "max": "72" }),
        }]);
    }
    for (text, code, params) in [
        (
            "A color palette can contain at most 256 swatches",
            "color.swatches.limit",
            serde_json::json!({"count":256}),
        ),
        (
            "Color swatch names require 1..128 characters and no control characters",
            "color.swatches.invalidName",
            serde_json::json!({"max":128}),
        ),
    ] {
        if message == text {
            return DevcelError::Diagnostics(vec![Diagnostic::Code {
                code: code.into(),
                params,
            }]);
        }
    }
    let extension = match message.as_str() {
        "Specify an .md file for Markdown operations" => Some(".md"),
        "Specify an .interface.toml file for interface operations" => Some(".interface.toml"),
        "Specify a .table.toml file for table operations"
        | "Specify an .table.toml file for table operations" => Some(".table.toml"),
        _ => None,
    };
    if let Some(extension) = extension {
        return DevcelError::Diagnostics(vec![Diagnostic::Code {
            code: "error.fileExtension".into(),
            params: serde_json::json!({ "extension": extension }),
        }]);
    }
    // Invalid identity or confirmation is not a revision conflict. Reloading
    // must not be offered as a generic way to discard the user's draft.
    let validation_detail = match message.as_str() {
        "The new column ID is invalid. Reload the data" => Some("The new column ID must be a UUID."),
        "A column with the same ID already exists. Reload the data" => Some("A column with the same ID already exists."),
        "To confirm warnings for the new column, reload the column settings and retry with the same column ID" => Some("Warning confirmation requires the same new column ID used for preview."),
        "The contents changed after the warning was confirmed. Enter the value again" => Some("The warning confirmation no longer matches this value. Review the value and confirm its warnings again."),
        _ => None,
    };
    if let Some(details) = validation_detail {
        return diagnostic(
            "error.invalidData",
            serde_json::json!({ "details": details }),
        );
    }
    let code = match message.as_str() {
        "Color swatch ID must be a UUID" | "Duplicate color swatch ID" => "color.swatches.invalidIdentity",
        "Saved color swatches must have canonical IDs, names and RGBA values" | "Applied color swatches must have canonical RGBA values" => "color.swatches.invalidStored",
        "Color swatches require Color32 or ColorFloat" | "Color swatch precision must match the destination type" => "color.swatches.typeMismatch",
        "Filename is empty" => "file.enterName",
        "Filenames must not contain path separators, control characters, or trailing spaces or periods" => "error.filenameInvalid",
        "Reserved filenames are not allowed" => "error.filenameReserved",
        "Filename is too long (at most 236 bytes including the extension)" => "error.filenameTooLong",
        "The destination parent folder is missing" | "project path is empty" | "Invalid table path" | "Not a regular table file" | "Not a regular interface file" | "Invalid file path" | "The specified path is not a directory" | "Could not get the project directory" | "Invalid project destination" | "Invalid destination" | "Failed to get project directory" | "Invalid project path" => "error.invalidPath",
        "Save the table before moving or renaming it" => "error.saveBeforeMove",
        "No operation available to redo" | "No operation available to undo" | "No history is available for safe restoration" => "error.historyUnavailable",
        "The target table for the bulk operation is not loaded" => "column.notLoaded",
        "The table changed outside its history. Reload it" => "error.staleData",
        "Lock acquisition timeout" => "error.lockTimeout",
        "Only empty tables can be initialized" => "error.tableNotEmpty",
        "Table not found" | "table not found" | "table file not found" | "The specified table was not found" | "The command deleted the target table" | "The table referenced by history was not found" => "error.tableMissing",
        "Interface not found" | "interface file not found" | "Interface destination not found" => "interface.notFound",
        crate::commands::INTERFACE_COLUMN_LOCKED_MSG => "column.interfaceOwnedHint",
        "Cell editing is disabled" => "table.edit.cellsBlocked",
        "Column not found. Reload the data" => "error.columnMissing",
        "Column not found"
        | "Column to change not found"
        | "Initial-value column not found"
        | "Column for the version change not found" => "error.columnMissing",
        "Record not found"
        | "Row to change not found"
        | "Insertion target row not found"
        | "Row for the version change not found" => "error.rowMissing",
        "The column was updated by another operation. Reload the data"
        | "The table was updated by another operation. Reload the data"
        | "The table was updated by another operation"
        | "The prevalidated table or project has changed"
        | "The table was updated by another operation. Reload it and try again"
        | "The project or table file changed. Reload and try again"
        | "The table file was updated by another operation. Reload it"
        | "The interface file was updated by another operation. Reload it" => "error.staleData",
        "Name cannot be empty." | "project name is empty" | "Table display name must not be empty" => "column.validation.emptyName",
        "Name is too long (maximum 255 characters)." => "column.validation.longName",
        "Name must start with an ASCII letter or underscore (_)." => "column.validation.nameStart",
        "Name may contain only ASCII letters, digits, and underscores (_)." => "column.validation.nameCharacters",
        "Reference configuration not found." | "Specify the referenced table" => "column.conversion.referenceConfigMissing",
        "Referenced record not found." => "column.conversion.referenceRecordMissing",
        "The referenced table could not be found." => "column.conversion.referenceTableMissing",
        "Referenced display column not found" => "error.columnMissing",
        "Referenced interface not found" => "interface.api.notFound",
        "Specify the referenced interface" => "column.conversion.tableReferenceConfigMissing",
        "The column color must be empty or in #RRGGBB format" | "Specify the formatting color as #RRGGBB" | "Specify color scale colors as #RRGGBB" => "color.hexInvalid",
        "Curve endpoints must be finite values" | "Curve endpoints must be finite" => "error.validation.valueType",
        "A column with the same name already exists" | "Stored values with the same name already exist" => "error.nameExists",
        "Ranges, comparisons, ranks, and color scales require a numeric type" => "error.rules.numericRequired",
        "Specify a minimum or maximum for the range" => "error.rules.rangeRequired",
        "The minimum must not exceed the maximum" | "The range minimum must not exceed its maximum" => "error.rules.rangeOrder",
        "The input rule or message is too long" | "The regular expression is too long" => "error.rules.tooLong",
        "An option rule requires a Select type with configured options" => "error.rules.selectRequired",
        "Select option values must be nonempty and unique" => "error.rules.selectOptions",
        "Configure only one input rule of each type" => "error.rules.duplicateType",
        "Use display-format overrides on interface-managed columns" | "Table-specific formatting can only be applied to interface-derived columns" => "error.rules.overrideScope",
        "Use no more than 64 conditional formatting rules" => "error.rules.formatLimit",
        "The conditional formatting ID is too long" | "The conditional formatting ID is duplicated" => "error.rules.invalidIdentity",
        "The rank count must be an integer of at least 1" => "error.rules.rankCount",
        "The type does not match the additional settings" => "error.rules.typeConfiguration",
        "Cannot delete a parent row while child rows remain. Delete the parent and children together" => "error.parentDelete",
        "Change write protection in the table's column settings" | "Edit column tags in the table column settings" => "table.edit.structureBlocked",
        "UserSettings must contain exactly one record" => "error.settingsSingleton",
        "no project open" | "No project open" | "No project is open" => "grid.loading.noProject",
        "project session changed" | "Project session changed" => "grid.loading.sessionChanged",
        "Enter a finite decimal number" | "Numeric values must be finite" => "error.validation.valueType",
        "UserSettings must keep its single settings record" => "error.settingsSingleton",
        "Rows cannot be added to this table" => "table.edit.rowsBlocked",
        "Columns cannot be added to this table" => "table.edit.columnsBlocked",
        "Cells cannot be edited in this table" => "table.edit.cellsBlocked",
        "This column is write-protected" => "table.edit.readOnly",
        "Rows cannot be deleted from this table"
        | "Columns cannot be deleted from this table"
        | "Cannot delete the table because row deletion is prohibited"
        | "Cannot delete the table because column deletion is prohibited"
        | "Change edit restrictions through the dedicated settings screen or settings API" => {
            "table.edit.structureBlocked"
        }
        "Enter a version as an integer between 0 and 4294967295" => {
            "column.validation.contentVersion"
        }
        _ => return DevcelError::Validation(message),
    };
    DevcelError::Diagnostics(vec![Diagnostic::Code {
        code: code.into(),
        params: serde_json::json!({}),
    }])
}

impl From<DevcelError> for AppError {
    fn from(error: DevcelError) -> Self {
        // The error category supplies the localized summary. Never repeat the
        // English Display prefix (e.g. "Validation error:") in its details.
        let details = match &error {
            DevcelError::Validation(text)
            | DevcelError::NotFound(text)
            | DevcelError::AlreadyExists(text)
            | DevcelError::InvalidOperation(text)
            | DevcelError::Project(text)
            | DevcelError::Table(text)
            | DevcelError::Command(text) => {
                if let DevcelError::Diagnostics(diagnostics) = authoring_error(text.clone()) {
                    return Self::Diagnostics { diagnostics };
                }
                text.clone()
            }
            DevcelError::Io(error) => error.to_string(),
            DevcelError::Serialization(error) => error.to_string(),
            DevcelError::Toml(error) => error.to_string(),
            DevcelError::InputValidation(_) | DevcelError::Diagnostics(_) => String::new(),
        };
        let code = match &error {
            DevcelError::InputValidation(_) => {
                let DevcelError::InputValidation(report) = error else {
                    unreachable!()
                };
                return Self::InputValidation { report };
            }
            DevcelError::Diagnostics(_) => {
                let DevcelError::Diagnostics(diagnostics) = error else {
                    unreachable!()
                };
                return Self::Diagnostics { diagnostics };
            }
            DevcelError::Io(_) => "error.io",
            DevcelError::Serialization(_) | DevcelError::Toml(_) => "error.parse",
            DevcelError::Validation(_) => "error.invalidData",
            DevcelError::NotFound(_) => "error.notFound",
            DevcelError::AlreadyExists(_) => "error.alreadyExists",
            DevcelError::InvalidOperation(_) => "error.invalidOperation",
            DevcelError::Project(_) => "error.project",
            DevcelError::Table(_) => "error.table",
            DevcelError::Command(_) => "error.command",
        };
        Self::code(code, serde_json::json!({ "details": details }))
    }
}

impl From<String> for AppError {
    fn from(text: String) -> Self {
        Self::Text { text }
    }
}
impl From<&str> for AppError {
    fn from(text: &str) -> Self {
        Self::text(text)
    }
}
impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        DevcelError::from(error).into()
    }
}
impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        DevcelError::from(error).into()
    }
}
impl From<toml::de::Error> for AppError {
    fn from(error: toml::de::Error) -> Self {
        DevcelError::from(error).into()
    }
}
impl From<uuid::Error> for AppError {
    fn from(error: uuid::Error) -> Self {
        Self::code(
            "column.conversion.invalidValue",
            serde_json::json!({ "type": "UUID", "details": error.to_string() }),
        )
    }
}
impl From<crate::FormulaError> for AppError {
    fn from(error: crate::FormulaError) -> Self {
        Self::Diagnostics {
            diagnostics: vec![error.diagnostic()],
        }
    }
}
impl<T> From<std::sync::PoisonError<T>> for AppError {
    fn from(error: std::sync::PoisonError<T>) -> Self {
        Self::technical(error)
    }
}
impl From<tokio::task::JoinError> for AppError {
    fn from(error: tokio::task::JoinError) -> Self {
        Self::technical(error)
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Code { code, params } => write!(formatter, "{code}: {params}"),
            Self::Text { text } => formatter.write_str(text),
            Self::InputValidation { report } => write!(
                formatter,
                "Input validation failed ({} issues)",
                report.issues.len()
            ),
            Self::Diagnostics { diagnostics } => {
                for (index, diagnostic) in diagnostics.iter().enumerate() {
                    if index > 0 {
                        formatter.write_str("; ")?;
                    }
                    write!(formatter, "{diagnostic}")?;
                }
                Ok(())
            }
        }
    }
}
impl std::error::Error for AppError {}

#[cfg(test)]
mod authoring_contract_tests {
    use super::*;
    #[test]
    fn cli_diagnostic_display_retains_identity_without_flattening_the_wire() {
        let error = DevcelError::Diagnostics(vec![
            Diagnostic::Code {
                code: "error.projectMissing".into(),
                params: serde_json::json!({"path":"/資料/{literal}"}),
            },
            Diagnostic::Text {
                text: "literal plugin detail {untouched}".into(),
            },
        ]);
        let display = error.to_string();
        assert!(display.contains("error.projectMissing"));
        assert!(display.contains("/資料/{literal}"));
        assert!(display.ends_with("literal plugin detail {untouched}"));
        let wire = serde_json::to_value(AppError::from(error)).unwrap();
        assert_eq!(wire["kind"], "diagnostics");
        assert_eq!(wire["diagnostics"][0]["params"]["path"], "/資料/{literal}");
        assert_eq!(
            wire["diagnostics"][1]["text"],
            "literal plugin detail {untouched}"
        );
    }

    #[test]
    fn authoring_diagnostics_cross_the_wire_as_codes_and_free_text_stays_literal() {
        let error = AppError::from(authoring_error(
            "The table was updated by another operation. Reload the data",
        ));
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["kind"], "diagnostics");
        assert_eq!(value["diagnostics"][0]["code"], "error.staleData");
        let literal = AppError::text("The table was updated by another operation. Reload the data");
        assert_eq!(serde_json::to_value(literal).unwrap()["kind"], "text");
        let custom = AppError::from(authoring_error(
            "User-supplied diagnostic: preserve this text",
        ));
        assert!(serde_json::to_value(custom).unwrap()["params"]["details"]
            .as_str()
            .unwrap()
            .contains("preserve this text"));
    }
    #[test]
    fn invalid_identity_and_confirmation_are_not_revision_conflicts() {
        for message in [
            "The new column ID is invalid. Reload the data",
            "A column with the same ID already exists. Reload the data",
            "To confirm warnings for the new column, reload the column settings and retry with the same column ID",
            "The contents changed after the warning was confirmed. Enter the value again",
        ] {
            let (key, params) = code(authoring_error(message));
            assert_eq!(key, "error.invalidData");
            assert!(!params["details"].as_str().unwrap().to_lowercase().contains("reload"));
        }
        assert_eq!(
            code(authoring_error("Column not found. Reload the data")).0,
            "error.columnMissing"
        );
    }

    fn code(error: DevcelError) -> (String, serde_json::Value) {
        match AppError::from(error).into_diagnostic() {
            Diagnostic::Code { code, params } => (code, params),
            other => panic!("expected a structured diagnostic: {other:?}"),
        }
    }

    #[test]
    fn name_type_reference_select_singleton_and_version_paths_are_structured() {
        for (input, expected) in [
            ("", "emptyName"),
            ("1name", "nameStart"),
            ("has space", "nameCharacters"),
        ] {
            let original = input.to_owned();
            assert_eq!(
                code(crate::validate_data_name(input).unwrap_err()).0,
                format!("column.validation.{expected}")
            );
            assert_eq!(input, original);
        }
        assert_eq!(
            code(crate::validate_data_name(&"x".repeat(256)).unwrap_err()).0,
            "column.validation.longName"
        );
        for (kind, input, expected) in [
            (crate::ValueType::U8, "300", "U8"),
            (crate::ValueType::F64, "NaN", "F64"),
            (crate::ValueType::Boolean, "perhaps", "Boolean"),
            (crate::ValueType::Reference, "not-an-id", "Reference"),
        ] {
            let column = crate::ColumnSchema {
                data_type: kind,
                ..Default::default()
            };
            let (key, params) = code(column.validate_value(&input.to_owned()).unwrap_err());
            assert_eq!(key, "column.conversion.invalidValue");
            assert_eq!(params["type"], expected);
        }
        assert_eq!(
            code(DevcelError::Validation(
                "UserSettings must contain exactly one record".into()
            ))
            .0,
            "error.settingsSingleton"
        );
        for input in ["", "-1", "1.5", "1e3", "4294967296"] {
            assert_eq!(
                code(crate::table_mutation::parse_content_version(input).unwrap_err()).0,
                "column.validation.contentVersion"
            );
        }
        assert_eq!(
            crate::table_mutation::parse_content_version("0").unwrap(),
            0
        );
        assert_eq!(
            crate::table_mutation::parse_content_version("4294967295").unwrap(),
            u32::MAX
        );
        let choices = crate::types::SelectConfig {
            options: vec![crate::types::SelectOption {
                value: "".into(),
                label: "User label".into(),
            }],
        };
        assert_eq!(
            code(authoring_error(choices.validate().unwrap_err())).0,
            "error.rules.selectOptions"
        );
    }

    #[test]
    fn technical_details_and_nested_errors_never_repeat_english_category_prefixes() {
        let error = AppError::from(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "original OS detail",
        ));
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], "error.io");
        assert_eq!(value["params"]["details"], "original OS detail");
        let nested = AppError::code(
            "grid.errorWithCause",
            serde_json::json!({"summary":"User document", "error":error}),
        );
        assert_eq!(
            serde_json::to_value(nested).unwrap()["params"]["error"]["code"],
            "error.io"
        );
        let literal = AppError::text("Name cannot be empty.");
        assert_eq!(
            serde_json::to_value(literal).unwrap()["text"],
            "Name cannot be empty."
        );
    }

    #[test]
    fn formula_summaries_keep_complete_technical_context_separate() {
        let error = crate::FormulaError::EvaluationContext {
            context: "table-id / row-id / source bytes 1..3".into(),
            source: Box::new(crate::FormulaError::EvaluationContext {
                context: "nested".into(),
                source: Box::new(crate::FormulaError::DivisionByZero),
            }),
        };
        let value = serde_json::to_value(error.diagnostic()).unwrap();
        assert_eq!(value["code"], "error.formula.divisionByZero");
        assert!(value["params"]["details"]
            .as_str()
            .unwrap()
            .contains("source bytes 1..3"));
        assert!(value["params"]["details"]
            .as_str()
            .unwrap()
            .contains("nested"));
    }
}
