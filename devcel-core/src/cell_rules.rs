//! Opt-in input rules and presentation-only conditional formatting.
//! The same pure evaluators serve editor previews, writes and the native grid.
use crate::{
    ColumnSchema, DevcelError, FormulaEngine, FormulaError, FormulaResult, Record, Result,
    TableData, ValueType,
};
use serde::{
    ser::{SerializeMap, SerializeSeq},
    Deserialize, Serialize, Serializer,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationMode {
    Reject,
    Warn,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputRule {
    Required,
    Unique,
    NumberRange {
        min: Option<String>,
        max: Option<String>,
    },
    Pattern {
        pattern: String,
    },
    SelectChoices,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputValidationSettings {
    #[serde(
        default = "input_rules_enabled",
        skip_serializing_if = "input_rules_enabled_value"
    )]
    pub enabled: bool,
    pub mode: ValidationMode,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub hint: String,
    pub rules: Vec<InputRule>,
}

fn input_rules_enabled() -> bool {
    true
}
fn input_rules_enabled_value(value: &bool) -> bool {
    *value
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CellStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FormatCondition {
    All,
    Empty,
    NotEmpty,
    Equals {
        value: String,
    },
    NotEquals {
        value: String,
    },
    GreaterThan {
        value: String,
    },
    GreaterThanOrEqual {
        value: String,
    },
    LessThan {
        value: String,
    },
    LessThanOrEqual {
        value: String,
    },
    Contains {
        value: String,
    },
    NotContains {
        value: String,
    },
    Between {
        min: String,
        max: String,
        #[serde(default = "range_low_color")]
        low_color: String,
        #[serde(default = "range_high_color")]
        high_color: String,
        #[serde(default = "range_out_color")]
        out_of_range_color: String,
    },
    Top {
        count: u32,
        include_ties: bool,
    },
    Bottom {
        count: u32,
        include_ties: bool,
    },
    ColorScale {
        low_color: String,
        high_color: String,
    },
}

fn range_low_color() -> String {
    "#93c5fd".into()
}
fn range_high_color() -> String {
    "#2563eb".into()
}
fn range_out_color() -> String {
    "#dc2626".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RangeBar {
    /// Fraction of the finite range, in basis points (0..=10000).
    pub fraction: u32,
    pub color: String,
    pub out_of_range: bool,
}

fn enabled() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormattingRule {
    #[serde(default)]
    pub id: String,
    #[serde(default = "enabled")]
    pub enabled: bool,
    pub condition: FormatCondition,
    #[serde(default)]
    pub style: CellStyle,
    #[serde(default)]
    pub stop_if_true: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConditionalFormatting {
    pub rules: Vec<FormattingRule>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ValidationIssue {
    pub diagnostic: crate::types::Diagnostic,
    pub table_uuid: String,
    pub column_uuid: String,
    pub column_name: String,
    pub record_uuid: Option<String>,
    pub kind: String,
    pub mode: ValidationMode,
    pub raw_value: String,
    pub effective_value: String,
    pub rule_key: String,
    #[serde(default)]
    pub peers: Vec<String>,
    /// `peers` is a bounded diagnostic sample; comparisons use complete groups.
    #[serde(default)]
    pub peer_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ValidationReport {
    pub issues: Vec<ValidationIssue>,
    pub acknowledgement: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CellPresentation {
    pub raw_value: String,
    pub display_value: String,
    pub style: CellStyle,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_bar: Option<RangeBar>,
    pub issues: Vec<ValidationIssue>,
    pub formula_error: Option<crate::types::Diagnostic>,
    pub hint: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TablePresentation {
    pub table_uuid: String,
    pub revision: String,
    pub cells: BTreeMap<String, BTreeMap<String, CellPresentation>>,
    pub definition_issues: Vec<crate::types::Diagnostic>,
    pub issue_count: usize,
}

fn invalid(message: impl Into<String>) -> DevcelError {
    crate::app_error::authoring_error(message)
}

pub fn numeric_type(kind: &ValueType) -> bool {
    matches!(
        kind,
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
    )
}

/// Decimal comparison never rounds 64-bit integer values through f64.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Decimal {
    negative: bool,
    digits: String,
    exponent: i32,
}
impl Decimal {
    fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        if raw.is_empty() || raw.len() > 4096 {
            return None;
        }
        let negative = raw.starts_with('-');
        let raw = raw.strip_prefix(['-', '+']).unwrap_or(raw);
        let mut parts = raw.split(['e', 'E']);
        let mantissa = parts.next()?;
        let exponent: i32 = parts.next().map(str::parse).transpose().ok()?.unwrap_or(0);
        if parts.next().is_some() || exponent.unsigned_abs() > 10000 {
            return None;
        }
        let mut parts = mantissa.split('.');
        let whole = parts.next()?;
        let fraction = parts.next().unwrap_or("");
        if parts.next().is_some() {
            return None;
        }
        let mut digits = format!("{whole}{fraction}");
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        digits = digits.trim_start_matches('0').to_owned();
        if digits.is_empty() {
            return Some(Self {
                negative: false,
                digits: "0".into(),
                exponent: 0,
            });
        }
        let zeros = digits.len() - digits.trim_end_matches('0').len();
        digits.truncate(digits.len() - zeros);
        Some(Self {
            negative,
            digits,
            exponent: exponent
                .checked_sub(fraction.len() as i32)?
                .checked_add(zeros as i32)?,
        })
    }
    fn key(&self) -> String {
        format!("{}:{}:{}", self.negative, self.digits, self.exponent)
    }
}
impl Ord for Decimal {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        if self.digits == "0" && other.digits == "0" {
            return Ordering::Equal;
        }
        if self.negative != other.negative {
            return if self.negative {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        let magnitude = if self.digits == "0" {
            Ordering::Less
        } else if other.digits == "0" {
            Ordering::Greater
        } else {
            (self.digits.len() as i64 + i64::from(self.exponent))
                .cmp(&(other.digits.len() as i64 + i64::from(other.exponent)))
                .then_with(|| {
                    let a = self.digits.as_bytes();
                    let b = other.digits.as_bytes();
                    (0..a.len().max(b.len()))
                        .find_map(|i| {
                            let order = a
                                .get(i)
                                .copied()
                                .unwrap_or(b'0')
                                .cmp(&b.get(i).copied().unwrap_or(b'0'));
                            (order != Ordering::Equal).then_some(order)
                        })
                        .unwrap_or(Ordering::Equal)
                })
        };
        if self.negative {
            magnitude.reverse()
        } else {
            magnitude
        }
    }
}
impl PartialOrd for Decimal {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn number(raw: &str) -> Result<Decimal> {
    if !raw.trim().parse::<f64>().is_ok_and(f64::is_finite) {
        return Err(invalid("Enter a finite decimal number"));
    }
    Decimal::parse(raw).ok_or_else(|| invalid("Enter a finite decimal number"))
}
fn color(raw: &str) -> bool {
    raw.len() == 7 && raw.starts_with('#') && raw[1..].bytes().all(|v| v.is_ascii_hexdigit())
}
fn require_numeric(column: &ColumnSchema) -> Result<()> {
    if numeric_type(&column.data_type) {
        Ok(())
    } else {
        Err(invalid(
            "Ranges, comparisons, ranks, and color scales require a numeric type",
        ))
    }
}

pub fn validate_column_definition(column: &ColumnSchema) -> Result<()> {
    crate::validate_data_name(&column.data_name)?;
    crate::validate_color_swatches(&column.color_swatches)?;
    if let Some(settings) = &column.input_validation {
        if settings.rules.len() > 16 || settings.message.len() > 4096 || settings.hint.len() > 4096
        {
            return Err(invalid("The input rule or message is too long"));
        }
        let mut kinds = BTreeSet::new();
        for rule in &settings.rules {
            let kind = match rule {
                InputRule::Required => "required",
                InputRule::Unique => "unique",
                InputRule::NumberRange { min, max } => {
                    require_numeric(column)?;
                    if min.is_none() && max.is_none() {
                        return Err(invalid("Specify a minimum or maximum for the range"));
                    }
                    let min = min.as_deref().map(number).transpose()?;
                    let max = max.as_deref().map(number).transpose()?;
                    if matches!((&min, &max), (Some(a), Some(b)) if a > b) {
                        return Err(invalid("The minimum must not exceed the maximum"));
                    }
                    "number_range"
                }
                InputRule::Pattern { pattern } => {
                    if pattern.len() > 65536 {
                        return Err(invalid("The regular expression is too long"));
                    }
                    regex::Regex::new(pattern).map_err(|e| {
                        DevcelError::Diagnostics(vec![crate::types::Diagnostic::Code {
                            code: "error.rulePattern".into(),
                            params: serde_json::json!({"details":e.to_string()}),
                        }])
                    })?;
                    "pattern"
                }
                InputRule::SelectChoices => {
                    if column.data_type != ValueType::Select || column.select_config.is_none() {
                        return Err(invalid(
                            "An option rule requires a Select type with configured options",
                        ));
                    }
                    column
                        .select_config
                        .as_ref()
                        .unwrap()
                        .validate()
                        .map_err(invalid)?;
                    "select_choices"
                }
            };
            if !kinds.insert(kind) {
                return Err(invalid("Configure only one input rule of each type"));
            }
        }
    }
    if column.conditional_formatting_override.is_some() && column.interface_origin.is_none() {
        return Err(invalid(
            "Use display-format overrides on interface-managed columns",
        ));
    }
    for formatting in [
        &column.conditional_formatting,
        &column.conditional_formatting_override,
    ]
    .into_iter()
    .flatten()
    {
        if formatting.rules.len() > 64 {
            return Err(invalid("Use no more than 64 conditional formatting rules"));
        }
        let mut ids = BTreeSet::new();
        for rule in &formatting.rules {
            if rule.id.len() > 128 {
                return Err(invalid("The conditional formatting ID is too long"));
            }
            if !rule.id.is_empty() && !ids.insert(&rule.id) {
                return Err(invalid("The conditional formatting ID is duplicated"));
            }
            for value in [&rule.style.background_color, &rule.style.text_color]
                .into_iter()
                .flatten()
            {
                if !color(value) {
                    return Err(invalid("Specify the formatting color as #RRGGBB"));
                }
            }
            match &rule.condition {
                FormatCondition::GreaterThan { value }
                | FormatCondition::GreaterThanOrEqual { value }
                | FormatCondition::LessThan { value }
                | FormatCondition::LessThanOrEqual { value } => {
                    require_numeric(column)?;
                    number(value)?;
                }
                FormatCondition::Equals { value } | FormatCondition::NotEquals { value }
                    if numeric_type(&column.data_type) && !value.is_empty() =>
                {
                    number(value)?;
                }
                FormatCondition::Between {
                    min,
                    max,
                    low_color,
                    high_color,
                    out_of_range_color,
                } => {
                    if !color(low_color) || !color(high_color) || !color(out_of_range_color) {
                        return Err(invalid("Specify the formatting color as #RRGGBB"));
                    }
                    require_numeric(column)?;
                    if number(min)? > number(max)? {
                        return Err(invalid("The range minimum must not exceed its maximum"));
                    }
                }
                FormatCondition::Top { count, .. } | FormatCondition::Bottom { count, .. } => {
                    require_numeric(column)?;
                    if *count == 0 {
                        return Err(invalid("The rank count must be an integer of at least 1"));
                    }
                }
                FormatCondition::ColorScale {
                    low_color,
                    high_color,
                } => {
                    require_numeric(column)?;
                    if !color(low_color) || !color(high_color) {
                        return Err(invalid("Specify color scale colors as #RRGGBB"));
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}

pub fn normalize_column_rules(column: &mut ColumnSchema) -> Result<()> {
    for formatting in [
        &mut column.conditional_formatting,
        &mut column.conditional_formatting_override,
    ]
    .into_iter()
    .flatten()
    {
        for (index, rule) in formatting.rules.iter_mut().enumerate() {
            // Direct APIs may omit IDs. Re-preparing identical input must not
            // invalidate a warning token, so this fallback is deterministic.
            if rule.id.is_empty() {
                rule.id = format!("rule-{}", fingerprint(&(&column.data_name, index, &*rule)));
            }
        }
    }
    validate_column_definition(column)
}

pub fn new_formatting_rule(kind: &str) -> Result<FormattingRule> {
    let condition = match kind {
        "all" => FormatCondition::All,
        "empty" => FormatCondition::Empty,
        "not_empty" => FormatCondition::NotEmpty,
        "equals" => FormatCondition::Equals { value: "0".into() },
        "not_equals" => FormatCondition::NotEquals { value: "0".into() },
        "greater_than" => FormatCondition::GreaterThan { value: "0".into() },
        "greater_than_or_equal" => FormatCondition::GreaterThanOrEqual { value: "0".into() },
        "less_than" => FormatCondition::LessThan { value: "0".into() },
        "less_than_or_equal" => FormatCondition::LessThanOrEqual { value: "0".into() },
        "contains" => FormatCondition::Contains {
            value: String::new(),
        },
        "not_contains" => FormatCondition::NotContains {
            value: String::new(),
        },
        "between" => FormatCondition::Between {
            min: "0".into(),
            max: "100".into(),
            low_color: range_low_color(),
            high_color: range_high_color(),
            out_of_range_color: range_out_color(),
        },
        "top" => FormatCondition::Top {
            count: 3,
            include_ties: true,
        },
        "bottom" => FormatCondition::Bottom {
            count: 3,
            include_ties: true,
        },
        "color_scale" => FormatCondition::ColorScale {
            low_color: "#ffffff".into(),
            high_color: "#60a5fa".into(),
        },
        _ => return Err(invalid("Unknown condition type")),
    };
    Ok(FormattingRule {
        id: uuid::Uuid::new_v4().to_string(),
        enabled: true,
        condition,
        style: CellStyle {
            background_color: Some("#dbeafe".into()),
            ..CellStyle::default()
        },
        stop_if_true: false,
    })
}

struct HashWriter(Sha256);

impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn hash_json<T: Serialize>(value: &T) -> String {
    let mut hash = HashWriter(Sha256::new());
    {
        // JSON emits many tiny fragments. Buffer those without keeping the full
        // encoded table alongside its in-memory data and canonical JSON values.
        let mut writer = BufWriter::new(&mut hash);
        serde_json::to_writer(&mut writer, value).expect("serializable rule snapshot");
        writer.flush().expect("infallible hash writer");
    }
    format!("{:x}", hash.0.finalize())
}

/// Keep serde_json's existing object ordering, escaping, and number semantics.
/// In particular, serializing f32 directly need not match to_value then encoding.
struct CanonicalValue<'a, T: ?Sized>(&'a T);

impl<T: Serialize + ?Sized> Serialize for CanonicalValue<'_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serde_json::to_value(self.0)
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }
}

struct CanonicalSequence<'a, T>(&'a [T]);

impl<T: Serialize> Serialize for CanonicalSequence<'_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for value in self.0 {
            sequence.serialize_element(&CanonicalValue(value))?;
        }
        sequence.end()
    }
}

// Records contain only strings, u32 and ordered sequences/maps of strings.
// Borrow them in canonical JSON key order instead of cloning every cell into a
// JSON Value. Explicit types and an exhaustive pattern guard future schema edits.
#[derive(Serialize)]
struct CanonicalRecord<'a> {
    #[serde(
        skip_serializing_if = "std::collections::HashMap::is_empty",
        serialize_with = "crate::ordered_map::serialize"
    )]
    interface_values: &'a std::collections::HashMap<String, String>,
    #[serde(skip_serializing_if = "str::is_empty")]
    label: &'a str,
    #[serde(
        skip_serializing_if = "std::collections::HashMap::is_empty",
        serialize_with = "crate::ordered_map::serialize"
    )]
    memo_texts: &'a std::collections::HashMap<String, String>,
    #[serde(skip_serializing_if = "canonical_zero")]
    min_version: u32,
    #[serde(skip_serializing_if = "str::is_empty")]
    parent_uuid: &'a str,
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    tags: &'a [String],
    uuid: &'a str,
    #[serde(serialize_with = "crate::ordered_map::serialize")]
    values: &'a std::collections::HashMap<String, String>,
}
impl<'a> CanonicalRecord<'a> {
    fn new(record: &'a Record) -> Self {
        let Record {
            uuid,
            parent_uuid,
            label,
            min_version,
            tags,
            values,
            interface_values,
            memo_texts,
        } = record;
        Self {
            interface_values,
            label,
            memo_texts,
            min_version: *min_version,
            parent_uuid,
            tags,
            uuid,
            values,
        }
    }
}
struct CanonicalRecords<'a>(&'a [Record]);
impl Serialize for CanonicalRecords<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for record in self.0 {
            sequence.serialize_element(&CanonicalRecord::new(record))?;
        }
        sequence.end()
    }
}

