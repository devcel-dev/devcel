use crate::column::ColumnSchema;
use crate::formula_context::FormulaQueryResolver;
use crate::formula_diagnostics::{
    DiagnosticState, FormulaDiagnostic, FormulaSourceContext, FormulaSourceLocation,
};
use crate::record::Record;
use crate::table::TableSchema;
use crate::types::{FormulaError, FormulaResult};
use std::collections::HashSet;
/// Builtins exposed by the native evaluator to formula editors. Availability
/// and source-dispatch parity are regression-tested; project symbols are separate.
pub const BUILTIN_FUNCTIONS: &[&str] = &[
    "ABS",
    "AVERAGE",
    "AVG",
    "CEIL",
    "CLAMP_COLOR",
    "COLOR32",
    "COLORFLOAT",
    "COLOR_TO_BYTE",
    "COLOR_TO_FLOAT",
    "CONCAT",
    "COUNT",
    "COUNTIF",
    "CURVE",
    "EXPOSURE",
    "FILTER",
    "FLOOR",
    "GAMMA_DECODE",
    "GAMMA_ENCODE",
    "GROUPBY",
    "HASROW",
    "IF",
    "JOIN",
    "LEN",
    "LENGTH",
    "LERP_COLOR",
    "LET",
    "LETREC",
    "LINEAR_TO_SRGB",
    "LOOKUP",
    "LOWER",
    "MAP",
    "MAX",
    "MIN",
    "REDUCE",
    "ROUND",
    "SAME",
    "SEQUENCE",
    "SRGB_TO_LINEAR",
    "SUM",
    "SUMIF",
    "TABLE",
    "TRUNC",
    "UPPER",
];
#[path = "formula_collections.rs"]
#[doc(hidden)]
pub mod collections;
pub use collections::{FormulaLimits, FormulaStatistics};

/// Preserve Unicode uppercase matching (including expansions such as ß -> SS)
/// without allocating two temporary strings for every column and subexpression.
pub(crate) fn names_equal(left: &str, right: &str) -> bool {
    if left.is_ascii() && right.is_ascii() {
        left.eq_ignore_ascii_case(right)
    } else {
        left.chars()
            .flat_map(char::to_uppercase)
            .eq(right.chars().flat_map(char::to_uppercase))
    }
}

/// Short formulas keep token and delimiter scratch space on the stack. Large
/// inputs spill to a Vec; the parser's depth/source/work limits still apply.
struct FormulaBuffer<T: Copy + Default, const N: usize> {
    inline: [T; N],
    len: usize,
    overflow: Option<Vec<T>>,
}
impl<T: Copy + Default, const N: usize> FormulaBuffer<T, N> {
    fn new() -> Self {
        Self {
            inline: [T::default(); N],
            len: 0,
            overflow: None,
        }
    }
    fn push(&mut self, value: T) {
        if let Some(values) = &mut self.overflow {
            values.push(value);
        } else if self.len < N {
            self.inline[self.len] = value;
            self.len += 1;
        } else {
            let mut values = Vec::with_capacity(N.saturating_mul(2).max(1));
            values.extend_from_slice(&self.inline);
            values.push(value);
            self.overflow = Some(values);
        }
    }
    fn pop(&mut self) -> Option<T> {
        if let Some(values) = &mut self.overflow {
            values.pop()
        } else if self.len == 0 {
            None
        } else {
            self.len -= 1;
            Some(self.inline[self.len])
        }
    }
}
impl<T: Copy + Default, const N: usize> std::ops::Deref for FormulaBuffer<T, N> {
    type Target = [T];
    fn deref(&self) -> &Self::Target {
        self.overflow.as_deref().unwrap_or(&self.inline[..self.len])
    }
}

/// Formula evaluation engine
pub struct FormulaEngine<'a> {
    /// Set of columns currently being evaluated, used to detect circular references
    evaluating_columns: HashSet<(String, String, String)>,
    context: Option<&'a dyn FormulaQueryResolver>,
    inheritance: Option<(
        &'a crate::table::TableData,
        crate::table::InputResolutionCache,
    )>,
    table_uuid: String,
    expression_depth: usize,
    budget: collections::Budget,
    evaluation_calls: usize,
    diagnostics: DiagnosticState,
}

impl<'a> FormulaEngine<'a> {
    /// Create a FormulaEngine instance
    pub fn new() -> Self {
        Self {
            evaluating_columns: HashSet::new(),
            context: None,
            inheritance: None,
            table_uuid: String::new(),
            expression_depth: 0,
            budget: collections::Budget::default(),
            evaluation_calls: 0,
            diagnostics: DiagnosticState::default(),
        }
    }

