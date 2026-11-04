use serde::{Deserialize, Serialize};

/// Enum representing the type of project entry
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProjectEntryType {
    /// Directory
    Directory,
    /// Table
    Table,
    /// Project file
    Project,
    /// Interface file
    Interface,
    /// Markdown file
    Markdown,
    /// Other files
    Other,
}

/// Structure representing a project entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    /// Filesystem last modification time, Unix milliseconds; None when unavailable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,
    /// Entry name
    pub name: String,
    /// Entry path
    pub path: String,
    /// Entry type
    pub entry_type: ProjectEntryType,
    /// Child entries for directories
    pub children: Option<Vec<ProjectEntry>>,
    /// UUID for interface entries
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
}

/// Structure representing a table reference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableReference {
    /// Path
    pub path: String,
    /// UUID
    pub uuid: String,
    /// Display name
    pub display_name: String,
    /// Data name
    pub data_name: String,
}

/// Enum representing value types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ValueType {
    None, // Undefined type
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
    Curve, // Curve type
    /// Reference to another record
    Reference,
    /// Table reference type: an interface-typed reference to an entire table
    /// The value is the UUID of a table implementing the specified interface.
    TableRef,
}

impl ValueType {
    pub fn is_color(&self) -> bool {
        matches!(self, Self::Color32 | Self::ColorFloat)
    }

    /// Return the default value
    pub fn default_value(&self) -> String {
        match self {
            ValueType::None => String::new(),
            ValueType::String => String::new(),
            ValueType::U8
            | ValueType::I8
            | ValueType::U16
            | ValueType::I16
            | ValueType::U32
            | ValueType::I32
            | ValueType::U64
            | ValueType::I64
            | ValueType::F32
            | ValueType::F64 => "0".to_string(),
            ValueType::Boolean => "false".to_string(),
            ValueType::Color32 => crate::color::Color32::default().canonical_string(),
            ValueType::ColorFloat => crate::color::ColorFloat::default().canonical_string(),
            ValueType::Select => String::new(),
            ValueType::DateTime => String::new(),
            ValueType::Curve => String::new(),
            ValueType::Reference => String::new(),
            ValueType::TableRef => String::new(),
        }
    }

    /// Validate the value
    pub fn validate(&self, value: &str) -> bool {
        match self {
            ValueType::None => true,
            ValueType::String
            | ValueType::Select
            | ValueType::DateTime
            | ValueType::Reference
            | ValueType::TableRef => true,
            ValueType::Curve => crate::curve::validate_curve(value).is_ok(),
            ValueType::U8 => value.parse::<u8>().is_ok(),
            ValueType::I8 => value.parse::<i8>().is_ok(),
            ValueType::U16 => value.parse::<u16>().is_ok(),
            ValueType::I16 => value.parse::<i16>().is_ok(),
            ValueType::U32 => value.parse::<u32>().is_ok(),
            ValueType::I32 => value.parse::<i32>().is_ok(),
            ValueType::U64 => value.parse::<u64>().is_ok(),
            ValueType::I64 => value.parse::<i64>().is_ok(),
            ValueType::F32 => value.parse::<f32>().is_ok(),
            ValueType::F64 => value.parse::<f64>().is_ok(),
            ValueType::Boolean => value == "true" || value == "false",
            ValueType::Color32 => crate::color::Color32::parse(value).is_ok(),
            ValueType::ColorFloat => crate::color::ColorFloat::parse(value).is_ok(),
        }
    }

