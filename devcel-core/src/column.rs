// Import project type definitions
// Import type definitions from project
use crate::types::{ReferenceConfig, ValueType};
use crate::{DevcelError, Result};
// Import serialization crates
// Import serialization crates
use serde::{Deserialize, Serialize};
// Import the UUID generation crate
// Import UUID generation crate
use uuid;

/// Schema definition for a table column
/// Includes the data type, display settings, validation rules, and more
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ColumnSchema {
    /// First content release containing this column. Omitted zero means the first release.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub min_version: u32,
    /// Protect stored inputs; column defaults and evaluated results remain editable.
    pub read_only: bool,
    /// Unique column identifier
    pub uuid: String,
    /// Column name displayed in the UI
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub display_name: String,
    /// Identifier used in the database
    pub data_name: String,
    /// Column header tooltip text
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tooltip: String,
    /// Column data type
    pub data_type: ValueType,
    /// Tags associated with the column
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Default value for new records
    pub default_value: String,
    /// Column display style settings
    pub style: ColumnStyle,
    /// Detailed column description
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub memo_text: String,
    /// Configuration for the Reference type
    pub reference_config: Option<ReferenceConfig>,
    /// Configuration for TableRef (interface required of the referenced table)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_ref_config: Option<crate::types::TableRefConfig>,
    /// Configuration for Curve (fixed y values at the endpoints)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curve_config: Option<crate::types::CurveConfig>,
    /// Explicit Select choices; absence means unrestricted input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub select_config: Option<crate::types::SelectConfig>,
    /// Named RGBA choices for authoring. Preserved across type changes; never an input restriction.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub color_swatches: Vec<crate::ColorSwatch>,
    /// UUID of the interface this column originates from (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface_origin: Option<String>,

    /// Fallback interface name for use after the interface is deleted
    /// Warning: for display only. Use interface_origin for actual processing
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface_origin_name_fallback: Option<String>,

    /// Whether the column is required (from the interface definition; optional if unspecified)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,

    /// Value constraints (uniqueness, range, and regular expression)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<ColumnConstraints>,

    /// Input-time rules are opt-in. Constraints retain their export semantics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_validation: Option<crate::cell_rules::InputValidationSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conditional_formatting: Option<crate::cell_rules::ConditionalFormatting>,
    /// None inherits; an empty rule list explicitly disables inherited formatting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conditional_formatting_override: Option<crate::cell_rules::ConditionalFormatting>,
}

/// Column value constraint definitions
/// Defined in interfaces and used to validate record values in implementing tables
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ColumnConstraints {
    /// Require unique values
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    /// Numeric lower bound
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_value: Option<f64>,
    /// Numeric upper bound
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_value: Option<f64>,
    /// Regular expression pattern that values must match
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
}

impl ColumnConstraints {
    /// Whether no constraints are specified
    pub fn is_empty(&self) -> bool {
        self.unique.is_none()
            && self.min_value.is_none()
            && self.max_value.is_none()
            && self.pattern.is_none()
    }
}

/// Column display style settings
/// Controls the column's appearance in the UI
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ColumnStyle {
    /// Column background color (hex color code)
    pub color: String,
    /// Font size in pixels
    pub font_size: u32,
    /// Preferred column width in pixels; zero lets the UI fit the initial title.
    pub width: u32,
}

impl Default for ColumnStyle {
    fn default() -> Self {
        Self {
            color: "#FFFFFF".to_string(), // White
            font_size: 12,                // 12 pixels
            width: 0,                     // Automatic initial width
        }
    }
}

impl ColumnStyle {
    /// Create the default column style
    pub fn new() -> Self {
        Self::default()
    }
}

impl Default for ColumnSchema {
    fn default() -> Self {
        Self {
            min_version: 0,
            read_only: false,
            uuid: uuid::Uuid::new_v4().to_string(), // Generate a new UUID
            display_name: String::new(),
            data_name: String::new(),
            tooltip: String::new(),
            data_type: ValueType::String, // Default to the string type
            tags: Vec::new(),
            default_value: String::new(),
            style: ColumnStyle::new(), // Apply the default style
            memo_text: String::new(),
            reference_config: None, // No reference configuration by default
            table_ref_config: None, // No table-reference configuration by default
            curve_config: None,     // No curve configuration by default
            select_config: None,
            color_swatches: Vec::new(),
            interface_origin: None,
            interface_origin_name_fallback: None,
            required: None,
            constraints: None,
            input_validation: None,
            conditional_formatting: None,
            conditional_formatting_override: None,
        }
    }
}