    pub fn with_table(data: &'a crate::table::TableData) -> Self {
        let mut engine = Self::new();
        engine.table_uuid = data.uuid.clone();
        engine.inheritance = Some((data, crate::table::InputResolutionCache::default()));
        engine
    }
    pub(crate) fn with_table_cache(
        data: &'a crate::table::TableData,
        cache: crate::table::InputResolutionCache,
    ) -> Self {
        let mut engine = Self::with_table(data);
        engine.inheritance = Some((data, cache));
        engine
    }
    pub(crate) fn take_table_cache(&mut self) -> crate::table::InputResolutionCache {
        self.inheritance
            .as_mut()
            .map(|(_, cache)| std::mem::take(cache))
            .unwrap_or_default()
    }
    pub(crate) fn effective_input(
        &mut self,
        table_uuid: &str,
        record: &Record,
        column: &ColumnSchema,
    ) -> Result<String, FormulaError> {
        // Local input and column defaults do not require a persisted table.
        // Formula previews may evaluate a synthetic row/schema with no catalog ID.
        match record.get_cell_value(column).is_some() {
            true => return Ok(record.get_cell_value(column).cloned().unwrap_or_default()),

            false if record.parent_uuid.is_empty() => return Ok(column.default_value.clone()),
            false => {}
        }
        if let Some(context) = self.context {
            return context.effective_input(self, table_uuid, record, column);
        }
        if let Some((data, resolver)) = &mut self.inheritance {
            return resolver
                .input(data, record, column)
                .map_err(FormulaError::from);
        }
        Err(FormulaError::InvalidReference(
            "Parent resolution requires a table context".into(),
        ))
    }

    /// Bind cross-table queries to one project and content-version population.
    pub fn with_context(context: &'a dyn FormulaQueryResolver, table_uuid: &str) -> Self {
        Self {
            context: Some(context),
            table_uuid: table_uuid.to_owned(),
            ..Self::new()
        }
    }

    fn begin_root(&mut self) -> Result<(), FormulaError> {
        if self.evaluation_calls == 0 {
            self.budget.reset();
            if let Some(context) = self.context {
                context.begin_evaluation()?;
            }
        }
        self.evaluation_calls += 1;
        Ok(())
    }
    fn finish_root(&mut self, result: FormulaResult) -> FormulaResult {
        self.evaluation_calls -= 1;
        if self.evaluation_calls == 0 {
            if let Some(context) = self.context {
                if let Err(error) = context.end_evaluation(self) {
                    if matches!(result, FormulaResult::Value(_)) {
                        return FormulaResult::Error(error);
                    }
                }
            }
        }
        result
    }
    /// Diagnostics for the most recent root evaluation, cleared by the next one.
    pub fn last_diagnostic(&self) -> Option<&FormulaDiagnostic> {
        self.diagnostics.last.as_ref()
    }
    pub fn take_diagnostic(&mut self) -> Option<FormulaDiagnostic> {
        self.diagnostics.last.take()
    }
    pub fn format_error(&self, error: &FormulaError) -> String {
        self.last_diagnostic().map_or_else(
            || format!("{error:?}"),
            |diagnostic| diagnostic.format_error(error),
        )
    }
    /// Supply a known local-table identity after a failed standalone evaluation.
    /// Existing cross-table identities are preserved; the success path is free.
    pub(crate) fn complete_diagnostic_table(&mut self, table_uuid: &str) {
        self.diagnostics.complete_table(table_uuid);
    }
    pub(crate) fn source_context(&mut self) -> Option<FormulaSourceContext> {
        self.diagnostics.context()
    }
    pub(crate) fn source_location(&mut self, expression: &str) -> Option<FormulaSourceLocation> {
        self.diagnostics.location(expression)
    }
    pub(crate) fn record_diagnostic(
        &mut self,
        location: Option<&FormulaSourceLocation>,
        operation: &str,
    ) {
        self.diagnostics.record(location, operation);
    }
    pub(crate) fn record_cell_diagnostic(
        &mut self,
        table_uuid: &str,
        row_uuid: Option<&str>,
        column_uuid: Option<&str>,
        operation: &str,
    ) {
        self.diagnostics
            .record_cell(table_uuid, row_uuid, column_uuid, operation);
    }
    pub(crate) fn record_callback_diagnostic(
        &mut self,
        operation: &str,
        element_index: Option<usize>,
        left_index: Option<usize>,
        right_index: Option<usize>,
    ) {
        self.diagnostics
            .callback(operation, element_index, left_index, right_index);
    }
    fn finish_diagnostic_scope(
        &mut self,
        formula: &str,
        column_uuid: Option<&str>,
        column_label: Option<&str>,
        record: &Record,
        failed: bool,
    ) {
        if failed && self.last_diagnostic().is_none() {
            // Direct SDK callers may pass a literal. Its cell identity is known,
            // but there is no formula expression whose position can be reported.
            let location = formula
                .trim()
                .starts_with('=')
                .then(|| self.source_location(formula))
                .flatten();
            self.record_diagnostic(location.as_ref(), "cell");
        }
        self.diagnostics.finish(
            &self.table_uuid,
            Some(&record.uuid),
            column_uuid,
            column_label,
            failed,
        );
    }
    pub fn evaluate(
        &mut self,
        formula: &str,
        column_name: &str,
        record: &Record,
        schema: &TableSchema,
    ) -> FormulaResult {
        self.diagnostics.begin(formula);
        let result = if let Err(error) = self.begin_root() {
            FormulaResult::Error(error)
        } else {
            let result = match self.budget.guard_stack() {
                Ok(()) => stacker::maybe_grow(256 * 1024, 2 * 1024 * 1024, || {
                    match self
                        .evaluate_body(formula, column_name, record, schema)
                        .and_then(|value| self.render_output(&value, formula))
                    {
                        Ok(value) => FormulaResult::Value(value),
                        Err(error) => FormulaResult::Error(error),
                    }
                }),
                Err(error) => FormulaResult::Error(error),
            };
            self.finish_root(result)
        };
        let failed = matches!(result, FormulaResult::Error(_));
        // The public entry point accepts a name, not necessarily a UUID.
        let column_uuid = if failed || self.diagnostics.has_provenance() {
            schema
                .columns
                .iter()
                .find(|column| column.uuid == column_name)
                .or_else(|| Self::named_column(schema, column_name).ok())
                .map(|column| column.uuid.as_str())
        } else {
            None
        };
        self.finish_diagnostic_scope(formula, column_uuid, Some(column_name), record, failed);
        result
    }
    pub fn evaluate_column(
        &mut self,
        formula: &str,
        column: &ColumnSchema,
        record: &Record,
        schema: &TableSchema,
    ) -> FormulaResult {
        self.diagnostics.begin(formula);
        let result = if let Err(error) = self.begin_root() {
            FormulaResult::Error(error)
        } else {
            let result = match self.budget.guard_stack() {
                Ok(()) => stacker::maybe_grow(256 * 1024, 2 * 1024 * 1024, || {
                    self.evaluate_column_body(formula, column, record, schema)
                }),
                Err(error) => FormulaResult::Error(error),
            };
            self.finish_root(result)
        };
        self.finish_diagnostic_scope(
            formula,
            Some(&column.uuid),
            None,
            record,
            matches!(result, FormulaResult::Error(_)),
        );
        result
    }