    /// Return the type name for Unity/C# code generation.
    /// Select and Reference should resolve to dedicated generated types,
    /// but define fallback mappings here as the single source of truth.
    pub fn csharp_type(&self) -> &'static str {
        match self {
            ValueType::None => "string",
            ValueType::String => "string",
            ValueType::U8 => "byte",
            ValueType::I8 => "sbyte",
            ValueType::U16 => "ushort",
            ValueType::I16 => "short",
            ValueType::U32 => "uint",
            ValueType::I32 => "int",
            ValueType::U64 => "ulong",
            ValueType::I64 => "long",
            ValueType::F32 => "float",
            ValueType::F64 => "double",
            ValueType::Boolean => "bool",
            ValueType::Color32 => "DevcelColor32",
            ValueType::ColorFloat => "DevcelColorFloat",
            ValueType::Select => "string",
            ValueType::DateTime => "string",
            ValueType::Curve => "string",
            ValueType::Reference | ValueType::TableRef => "string",
        }
    }

    /// Return the type name for C++/Unreal code generation.
    pub fn cpp_type(&self) -> &'static str {
        match self {
            ValueType::None => "std::string",
            ValueType::String => "std::string",
            ValueType::U8 => "uint8_t",
            ValueType::I8 => "int8_t",
            ValueType::U16 => "uint16_t",
            ValueType::I16 => "int16_t",
            ValueType::U32 => "uint32_t",
            ValueType::I32 => "int32_t",
            ValueType::U64 => "uint64_t",
            ValueType::I64 => "int64_t",
            ValueType::F32 => "float",
            ValueType::F64 => "double",
            ValueType::Boolean => "bool",
            ValueType::Color32 => "DevcelColor32",
            ValueType::ColorFloat => "DevcelColorFloat",
            ValueType::Select => "std::string",
            ValueType::DateTime => "std::string",
            ValueType::Curve => "std::string",
            ValueType::Reference | ValueType::TableRef => "std::string",
        }
    }

    /// Return the canonical scalar kind stored internally by the runtime reader.
    /// Distinguish string-pool values from numeric column-array values.
    pub fn scalar_kind(&self) -> ScalarKind {
        match self {
            ValueType::None
            | ValueType::String
            | ValueType::Select
            | ValueType::DateTime
            | ValueType::Curve
            | ValueType::Reference
            | ValueType::TableRef => ScalarKind::Text,
            ValueType::U8 | ValueType::U16 | ValueType::U32 | ValueType::U64 => {
                ScalarKind::Unsigned
            }
            ValueType::I8 | ValueType::I16 | ValueType::I32 | ValueType::I64 => ScalarKind::Signed,
            ValueType::F32 | ValueType::F64 => ScalarKind::Float,
            ValueType::Boolean => ScalarKind::Boolean,
            ValueType::Color32 => ScalarKind::Color32,
            ValueType::ColorFloat => ScalarKind::ColorFloat,
        }
    }
}

/// Canonical scalar kind used by the runtime reader to store values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScalarKind {
    /// Stored in the string pool as text
    Text,
    /// Unsigned integer
    Unsigned,
    /// Signed integer
    Signed,
    /// Floating point
    Float,
    /// Boolean
    Boolean,
    /// Straight-alpha unsigned 8-bit RGBA channels.
    Color32,
    /// Straight-alpha finite f32 RGBA channels.
    ColorFloat,
}

/// Enum representing formula evaluation results
#[derive(Debug, Clone)]
pub enum FormulaResult {
    /// Successfully evaluated value
    Value(String),
    /// Evaluation error
    Error(FormulaError),
}

/// Enum representing formula evaluation errors
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FormulaError {
    /// A core application failure retains its semantic diagnostic across formula evaluation.
    Structured(Box<Diagnostic>),
    ExecutionLimit(String),
    Cancelled,
    DataChanged(String),
    EvaluationContext {
        context: String,
        source: Box<FormulaError>,
    },
    /// Parse error
    ParseError(String),
    /// Type error
    TypeError(String),
    /// Circular reference error
    CircularReference,
    /// Invalid reference error
    InvalidReference(String),
    /// Division by zero error
    DivisionByZero,
    /// Function not found error
    FunctionNotFound(String),
    /// Argument error
    ArgumentError(String),
}

impl From<crate::DevcelError> for FormulaError {
    fn from(error: crate::DevcelError) -> Self {
        Self::Structured(Box::new(crate::AppError::from(error).into_diagnostic()))
    }
}