struct CanonicalSchema<'a>(&'a crate::table::TableSchema);

impl Serialize for CanonicalSchema<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let crate::table::TableSchema { columns } = self.0;
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry("columns", &CanonicalSequence(columns))?;
        map.end()
    }
}

struct CanonicalTable<'a>(&'a TableData);

impl Serialize for CanonicalTable<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        // Exhaustive patterns make added table/schema fields a compile error
        // here instead of silently excluding them from optimistic concurrency.
        let TableData {
            uuid,
            display_name,
            description,
            metadata,
            interface_implementations,
            schema,
            records,
        } = self.0;
        // These keys have the same lexical order as serde_json::Value objects.
        // Numeric-bearing nested objects still use Value; records borrow their
        // typed cells, so scratch memory does not grow with the row count.
        let mut map = serializer.serialize_map(Some(7))?;
        map.serialize_entry("description", description)?;
        map.serialize_entry("display_name", display_name)?;
        map.serialize_entry(
            "interface_implementations",
            &CanonicalValue(interface_implementations),
        )?;

        map.serialize_entry("metadata", &CanonicalValue(metadata))?;
        map.serialize_entry("records", &CanonicalRecords(records))?;
        map.serialize_entry("schema", &CanonicalSchema(schema))?;
        map.serialize_entry("uuid", uuid)?;
        map.end()
    }
}