impl ColumnSchema {
    /// Create a column schema
    /// Initialize with default values and an automatically generated UUID
    pub fn new() -> Self {
        Self::default()
    }

    /// Canonicalize a user-entered color default before recording it in history.
    /// Empty color defaults mean the type's opaque-white default.
    pub fn normalize_color_default(&mut self) -> Result<()> {
        if self.data_type.is_color() {
            self.default_value = if self.default_value.is_empty() {
                self.data_type.default_value()
            } else {
                self.validate_value(&self.default_value)?
            };
        }
        Ok(())
    }

    /// Persisted color literals must already be canonical. Loading never repairs
    /// a spelling or substitutes an invalid value; formulas and inheritance keep
    /// their existing explicit representation.
    pub fn validate_color_storage_value(&self, value: &str) -> Result<()> {
        if self.data_type.is_color() && !value.is_empty() && !value.starts_with('=') {
            let normalized = self.validate_value(&value.to_owned())?;
            if normalized != value {
                return Err(crate::app_error::authoring_error(format!(
                    "Color value in column '{}' is not canonical RGBA: {}",
                    self.data_name, value
                )));
            }
        }
        Ok(())
    }

    pub fn validate_color_storage_contract(&self) -> Result<()> {
        crate::validate_color_swatches(&self.color_swatches)?;
        self.validate_color_storage_value(&self.default_value)
    }

    /// Validate a value against the column's data type
    /// Check conformance to the type specification and return a normalized value
    pub fn validate_value(&self, value: &String) -> Result<String> {
        // None remains a value-less type even when text starts with '='.
        if self.data_type == ValueType::None {
            return Ok(String::new());
        }
        // Skip validation for formulas
        if value.starts_with('=') {
            return Ok(value.clone());
        }

        match self.data_type {
            // None type: always return an empty string
            // None type: always returns empty string
            ValueType::None => Ok(String::new()),

            // Numeric types: attempt parsing and return a string on success
            // Numeric types: attempt parsing, return as string if successful
            ValueType::U8 => match value.parse::<u8>() {
                Ok(v) => Ok(v.to_string()),
                Err(_) => Err(crate::app_error::authoring_error(
                    "Invalid value type. Enter a U8 value.".to_string(),
                )),
            },
            ValueType::I8 => match value.parse::<i8>() {
                Ok(v) => Ok(v.to_string()),
                Err(_) => Err(crate::app_error::authoring_error(
                    "Invalid value type. Enter an I8 value.".to_string(),
                )),
            },
            ValueType::U16 => match value.parse::<u16>() {
                Ok(v) => Ok(v.to_string()),
                Err(_) => Err(crate::app_error::authoring_error(
                    "Invalid value type. Enter a U16 value.".to_string(),
                )),
            },
            ValueType::I16 => match value.parse::<i16>() {
                Ok(v) => Ok(v.to_string()),
                Err(_) => Err(crate::app_error::authoring_error(
                    "Invalid value type. Enter an I16 value.".to_string(),
                )),
            },
            ValueType::U32 => match value.parse::<u32>() {
                Ok(v) => Ok(v.to_string()),
                Err(_) => Err(crate::app_error::authoring_error(
                    "Invalid value type. Enter a U32 value.".to_string(),
                )),
            },
            ValueType::I32 => match value.parse::<i32>() {
                Ok(v) => Ok(v.to_string()),
                Err(_) => Err(crate::app_error::authoring_error(
                    "Invalid value type. Enter an I32 value.".to_string(),
                )),
            },
            ValueType::U64 => match value.parse::<u64>() {
                Ok(v) => Ok(v.to_string()),
                Err(_) => Err(crate::app_error::authoring_error(
                    "Invalid value type. Enter a U64 value.".to_string(),
                )),
            },
            ValueType::I64 => match value.parse::<i64>() {
                Ok(v) => Ok(v.to_string()),
                Err(_) => Err(crate::app_error::authoring_error(
                    "Invalid value type. Enter an I64 value.".to_string(),
                )),
            },
            ValueType::F32 => match value.parse::<f32>() {
                Ok(v) if v.is_finite() => Ok(v.to_string()),
                _ => Err(crate::app_error::authoring_error(
                    "Invalid value type. Enter a finite F32 value.".to_string(),
                )),
            },
            ValueType::F64 => match value.parse::<f64>() {
                Ok(v) if v.is_finite() => Ok(v.to_string()),
                _ => Err(crate::app_error::authoring_error(
                    "Invalid value type. Enter a finite F64 value.".to_string(),
                )),
            },

            // String type: accept as is
            // String type: accept as-is
            ValueType::String => Ok(value.to_string()),

            // Boolean type: attempt parsing as a boolean
            // Boolean type: attempt parsing as boolean
            ValueType::Boolean => match value.parse::<bool>() {
                Ok(v) => Ok(v.to_string()),
                Err(_) => Err(crate::app_error::authoring_error(
                    "Invalid value type. Enter a Bool value.".to_string(),
                )),
            },

            // Reference type: only check UUID format (actual references are checked by another method)
            // Reference type: only check UUID format (actual reference check implemented in separate method)
            ValueType::Reference => {
                if value.is_empty() {
                    // Treat an empty string as NULL
                    // Empty string is treated as NULL value
                    Ok(value.to_string())
                } else {
                    // Check UUID format
                    // Check UUID format
                    match uuid::Uuid::parse_str(value) {
                        Ok(_) => Ok(value.to_string()),
                        Err(_) => Err(crate::app_error::authoring_error(
                            "The reference value must be a valid UUID.".to_string(),
                        )),
                    }
                }
            }
            // Reject malformed curves before changing data/history.
            ValueType::Curve => {
                crate::curve::validate_curve(value).map_err(|details| {
                    DevcelError::Diagnostics(vec![crate::types::Diagnostic::Code {
                        code: "column.conversion.invalidValue".into(),
                        params: serde_json::json!({"type":"Curve", "details": details}),
                    }])
                })?;
                Ok(value.clone())
            }
            // Table-reference type: accept empty (NULL) or a referenced table UUID
            // TableRef type: accept empty (NULL) or a UUID string of the target table
            ValueType::TableRef => {
                if value.is_empty() {
                    Ok(value.to_string())
                } else {
                    match uuid::Uuid::parse_str(value) {
                        Ok(_) => Ok(value.to_string()),
                        Err(_) => Err(crate::app_error::authoring_error(
                            "The table reference must be a valid table UUID.".to_string(),
                        )),
                    }
                }
            }
            // Handle other value types with default behavior
            ValueType::Color32 => crate::color::Color32::parse(value)
                .map(|color| color.canonical_string())
                .map_err(DevcelError::Validation),
            ValueType::ColorFloat => crate::color::ColorFloat::parse(value)
                .map(|color| color.canonical_string())
                .map_err(DevcelError::Validation),
            ValueType::Select | ValueType::DateTime => Ok(value.to_string()),
        }
    }