impl FormulaError {
    /// Machine-readable summary plus original technical details for inspection.
    /// The display message never includes an internal table/row UUID by default.
    pub fn diagnostic(&self) -> Diagnostic {
        let mut cause = self;
        let mut contexts = Vec::new();
        while let Self::EvaluationContext { context, source } = cause {
            contexts.push(context.as_str());
            cause = source.as_ref();
        }
        if let Self::Structured(diagnostic) = cause {
            return if contexts.is_empty() {
                diagnostic.as_ref().clone()
            } else {
                Diagnostic::Code {
                    code: "grid.errorWithCause".into(),
                    params: serde_json::json!({
                        "summary": diagnostic,
                        "error": Diagnostic::Text { text: contexts.join("\n") },
                    }),
                }
            };
        }
        let (code, name) = match cause {
            Self::ExecutionLimit(_) => ("error.formula.limit", None),
            Self::Cancelled => ("grid.loading.cancelled", None),
            Self::DataChanged(_) => ("error.staleData", None),
            Self::ParseError(_) => ("error.formula.syntax", None),
            Self::TypeError(_) => ("error.formula.type", None),
            Self::CircularReference => ("error.formula.circular", None),
            Self::InvalidReference(_) => ("error.formula.reference", None),
            Self::DivisionByZero => ("error.formula.divisionByZero", None),
            Self::FunctionNotFound(name) => ("error.formula.function", Some(name)),
            Self::ArgumentError(_) => ("error.formula.arguments", None),
            Self::EvaluationContext { .. } | Self::Structured(_) => unreachable!(),
        };
        Diagnostic::Code {
            code: code.into(),
            params: serde_json::json!({ "name": name, "details": format!("{self:?}") }),
        }
    }
}

impl FormulaResult {
    /// Convert FormulaResult to Result
    pub fn into_result(self) -> Result<String, FormulaError> {
        match self {
            FormulaResult::Value(v) => Ok(v),
            FormulaResult::Error(e) => Err(e),
        }
    }
}

/// Structure representing a type-cast result
#[derive(Debug, Clone)]
pub struct TypeCastResult {
    /// Value after casting
    pub value: String,
    /// Warning message, such as overflow
    pub warning: Option<String>,
}

impl ValueType {
    /// Cast a numeric value to the specified type
    /// Handle NaN, infinity, and overflow appropriately
    pub fn cast_numeric_value(&self, value: &str) -> TypeCastResult {
        if !matches!(
            self,
            ValueType::U8
                | ValueType::I8
                | ValueType::U16
                | ValueType::I16
                | ValueType::U32
                | ValueType::I32
                | ValueType::U64
                | ValueType::I64
                | ValueType::F32
                | ValueType::F64
        ) {
            return TypeCastResult {
                value: value.to_string(),
                warning: None,
            };
        }
        // Preserve integer formula results and detect boundary overflow before any f64 rounding.
        let integer_bounds = match self {
            ValueType::U8 => Some((u8::MIN as i128, u8::MAX as i128)),
            ValueType::I8 => Some((i8::MIN as i128, i8::MAX as i128)),
            ValueType::U16 => Some((u16::MIN as i128, u16::MAX as i128)),
            ValueType::I16 => Some((i16::MIN as i128, i16::MAX as i128)),
            ValueType::U32 => Some((u32::MIN as i128, u32::MAX as i128)),
            ValueType::I32 => Some((i32::MIN as i128, i32::MAX as i128)),
            ValueType::U64 => Some((u64::MIN as i128, u64::MAX as i128)),
            ValueType::I64 => Some((i64::MIN as i128, i64::MAX as i128)),
            _ => None,
        };
        let digits = value.strip_prefix(['+', '-']).unwrap_or(value);
        if let Some((minimum, maximum)) = integer_bounds {
            if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
                return match value.parse::<i128>() {
                    Ok(number) if (minimum..=maximum).contains(&number) => TypeCastResult {
                        value: number.to_string(),
                        warning: None,
                    },
                    number => {
                        let clamped = match number {
                            Ok(number) => number.clamp(minimum, maximum),
                            Err(_) if value.starts_with('-') => minimum,
                            Err(_) => maximum,
                        };
                        TypeCastResult {
                            value: clamped.to_string(),
                            warning: Some(format!(
                                "Integer value {value} is outside {self:?} range"
                            )),
                        }
                    }
                };
            }
        }
        // Try parsing as a number first
        let parsed_value = match value.parse::<f64>() {
            Ok(v) => v,
            Err(_) => {
                // Return unchanged if parsing as a number fails
                return TypeCastResult {
                    value: value.to_string(),
                    warning: None,
                };
            }
        };

        // Check for NaN and infinity
        if parsed_value.is_nan() {
            return TypeCastResult {
                value: "0".to_string(),
                warning: Some("NaN converted to 0".to_string()),
            };
        }

        if parsed_value.is_infinite() {
            return TypeCastResult {
                value: "0".to_string(),
                warning: Some("Infinity converted to 0".to_string()),
            };
        }