    /// Evaluate a dependent cell without discarding the active dependency stack.
    pub(crate) fn evaluate_column_in_table(
        &mut self,
        table_uuid: &str,
        formula: &str,
        column: &ColumnSchema,
        record: &Record,
        schema: &TableSchema,
    ) -> FormulaResult {
        let previous = std::mem::replace(&mut self.table_uuid, table_uuid.to_owned());
        let result = self.evaluate_column(formula, column, record, schema);
        self.table_uuid = previous;
        result
    }

    /// Evaluate every formula through the same typed syntax tree.
    fn evaluate_body(
        &mut self,
        formula: &str,
        column_name: &str,
        record: &Record,
        schema: &TableSchema,
    ) -> Result<collections::Value, FormulaError> {
        self.budget.charge(1, 0)?;
        // UUID identity includes table and row: another row's same column is valid.
        let identity = (
            self.table_uuid.clone(),
            record.uuid.clone(),
            column_name.to_owned(),
        );
        if !self.evaluating_columns.insert(identity.clone()) {
            return Err(FormulaError::CircularReference);
        }
        let result = self.evaluate_internal(formula, record, schema);
        self.evaluating_columns.remove(&identity);
        result
    }

    /// Normalize the typed result at the cell boundary used by presentation/export.
    /// UUIDs distinguish interface-owned columns that share a data name.
    fn evaluate_column_body(
        &mut self,
        formula: &str,
        column: &ColumnSchema,
        record: &Record,
        schema: &TableSchema,
    ) -> FormulaResult {
        if column.data_type == crate::types::ValueType::None {
            return FormulaResult::Value(String::new());
        }
        let result = (|| {
            let value = self.evaluate_body(formula, &column.uuid, record, schema)?;
            self.validate_output(&value, column)?;
            let text = self.render_output(&value, formula)?;
            let cast = column.data_type.cast_numeric_value(&text);
            if let Some(warning) = cast.warning {
                return Err(FormulaError::TypeError(warning));
            }
            let text_type = matches!(
                column.data_type,
                crate::ValueType::String | crate::ValueType::Select | crate::ValueType::DateTime
            );
            if cast.value.starts_with('=') && !text_type {
                return Err(FormulaError::TypeError(
                    "Formula result is not a value of the destination type".into(),
                ));
            }
            column
                .validate_value(&cast.value)
                .map_err(FormulaError::from)
        })();
        match result {
            Ok(value) => FormulaResult::Value(value),
            Err(error) => FormulaResult::Error(error),
        }
    }

    fn render_output(
        &mut self,
        value: &collections::Value,
        formula: &str,
    ) -> Result<String, FormulaError> {
        value.text(&mut self.budget).inspect_err(|_| {
            let location = self.source_location(formula.strip_prefix('=').unwrap_or(formula));
            self.record_diagnostic(location.as_ref(), "scalar output");
        })
    }

    fn evaluate_internal(
        &mut self,
        formula: &str,
        record: &Record,
        schema: &TableSchema,
    ) -> Result<collections::Value, FormulaError> {
        if formula.len().saturating_sub(1) > self.budget.limits.source_bytes {
            return Err(FormulaError::ExecutionLimit(
                "Formula source length exceeded".into(),
            ));
        }
        let expression = formula
            .strip_prefix('=')
            .ok_or_else(|| FormulaError::ParseError("Formula must start with '='".into()))?;
        if expression.is_empty() {
            return Ok(collections::Value::String("".into()));
        }
        self.evaluate_expression(expression, record, schema)
    }