/// JSON objects are sorted before hashing; HashMap iteration order is irrelevant.
fn fingerprint<T: Serialize>(value: &T) -> String {
    hash_json(&CanonicalValue(value))
}

pub fn revision(data: &TableData) -> String {
    hash_json(&CanonicalTable(data))
}

#[derive(Clone)]
struct Evaluated {
    raw: String,
    value: String,
    error: Option<crate::types::Diagnostic>,
}
pub(crate) type FormulaEvaluator<'a> =
    dyn FnMut(&TableData, &ColumnSchema, &Record, &str) -> FormulaResult + 'a;

fn standalone_evaluator() -> impl FnMut(&TableData, &ColumnSchema, &Record, &str) -> FormulaResult {
    let mut inputs = std::collections::HashMap::<usize, crate::table::InputResolutionCache>::new();
    move |data, column, record, formula| {
        // This evaluator lives for one immutable batch, including its temporary
        // baseline. Cache indices and requested inputs, never entire row copies.
        let key = data as *const TableData as usize;
        let cache = inputs.remove(&key).unwrap_or_default();
        let mut engine = FormulaEngine::with_table_cache(data, cache);
        let result = standalone_formula_with_engine(&mut engine, data, column, record, formula);
        inputs.insert(key, engine.take_table_cache());
        result
    }
}
#[cfg(test)]
fn standalone_formula(
    data: &TableData,
    column: &ColumnSchema,
    record: &Record,
    formula: &str,
) -> FormulaResult {
    standalone_evaluator()(data, column, record, formula)
}
fn standalone_formula_with_engine(
    engine: &mut FormulaEngine<'_>,
    data: &TableData,
    column: &ColumnSchema,
    record: &Record,
    formula: &str,
) -> FormulaResult {
    match engine.evaluate_column(formula, column, record, &data.schema) {
        FormulaResult::Error(error)
            if !matches!(error, FormulaError::Cancelled) && engine.last_diagnostic().is_some() =>
        {
            engine.complete_diagnostic_table(&data.uuid);
            FormulaResult::Error(FormulaError::EvaluationContext {
                context: engine.format_error(&error),
                source: Box::new(error),
            })
        }
        result => result,
    }
}

fn evaluate(
    data: &TableData,
    column: &ColumnSchema,
    record: &Record,
    evaluator: &mut FormulaEvaluator<'_>,
    inputs: &mut crate::table::InputResolutionCache,
) -> Evaluated {
    let raw = match inputs.input(data, record, column) {
        Ok(value) => value.to_owned(),
        Err(error) => {
            return Evaluated {
                raw: String::new(),
                value: String::new(),
                error: Some(crate::AppError::from(error).into_diagnostic()),
            }
        }
    };
    if column.data_type == ValueType::None {
        return Evaluated {
            raw,
            value: String::new(),
            error: None,
        };
    }
    let value = raw.clone();
    if !value.starts_with('=') {
        return Evaluated {
            raw,
            value,
            error: None,
        };
    }
    match evaluator(data, column, record, &value) {
        FormulaResult::Value(value) => Evaluated {
            raw,
            value,
            error: None,
        },
        FormulaResult::Error(error) => Evaluated {
            raw,
            value: String::new(),
            error: Some(error.diagnostic()),
        },
    }
}

fn unique_key(column: &ColumnSchema, value: &str) -> String {
    if numeric_type(&column.data_type) {
        if let Ok(normalized) = column.validate_value(&value.to_string()) {
            if let Some(decimal) = Decimal::parse(&normalized) {
                return decimal.key();
            }
        }
    }
    value.to_string()
}

pub fn table_issues(data: &TableData) -> Vec<ValidationIssue> {
    table_issues_with_evaluator(data, &mut standalone_evaluator())
}

pub(crate) fn table_issues_with_evaluator(
    data: &TableData,
    evaluator: &mut FormulaEvaluator<'_>,
) -> Vec<ValidationIssue> {
    table_issues_with_evaluator_cancellable(data, evaluator, None)
        .expect("evaluation without a cancellation token cannot be cancelled")
}

fn check_cancellation(cancellation: Option<&AtomicBool>) -> std::result::Result<(), FormulaError> {
    if cancellation.is_some_and(|token| token.load(Ordering::Relaxed)) {
        Err(FormulaError::Cancelled)
    } else {
        Ok(())
    }
}

fn table_issues_with_evaluator_cancellable(
    data: &TableData,
    evaluator: &mut FormulaEvaluator<'_>,
    cancellation: Option<&AtomicBool>,
) -> std::result::Result<Vec<ValidationIssue>, FormulaError> {
    table_issues_for_version(data, evaluator, cancellation, None)
}

pub(crate) fn table_issues_for_version(
    data: &TableData,
    evaluator: &mut FormulaEvaluator<'_>,
    cancellation: Option<&AtomicBool>,
    version: Option<u32>,
) -> std::result::Result<Vec<ValidationIssue>, FormulaError> {
    check_cancellation(cancellation)?;
    let records: Vec<_> = data
        .records
        .iter()
        .filter(|record| version.is_none_or(|v| record.min_version <= v))
        .collect();
    let mut inputs = crate::table::InputResolutionCache::default();
    let mut issues = Vec::new();
    for column in &data.schema.columns {
        check_cancellation(cancellation)?;
        let Some(settings) = &column.input_validation else {
            continue;
        };
        if !settings.enabled || settings.rules.is_empty() {
            continue;
        }
        let mut input_column = column.clone();
        input_column.conditional_formatting = None;
        input_column.conditional_formatting_override = None;
        let definition = validate_column_definition(&input_column);
        if let Err(error) = definition {
            issues.push(ValidationIssue {
                table_uuid: data.uuid.clone(),
                column_uuid: column.uuid.clone(),
                column_name: column.display_name.clone(),
                record_uuid: None,
                kind: "definition".into(),
                diagnostic: crate::AppError::from(error).into_diagnostic(),
                mode: ValidationMode::Reject,
                raw_value: String::new(),
                effective_value: String::new(),
                rule_key: fingerprint(settings),
                peers: Vec::new(),
                peer_count: 0,
            });
            continue;
        }
        let values: Vec<_> = records
            .iter()
            .map(|r| {
                check_cancellation(cancellation)?;
                let value = evaluate(data, column, r, evaluator, &mut inputs);
                check_cancellation(cancellation)?;
                Ok(value)
            })
            .collect::<std::result::Result<_, FormulaError>>()?;
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        if settings
            .rules
            .iter()
            .any(|r| matches!(r, InputRule::Unique))
        {
            for (record, value) in records.iter().zip(&values) {
                check_cancellation(cancellation)?;
                if value.error.is_none() && !value.value.trim().is_empty() {
                    groups
                        .entry(unique_key(column, &value.value))
                        .or_default()
                        .push(record.uuid.clone());
                }
            }
            for group in groups.values_mut() {
                check_cancellation(cancellation)?;
                group.sort();
            }
        }
        let patterns: Vec<_> = settings
            .rules
            .iter()
            .map(|rule| match rule {
                InputRule::Pattern { pattern } => regex::Regex::new(pattern).ok(),
                _ => None,
            })
            .collect();
        // A rule's identity is constant for this whole column evaluation.
        // Hash it once, rather than once per row (including valid cells).
        let rule_keys: Vec<_> = settings.rules.iter().map(fingerprint).collect();
        for (record, value) in records.iter().zip(&values) {
            check_cancellation(cancellation)?;
            let mut add = |kind: &str, message: String, rule_key: String, peers: Vec<String>| {
                let mut params: BTreeMap<String, serde_json::Value> = BTreeMap::new();
                let code = if settings.message.is_empty() {
                    let suffix = match kind {
                        "required" => Some("required"),
                        "unique" => Some("unique"),
                        "pattern" => Some("pattern"),
                        "select_choices" => Some("selectChoices"),
                        "value_type" => Some("valueType"),
                        "formula" => {
                            params.insert("error".into(), serde_json::json!(value.error));
                            Some("formula")
                        }
                        "number_range" => {
                            if let Some(InputRule::NumberRange { min, max }) = settings
                                .rules
                                .iter()
                                .find(|rule| fingerprint(*rule) == rule_key)
                            {
                                params.insert(
                                    "min".into(),
                                    serde_json::json!(min.clone().unwrap_or_else(|| "−∞".into())),
                                );
                                params.insert(
                                    "max".into(),
                                    serde_json::json!(max.clone().unwrap_or_else(|| "+∞".into())),
                                );
                            }
                            Some("numberRange")
                        }
                        _ => None,
                    };
                    suffix.map(|suffix| format!("error.validation.{suffix}"))
                } else {
                    None
                };
                issues.push(ValidationIssue {
                    table_uuid: data.uuid.clone(),
                    column_uuid: column.uuid.clone(),
                    column_name: column.display_name.clone(),
                    record_uuid: Some(record.uuid.clone()),
                    kind: kind.into(),
                    diagnostic: match code {
                        Some(code) => crate::types::Diagnostic::Code {
                            code,
                            params: serde_json::json!(params),
                        },
                        None => crate::types::Diagnostic::Text {
                            text: if settings.message.is_empty() {
                                message
                            } else {
                                settings.message.clone()
                            },
                        },
                    },
                    mode: settings.mode.clone(),
                    raw_value: value.raw.clone(),
                    effective_value: value
                        .error
                        .as_ref()
                        .map(|_| "#ERROR".to_owned())
                        .unwrap_or_else(|| value.value.clone()),
                    rule_key,
                    peers,
                    peer_count: if kind == "unique" {
                        groups
                            .get(&unique_key(column, &value.value))
                            .map_or(0, |group| group.len().saturating_sub(1))
                    } else {
                        0
                    },
                });
            };
            if let Some(error) = &value.error {
                add(
                    "formula",
                    format!("Could not evaluate the formula: {error}"),
                    "formula".into(),
                    Vec::new(),
                );
                continue;
            }
            if numeric_type(&column.data_type)
                && !value.value.trim().is_empty()
                && (column.validate_value(&value.value).is_err()
                    || !value.value.parse::<f64>().is_ok_and(f64::is_finite))
            {
                add(
                    "value_type",
                    "Enter a finite number that matches the column type".into(),
                    "value_type".into(),
                    Vec::new(),
                );
                continue;
            }
            for (index, rule) in settings.rules.iter().enumerate() {
                let key = rule_keys[index].clone();
                match rule {
                    InputRule::Required if value.value.trim().is_empty() => {
                        add("required", "Enter a value".into(), key, Vec::new())
                    }
                    InputRule::Unique if !value.value.trim().is_empty() => {
                        let peers: Vec<_> = groups
                            .get(&unique_key(column, &value.value))
                            .into_iter()
                            .flatten()
                            .filter(|id| *id != &record.uuid)
                            .take(8)
                            .cloned()
                            .collect();
                        if !peers.is_empty() {
                            add(
                                "unique",
                                "Another row has the same value".into(),
                                key,
                                peers,
                            );
                        }
                    }
                    InputRule::NumberRange { min, max } if !value.value.trim().is_empty() => {
                        let number = Decimal::parse(&value.value);
                        let outside = number.as_ref().is_none_or(|value| {
                            min.as_deref()
                                .and_then(Decimal::parse)
                                .is_some_and(|min| value < &min)
                                || max
                                    .as_deref()
                                    .and_then(Decimal::parse)
                                    .is_some_and(|max| value > &max)
                        });
                        if outside {
                            add(
                                "number_range",
                                format!(
                                    "The value must be between {} and {} (inclusive)",
                                    min.as_deref().unwrap_or("No minimum"),
                                    max.as_deref().unwrap_or("No maximum")
                                ),
                                key,
                                Vec::new(),
                            );
                        }
                    }
                    InputRule::Pattern { .. } if !value.value.is_empty() => {
                        if patterns[index]
                            .as_ref()
                            .is_some_and(|pattern| !pattern.is_match(&value.value))
                        {
                            add(
                                "pattern",
                                "The value does not match the regular expression".into(),
                                key,
                                Vec::new(),
                            );
                        }
                    }
                    InputRule::SelectChoices
                        if !value.value.is_empty()
                            && !column
                                .select_config
                                .as_ref()
                                .unwrap()
                                .options
                                .iter()
                                .any(|option| option.value == value.value) =>
                    {
                        add(
                            "select_choices",
                            "This value is not one of the available choices.".into(),
                            key,
                            Vec::new(),
                        );
                    }
                    _ => {}
                }
            }
        }
    }
    issues.sort_by(|a, b| {
        (&a.column_uuid, &a.record_uuid, &a.kind).cmp(&(&b.column_uuid, &b.record_uuid, &b.kind))
    });
    check_cancellation(cancellation)?;
    Ok(issues)
}