        // Integer formula results use nearest rounding, with ties away from zero.
        // Check the rounded integer, not the original fraction. All supported integer
        // bounds fit strictly inside i128, so even a saturating f64 -> i128 cast is
        // necessarily rejected when the rounded float is outside i128's range.
        // Comparing integer bounds also avoids rounding I64::MAX/U64::MAX up in f64.
        if let Some((minimum, maximum)) = integer_bounds {
            let rounded = parsed_value.round() as i128;
            return TypeCastResult {
                value: rounded.clamp(minimum, maximum).to_string(),
                warning: (!(minimum..=maximum).contains(&rounded))
                    .then(|| format!("Rounded value {value} is outside {self:?} range")),
            };
        }

        match self {
            ValueType::F32 => {
                let f32_val = parsed_value as f32;
                TypeCastResult {
                    value: f32_val.to_string(),
                    warning: (!f32_val.is_finite())
                        .then(|| "Value overflows finite F32 range".to_string()),
                }
            }
            ValueType::F64 => TypeCastResult {
                value: parsed_value.to_string(),
                warning: None,
            },
            _ => {
                // Return unchanged for nonnumeric types
                TypeCastResult {
                    value: value.to_string(),
                    warning: None,
                }
            }
        }
    }
}

/// Structure holding reference-column configuration
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReferenceConfig {
    /// UUID of the target table
    pub target_table_uuid: String,

    /// UUID of the display column, used for dropdown labels
    pub display_column_uuid: Option<String>,
}

/// Structure holding curve-column configuration
/// x is always in 0..1. Fix the y values at the start (x=0) and end (x=1) at the type level.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CurveConfig {
    /// y value at the start (x=0)
    pub start_value: f64,
    /// y value at the end (x=1)
    pub end_value: f64,
}

impl Default for CurveConfig {
    fn default() -> Self {
        Self {
            start_value: 0.0,
            end_value: 1.0,
        }
    }
}

/// Structure holding table-reference column configuration
/// The value is the UUID of a table implementing this interface_uuid
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TableRefConfig {
    /// UUID of the interface the referenced table must implement
    pub interface_uuid: String,
}

/// Row references always prevent deletion while a referencing row survives.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ReferenceOnDelete {
    Restrict,
}

/// Structure representing an option for a reference column
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceOption {
    /// Record UUID
    pub uuid: String,

    /// Display value
    pub display_value: String,
}

/// Structure representing a referential-integrity check result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceIntegrityCheck {
    /// UUID of the record being checked
    pub record_uuid: String,

    /// List of referencing records
    pub referencing_records: Vec<ReferencingRecord>,

    /// Whether deletion is allowed
    pub can_delete: bool,

    /// Deletion impact
    pub delete_impact: DeleteImpact,
}

/// Structure describing a referencing record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferencingRecord {
    /// UUID of the referencing table
    pub table_uuid: String,

    /// Display name of the referencing table
    pub table_name: String,

    /// UUID of the referencing record
    pub record_uuid: String,

    /// Display value of the referencing record
    pub record_display_value: String,

    /// UUID of the referencing column
    pub column_uuid: String,

    /// Display name of the referencing column
    pub column_name: String,

    /// Action on deletion
    pub on_delete_action: ReferenceOnDelete,
}

/// Structure representing deletion impact
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteImpact {
    /// Number of affected records
    pub affected_record_count: usize,

    /// Number of records that will cause an error
    pub restrict_count: usize,
}

/// Explicit choices for Select columns.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct SelectOption {
    pub value: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct SelectConfig {
    pub options: Vec<SelectOption>,
}

impl SelectConfig {
    pub fn validate(&self) -> std::result::Result<(), String> {
        let mut values = std::collections::HashSet::new();
        for option in &self.options {
            if option.value.is_empty() || !values.insert(&option.value) {
                return Err("Select option values must be nonempty and unique".into());
            }
        }
        Ok(())
    }
}

/// A diagnostic has exactly one presentation source. User text is never interpreted as a key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Diagnostic {
    Code {
        code: String,
        params: serde_json::Value,
    },
    Text {
        text: String,
    },
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Text { text } => formatter.write_str(text),
            Self::Code { code, params } => write!(formatter, "{code}: {params}"),
        }
    }
}