    pub(crate) fn named_column<'s>(
        schema: &'s TableSchema,
        name: &str,
    ) -> Result<&'s ColumnSchema, FormulaError> {
        let mut columns = schema.columns.iter().filter(|column| {
            names_equal(&column.data_name, name) || names_equal(&column.display_name, name)
        });
        let column = columns
            .next()
            .ok_or_else(|| FormulaError::InvalidReference(format!("Column not found: {name}")))?;
        if columns.next().is_some() {
            return Err(FormulaError::InvalidReference(format!(
                "Ambiguous column reference: {name}"
            )));
        }
        Ok(column)
    }

    /// Validate matching parentheses and quotes, and return top-level token positions.
    fn top_level_tokens(expr: &str) -> Result<FormulaBuffer<(usize, char), 16>, FormulaError> {
        let mut tokens = FormulaBuffer::new();
        let mut depth = 0usize;
        let mut delimiters = FormulaBuffer::<char, 16>::new();
        let mut quote = None;
        let mut chars = expr.char_indices().peekable();
        while let Some((i, ch)) = chars.next() {
            if let Some(delimiter) = quote {
                if ch == delimiter {
                    if chars.peek().is_some_and(|(_, next)| *next == delimiter) {
                        chars.next();
                    } else {
                        quote = None;
                        if depth == 0 {
                            tokens.push((i, ch));
                        }
                    }
                }
                continue;
            }
            if ch == '"' || ch == '`' {
                quote = Some(ch);
                if depth == 0 {
                    tokens.push((i, ch));
                }
                continue;
            }
            match ch {
                '(' | '[' | '{' => {
                    if depth == 0 {
                        tokens.push((i, ch));
                    }
                    depth += 1;
                    delimiters.push(ch);
                }
                ')' | ']' | '}' => {
                    if depth == 0 {
                        return Err(FormulaError::ParseError("Unexpected ')'".to_string()));
                    }
                    let expected = match ch {
                        ')' => '(',
                        ']' => '[',
                        _ => '{',
                    };
                    if delimiters.pop() != Some(expected) {
                        return Err(FormulaError::ParseError("Mismatched delimiter".into()));
                    }
                    depth -= 1;
                    if depth == 0 {
                        tokens.push((i, ch));
                    }
                }
                _ if depth == 0 && !ch.is_whitespace() => tokens.push((i, ch)),
                _ => {}
            }
        }
        if quote.is_some() || depth != 0 {
            return Err(FormulaError::ParseError(
                "Unclosed string or parenthesis".to_string(),
            ));
        }
        Ok(tokens)
    }

    fn is_unary_or_exponent_sign(expr: &str, pos: usize) -> bool {
        let before = &expr[..pos];
        match before.trim_end().chars().next_back() {
            None | Some('+' | '-' | '*' | '/' | '<' | '>' | '=' | '!' | ',' | '(') => true,
            _ if before.ends_with(['e', 'E']) => {
                let mantissa = before[..before.len() - 1]
                    .rsplit(|ch: char| ch.is_whitespace() || "+-*/<>=!,(".contains(ch))
                    .next()
                    .unwrap_or("");
                mantissa.parse::<f64>().is_ok()
            }
            _ => false,
        }
    }

    fn compare_values(left: &str, right: &str, operator: &str) -> Result<bool, FormulaError> {
        let order = match (Number::parse(left)?, Number::parse(right)?) {
            (Some(left), Some(right)) => left.compare(right)?,
            _ => left.cmp(right),
        };
        Ok(Self::compare_ordering(order, operator))
    }

    fn compare_ordering(order: std::cmp::Ordering, operator: &str) -> bool {
        use std::cmp::Ordering::{Equal, Greater, Less};
        match operator {
            "=" | "==" => order == Equal,
            "!=" | "<>" => order != Equal,
            "<" => order == Less,
            ">" => order == Greater,
            "<=" => matches!(order, Less | Equal),
            ">=" => matches!(order, Greater | Equal),
            _ => unreachable!(),
        }
    }

    fn split_function_args(args_str: &str) -> Result<Vec<&str>, FormulaError> {
        if args_str.trim().is_empty() {
            return Ok(vec![]);
        }
        let mut args = Vec::new();
        let mut start = 0;
        for &(i, ch) in Self::top_level_tokens(args_str)?.iter() {
            if ch == ',' {
                args.push(&args_str[start..i]);
                start = i + 1;
            }
        }
        args.push(&args_str[start..]);
        if args.iter().any(|arg| arg.trim().is_empty()) {
            return Err(FormulaError::ParseError("Missing expression".into()));
        }
        Ok(args)
    }

    fn truthy(value: &str) -> bool {
        !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false")
    }

    /// Evaluate a built-in function
    fn evaluate_function(&mut self, name: &str, args: Vec<String>) -> Result<String, FormulaError> {
        let bytes = args
            .iter()
            .fold(0usize, |sum, arg| sum.saturating_add(arg.len()));
        self.budget.charge(
            0,
            bytes
                .saturating_mul(3)
                .saturating_add(args.len().saturating_mul(32)),
        )?;
        match name {
            "CURVE" => self.func_curve(args),
            "SUM" => self.func_sum(args),
            "AVG" | "AVERAGE" => self.func_average(args),
            "MIN" => self.func_min(args),
            "MAX" => self.func_max(args),
            "COUNT" => self.func_count(args),
            "ABS" => self.func_abs(args),
            "ROUND" => self.func_round(args),
            "TRUNC" | "FLOOR" | "CEIL" => self.func_integer_rounding(name, args),
            "CONCAT" => self.func_concat(args),
            "LEN" | "LENGTH" => self.func_length(args),
            "UPPER" => self.func_upper(args),
            "LOWER" => self.func_lower(args),
            _ => Err(FormulaError::FunctionNotFound(name.to_string())),
        }
    }

    /// Normalize an input interval, then use the canonical runtime curve sampler.
    fn func_curve(&self, args: Vec<String>) -> Result<String, FormulaError> {
        if args.len() != 4 {
            return Err(FormulaError::ArgumentError(
                "CURVE requires exactly 4 arguments: current, min, max, curve".into(),
            ));
        }
        let current = Number::required(&args[0])?.float()?;
        let min = Number::required(&args[1])?.float()?;
        let max = Number::required(&args[2])?.float()?;
        if min >= max {
            return Err(FormulaError::ArgumentError(
                "CURVE requires min < max".into(),
            ));
        }
        if args[3].is_empty() {
            return Err(FormulaError::TypeError(
                "CURVE requires a curve value".into(),
            ));
        }
        let curve =
            devcel_runtime::curve::Curve::parse(&args[3], None).map_err(FormulaError::TypeError)?;
        // Scaling first avoids overflow for finite intervals spanning -MAX..MAX.
        let x = if current <= min {
            0.0
        } else if current >= max {
            1.0
        } else {
            let width = max - min;
            if width.is_finite() {
                ((current - min) / width).clamp(0.0, 1.0)
            } else {
                let scale = min.abs().max(max.abs());
                ((current / scale - min / scale) / (max / scale - min / scale)).clamp(0.0, 1.0)
            }
        };
        Number::finite(curve.sample(x)).map(Number::text)
    }

    /// Resolve a column reference within the same record
    fn resolve_reference(
        &mut self,
        column: &ColumnSchema,
        record: &Record,
        schema: &TableSchema,
    ) -> Result<String, FormulaError> {
        if column.data_type == crate::types::ValueType::None {
            return Ok(String::new());
        }
        let table_uuid = self.table_uuid.clone();
        let value = self.effective_input(&table_uuid, record, column)?;
        self.budget.charge(0, value.len().saturating_mul(3))?;
        if value.starts_with('=') {
            let value = self
                .evaluate_column(&value, column, record, schema)
                .into_result()?;
            let result = formula_operand(column, value);
            if result.is_err() {
                self.diagnostics.record_cell(
                    &self.table_uuid,
                    Some(&record.uuid),
                    Some(&column.uuid),
                    "cell value",
                );
            }
            return result;
        }
        if !value.is_empty()
            || matches!(
                column.data_type,
                crate::ValueType::Curve | crate::ValueType::Color32 | crate::ValueType::ColorFloat
            )
        {
            let result = formula_operand(column, value.clone());
            if result.is_err() {
                self.diagnostics.record_cell(
                    &self.table_uuid,
                    Some(&record.uuid),
                    Some(&column.uuid),
                    "cell value",
                );
            }
            return result;
        }
        Ok(match column.data_type {
            crate::types::ValueType::U8
            | crate::types::ValueType::I8
            | crate::types::ValueType::U16
            | crate::types::ValueType::I16
            | crate::types::ValueType::U32
            | crate::types::ValueType::I32
            | crate::types::ValueType::U64
            | crate::types::ValueType::I64
            | crate::types::ValueType::F32
            | crate::types::ValueType::F64 => "0",
            crate::types::ValueType::Boolean => "false",
            _ => "",
        }
        .into())
    }

    fn numeric_args(args: Vec<String>, name: &str) -> Result<Vec<Number>, FormulaError> {
        if args.is_empty() {
            return Err(FormulaError::ArgumentError(format!(
                "{name} requires at least one argument"
            )));
        }
        let mut numbers = Vec::new();
        for arg in args {
            if let Some(number) = Number::parse(&arg)? {
                numbers.push(number);
            }
        }
        Ok(numbers)
    }

    fn func_sum(&self, args: Vec<String>) -> Result<String, FormulaError> {
        Self::numeric_args(args, "SUM")?
            .into_iter()
            .try_fold(Number::Integer(0), |sum, value| sum.binary(value, '+'))
            .map(Number::text)
    }

    fn func_average(&self, args: Vec<String>) -> Result<String, FormulaError> {
        let numbers = Self::numeric_args(args, "AVG")?;
        if numbers.is_empty() {
            return Ok("0".into());
        }
        let count = numbers.len() as i128;
        numbers
            .into_iter()
            .try_fold(Number::Integer(0), |sum, value| sum.binary(value, '+'))?
            .binary(Number::Integer(count), '/')
            .map(Number::text)
    }

    fn numeric_extreme(
        args: Vec<String>,
        name: &str,
        minimum: bool,
    ) -> Result<String, FormulaError> {
        let mut numbers = Self::numeric_args(args, name)?.into_iter();
        let mut best = numbers.next().ok_or_else(|| {
            FormulaError::ArgumentError(format!("{name} requires at least one numeric argument"))
        })?;
        for value in numbers {
            let order = value.compare(best)?;
            if (minimum && order.is_lt()) || (!minimum && order.is_gt()) {
                best = value;
            }
        }
        Ok(best.text())
    }

    fn func_min(&self, args: Vec<String>) -> Result<String, FormulaError> {
        Self::numeric_extreme(args, "MIN", true)
    }

    fn func_max(&self, args: Vec<String>) -> Result<String, FormulaError> {
        Self::numeric_extreme(args, "MAX", false)
    }

    fn func_count(&self, args: Vec<String>) -> Result<String, FormulaError> {
        Ok(args.len().to_string())
    }

    fn func_abs(&self, args: Vec<String>) -> Result<String, FormulaError> {
        if args.len() != 1 {
            return Err(FormulaError::ArgumentError(
                "ABS requires exactly one argument".to_string(),
            ));
        }

        let number = Number::required(&args[0])?;
        let result = match number {
            Number::Integer(value) => {
                Number::Integer(value.checked_abs().ok_or_else(Number::overflow)?)
            }
            Number::Float(value) => Number::Float(value.abs()),
        };
        Ok(result.text())
    }

    fn func_round(&self, args: Vec<String>) -> Result<String, FormulaError> {
        if args.is_empty() || args.len() > 2 {
            return Err(FormulaError::ArgumentError(
                "ROUND requires 1 or 2 arguments".into(),
            ));
        }
        let number = Number::required(&args[0])?;
        let precision = if args.len() == 2 {
            args[1].parse::<i32>().map_err(|_| {
                FormulaError::TypeError("ROUND second argument must be an integer".into())
            })?
        } else {
            0
        };
        let result = match number {
            Number::Integer(value) if precision >= 0 => Number::Integer(value),
            Number::Integer(value) => {
                let Some(factor) = 10_i128.checked_pow(precision.unsigned_abs()) else {
                    return Ok("0".into());
                };
                let mut rounded = value / factor;
                if (value % factor).unsigned_abs() >= (factor / 2) as u128 {
                    rounded = rounded
                        .checked_add(value.signum())
                        .ok_or_else(Number::overflow)?;
                }
                Number::Integer(rounded.checked_mul(factor).ok_or_else(Number::overflow)?)
            }
            Number::Float(value) => {
                let factor = 10_f64.powi(precision);
                if !factor.is_finite() || factor == 0.0 {
                    return Err(FormulaError::TypeError(
                        "ROUND precision is outside the finite range".into(),
                    ));
                }
                Number::finite((value * factor).round() / factor)?
            }
        };
        Ok(result.text())
    }

    fn func_integer_rounding(&self, name: &str, args: Vec<String>) -> Result<String, FormulaError> {
        if args.len() != 1 {
            return Err(FormulaError::ArgumentError(format!(
                "{name} requires exactly one argument"
            )));
        }
        let result = match Number::required(&args[0])? {
            // Never convert exact integer inputs through f64.
            Number::Integer(value) => Number::Integer(value),
            Number::Float(value) => Number::finite(match name {
                "TRUNC" => value.trunc(),
                "FLOOR" => value.floor(),
                "CEIL" => value.ceil(),
                _ => unreachable!(),
            })?,
        };
        Ok(result.text())
    }

    fn func_concat(&self, args: Vec<String>) -> Result<String, FormulaError> {
        Ok(args.join(""))
    }

    fn func_length(&self, args: Vec<String>) -> Result<String, FormulaError> {
        if args.len() != 1 {
            return Err(FormulaError::ArgumentError(
                "LEN requires exactly one argument".to_string(),
            ));
        }

        Ok(args[0].chars().count().to_string())
    }

    fn func_upper(&self, args: Vec<String>) -> Result<String, FormulaError> {
        if args.len() != 1 {
            return Err(FormulaError::ArgumentError(
                "UPPER requires exactly one argument".to_string(),
            ));
        }

        Ok(args[0].to_uppercase())
    }

    fn func_lower(&self, args: Vec<String>) -> Result<String, FormulaError> {
        if args.len() != 1 {
            return Err(FormulaError::ArgumentError(
                "LOWER requires exactly one argument".to_string(),
            ));
        }

        Ok(args[0].to_lowercase())
    }
}