pub fn transition_report(
    project_uuid: &str,
    before: &TableData,
    after: &TableData,
) -> Result<ValidationReport> {
    transition_report_with_evaluator(project_uuid, before, after, &mut standalone_evaluator())
}

pub(crate) fn transition_report_with_evaluator(
    project_uuid: &str,
    before: &TableData,
    after: &TableData,
    evaluator: &mut FormulaEvaluator<'_>,
) -> Result<ValidationReport> {
    after.validate_parent_graph()?;
    for column in &after.schema.columns {
        validate_column_definition(column)?;
    }
    // table_issues skips absent and empty input rules. Keep definition validation
    // above, but avoid a full baseline clone when no transition can add an issue.
    if after.schema.columns.iter().all(|column| {
        column
            .input_validation
            .as_ref()
            .is_none_or(|settings| settings.rules.is_empty())
    }) {
        return Ok(ValidationReport {
            issues: Vec::new(),
            acknowledgement: None,
        });
    }
    compare_input_rule_transition(project_uuid, before, after, evaluator)
}

fn compare_input_rule_transition(
    project_uuid: &str,
    before: &TableData,
    after: &TableData,
    evaluator: &mut FormulaEvaluator<'_>,
) -> Result<ValidationReport> {
    let mut baseline = before.clone();
    // New rules may be introduced over old data; changes to values/defaults/types
    // still compare against the old data and therefore cannot create new errors.
    for column in &after.schema.columns {
        if let Some(old) = baseline
            .schema
            .columns
            .iter_mut()
            .find(|old| old.uuid == column.uuid)
        {
            old.input_validation = column.input_validation.clone();
            // A newly introduced Select-choices rule needs the proposed choices,
            // but changing choices on an existing rule remains a data transition.
            let had_choices = before
                .schema
                .columns
                .iter()
                .find(|c| c.uuid == column.uuid)
                .and_then(|c| c.input_validation.as_ref())
                .is_some_and(|s| {
                    s.enabled
                        && s.rules
                            .iter()
                            .any(|r| matches!(r, InputRule::SelectChoices))
                });
            if !had_choices {
                old.select_config = column.select_config.clone();
            }
        } else {
            baseline.schema.columns.push(column.clone());
        }
    }
    let old_issues = table_issues_with_evaluator(&baseline, evaluator);
    let old_keys: BTreeSet<_> = old_issues
        .iter()
        .map(|issue| {
            (
                &issue.column_uuid,
                &issue.record_uuid,
                &issue.rule_key,
                &issue.kind,
                &issue.raw_value,
                &issue.effective_value,
            )
        })
        .collect();
    // Store each duplicate group once, rather than cloning N peer IDs for every
    // one of N rows. A newly added peer outside the displayed sample still fails.
    let previous_groups = unique_groups(&baseline, evaluator);
    let candidate_groups = unique_groups(after, evaluator);
    let continuing_groups: BTreeSet<_> = candidate_groups
        .iter()
        .filter_map(|(key, members)| {
            previous_groups
                .get(key)
                .filter(|old| members.is_subset(old))
                .map(|_| key.clone())
        })
        .collect();
    let issues: Vec<_> = table_issues_with_evaluator(after, evaluator)
        .into_iter()
        .filter(|issue| {
            let same = old_keys.contains(&(
                &issue.column_uuid,
                &issue.record_uuid,
                &issue.rule_key,
                &issue.kind,
                &issue.raw_value,
                &issue.effective_value,
            ));
            let peers_unchanged = issue.kind != "unique"
                || after
                    .schema
                    .columns
                    .iter()
                    .find(|column| column.uuid == issue.column_uuid)
                    .is_some_and(|column| {
                        continuing_groups.contains(&(
                            column.uuid.clone(),
                            unique_key(column, &issue.effective_value),
                        ))
                    });
            !same || !peers_unchanged
        })
        .collect();
    // Synchronization timestamps are generated bookkeeping, not user data.
    // Bind the complete before state and all proposed values/schema/version IDs,
    // while making a retry independent of the wall clock used for that timestamp.
    let acknowledgement =
        (!issues.is_empty() && issues.iter().all(|i| i.mode == ValidationMode::Warn)).then(|| {
            let mut acknowledged_after = after.clone();
            for (id, implementation) in &mut acknowledged_after.interface_implementations {
                implementation.last_sync_date = before
                    .interface_implementations
                    .get(id)
                    .map(|old| old.last_sync_date)
                    .unwrap_or(chrono::DateTime::<chrono::Utc>::UNIX_EPOCH);
            }
            hash_json(&(
                project_uuid,
                CanonicalTable(before),
                CanonicalTable(&acknowledged_after),
                CanonicalValue(&issues),
            ))
        });
    Ok(ValidationReport {
        issues,
        acknowledgement,
    })
}

fn unique_groups(
    data: &TableData,
    evaluator: &mut FormulaEvaluator<'_>,
) -> BTreeMap<(String, String), BTreeSet<String>> {
    let mut inputs = crate::table::InputResolutionCache::default();
    let mut groups: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for column in &data.schema.columns {
        if !column.input_validation.as_ref().is_some_and(|settings| {
            settings.enabled
                && settings
                    .rules
                    .iter()
                    .any(|rule| matches!(rule, InputRule::Unique))
        }) {
            continue;
        }
        for record in &data.records {
            let value = evaluate(data, column, record, evaluator, &mut inputs);
            if value.error.is_none() && !value.value.trim().is_empty() {
                groups
                    .entry((column.uuid.clone(), unique_key(column, &value.value)))
                    .or_default()
                    .insert(record.uuid.clone());
            }
        }
    }
    groups
}