    /// Validate a reference value (requires access to the Project)
    pub fn validate_reference_value(&self, value: &str, project: &crate::Project) -> Result<()> {
        // Error if this is not a Reference column
        // Error if not Reference type
        if self.data_type != ValueType::Reference {
            return Err(crate::app_error::authoring_error(
                "This column is not a reference type.".to_string(),
            ));
        }

        let config = self.reference_config.as_ref().ok_or_else(|| {
            crate::app_error::authoring_error("Reference configuration not found.".to_string())
        })?;

        // Always allow an empty string (NULL)
        // Empty string (NULL value) is always allowed
        if value.is_empty() {
            return Ok(());
        }

        // Check UUID format
        // Check UUID format
        let uuid = uuid::Uuid::parse_str(value).map_err(|_| {
            crate::app_error::authoring_error(
                "The reference value must be a valid UUID.".to_string(),
            )
        })?;

        // Check that the referenced table exists
        // Check if target table exists
        let target_table = project.read_table_data_by_uuid(&config.target_table_uuid)?;

        // Check that the referenced record exists
        // Check if target record exists
        let record_exists = target_table
            .records
            .iter()
            .any(|r| r.uuid == uuid.to_string());

        if !record_exists {
            return Err(crate::app_error::authoring_error(
                "Referenced record not found.".to_string(),
            ));
        }

        Ok(())
    }
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

#[cfg(test)]
mod initial_width_tests {
    use super::ColumnStyle;
    #[test]
    fn automatic_initial_width_preserves_explicit_widths_on_roundtrip() {
        assert_eq!(ColumnStyle::default().width, 0);
        for width in [0, 100, 237] {
            let style = ColumnStyle {
                width,
                ..ColumnStyle::default()
            };
            let encoded = toml::to_string(&style).unwrap();
            let decoded: ColumnStyle = toml::from_str(&encoded).unwrap();
            assert_eq!(decoded.width, width);
        }
    }
}