/// Preserve a floating column's type when passing its textual value to an expression.
/// Large finite floats can have an integer-looking decimal display beyond i128.
pub(crate) fn formula_operand(
    column: &ColumnSchema,
    value: String,
) -> Result<String, FormulaError> {
    if column.data_type == crate::ValueType::Color32 {
        return crate::color::Color32::parse(if value.is_empty() {
            "[255,255,255,255]"
        } else {
            &value
        })
        .map(|color| color.canonical_string())
        .map_err(FormulaError::TypeError);
    }
    if column.data_type == crate::ValueType::ColorFloat {
        return crate::color::ColorFloat::parse(if value.is_empty() {
            "[1,1,1,1]"
        } else {
            &value
        })
        .map(|color| color.canonical_string())
        .map_err(FormulaError::TypeError);
    }
    if column.data_type == crate::ValueType::Curve {
        return crate::curve::formula_curve_value(&value, column.curve_config.as_ref())
            .map_err(FormulaError::TypeError);
    }
    if matches!(
        column.data_type,
        crate::ValueType::F32 | crate::ValueType::F64
    ) {
        let number = value
            .parse::<f64>()
            .map_err(|_| FormulaError::TypeError("Floating cell is not numeric".into()))?;
        Number::finite(number)?;
        Ok(format!("{number:e}"))
    } else {
        Ok(value)
    }
}