/// Defense in depth for the ordinary "add row" exception. No existing row,
/// order, schema, metadata, or supplied nonempty value may change with it.
/// New rows remain normal persisted rows; presentation still reports every issue.
pub(crate) fn is_default_record_creation(before: &TableData, after: &TableData) -> bool {
    let old_ids: BTreeSet<_> = before.records.iter().map(|record| &record.uuid).collect();
    let mut seen = BTreeSet::new();
    let mut restored = after.clone();
    let mut added = false;
    for record in &after.records {
        if !seen.insert(&record.uuid) {
            return false;
        }
        if old_ids.contains(&record.uuid) {
            continue;
        }
        added = true;
        if uuid::Uuid::parse_str(&record.uuid).is_err()
            || !record.parent_uuid.is_empty()
            || !record.label.is_empty()
            || record.min_version != 0
            || !record.tags.is_empty()
            || !record.memo_texts.is_empty()
            || record.values.values().any(|value| !value.is_empty())
            || record
                .interface_values
                .values()
                .any(|value| !value.is_empty())
        {
            return false;
        }
    }
    restored
        .records
        .retain(|record| old_ids.contains(&record.uuid));
    added && revision(&restored) == revision(before)
}

pub fn validate_transition(
    project_uuid: &str,
    before: &TableData,
    after: &TableData,
    acknowledgement: Option<&str>,
) -> Result<()> {
    validate_transition_with_evaluator(
        project_uuid,
        before,
        after,
        acknowledgement,
        &mut standalone_evaluator(),
    )
}

pub(crate) fn validate_transition_with_evaluator(
    project_uuid: &str,
    before: &TableData,
    after: &TableData,
    acknowledgement: Option<&str>,
    evaluator: &mut FormulaEvaluator<'_>,
) -> Result<()> {
    let report = transition_report_with_evaluator(project_uuid, before, after, evaluator)?;
    if report.issues.is_empty() {
        if acknowledgement.is_some() {
            return Err(invalid(
                "The contents changed after the warning was confirmed. Enter the value again",
            ));
        }
        return Ok(());
    }
    if report
        .acknowledgement
        .as_deref()
        .is_some_and(|expected| Some(expected) == acknowledgement)
    {
        return Ok(());
    }
    Err(DevcelError::InputValidation(report))
}

fn effective_formatting(column: &ColumnSchema) -> ConditionalFormatting {
    column
        .conditional_formatting_override
        .as_ref()
        .or(column.conditional_formatting.as_ref())
        .cloned()
        .unwrap_or_default()
}

fn merge_style(current: &mut CellStyle, next: &CellStyle) {
    if current.background_color.is_none() {
        current.background_color = next.background_color.clone();
    }
    if current.text_color.is_none() {
        current.text_color = next.text_color.clone();
    }
    if current.bold.is_none() {
        current.bold = next.bold;
    }
}

fn blend_color(low: &str, high: &str, ratio: f64) -> String {
    let mut result = String::from("#");
    for i in [1, 3, 5] {
        let a = u8::from_str_radix(&low[i..i + 2], 16).unwrap_or(0);
        let b = u8::from_str_radix(&high[i..i + 2], 16).unwrap_or(0);
        let channel =
            (f64::from(a) + (f64::from(b) - f64::from(a)) * ratio.clamp(0.0, 1.0)).round() as u8;
        result.push_str(&format!("{channel:02x}"));
    }
    result
}

fn scale_ratio(value: &str, min: &str, max: &str) -> f64 {
    let (value, min, max) = (value.trim(), min.trim(), max.trim());
    if let (Ok(v), Ok(a), Ok(b)) = (
        value.parse::<i128>(),
        min.parse::<i128>(),
        max.parse::<i128>(),
    ) {
        if a == b {
            return 0.5;
        }
        // All supported integers are at most 64 bits; subtract before conversion.
        if let (Some(top), Some(bottom)) = (v.checked_sub(a), b.checked_sub(a)) {
            return (top as f64 / bottom as f64).clamp(0.0, 1.0);
        }
    }
    let (Ok(v), Ok(a), Ok(b)) = (value.parse::<f64>(), min.parse::<f64>(), max.parse::<f64>())
    else {
        return 0.5;
    };
    if a == b {
        return 0.5;
    }
    let scale = a.abs().max(b.abs());
    if scale == 0.0 || !scale.is_finite() {
        return 0.5;
    }
    let result = (v / scale - a / scale) / (b / scale - a / scale);
    if result.is_finite() {
        result.clamp(0.0, 1.0)
    } else {
        0.5
    }
}

fn equal(column: &ColumnSchema, value: &str, expected: &str) -> bool {
    if numeric_type(&column.data_type) && !value.is_empty() && !expected.is_empty() {
        matches!((Decimal::parse(value), Decimal::parse(expected)), (Some(a), Some(b)) if a == b)
    } else {
        value == expected
    }
}