/// Preserve integer cells (including all U64/I64 values) without routing them through f64.
/// Mixed arithmetic is allowed only when conversion of an integer is exact.
#[derive(Clone, Copy)]
#[doc(hidden)]
pub enum Number {
    Integer(i128),
    Float(f64),
}

impl Number {
    fn overflow() -> FormulaError {
        FormulaError::TypeError("Integer arithmetic overflow".into())
    }

    pub(crate) fn parse(value: &str) -> Result<Option<Self>, FormulaError> {
        let unsigned = value.strip_prefix(['+', '-']).unwrap_or(value);
        if !unsigned.is_empty() && unsigned.bytes().all(|byte| byte.is_ascii_digit()) {
            return value
                .parse::<i128>()
                .map(|value| Some(Self::Integer(value)))
                .map_err(|_| Self::overflow());
        }
        match value.parse::<f64>() {
            Ok(value) => Self::finite(value).map(Some),
            Err(_) => Ok(None),
        }
    }

    pub(crate) fn required(value: &str) -> Result<Self, FormulaError> {
        Self::parse(value)?
            .ok_or_else(|| FormulaError::TypeError("Operand must be a number".into()))
    }

    pub(crate) fn finite(value: f64) -> Result<Self, FormulaError> {
        if value.is_finite() {
            Ok(Self::Float(value))
        } else {
            Err(FormulaError::TypeError("Non-finite numeric result".into()))
        }
    }

    pub(crate) fn float(self) -> Result<f64, FormulaError> {
        match self {
            Self::Float(value) => Ok(value),
            Self::Integer(value) => {
                let float = value as f64;
                if float >= i128::MAX as f64 || (float as i128) != value {
                    Err(FormulaError::TypeError(
                        "Integer cannot be represented exactly in floating-point arithmetic".into(),
                    ))
                } else {
                    Ok(float)
                }
            }
        }
    }

    pub(crate) fn text(self) -> String {
        match self {
            Self::Integer(value) => value.to_string(),
            Self::Float(value) if value.abs() >= i128::MAX as f64 => format!("{value:e}"),
            // The shortest f64 spelling may be a different integer (e.g. I64::MIN
            // displays as -9223372036854776000). Preserve the actual integral value
            // before the next stage parses this text as an exact integer.
            Self::Float(value) if value.fract() == 0.0 => format!("{value:.0}"),
            Self::Float(value) => value.to_string(),
        }
    }

    pub(crate) fn binary(self, other: Self, operator: char) -> Result<Self, FormulaError> {
        if let (Self::Integer(left), Self::Integer(right)) = (self, other) {
            let integer = match operator {
                '+' => left.checked_add(right),
                '-' => left.checked_sub(right),
                '*' => left.checked_mul(right),
                '/' if right == 0 => return Err(FormulaError::DivisionByZero),
                '/' if left.checked_rem(right) == Some(0) => left.checked_div(right),
                '/' if left == i128::MIN && right == -1 => None,
                '/' => return Self::finite(self.float()? / other.float()?),
                _ => unreachable!(),
            };
            return integer.map(Self::Integer).ok_or_else(Self::overflow);
        }
        let left = self.float()?;
        let right = other.float()?;
        Self::finite(match operator {
            '+' => left + right,
            '-' => left - right,
            '*' => left * right,
            '/' if right == 0.0 => return Err(FormulaError::DivisionByZero),
            '/' => left / right,
            _ => unreachable!(),
        })
    }

    /// Equivalent to parsing `text()` for comparison, without the temporary
    /// string. Integral floats historically compare as exact i128 integers.
    pub(crate) fn comparison_value(self) -> Self {
        match self {
            Self::Float(value) if value.fract() == 0.0 && value.abs() < i128::MAX as f64 => {
                Self::Integer(value as i128)
            }
            value => value,
        }
    }

    pub(crate) fn compare(self, other: Self) -> Result<std::cmp::Ordering, FormulaError> {
        if let (Self::Integer(left), Self::Integer(right)) = (self, other) {
            return Ok(left.cmp(&right));
        }
        self.float()?
            .partial_cmp(&other.float()?)
            .ok_or_else(|| FormulaError::TypeError("Non-finite numeric comparison".into()))
    }
}