fn formatted_styles(
    data: &TableData,
    column: &ColumnSchema,
    values: &[Evaluated],
    formatting: &ConditionalFormatting,
    cancellation: Option<&AtomicBool>,
) -> std::result::Result<Vec<(CellStyle, Option<RangeBar>)>, FormulaError> {
    check_cancellation(cancellation)?;
    let mut styles = vec![(CellStyle::default(), None); values.len()];
    // Most columns have no formatting. They need no Decimal parsing/ranking.
    if !formatting.rules.iter().any(|rule| rule.enabled) {
        return Ok(styles);
    }
    let mut stopped = vec![false; values.len()];
    let mut ranking = Vec::new();
    for (i, value) in values.iter().enumerate() {
        check_cancellation(cancellation)?;
        if value.error.is_none() && value.value.parse::<f64>().is_ok_and(f64::is_finite) {
            if let Some(number) = Decimal::parse(&value.value) {
                ranking.push((number, data.records[i].uuid.clone(), i));
            }
        }
    }
    ranking.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    for rule in formatting.rules.iter().filter(|rule| rule.enabled) {
        check_cancellation(cancellation)?;
        let mut ranked = BTreeSet::new();
        if let FormatCondition::Top {
            count,
            include_ties,
        }
        | FormatCondition::Bottom {
            count,
            include_ties,
        } = &rule.condition
        {
            let mut ordered: Vec<_> = ranking.iter().collect();
            if matches!(rule.condition, FormatCondition::Top { .. }) {
                ordered.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            }
            let count = (*count as usize).min(ordered.len());
            if count > 0 {
                let boundary = &ordered[count - 1].0;
                for (position, entry) in ordered.iter().enumerate() {
                    check_cancellation(cancellation)?;
                    if position < count || (*include_ties && &entry.0 == boundary) {
                        ranked.insert(entry.2);
                    }
                }
            }
        }
        for (i, value) in values.iter().enumerate() {
            check_cancellation(cancellation)?;
            if stopped[i] || value.error.is_some() {
                continue;
            }
            let decimal = Decimal::parse(&value.value);
            let mut style = rule.style.clone();
            let mut range_bar = None;
            let matched = match &rule.condition {
                FormatCondition::All => true,
                FormatCondition::Empty => value.value.is_empty(),
                FormatCondition::NotEmpty => !value.value.is_empty(),
                FormatCondition::Equals { value: expected } => {
                    equal(column, &value.value, expected)
                }
                FormatCondition::NotEquals { value: expected } => {
                    !equal(column, &value.value, expected)
                }
                FormatCondition::Contains { value: needle } => value.value.contains(needle),
                FormatCondition::NotContains { value: needle } => !value.value.contains(needle),
                FormatCondition::GreaterThan { value: expected } => {
                    matches!((&decimal, Decimal::parse(expected)), (Some(a), Some(b)) if a > &b)
                }
                FormatCondition::GreaterThanOrEqual { value: expected } => {
                    matches!((&decimal, Decimal::parse(expected)), (Some(a), Some(b)) if a >= &b)
                }
                FormatCondition::LessThan { value: expected } => {
                    matches!((&decimal, Decimal::parse(expected)), (Some(a), Some(b)) if a < &b)
                }
                FormatCondition::LessThanOrEqual { value: expected } => {
                    matches!((&decimal, Decimal::parse(expected)), (Some(a), Some(b)) if a <= &b)
                }
                FormatCondition::Between {
                    min,
                    max,
                    low_color,
                    high_color,
                    out_of_range_color,
                } => {
                    if let (Some(v), Some(a), Some(b)) =
                        (&decimal, Decimal::parse(min), Decimal::parse(max))
                    {
                        if value.value.parse::<f64>().is_ok_and(f64::is_finite) {
                            let outside = v < &a || v > &b;
                            // A degenerate range has exactly one valid value: a full bar.
                            let ratio = if a == b {
                                1.0
                            } else {
                                scale_ratio(&value.value, min, max)
                            };
                            range_bar = Some(RangeBar {
                                fraction: if outside {
                                    10000
                                } else {
                                    (ratio * 10000.0).round() as u32
                                },
                                color: if outside {
                                    out_of_range_color.clone()
                                } else {
                                    blend_color(low_color, high_color, ratio)
                                },
                                out_of_range: outside,
                            });
                            style.background_color = None;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                }
                FormatCondition::Top { .. } | FormatCondition::Bottom { .. } => ranked.contains(&i),
                FormatCondition::ColorScale {
                    low_color,
                    high_color,
                } => {
                    if decimal.is_some() && value.value.parse::<f64>().is_ok_and(f64::is_finite) {
                        if let (Some(min), Some(max)) = (ranking.first(), ranking.last()) {
                            style.background_color = Some(blend_color(
                                low_color,
                                high_color,
                                scale_ratio(
                                    &value.value,
                                    &values[min.2].value,
                                    &values[max.2].value,
                                ),
                            ));
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                }
            };
            if matched {
                // The first matching background treatment owns the visual surface.
                if styles[i].0.background_color.is_none() && styles[i].1.is_none() {
                    styles[i].1 = range_bar;
                }
                if styles[i].1.is_some() {
                    style.background_color = None;
                }
                merge_style(&mut styles[i].0, &style);
                stopped[i] = rule.stop_if_true;
            }
        }
    }
    check_cancellation(cancellation)?;
    Ok(styles)
}

pub fn presentation(data: &TableData) -> TablePresentation {
    presentation_with_evaluator(data, &mut standalone_evaluator())
}

pub(crate) fn presentation_with_evaluator(
    data: &TableData,
    evaluator: &mut FormulaEvaluator<'_>,
) -> TablePresentation {
    presentation_with_evaluator_cancellable(data, evaluator, None)
        .expect("evaluation without a cancellation token cannot be cancelled")
}

pub(crate) fn presentation_with_evaluator_cancellable(
    data: &TableData,
    evaluator: &mut FormulaEvaluator<'_>,
    cancellation: Option<&AtomicBool>,
) -> std::result::Result<TablePresentation, FormulaError> {
    check_cancellation(cancellation)?;
    let mut inputs = crate::table::InputResolutionCache::default();
    let issues = table_issues_with_evaluator_cancellable(data, evaluator, cancellation)?;
    let mut result = TablePresentation {
        table_uuid: data.uuid.clone(),
        revision: revision(data),
        issue_count: issues.len(),
        ..TablePresentation::default()
    };
    let mut by_cell: BTreeMap<(&str, &str), Vec<ValidationIssue>> = BTreeMap::new();
    for issue in &issues {
        check_cancellation(cancellation)?;
        if let Some(record) = &issue.record_uuid {
            by_cell
                .entry((record, &issue.column_uuid))
                .or_default()
                .push(issue.clone());
        } else {
            result.definition_issues.push(issue.diagnostic.clone());
        }
    }
    for column in &data.schema.columns {
        check_cancellation(cancellation)?;
        let has_rules = column.input_validation.is_some()
            || column.conditional_formatting.is_some()
            || column.conditional_formatting_override.is_some();
        let values: Vec<_> = data
            .records
            .iter()
            .map(|r| {
                check_cancellation(cancellation)?;
                let value = evaluate(data, column, r, evaluator, &mut inputs);
                check_cancellation(cancellation)?;
                Ok(value)
            })
            .collect::<std::result::Result<_, FormulaError>>()?;
        let mut formatting = effective_formatting(column);
        let mut check = column.clone();
        check.input_validation = None;
        if let Err(error) = validate_column_definition(&check) {
            result
                .definition_issues
                .push(crate::types::Diagnostic::Code {
                    code: "grid.errorWithCause".into(),
                    params: serde_json::json!({ "summary": column.display_name, "error": crate::AppError::from(error) }),
                });
            formatting.rules.clear();
        }
        let styles = formatted_styles(data, column, &values, &formatting, cancellation)?;
        for (index, (record, value)) in data.records.iter().zip(&values).enumerate() {
            check_cancellation(cancellation)?;
            let formula = value.raw.starts_with('=')
                || (value.raw.is_empty() && column.default_value.starts_with('='));
            if !has_rules && !formula {
                continue;
            }
            result.cells.entry(record.uuid.clone()).or_default().insert(
                column.uuid.clone(),
                CellPresentation {
                    raw_value: value.raw.clone(),
                    display_value: value
                        .error
                        .as_ref()
                        .map(|_| "#ERROR".to_owned())
                        .unwrap_or_else(|| value.value.clone()),
                    style: styles[index].0.clone(),
                    range_bar: styles[index].1.clone(),
                    issues: by_cell
                        .get(&(record.uuid.as_str(), column.uuid.as_str()))
                        .cloned()
                        .unwrap_or_default(),
                    formula_error: value.error.clone(),
                    hint: column
                        .input_validation
                        .as_ref()
                        .map(|s| s.hint.clone())
                        .unwrap_or_default(),
                },
            );
        }
    }
    result
        .definition_issues
        .sort_by_cached_key(|issue| serde_json::to_string(issue).unwrap_or_default());
    result.definition_issues.dedup();
    check_cancellation(cancellation)?;
    Ok(result)
}

pub fn ranking_population_count(data: &TableData, column: &ColumnSchema) -> usize {
    ranking_population_count_with_evaluator(data, column, &mut standalone_evaluator())
}

pub(crate) fn ranking_population_count_with_evaluator(
    data: &TableData,
    column: &ColumnSchema,
    evaluator: &mut FormulaEvaluator<'_>,
) -> usize {
    if !numeric_type(&column.data_type) {
        return 0;
    }
    let mut inputs = crate::table::InputResolutionCache::default();
    data.records
        .iter()
        .filter(|record| {
            let value = evaluate(data, column, record, evaluator, &mut inputs);
            value.error.is_none()
                && value.value.parse::<f64>().is_ok_and(f64::is_finite)
                && Decimal::parse(&value.value).is_some()
        })
        .count()
}

#[cfg(test)]
pub(crate) mod canonical_revision_tests {
    use super::*;
    use crate::{
        column::{ColumnConstraints, ColumnStyle},
        interface::InterfaceImplementation,
        table::{TableMetadata, TableSchema},
    };
    use std::collections::HashMap;
    use uuid::Uuid;

    fn reference_bytes<T: Serialize>(value: &T) -> Vec<u8> {
        serde_json::to_vec(&serde_json::to_value(value).unwrap()).unwrap()
    }

    fn reference_fingerprint<T: Serialize>(value: &T) -> String {
        format!("{:x}", Sha256::digest(reference_bytes(value)))
    }

    pub(crate) fn full_table() -> TableData {
        let id = Uuid::from_u128(1);
        let column_id = Uuid::from_u128(2).to_string();
        let style = CellStyle {
            background_color: Some("#012345".into()),
            text_color: Some("#fedcba".into()),
            bold: Some(false),
        };
        let conditions = vec![
            FormatCondition::All,
            FormatCondition::Empty,
            FormatCondition::NotEmpty,
            FormatCondition::Equals { value: "x".into() },
            FormatCondition::NotEquals { value: "x".into() },
            FormatCondition::GreaterThan { value: "1".into() },
            FormatCondition::GreaterThanOrEqual { value: "1".into() },
            FormatCondition::LessThan { value: "2".into() },
            FormatCondition::LessThanOrEqual { value: "2".into() },
            FormatCondition::Contains {
                value: "日".into()
            },
            FormatCondition::NotContains {
                value: "日".into()
            },
            FormatCondition::Between {
                low_color: range_low_color(),
                high_color: range_high_color(),
                out_of_range_color: range_out_color(),
                min: "1".into(),
                max: "2".into(),
            },
            FormatCondition::Top {
                count: u32::MAX,
                include_ties: false,
            },
            FormatCondition::Bottom {
                count: 0,
                include_ties: true,
            },
            FormatCondition::ColorScale {
                low_color: "#000000".into(),
                high_color: "#ffffff".into(),
            },
        ];
        let column = ColumnSchema {
            read_only: false,
            min_version: 0,
            uuid: column_id.clone(),
            display_name: "日本語 \"\\\n\t\r\0 🦀".into(),
            data_name: "value".into(),
            tooltip: "tooltip\u{2028}\u{2029}".into(),
            data_type: ValueType::F64,
            tags: vec!["z".into(), "a".into()],
            default_value: "3.5".into(),
            style: ColumnStyle {
                color: "#123456".into(),
                font_size: u32::MAX,
                width: 0,
            },
            memo_text: "memo".into(),
            reference_config: Some(crate::ReferenceConfig {
                target_table_uuid: id.to_string(),
                display_column_uuid: Some(column_id.clone()),
            }),
            table_ref_config: Some(crate::TableRefConfig {
                interface_uuid: id.to_string(),
            }),
            curve_config: Some(crate::CurveConfig {
                start_value: -0.0,
                end_value: f64::MAX,
            }),
            select_config: Some(crate::SelectConfig {
                options: vec![crate::SelectOption {
                    value: "first".into(),
                    label: "選択".into(),
                }],
            }),
            interface_origin: None,
            interface_origin_name_fallback: Some("origin".into()),
            color_swatches: Vec::new(),
            required: Some(false),
            constraints: Some(ColumnConstraints {
                unique: Some(true),
                min_value: Some(f64::MIN),
                max_value: Some(f64::MAX),
                pattern: Some("^.*$".into()),
            }),
            input_validation: Some(InputValidationSettings {
                enabled: true,
                mode: ValidationMode::Warn,
                message: "message".into(),
                hint: "hint".into(),
                rules: vec![
                    InputRule::Required,
                    InputRule::Unique,
                    InputRule::NumberRange {
                        min: None,
                        max: Some("18446744073709551615".into()),
                    },
                    InputRule::Pattern {
                        pattern: "a.*".into(),
                    },
                    InputRule::SelectChoices,
                ],
            }),
            conditional_formatting: Some(ConditionalFormatting {
                rules: conditions
                    .into_iter()
                    .enumerate()
                    .map(|(index, condition)| FormattingRule {
                        id: format!("rule-{index}"),
                        enabled: index % 2 == 0,
                        condition,
                        style: style.clone(),
                        stop_if_true: index % 3 == 0,
                    })
                    .collect(),
            }),
            conditional_formatting_override: Some(ConditionalFormatting::default()),
        };
        let mut inherited = column.clone();
        inherited.uuid = Uuid::from_u128(3).to_string();
        inherited.data_name = "inherited".into();
        inherited.interface_origin = Some(id.to_string());
        let record = Record {
            uuid: Uuid::from_u128(4).to_string(),
            parent_uuid: String::new(),
            label: "record\0\n日本語".into(),
            min_version: u32::MAX,
            tags: vec!["z".into(), "a".into()],
            values: HashMap::from([("value".into(), "9007199254740993".into())]),
            interface_values: HashMap::from([(inherited.uuid.clone(), "=1+2".into())]),

            memo_texts: ["z", "a", "日", "🦀", "\0", "\n", "\"\\"]
                .into_iter()
                .map(|key| (key.to_owned(), format!("{key} value")))
                .collect(),
        };
        let mut second = record.clone();
        second.uuid = Uuid::from_u128(5).to_string();
        second.min_version = 0;
        second.values.insert("value".into(), String::new());
        TableData {
            description: "description\r\n".into(),
            uuid: Uuid::from_u128(6).to_string(),
            display_name: "table".into(),
            metadata: TableMetadata {
                interface_order: vec![
                    Uuid::from_u128(12),
                    Uuid::from_u128(10),
                    Uuid::from_u128(11),
                ],
                initial_transposed: false,
                edit_permissions: Default::default(),
                parent_uuid: "parent".into(),
                data_name: "table_name".into(),
            },
            interface_implementations: (0..3)
                .map(|index| {
                    let key = Uuid::from_u128(index as u128 + 10);
                    (
                        key,
                        InterfaceImplementation {
                            interface_uuid: key,
                            synced_version_id: id,
                            last_sync_date: chrono::DateTime::UNIX_EPOCH,
                            effective_fingerprint: (index != 0).then(|| "fingerprint".into()),
                            required_column_uuids: None,
                        },
                    )
                })
                .collect(),

            schema: TableSchema {
                columns: vec![column, inherited],
            },
            records: vec![record, second],
        }
    }

    fn assert_equivalent(data: &TableData) {
        assert_eq!(
            serde_json::to_vec(&CanonicalTable(data)).unwrap(),
            reference_bytes(data)
        );
        assert_eq!(revision(data), reference_fingerprint(data));
    }

    #[test]
    fn streamed_revision_matches_all_fields_and_optional_omissions() {
        let mut data = full_table();
        assert_equivalent(&data);
        data.schema.columns = vec![ColumnSchema {
            data_name: "value".into(),
            ..Default::default()
        }];
        data.interface_implementations.clear();
        data.metadata.interface_order.clear();
        data.records.clear();
        assert_equivalent(&data);
        data.schema.columns.clear();
        data.description.clear();
        assert_equivalent(&data);
    }

    #[test]
    fn streamed_revision_preserves_map_order_independence_and_array_order() {
        let original = full_table();
        let expected = revision(&original);
        for shift in 0..7 {
            let mut data = original.clone();
            for record in &mut data.records {
                for map in [
                    &mut record.values,
                    &mut record.interface_values,
                    &mut record.memo_texts,
                ] {
                    let mut entries: Vec<_> = map.drain().collect();
                    entries.sort();
                    let len = entries.len();
                    if len != 0 {
                        entries.rotate_left(shift % len);
                    }
                    map.extend(entries);
                }
            }
            let mut entries: Vec<_> = data.interface_implementations.drain().collect();
            entries.sort_by_key(|entry| entry.0);
            let len = entries.len();
            entries.rotate_left(shift % len);
            data.interface_implementations.extend(entries);
            assert_equivalent(&data);
            assert_eq!(revision(&data), expected);
        }
        let mut changed = original.clone();
        changed.records.reverse();
        assert_equivalent(&changed);
        assert_ne!(revision(&changed), expected);
        changed = original.clone();
        changed.schema.columns.reverse();
        assert_equivalent(&changed);
        assert_ne!(revision(&changed), expected);
        changed = original;
        changed.metadata.interface_order.reverse();
        assert_equivalent(&changed);
        assert_ne!(revision(&changed), expected);
    }

    #[test]
    fn streamed_revision_preserves_float_boundaries_and_nonfinite_values() {
        let mut data = full_table();
        for value in [
            0.0,
            -0.0,
            0.1,
            f64::MIN_POSITIVE,
            f64::from_bits(1),
            f64::MIN,
            f64::MAX,
            9007199254740992.0,
            1e-100,
            1e100,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NAN,
        ] {
            data.schema.columns[0].curve_config = Some(crate::CurveConfig {
                start_value: value,
                end_value: -value,
            });
            data.schema.columns[1]
                .constraints
                .as_mut()
                .unwrap()
                .min_value = Some(value);
            assert_equivalent(&data);
        }
    }

    #[test]
    fn streamed_fingerprint_preserves_arbitrary_json_and_f32_normalization() {
        let params = serde_json::json!({"z": [null, false, true, 0, -1, u64::MAX, i64::MIN, 0.1],
            "a": {"日": "\0\n\t\r\"\\🦀", "nested": [{"z": 1, "a": {}}]}});
        let diagnostic = crate::types::Diagnostic::Code {
            code: "test".into(),
            params,
        };
        assert_eq!(fingerprint(&diagnostic), reference_fingerprint(&diagnostic));
        for value in [
            0.1_f32,
            -0.0,
            f32::MAX,
            f32::MIN_POSITIVE,
            f32::INFINITY,
            f32::NAN,
        ] {
            assert_eq!(fingerprint(&value), reference_fingerprint(&value));
        }
    }

    #[test]
    fn streamed_acknowledgement_matches_token_and_timestamp_retry_contract() {
        let mut before = full_table();
        before.schema.columns = vec![ColumnSchema {
            data_name: "value".into(),
            input_validation: Some(InputValidationSettings {
                enabled: true,
                mode: ValidationMode::Warn,
                message: String::new(),
                hint: String::new(),
                rules: vec![InputRule::Required],
            }),
            ..Default::default()
        }];
        before.records.truncate(1);
        before.records[0].interface_values.clear();
        let mut after = before.clone();
        after.records[0]
            .values
            .insert("value".into(), String::new());
        let new_id = Uuid::from_u128(99);
        let mut implementation = after
            .interface_implementations
            .values()
            .next()
            .unwrap()
            .clone();
        implementation.interface_uuid = new_id;
        after
            .interface_implementations
            .insert(new_id, implementation);
        let mut first = None;
        for timestamp in [1, 86400, 1_234_567_890] {
            for implementation in after.interface_implementations.values_mut() {
                implementation.last_sync_date =
                    chrono::DateTime::from_timestamp(timestamp, 123_456_789).unwrap();
            }
            let report = transition_report("project", &before, &after).unwrap();
            assert_eq!(report.issues.len(), 1);
            let mut normalized = after.clone();
            for (id, implementation) in &mut normalized.interface_implementations {
                implementation.last_sync_date = before
                    .interface_implementations
                    .get(id)
                    .map(|old| old.last_sync_date)
                    .unwrap_or(chrono::DateTime::UNIX_EPOCH);
            }
            let expected =
                reference_fingerprint(&("project", &before, &normalized, &report.issues));
            assert_eq!(report.acknowledgement.as_ref(), Some(&expected));
            if let Some(token) = &first {
                assert_eq!(token, &expected);
            } else {
                first = Some(expected);
            }
        }
        assert!(transition_report("project", &before, &before)
            .unwrap()
            .acknowledgement
            .is_none());
        after.schema.columns[0]
            .input_validation
            .as_mut()
            .unwrap()
            .mode = ValidationMode::Reject;
        let report = transition_report("project", &before, &after).unwrap();
        assert!(!report.issues.is_empty());
        assert!(report.acknowledgement.is_none());
    }

    #[test]
    fn no_input_rules_skip_baseline_but_still_validate_column_definitions() {
        for inherited in [false, true] {
            for raw in ["", "not-a-number", "=unknown_function()"] {
                let mut before = full_table();
                before.schema.columns = vec![ColumnSchema {
                    data_name: "value".into(),
                    data_type: ValueType::F64,
                    interface_origin: inherited.then(|| Uuid::from_u128(1).to_string()),
                    required: Some(true),
                    constraints: Some(ColumnConstraints {
                        unique: Some(true),
                        ..Default::default()
                    }),
                    input_validation: Some(InputValidationSettings {
                        enabled: true,
                        mode: ValidationMode::Reject,
                        message: String::new(),
                        hint: String::new(),
                        rules: vec![InputRule::Required],
                    }),
                    ..Default::default()
                }];
                before.records.truncate(1);
                let column = &before.schema.columns[0];
                before.records[0].values.clear();
                before.records[0].interface_values.clear();
                before.records[0].set_cell_value(column, "1".into());
                for settings in [
                    None,
                    Some(InputValidationSettings {
                        enabled: true,
                        mode: ValidationMode::Warn,
                        message: "message".into(),
                        hint: "hint".into(),
                        rules: Vec::new(),
                    }),
                ] {
                    let mut after = before.clone();
                    after.schema.columns[0].input_validation = settings;
                    after.records[0].set_cell_value(&after.schema.columns[0], raw.into());
                    assert!(table_issues(&after).is_empty());
                    let report = transition_report("project", &before, &after).unwrap();
                    // The original comparison path has no early exit and still
                    // performs baseline/rule/group evaluation for this fixture.
                    let unshortened = compare_input_rule_transition(
                        "project",
                        &before,
                        &after,
                        &mut standalone_formula,
                    )
                    .unwrap();
                    assert_eq!(
                        serde_json::to_value(&report).unwrap(),
                        serde_json::to_value(unshortened).unwrap()
                    );
                    assert!(report.issues.is_empty());
                    assert!(report.acknowledgement.is_none());
                    after.schema.columns[0].conditional_formatting = Some(ConditionalFormatting {
                        rules: vec![FormattingRule {
                            id: "invalid".into(),
                            enabled: false,
                            condition: FormatCondition::All,
                            style: CellStyle {
                                background_color: Some("invalid-color".into()),
                                ..Default::default()
                            },
                            stop_if_true: false,
                        }],
                    });
                    assert!(transition_report("project", &before, &after).is_err());
                }
                let mut after = before.clone();
                after.records[0].set_cell_value(&after.schema.columns[0], raw.into());
                let report = transition_report("project", &before, &after).unwrap();
                assert!(
                    !report.issues.is_empty(),
                    "active rules must still validate {raw}"
                );
            }
        }
    }
}

fn canonical_zero(value: &u32) -> bool {
    *value == 0
}

#[cfg(test)]
mod range_bar_tests {
    use super::*;
    fn table() -> TableData {
        let mut table = canonical_revision_tests::full_table();
        table.schema.columns = vec![ColumnSchema {
            uuid: "range".into(),
            data_name: "value".into(),
            data_type: ValueType::F64,
            conditional_formatting: Some(ConditionalFormatting {
                rules: vec![new_formatting_rule("between").unwrap()],
            }),
            ..Default::default()
        }];
        table.records = [
            "-1", "0", "25", "100", "101", "", "NaN", "inf", "bad", "=1/0", "=25",
        ]
        .iter()
        .map(|value| {
            let mut row = Record::new();
            row.set_cell_value(&table.schema.columns[0], (*value).into());
            row
        })
        .collect();
        table
    }
    #[test]
    fn range_bar_authoritative_presentation_and_roundtrip() {
        let table = table();
        let before = serde_json::to_string(&table).unwrap();
        let result = presentation(&table);
        for (index, fraction, outside) in [
            (0, 10000, true),
            (1, 0, false),
            (2, 2500, false),
            (3, 10000, false),
            (4, 10000, true),
        ] {
            let cell = &result.cells[&table.records[index].uuid]["range"];
            let bar = cell.range_bar.as_ref().unwrap();
            assert_eq!(bar.fraction, fraction);
            assert_eq!(bar.out_of_range, outside);
            if outside {
                assert_eq!(bar.color, "#dc2626");
            }
            assert_eq!(cell.raw_value, table.records[index].values["value"]);
        }
        for row in &table.records[5..10] {
            assert!(result.cells[&row.uuid]["range"].range_bar.is_none());
        }
        let formula_cell = &result.cells[&table.records[10].uuid]["range"];
        assert_eq!(formula_cell.raw_value, "=25");
        assert_eq!(formula_cell.range_bar.as_ref().unwrap().fraction, 2500);
        assert_eq!(
            before,
            serde_json::to_string(&table).unwrap(),
            "presentation never edits numbers"
        );
        let condition: FormatCondition =
            serde_json::from_str(r#"{"kind":"between","min":"-10","max":"10"}"#).unwrap();
        if let FormatCondition::Between {
            low_color,
            high_color,
            out_of_range_color,
            ..
        } = &condition
        {
            assert_eq!(low_color, "#93c5fd");
            assert_eq!(high_color, "#2563eb");
            assert_eq!(out_of_range_color, "#dc2626");
        } else {
            panic!()
        }
        assert_eq!(
            condition,
            serde_json::from_str::<FormatCondition>(&serde_json::to_string(&condition).unwrap())
                .unwrap()
        );
        assert_eq!(
            condition,
            toml::from_str::<FormatCondition>(&toml::to_string(&condition).unwrap()).unwrap()
        );
    }
    #[test]
    fn range_bar_whitespace_matches_numeric_validation() {
        let mut table = table();
        if let FormatCondition::Between { min, max, .. } = &mut table.schema.columns[0]
            .conditional_formatting
            .as_mut()
            .unwrap()
            .rules[0]
            .condition
        {
            *min = " 0 ".into();
            *max = " 100\t".into();
        }
        assert!(validate_column_definition(&table.schema.columns[0]).is_ok());
        let result = presentation(&table);
        for (index, fraction) in [(1, 0), (2, 2500), (3, 10000)] {
            assert_eq!(
                result.cells[&table.records[index].uuid]["range"]
                    .range_bar
                    .as_ref()
                    .unwrap()
                    .fraction,
                fraction
            );
        }
        assert_eq!(scale_ratio(" 25 ", " 0 ", " 100 "), 0.25);
    }
    #[test]
    fn range_bar_does_not_replace_color_scale_or_validation() {
        let mut table = table();
        table.schema.columns[0].conditional_formatting = Some(ConditionalFormatting {
            rules: vec![new_formatting_rule("color_scale").unwrap()],
        });
        table.schema.columns[0].input_validation = Some(InputValidationSettings {
            enabled: true,
            mode: ValidationMode::Reject,
            message: String::new(),
            hint: String::new(),
            rules: vec![InputRule::NumberRange {
                min: Some("0".into()),
                max: Some("100".into()),
            }],
        });
        let result = presentation(&table);
        let outside = &result.cells[&table.records[0].uuid]["range"];
        assert!(outside.range_bar.is_none());
        assert!(outside.style.background_color.is_some());
        assert!(!outside.issues.is_empty());
    }
    #[test]
    fn range_bar_negative_degenerate_invalid_and_priority() {
        let mut table = table();
        let col = &mut table.schema.columns[0];
        col.conditional_formatting.as_mut().unwrap().rules[0].condition = serde_json::from_str(
            r##"{"kind":"between","min":"-10","max":"10","out_of_range_color":"#ff00ff"}"##,
        )
        .unwrap();
        let result = presentation(&table);
        assert_eq!(
            result.cells[&table.records[1].uuid]["range"]
                .range_bar
                .as_ref()
                .unwrap()
                .fraction,
            5000
        );
        let rule = &mut table.schema.columns[0]
            .conditional_formatting
            .as_mut()
            .unwrap()
            .rules[0];
        if let FormatCondition::Between { min, max, .. } = &mut rule.condition {
            *min = "0".into();
            *max = "0".into();
        }
        let result = presentation(&table);
        assert!(
            !result.cells[&table.records[1].uuid]["range"]
                .range_bar
                .as_ref()
                .unwrap()
                .out_of_range
        );
        assert_eq!(
            result.cells[&table.records[1].uuid]["range"]
                .range_bar
                .as_ref()
                .unwrap()
                .fraction,
            10000
        );
        assert_eq!(
            result.cells[&table.records[0].uuid]["range"]
                .range_bar
                .as_ref()
                .unwrap()
                .color,
            "#ff00ff"
        );
        let mut all = new_formatting_rule("all").unwrap();
        all.stop_if_true = true;
        table.schema.columns[0]
            .conditional_formatting
            .as_mut()
            .unwrap()
            .rules
            .insert(0, all);
        assert!(presentation(&table).cells[&table.records[1].uuid]["range"]
            .range_bar
            .is_none());
        let rules = &mut table.schema.columns[0]
            .conditional_formatting
            .as_mut()
            .unwrap()
            .rules;
        rules.swap(0, 1);
        rules[0].stop_if_true = true;
        assert!(presentation(&table).cells[&table.records[1].uuid]["range"]
            .range_bar
            .is_some());
        if let FormatCondition::Between { min, max, .. } = &mut table.schema.columns[0]
            .conditional_formatting
            .as_mut()
            .unwrap()
            .rules[0]
            .condition
        {
            *min = "2".into();
            *max = "1".into();
        }
        assert!(validate_column_definition(&table.schema.columns[0]).is_err());
    }
}