impl Default for FormulaEngine<'_> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::column::{ColumnSchema, ColumnStyle};
    use crate::record::Record;
    use crate::table::TableSchema;
    use crate::types::{FormulaResult, ValueType};

    fn create_test_schema() -> TableSchema {
        TableSchema {
            columns: vec![
                ColumnSchema {
                    read_only: false,
                    uuid: "col1".to_string(),
                    display_name: "A".to_string(),
                    data_name: "col_a".to_string(),
                    data_type: ValueType::I32,
                    default_value: "0".to_string(),
                    tooltip: String::new(),
                    memo_text: String::new(),
                    tags: vec![],
                    style: ColumnStyle::default(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: None,
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                },
                ColumnSchema {
                    read_only: false,
                    uuid: "col2".to_string(),
                    display_name: "B".to_string(),
                    data_name: "col_b".to_string(),
                    data_type: ValueType::I32,
                    default_value: "0".to_string(),
                    tooltip: String::new(),
                    memo_text: String::new(),
                    tags: vec![],
                    style: ColumnStyle::default(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: None,
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                },
                ColumnSchema {
                    read_only: false,
                    uuid: "col3".to_string(),
                    display_name: "C".to_string(),
                    data_name: "col_c".to_string(),
                    data_type: ValueType::F64,
                    default_value: "0.0".to_string(),
                    tooltip: String::new(),
                    memo_text: String::new(),
                    tags: vec![],
                    style: ColumnStyle::default(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: None,
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                },
                ColumnSchema {
                    read_only: false,
                    uuid: "col4".to_string(),
                    display_name: "Name".to_string(),
                    data_name: "col_name".to_string(),
                    data_type: ValueType::String,
                    default_value: String::new(),
                    tooltip: String::new(),
                    memo_text: String::new(),
                    tags: vec![],
                    style: ColumnStyle::default(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: None,
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                },
            ],
        }
    }

    fn create_test_record() -> Record {
        let mut record = Record::new();
        record.values.insert("col_a".to_string(), "10".to_string());
        record.values.insert("col_b".to_string(), "20".to_string());
        record
            .values
            .insert("col_c".to_string(), "3.14".to_string());
        record
            .values
            .insert("col_name".to_string(), "Test".to_string());
        record
    }

    #[test]
    fn test_simple_number() {
        let mut engine = FormulaEngine::new();
        let record = create_test_record();
        let schema = create_test_schema();

        let result = engine.evaluate("=42", "test_col", &record, &schema);
        match result {
            FormulaResult::Value(val) => assert_eq!(val, "42"),
            _ => panic!("Expected value, got error"),
        }
    }

    #[test]
    fn test_simple_string() {
        let mut engine = FormulaEngine::new();
        let record = create_test_record();
        let schema = create_test_schema();

        let result = engine.evaluate("=\"Hello World\"", "test_col", &record, &schema);
        match result {
            FormulaResult::Value(val) => assert_eq!(val, "Hello World"),
            _ => panic!("Expected value, got error"),
        }
    }

    #[test]
    fn test_column_reference() {
        let mut engine = FormulaEngine::new();
        let record = create_test_record();
        let schema = create_test_schema();

        // Display name reference
        let result = engine.evaluate("=A", "test_col", &record, &schema);
        match result {
            FormulaResult::Value(val) => assert_eq!(val, "10"),
            _ => panic!("Expected value, got error"),
        }

        // Data name reference
        let result = engine.evaluate("=col_b", "test_col", &record, &schema);
        match result {
            FormulaResult::Value(val) => assert_eq!(val, "20"),
            _ => panic!("Expected value, got error"),
        }
    }

    #[test]
    fn test_addition() {
        let mut engine = FormulaEngine::new();
        let record = create_test_record();
        let schema = create_test_schema();

        let result = engine.evaluate("=A+B", "test_col", &record, &schema);
        match result {
            FormulaResult::Value(val) => assert_eq!(val, "30"),
            _ => panic!("Expected value, got error"),
        }
    }

    #[test]
    fn test_subtraction() {
        let mut engine = FormulaEngine::new();
        let record = create_test_record();
        let schema = create_test_schema();

        let result = engine.evaluate("=B-A", "test_col", &record, &schema);
        match result {
            FormulaResult::Value(val) => assert_eq!(val, "10"),
            _ => panic!("Expected value, got error"),
        }
    }

    #[test]
    fn test_multiplication() {
        let mut engine = FormulaEngine::new();
        let record = create_test_record();
        let schema = create_test_schema();

        let result = engine.evaluate("=A*2", "test_col", &record, &schema);
        match result {
            FormulaResult::Value(val) => assert_eq!(val, "20"),
            _ => panic!("Expected value, got error"),
        }
    }

    #[test]
    fn test_division() {
        let mut engine = FormulaEngine::new();
        let record = create_test_record();
        let schema = create_test_schema();

        let result = engine.evaluate("=B/A", "test_col", &record, &schema);
        match result {
            FormulaResult::Value(val) => assert_eq!(val, "2"),
            _ => panic!("Expected value, got error"),
        }
    }

    #[test]
    fn test_sum_function() {
        let mut engine = FormulaEngine::new();
        let record = create_test_record();
        let schema = create_test_schema();

        let result = engine.evaluate("=SUM(A, B, C)", "test_col", &record, &schema);
        match result {
            FormulaResult::Value(val) => {
                let sum: f64 = val.parse().unwrap();
                assert!((sum - 33.14).abs() < 0.001);
            }
            _ => panic!("Expected value, got error"),
        }
    }
}
