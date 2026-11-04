//! The formula parser and evaluator, with typed expression-local values.
//! Scalars, interpolation, references, collections and closures share one AST.
//! No collection or closure is a storage value.
use super::*;
use crate::color::{Color32, ColorFloat};
use crate::formula_diagnostics::{FormulaSourceContext, FormulaSourceLocation};
use crate::formula_memory::{SourceBudget, SourceReservation, TypedTableBacking};
use crate::ValueType;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
type Result<T> = std::result::Result<T, FormulaError>;
#[path = "formula_colors.rs"]
mod colors;
use colors::{color_channel, color_function};

#[derive(Clone, Debug)]
pub struct FormulaLimits {
    pub source_bytes: usize,
    pub syntax_depth: usize,
    pub call_depth: usize,
    pub steps: usize,
    pub collection_items: usize,
    pub allocated_bytes: usize,
    /// Deterministic source-read/parse weight, separate from expression temporaries.
    pub source_working_bytes: usize,
}
impl Default for FormulaLimits {
    fn default() -> Self {
        Self {
            source_bytes: 1_048_576,
            syntax_depth: 128,
            call_depth: 64,
            steps: 2_000_000,
            collection_items: 100_000,
            allocated_bytes: 64 * 1024 * 1024,
            source_working_bytes: 256 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct FormulaStatistics {
    pub parsed_nodes: usize,
    pub callback_calls: usize,
    pub charged_steps: usize,
    pub charged_bytes: usize,
    pub charged_source_bytes: usize,
    pub source_memory_live_bytes: usize,
    pub source_memory_peak_bytes: usize,
}
pub(super) struct Budget {
    pub limits: FormulaLimits,
    pub cancel: Option<Arc<AtomicBool>>,
    steps: usize,
    bytes: usize,
    source_budget: Option<Arc<SourceBudget>>,
    collections_active: bool,
    calls: usize,
    pub(super) parsed_nodes: usize,
    callback_calls: usize,
}
impl Default for Budget {
    fn default() -> Self {
        let limits = FormulaLimits::default();
        Self {
            source_budget: None,
            limits,
            cancel: None,
            steps: 0,
            bytes: 0,
            collections_active: false,
            calls: 0,
            parsed_nodes: 0,
            callback_calls: 0,
        }
    }
}
const STACK_RED_ZONE: usize = 256 * 1024;
const STACK_SEGMENT: usize = 2 * 1024 * 1024;
impl Budget {
    pub(super) fn guard_stack(&mut self) -> Result<()> {
        if stacker::remaining_stack().is_none_or(|left| left < STACK_RED_ZONE) {
            self.charge(0, STACK_SEGMENT)?;
        }
        Ok(())
    }

    pub(super) fn reset(&mut self) {
        self.steps = 0;
        self.bytes = 0;
        self.source_budget = None;
        self.collections_active = false;
        self.calls = 0;
        self.parsed_nodes = 0;
        self.callback_calls = 0;
    }
    pub(super) fn charge(&mut self, steps: usize, bytes: usize) -> Result<()> {
        if self
            .cancel
            .as_ref()
            .is_some_and(|v| v.load(Ordering::Relaxed))
        {
            return Err(FormulaError::Cancelled);
        }
        self.steps = self.steps.saturating_add(steps);
        self.bytes = self.bytes.saturating_add(bytes);
        if self.steps > self.limits.steps {
            return Err(FormulaError::ExecutionLimit(
                "Formula step budget exceeded".into(),
            ));
        }
        if self.bytes > self.limits.allocated_bytes {
            return Err(FormulaError::ExecutionLimit(
                "Formula allocation budget exceeded".into(),
            ));
        }
        Ok(())
    }
    fn items(&mut self, count: usize) -> Result<()> {
        if count > self.limits.collection_items {
            return Err(FormulaError::ExecutionLimit(
                "Collection item limit exceeded".into(),
            ));
        }
        self.charge(0, count.saturating_mul(std::mem::size_of::<Value>()))
    }
}
#[derive(Clone)]
pub enum Value {
    Number(Number),
    String(Arc<str>),
    Boolean(bool),
    Color32(Color32),
    ColorFloat(ColorFloat),
    Scalar(ValueType, Arc<str>),
    Reference {
        column: Arc<ColumnSchema>,
        value: Arc<str>,
    },
    TableReference {
        column: Arc<ColumnSchema>,
        value: Arc<str>,
    },
    Row {
        data: Arc<TypedTableBacking>,
        index: usize,
    },
    Record(Arc<Vec<(String, Value)>>),
    Collection(Arc<Vec<Value>>, Option<Arc<Kind>>),
    Optional(Option<Arc<Value>>, Arc<Kind>),
    Function(Arc<Function>),
}
#[derive(Clone, PartialEq)]
pub enum Kind {
    Number,
    String,
    Boolean,
    Color32,
    ColorFloat,
    Scalar(ValueType),
    Reference(String),
    TableReference,
    Row(String),
    Record(Vec<(String, Kind)>),
    Collection(Option<Box<Kind>>),
    Optional(Box<Kind>),
    Function,
}
#[derive(Clone)]
pub struct Function {
    params: Vec<String>,
    body: Arc<Expr>,
    env: Env,
    recursive: Option<String>,
}
#[derive(Clone, Default)]
struct Env(Option<Arc<Vec<(String, Value)>>>);
impl Env {
    fn with_bindings(bindings: Vec<(String, Value)>) -> Self {
        Self(Some(Arc::new(bindings)))
    }
}
impl std::ops::Deref for Env {
    type Target = [(String, Value)];
    fn deref(&self) -> &Self::Target {
        self.0.as_deref().map_or(&[], Vec::as_slice)
    }
}
#[derive(Clone)]
struct Expr {
    raw: String,
    location: Option<FormulaSourceLocation>,
    node: Node,
}
#[derive(Clone)]
enum Node {
    Number(Result<Number>),
    String(Vec<Part>),
    Name(String, bool),
    Array(Vec<Arc<Expr>>),
    Record(Vec<(String, Arc<Expr>)>),
    Lambda(Vec<String>, Arc<Expr>),
    Call(String, Vec<Arc<Expr>>),
    Field(Arc<Expr>, String),
    Unary(char, Arc<Expr>),
    Binary(&'static str, Arc<Expr>, Arc<Expr>),
    If(Arc<Expr>, Arc<Expr>, Arc<Expr>),
    Group(Arc<Expr>),
}
#[derive(Clone)]
enum Part {
    Text(String),
    Expression(Arc<Expr>),
}
fn error(s: impl Into<String>) -> FormulaError {
    FormulaError::TypeError(s.into())
}
fn parse_error(s: impl Into<String>) -> FormulaError {
    FormulaError::ParseError(s.into())
}
fn canonical(s: &str) -> String {
    s.to_uppercase()
}
impl Value {
    fn kind(&self) -> Kind {
        match self {
            Self::Number(_) => Kind::Number,
            Self::String(_) => Kind::String,
            Self::Boolean(_) => Kind::Boolean,
            Self::Color32(_) => Kind::Color32,
            Self::ColorFloat(_) => Kind::ColorFloat,
            Self::Scalar(k, _) => Kind::Scalar(k.clone()),
            Self::Reference { column, .. } => Kind::Reference(
                column
                    .reference_config
                    .as_ref()
                    .map(|c| {
                        uuid::Uuid::parse_str(&c.target_table_uuid)
                            .map(|id| id.to_string())
                            .unwrap_or_else(|_| c.target_table_uuid.clone())
                    })
                    .unwrap_or_default(),
            ),
            Self::TableReference { .. } => Kind::TableReference,
            Self::Row { data, .. } => Kind::Row(data.uuid.clone()),
            Self::Record(fields) => {
                let mut kinds: Vec<_> = fields
                    .iter()
                    .map(|(n, v)| (canonical(n), v.kind()))
                    .collect();
                kinds.sort_by(|a, b| a.0.cmp(&b.0));
                Kind::Record(kinds)
            }
            Self::Collection(_, kind) => {
                Kind::Collection(kind.as_ref().map(|k| Box::new((**k).clone())))
            }
            Self::Optional(_, kind) => Kind::Optional(Box::new((**kind).clone())),
            Self::Function(_) => Kind::Function,
        }
    }
    pub(super) fn text(&self, budget: &mut Budget) -> Result<String> {
        let bytes = match self {
            Self::String(s) | Self::Scalar(_, s) => s.len(),
            Self::Reference { value, .. } | Self::TableReference { value, .. } => value.len(),
            _ => 64,
        };
        budget.charge(0, bytes)?;
        match self {
            Self::Number(n) => Ok(n.text()),
            Self::String(s) | Self::Scalar(_, s) => Ok(s.to_string()),
            Self::Boolean(b) => Ok(b.to_string()),
            Self::Color32(color) => Ok(color.canonical_string()),
            Self::ColorFloat(color) => Ok(color.canonical_string()),
            Self::Reference { value, .. } | Self::TableReference { value, .. } => {
                Ok(value.to_string())
            }
            _ => Err(error(
                "Structured or function value cannot be used as a scalar",
            )),
        }
    }
    fn is_color(&self) -> bool {
        matches!(self, Self::Color32(_) | Self::ColorFloat(_))
    }
    fn number(&self) -> Result<Number> {
        if let Self::Number(n) = self {
            Ok(*n)
        } else {
            match self {
                Self::String(s) | Self::Scalar(_, s) => Number::required(s),
                Self::Boolean(b) => Err(error(format!("Boolean {b} is not numeric"))),
                Self::Reference { value, .. } | Self::TableReference { value, .. } => {
                    Number::required(value)
                }
                _ => Err(error("Structured value is not numeric")),
            }
        }
    }
    fn truth(&self) -> Result<bool> {
        match self {
            Self::Number(Number::Integer(n)) => Ok(*n != 0),
            Self::Number(Number::Float(n)) => Ok(*n != 0.0),
            Self::Boolean(b) => Ok(*b),
            Self::String(s) | Self::Scalar(_, s) => Ok(FormulaEngine::truthy(s)),
            Self::Reference { value, .. } | Self::TableReference { value, .. } => {
                Ok(FormulaEngine::truthy(value))
            }
            _ => Err(error("Structured value cannot be used as a condition")),
        }
    }
    fn collection(&self) -> Result<(&[Value], Option<Arc<Kind>>)> {
        if let Self::Collection(v, k) = self {
            Ok((v, k.clone()))
        } else {
            Err(error("Expected a collection"))
        }
    }
    fn function(&self, allowed: &[usize], name: &str) -> Result<Arc<Function>> {
        match self {
            Self::Function(f) if allowed.contains(&f.params.len()) => Ok(f.clone()),
            Self::Function(_) => Err(FormulaError::ArgumentError(format!(
                "{name}: invalid callback argument count"
            ))),
            _ => Err(error(format!("{name} requires a lambda or local function"))),
        }
    }
}
fn compatible(a: &Kind, b: &Kind) -> bool {
    match (a, b) {
        (Kind::Collection(a), Kind::Collection(b)) => a
            .as_ref()
            .zip(b.as_ref())
            .is_none_or(|(a, b)| compatible(a, b)),
        (Kind::Optional(a), Kind::Optional(b)) => compatible(a, b),
        (Kind::Record(a), Kind::Record(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b)
                    .all(|((n, a), (m, b))| n == m && compatible(a, b))
        }
        _ => a == b,
    }
}
// Compatibility permits unknown empty collection element kinds. Refine those
// unknowns after every accepted element, including nested record fields.
fn refine_kind(current: &mut Kind, next: &Kind) {
    match (current, next) {
        (Kind::Collection(a), Kind::Collection(Some(next))) => {
            if let Some(current) = a {
                refine_kind(current, next);
            } else {
                *a = Some(next.clone());
            }
        }
        (Kind::Record(a), Kind::Record(b)) => {
            for ((_, current), (_, next)) in a.iter_mut().zip(b) {
                refine_kind(current, next);
            }
        }
        (Kind::Optional(a), Kind::Optional(b)) => refine_kind(a, b),
        _ => {}
    }
}

fn element_kind(v: &Value) -> Result<Kind> {
    match v {
        Value::Collection(..) | Value::Function(..) | Value::Optional(..) => Err(error(
            "Collection elements must be scalar, Reference, or record",
        )),
        _ => Ok(v.kind()),
    }
}
fn collection(values: Vec<Value>, kind: Option<Arc<Kind>>) -> Result<Value> {
    collection_indexed(values, kind).map_err(|(_, error)| error)
}
fn collection_indexed(
    values: Vec<Value>,
    mut kind: Option<Arc<Kind>>,
) -> std::result::Result<Value, (usize, FormulaError)> {
    for (index, value) in values.iter().enumerate() {
        let next = element_kind(value).map_err(|error| {
            (
                index,
                match error {
                    FormulaError::TypeError(message) => FormulaError::TypeError(format!(
                        "{message} at element index {index} (zero-based)"
                    )),
                    other => other,
                },
            )
        })?;
        if let Some(k) = &mut kind {
            if !compatible(k, &next) {
                return Err((index, error(format!(
                    "Collection elements have incompatible types or fields at element index {index} (zero-based)"
                ))));
            }
            refine_kind(Arc::make_mut(k), &next);
        } else {
            kind = Some(Arc::new(next));
        }
    }
    Ok(Value::Collection(Arc::new(values), kind))
}

fn name(s: &str) -> Result<String> {
    let s = s.trim();
    if s.starts_with('`') && s.ends_with('`') && s.len() >= 2 {
        return Ok(s[1..s.len() - 1].replace("``", "`"));
    }
    if s.is_empty()
        || s.chars()
            .any(|c| c.is_whitespace() || "[]{}(),:+-*/<>=!?&|.\"`".contains(c))
    {
        return Err(parse_error("Invalid local or field name"));
    }
    Ok(s.into())
}
fn parse(
    s: &str,
    depth: usize,
    budget: &mut Budget,
    schema: &TableSchema,
    source: Option<&FormulaSourceContext>,
    diagnostic: &mut Option<FormulaSourceLocation>,
) -> Result<Arc<Expr>> {
    let previous_diagnostic = diagnostic.clone();
    let result = budget.guard_stack().and_then(|()| {
        stacker::maybe_grow(STACK_RED_ZONE, STACK_SEGMENT, || {
            parse_body(s, depth, budget, schema, source, diagnostic)
        })
    });
    // A complete column name is a grammar atom even when it contains spaces,
    // delimiters, or operator characters. When it also forms an expression,
    // keep that AST so local bindings can take precedence during evaluation.
    if matches!(&result, Err(FormulaError::ParseError(_))) {
        let name = s.trim();
        if !name.is_empty()
            && schema.columns.iter().any(|column| {
                names_equal(&column.data_name, name) || names_equal(&column.display_name, name)
            })
        {
            *diagnostic = previous_diagnostic;
            return Ok(Arc::new(Expr {
                raw: String::new(),
                location: source.and_then(|context| context.location(name)),
                node: Node::Name(name.into(), false),
            }));
        }
    }
    if result.is_err() && diagnostic.is_none() {
        *diagnostic = source.and_then(|context| context.location(s.trim()));
    }
    result
}
fn parse_body(
    s: &str,
    depth: usize,
    budget: &mut Budget,
    schema: &TableSchema,
    source: Option<&FormulaSourceContext>,
    diagnostic: &mut Option<FormulaSourceLocation>,
) -> Result<Arc<Expr>> {
    if depth >= budget.limits.syntax_depth.min(128) {
        return Err(FormulaError::ExecutionLimit(
            "Formula syntax depth exceeded".into(),
        ));
    }
    let s = s.trim();
    if s.is_empty() {
        return Err(parse_error("Missing expression"));
    }
    budget.parsed_nodes += 1;
    budget.charge(1, s.len().saturating_mul(24).saturating_add(128))?;
    // Numeric atoms need neither tokenization nor a schema name scan. Keep
    // range/type failures in the AST so unselected branches still stay lazy.
    let number = match Number::parse(s) {
        Ok(Some(number)) => Some(Ok(number)),
        Ok(None) => None,
        Err(error) => Some(Err(error)),
    };
    if let Some(number) = number {
        return Ok(Arc::new(Expr {
            raw: String::new(),
            location: source.and_then(|context| context.location(s)),
            node: Node::Number(number),
        }));
    }
    let mut sub = |s: &str, mapping: Option<&FormulaSourceContext>| {
        parse(s, depth + 1, budget, schema, mapping, diagnostic)
    };
    let tokens = FormulaEngine::top_level_tokens(s)?;
    let mut skip = None;
    for &(i, ch) in tokens.iter() {
        if ch == '&' || ch == '|' {
            if skip == Some(i) {
                skip = None;
                continue;
            }
            if s.as_bytes().get(i + 1) != Some(&(ch as u8))
                || s.as_bytes().get(i + 2) == Some(&(ch as u8))
            {
                // Operator characters are legal in a complete display name.
                // Only the malformed-operator case needs this schema lookup.
                if FormulaEngine::named_column(schema, s).is_err() {
                    return Err(parse_error("Logical operators require exactly && or ||"));
                }
                break;
            }
            skip = Some(i + 1);
        }
    }
    let node = if let Some(&(i, _)) = tokens
        .iter()
        .find(|&&(i, c)| c == '=' && s[i..].starts_with("=>"))
    {
        let p = s[..i].trim();
        let p = if p.starts_with('(') && p.ends_with(')') {
            &p[1..p.len() - 1]
        } else {
            p
        };
        let params = FormulaEngine::split_function_args(p)?
            .into_iter()
            .map(name)
            .collect::<Result<Vec<_>>>()?;
        if params.is_empty() {
            return Err(parse_error("Lambda requires parameters"));
        }
        let mut names = HashSet::new();
        if params.iter().any(|p| !names.insert(canonical(p))) {
            return Err(parse_error("Duplicate lambda parameter"));
        }
        Node::Lambda(params, sub(&s[i + 2..], source)?)
    } else if tokens.len() == 2 && tokens[0] == (0, '"') && tokens[1] == (s.len() - 1, '"') {
        let raw = &s[1..s.len() - 1];
        let text = if raw.contains("\"\"") {
            std::borrow::Cow::Owned(raw.replace("\"\"", "\""))
        } else {
            std::borrow::Cow::Borrowed(raw)
        };
        if raw.contains("\"\"") && source.is_some() {
            budget.charge(
                0,
                text.len()
                    .saturating_add(1)
                    .saturating_mul(std::mem::size_of::<usize>()),
            )?;
        }
        let mapped = source.and_then(|context| context.remap_doubled_quotes(raw, &text));
        let mut parts = Vec::new();
        let mut literal = String::new();
        let mut i = 0;
        while i < text.len() {
            if text[i..].starts_with("$${") {
                literal.push_str("${");
                i += 3;
            } else if text[i..].starts_with("${") {
                if !literal.is_empty() {
                    parts.push(Part::Text(std::mem::take(&mut literal)));
                }
                let start = i + 2;
                let mut nesting = 1;
                let mut quote = None;
                let mut chars = text[start..].char_indices().peekable();
                let mut end = None;
                while let Some((offset, ch)) = chars.next() {
                    if let Some(q) = quote {
                        if ch == q {
                            if chars.peek().is_some_and(|(_, n)| *n == q) {
                                chars.next();
                            } else {
                                quote = None;
                            }
                        }
                    } else if ch == '"' || ch == '`' {
                        quote = Some(ch);
                    } else if ch == '{' {
                        nesting += 1;
                    } else if ch == '}' {
                        nesting -= 1;
                        if nesting == 0 {
                            end = Some(start + offset);
                            break;
                        }
                    }
                }
                let end = end.ok_or_else(|| parse_error("Unclosed interpolation"))?;
                parts.push(Part::Expression(parse(
                    &text[start..end],
                    depth + 1,
                    budget,
                    schema,
                    mapped.as_ref(),
                    diagnostic,
                )?));
                i = end + 1;
            } else {
                let ch = text[i..].chars().next().unwrap();
                literal.push(ch);
                i += ch.len_utf8();
            }
        }
        if !literal.is_empty() {
            parts.push(Part::Text(literal));
        }
        Node::String(parts)
    } else if let Some(&(q, _)) = tokens.iter().find(|(_, c)| *c == '?') {
        let mut n = 0;
        let mut colon = None;
        for &(i, c) in tokens.iter() {
            if i < q {
                continue;
            }
            if c == '?' {
                n += 1;
            } else if c == ':' {
                n -= 1;
                if n == 0 {
                    colon = Some(i);
                    break;
                }
            }
        }
        let c = colon.ok_or_else(|| parse_error("Conditional requires ':'"))?;
        Node::If(
            sub(&s[..q], source)?,
            sub(&s[q + 1..c], source)?,
            sub(&s[c + 1..], source)?,
        )
    } else {
        let mut binary = None;
        'outer: for ops in ["|", "&", "<>=!", "+-", "*/"] {
            for &(i, c) in tokens.iter().rev() {
                if !ops.contains(c) || c == '!' {
                    continue;
                }
                if (c == '+' || c == '-') && FormulaEngine::is_unary_or_exponent_sign(s, i) {
                    continue;
                }
                let mut start = i;
                let mut end = i + 1;
                if c == '|' || c == '&' {
                    if i == 0 || s.as_bytes()[i - 1] != c as u8 {
                        continue;
                    }
                    start -= 1;
                } else if ops == "<>=!"
                    && i > 0
                    && matches!(
                        &s.as_bytes()[i - 1..=i],
                        b">=" | b"<=" | b"==" | b"!=" | b"<>"
                    )
                {
                    start -= 1;
                }
                if c == '=' && s.as_bytes().get(i + 1) == Some(&b'>') {
                    end += 1;
                }
                binary = Some(Node::Binary(
                    match &s[start..end] {
                        "+" => "+",
                        "-" => "-",
                        "*" => "*",
                        "/" => "/",
                        "&&" => "&&",
                        "||" => "||",
                        "=" => "=",
                        "==" => "==",
                        "!=" => "!=",
                        "<>" => "<>",
                        "<" => "<",
                        ">" => ">",
                        "<=" => "<=",
                        ">=" => ">=",
                        _ => return Err(parse_error("Invalid binary operator")),
                    },
                    sub(&s[..start], source)?,
                    sub(&s[end..], source)?,
                ));
                break 'outer;
            }
        }
        if let Some(n) = binary {
            n
        } else if s.starts_with('(') && s.ends_with(')') && tokens.len() == 2 {
            Node::Group(sub(&s[1..s.len() - 1], source)?)
        } else if s.starts_with('[') && s.ends_with(']') && tokens.len() == 2 {
            Node::Array(
                FormulaEngine::split_function_args(&s[1..s.len() - 1])?
                    .into_iter()
                    .map(|value| sub(value, source))
                    .collect::<Result<_>>()?,
            )
        } else if s.starts_with('{') && s.ends_with('}') && tokens.len() == 2 {
            let mut fields = Vec::new();
            let mut seen = HashSet::new();
            for f in FormulaEngine::split_function_args(&s[1..s.len() - 1])? {
                let ts = FormulaEngine::top_level_tokens(f)?;
                let i = ts
                    .iter()
                    .find(|(_, c)| *c == ':')
                    .map(|x| x.0)
                    .ok_or_else(|| parse_error("Record field requires ':'"))?;
                let key = name(&f[..i])?;
                if !seen.insert(canonical(&key)) {
                    return Err(parse_error("Duplicate record field"));
                }
                fields.push((key, sub(&f[i + 1..], source)?));
            }
            Node::Record(fields)
        } else if s.starts_with(['!', '-', '+']) {
            Node::Unary(s.chars().next().unwrap(), sub(&s[1..], source)?)
        } else if let Some(&(i, _)) = tokens.iter().rev().find(|(_, c)| *c == '.') {
            Node::Field(sub(&s[..i], source)?, name(&s[i + 1..])?)
        } else if let Some(&(i, _)) = tokens.iter().find(|(_, c)| *c == '(') {
            if !s.ends_with(')') {
                return Err(parse_error("Invalid function call"));
            }
            Node::Call(
                name(&s[..i])?,
                FormulaEngine::split_function_args(&s[i + 1..s.len() - 1])?
                    .into_iter()
                    .map(|value| sub(value, source))
                    .collect::<Result<_>>()?,
            )
        } else {
            // Ordinary names are grammar atoms independently of the schema.
            // The parse wrapper handles legal display names with punctuation.
            Node::Name(name(s)?, s.starts_with('`'))
        }
    };
    Ok(Arc::new(Expr {
        raw: if matches!(node, Node::String(_) | Node::Name(_, false)) {
            String::new()
        } else {
            s.into()
        },
        location: source.and_then(|context| context.location(s)),
        node,
    }))
}

fn uses_bindings(e: &Expr, env: &Env) -> bool {
    if env.is_empty() {
        return false;
    }
    let bound = |n: &str| env.iter().any(|(k, _)| names_equal(k, n));
    match &e.node {
        Node::Name(n, false) => bound(n),
        Node::Group(e) | Node::Unary(_, e) | Node::Field(e, _) => uses_bindings(e, env),
        Node::Binary(_, a, b) => uses_bindings(a, env) || uses_bindings(b, env),
        Node::If(a, b, c) => {
            uses_bindings(a, env) || uses_bindings(b, env) || uses_bindings(c, env)
        }
        Node::Call(n, args) => bound(n) || args.iter().any(|e| uses_bindings(e, env)),
        Node::Array(args) => args.iter().any(|e| uses_bindings(e, env)),
        Node::Record(fields) => fields.iter().any(|(_, e)| uses_bindings(e, env)),
        _ => false,
    }
}

impl FormulaEngine<'_> {
    pub fn limits(&self) -> &FormulaLimits {
        &self.budget.limits
    }
    pub(crate) fn cancellation_token(&self) -> Option<Arc<AtomicBool>> {
        self.budget.cancel.clone()
    }
    pub fn statistics(&self) -> FormulaStatistics {
        FormulaStatistics {
            parsed_nodes: self.budget.parsed_nodes,
            callback_calls: self.budget.callback_calls,
            charged_steps: self.budget.steps,
            charged_bytes: self.budget.bytes,
            charged_source_bytes: self.budget.source_budget.as_ref().map_or(0, |p| p.total()),
            source_memory_live_bytes: self.budget.source_budget.as_ref().map_or(0, |p| p.used()),
            source_memory_peak_bytes: self.budget.source_budget.as_ref().map_or(0, |p| p.peak()),
        }
    }
    pub fn set_limits(&mut self, limits: FormulaLimits) {
        self.budget.limits = limits;
    }
    pub fn set_cancellation(&mut self, cancel: Option<Arc<AtomicBool>>) {
        self.budget.cancel = cancel;
    }
    pub(crate) fn charge_collection_items(&mut self, count: usize) -> Result<()> {
        self.budget.items(count)
    }
    pub(crate) fn source_budget(&mut self) -> Arc<SourceBudget> {
        self.budget
            .source_budget
            .get_or_insert_with(|| {
                Arc::new(SourceBudget::new(self.budget.limits.source_working_bytes))
            })
            .clone()
    }
    pub(crate) fn requires_collection_budget(&self) -> bool {
        self.budget.collections_active
    }
    pub(crate) fn reserve_source_memory(&mut self, bytes: usize) -> Result<SourceReservation> {
        self.budget.charge(1, 0)?;
        self.source_budget().reserve(bytes)
    }
    pub(crate) fn charge_work(&mut self, steps: usize, bytes: usize) -> Result<()> {
        self.budget.charge(steps, bytes)
    }
    pub(super) fn evaluate_expression(
        &mut self,
        s: &str,
        record: &Record,
        schema: &TableSchema,
    ) -> Result<Value> {
        if s.len() > self.budget.limits.source_bytes {
            return Err(FormulaError::ExecutionLimit(
                "Formula source length exceeded".into(),
            ));
        }
        self.budget.charge(0, s.len().saturating_mul(8))?;
        let source = self.source_context();
        let mut diagnostic = None;
        let expr = parse(
            s,
            0,
            &mut self.budget,
            schema,
            source.as_ref(),
            &mut diagnostic,
        )
        .inspect_err(|_| {
            self.record_diagnostic(diagnostic.as_ref(), "parse");
        })?;
        if !self.budget.collections_active && expr.requires_collection_snapshot() {
            self.budget.collections_active = true;
            if let Some(context) = self.context {
                context.begin_collection_snapshot(self)?;
            }
        }
        self.eval(&expr, &Env::default(), record, schema)
    }
    fn eval(
        &mut self,
        e: &Arc<Expr>,
        env: &Env,
        record: &Record,
        schema: &TableSchema,
    ) -> Result<Value> {
        if self.expression_depth >= self.budget.limits.syntax_depth.min(128) {
            self.record_diagnostic(e.location.as_ref(), "evaluation depth");
            return Err(FormulaError::ExecutionLimit(
                "Combined expression/call/dependency stack depth exceeded".into(),
            ));
        }
        self.expression_depth += 1;
        let result = self.budget.guard_stack().and_then(|()| {
            stacker::maybe_grow(STACK_RED_ZONE, STACK_SEGMENT, || {
                self.eval_body(e, env, record, schema)
            })
        });
        self.expression_depth -= 1;
        if result.is_err() {
            let operation = match &e.node {
                Node::Call(name, _) => name.as_str(),
                Node::Binary(operator, _, _) => operator,
                Node::Unary('+', _) => "unary +",
                Node::Unary('-', _) => "unary -",
                Node::Unary(_, _) => "unary operator",
                Node::Field(_, _) => "field access",
                Node::Name(_, _) => "column or local reference",
                Node::If(_, _, _) => "conditional",
                Node::String(_) => "interpolation",
                Node::Array(_) => "collection",
                Node::Record(_) => "record",
                Node::Lambda(_, _) => "lambda",
                Node::Group(_) => "group",
                Node::Number(_) => "number",
            };
            self.record_diagnostic(e.location.as_ref(), operation);
        }
        result
    }
    fn eval_body(
        &mut self,
        e: &Arc<Expr>,
        env: &Env,
        record: &Record,
        schema: &TableSchema,
    ) -> Result<Value> {
        self.budget.charge(1, 0)?;
        if let Node::Name(n, false) = &e.node {
            if let Some((_, v)) = env.iter().rev().find(|(k, _)| names_equal(k, n)) {
                return Ok(v.clone());
            }
        }
        if !matches!(e.node, Node::Number(_) | Node::String(_)) && !uses_bindings(e, env) {
            let raw = match &e.node {
                Node::Name(name, false) => name,
                _ => &e.raw,
            };
            let mut columns = schema
                .columns
                .iter()
                .filter(|c| names_equal(&c.data_name, raw) || names_equal(&c.display_name, raw));
            if let Some(c) = columns.next() {
                if columns.next().is_some() {
                    return Err(FormulaError::InvalidReference(format!(
                        "Ambiguous column reference: {}",
                        raw
                    )));
                }
                return self.typed_column(c, record, schema);
            }
        }
        match &e.node {
            Node::Number(number) => number.clone().map(Value::Number),
            Node::String(parts) => {
                let mut text = String::new();
                for part in parts {
                    let value = match part {
                        Part::Text(t) => {
                            self.budget.charge(0, t.len())?;
                            text.push_str(t);
                            continue;
                        }
                        Part::Expression(e) => {
                            let value = self.eval(e, env, record, schema)?;
                            if value.is_color() {
                                self.record_diagnostic(
                                    e.location.as_ref(),
                                    "interpolation scalar output",
                                );
                                return Err(error(
                                    "Color interpolation requires an explicit channel selection",
                                ));
                            }
                            value.text(&mut self.budget).inspect_err(|_| {
                                self.record_diagnostic(
                                    e.location.as_ref(),
                                    "interpolation scalar output",
                                );
                            })?
                        }
                    };
                    self.budget.charge(0, value.len())?;
                    text.push_str(&value);
                }
                Ok(Value::String(text.into()))
            }
            Node::Name(n, quoted) => {
                if !quoted {
                    if names_equal(n, "true") {
                        return Ok(Value::Boolean(true));
                    }
                    if names_equal(n, "false") {
                        return Ok(Value::Boolean(false));
                    }
                }
                let column = Self::named_column(schema, n)?;
                self.typed_column(column, record, schema)
            }
            Node::Group(e) => self.eval(e, env, record, schema),
            Node::Array(items) => {
                self.budget.items(items.len())?;
                let mut values = Vec::with_capacity(items.len());
                for item in items {
                    values.push(self.eval(item, env, record, schema)?);
                }
                collection_indexed(values, None).map_err(|(index, error)| {
                    self.record_diagnostic(items[index].location.as_ref(), "collection element");
                    self.record_callback_diagnostic("collection", Some(index), None, None);
                    error
                })
            }
            Node::Record(fields) => {
                self.budget.charge(0, fields.len() * 96)?;
                let mut values = Vec::with_capacity(fields.len());
                for (name, e) in fields {
                    let v = self.eval(e, env, record, schema)?;
                    if matches!(v, Value::Function(_)) {
                        return Err(error("Record fields cannot contain functions"));
                    }
                    values.push((name.clone(), v));
                }
                Ok(Value::Record(Arc::new(values)))
            }
            Node::Lambda(params, body) => {
                self.budget
                    .charge(0, 128 + params.iter().map(String::len).sum::<usize>())?;
                Ok(Value::Function(Arc::new(Function {
                    params: params.clone(),
                    body: body.clone(),
                    env: env.clone(),
                    recursive: None,
                })))
            }
            Node::Field(base, name) => {
                let value = self.eval(base, env, record, schema)?;
                self.field(&value, name)
            }
            Node::If(c, a, b) => {
                let truth = self.eval(c, env, record, schema)?.truth()?;
                self.eval(if truth { a } else { b }, env, record, schema)
            }
            Node::Unary(op, e) => {
                let v = self.eval(e, env, record, schema)?;
                if *op == '!' {
                    return Ok(Value::Boolean(!v.truth()?));
                }
                let n = v.number()?;
                Ok(Value::Number(if *op == '-' {
                    Number::Integer(0).binary(n, '-')?
                } else {
                    n
                }))
            }
            Node::Binary(op, l, r) => {
                let left = self.eval(l, env, record, schema)?;
                if *op == "&&" || *op == "||" {
                    let truth = left.truth()?;
                    return if (*op == "&&" && !truth) || (*op == "||" && truth) {
                        Ok(Value::Boolean(truth))
                    } else {
                        Ok(Value::Boolean(self.eval(r, env, record, schema)?.truth()?))
                    };
                }
                let right = self.eval(r, env, record, schema)?;
                if left.is_color() || right.is_color() {
                    return match *op {
                        "=" | "==" => Ok(Value::Boolean(same(&left, &right)?)),
                        "!=" | "<>" => Ok(Value::Boolean(!same(&left, &right)?)),
                        _ => Err(error("Colors require explicit color functions; ordering and arithmetic operators are not supported")),
                    };
                }
                if let (Value::Number(left), Value::Number(right)) = (&left, &right) {
                    // Preserve the deterministic budget of the former two
                    // scalar renderings without allocating or reparsing them.
                    self.budget.charge(0, 64)?;
                    self.budget.charge(0, 64)?;
                    if ["=", "==", "!=", "<>", "<", ">", "<=", ">="].contains(op) {
                        return Ok(Value::Boolean(Self::compare_ordering(
                            left.comparison_value().compare(right.comparison_value())?,
                            op,
                        )));
                    }
                    return Ok(Value::Number(
                        left.binary(*right, op.chars().next().unwrap())?,
                    ));
                }
                let a = left.text(&mut self.budget)?;
                let b = right.text(&mut self.budget)?;
                if ["=", "==", "!=", "<>", "<", ">", "<=", ">="].contains(op) {
                    return Ok(Value::Boolean(Self::compare_values(&a, &b, op)?));
                }
                let x = Number::parse(&a)?;
                let y = Number::parse(&b)?;
                if *op == "+" && (x.is_none() || y.is_none()) {
                    self.budget.charge(0, a.len().saturating_add(b.len()))?;
                    return Ok(Value::String(format!("{a}{b}").into()));
                }
                Ok(Value::Number(
                    left.number()?
                        .binary(right.number()?, op.chars().next().unwrap())?,
                ))
            }
            Node::Call(name, args) => self.call(name, args, env, record, schema),
        }
    }
    pub(super) fn validate_output(
        &mut self,
        value: &Value,
        destination: &ColumnSchema,
    ) -> Result<()> {
        if matches!(
            destination.data_type,
            ValueType::Color32 | ValueType::ColorFloat
        ) || value.is_color()
        {
            return if matches!(
                (&destination.data_type, value),
                (ValueType::Color32, Value::Color32(_))
                    | (ValueType::ColorFloat, Value::ColorFloat(_))
            ) {
                Ok(())
            } else {
                Err(error("Color output requires a matching color column; use COLOR_TO_FLOAT or COLOR_TO_BYTE explicitly"))
            };
        }
        match value {
            Value::Reference { column, .. } => {
                let source = column
                    .reference_config
                    .as_ref()
                    .map(|c| c.target_table_uuid.as_str());
                let target = destination
                    .reference_config
                    .as_ref()
                    .map(|c| c.target_table_uuid.as_str());
                if destination.data_type != ValueType::Reference
                    || !source
                        .zip(target)
                        .is_some_and(|(a, b)| identity_equal(a, b))
                {
                    return Err(error(
                        "Reference result is incompatible with destination target",
                    ));
                }
            }
            Value::TableReference { column, .. } => {
                if destination.data_type != ValueType::TableRef {
                    return Err(error("TableRef result requires a TableRef destination"));
                }
                if self.context.is_none() && column.table_ref_config != destination.table_ref_config
                {
                    return Err(error(
                        "TableRef result is incompatible with destination interface",
                    ));
                }
            }
            _ => {}
        }
        if let Some(context) = self.context {
            context.validate_typed_output(self, value, destination)?;
        }
        Ok(())
    }
    fn typed_column(
        &mut self,
        c: &ColumnSchema,
        row: &Record,
        schema: &TableSchema,
    ) -> Result<Value> {
        let table_uuid = self.table_uuid.clone();
        let input = self.effective_input(&table_uuid, row, c)?;
        let result = self.budget.charge(0, input.len()).and_then(|()| {
            let value = self.resolve_reference(c, row, schema)?;
            self.typed_scalar(c, value)
        });
        if result.is_err() {
            let table = self.table_uuid.clone();
            self.record_cell_diagnostic(&table, Some(&row.uuid), Some(&c.uuid), "cell value");
        }
        result
    }
    pub(crate) fn typed_scalar(&mut self, c: &ColumnSchema, value: String) -> Result<Value> {
        self.budget
            .charge(0, value.len().saturating_mul(3).saturating_add(128))?;
        let reference_bytes = c
            .reference_config
            .as_ref()
            .map_or(0, |c| c.target_table_uuid.len());
        let table_ref_bytes = c
            .table_ref_config
            .as_ref()
            .map_or(0, |c| c.interface_uuid.len());
        self.budget
            .charge(0, reference_bytes.saturating_add(table_ref_bytes))?;
        let value = c.validate_value(&value).map_err(|e| error(e.to_string()))?;
        let value = formula_operand(c, value)?;
        Ok(match c.data_type {
            ValueType::String => Value::String(value.into()),
            ValueType::Boolean => Value::Boolean(Self::truthy(&value)),
            ValueType::Color32 => Value::Color32(Color32::parse(&value).map_err(error)?),
            ValueType::ColorFloat => Value::ColorFloat(ColorFloat::parse(&value).map_err(error)?),
            ValueType::U8
            | ValueType::I8
            | ValueType::U16
            | ValueType::I16
            | ValueType::U32
            | ValueType::I32
            | ValueType::U64
            | ValueType::I64
            | ValueType::F32
            | ValueType::F64 => Value::Number(Number::required(&value)?),
            ValueType::Reference => Value::Reference {
                column: Arc::new(ColumnSchema {
                    data_type: c.data_type.clone(),
                    reference_config: c.reference_config.as_ref().map(|r| crate::ReferenceConfig {
                        target_table_uuid: r.target_table_uuid.clone(),
                        display_column_uuid: None,
                    }),
                    table_ref_config: c.table_ref_config.clone(),
                    ..ColumnSchema::default()
                }),
                value: value.into(),
            },
            ValueType::TableRef => Value::TableReference {
                column: Arc::new(ColumnSchema {
                    data_type: c.data_type.clone(),
                    reference_config: c.reference_config.as_ref().map(|r| crate::ReferenceConfig {
                        target_table_uuid: r.target_table_uuid.clone(),
                        display_column_uuid: None,
                    }),
                    table_ref_config: c.table_ref_config.clone(),
                    ..ColumnSchema::default()
                }),
                value: value.into(),
            },
            _ => Value::Scalar(c.data_type.clone(), value.into()),
        })
    }
    fn record_input_row(&mut self, value: &Value, operation: &str) {
        match value {
            Value::Row { data, index } => self.record_cell_diagnostic(
                &data.uuid,
                Some(&data.records[*index].uuid),
                None,
                operation,
            ),
            Value::Optional(Some(value), _) => self.record_input_row(value, operation),
            _ => {}
        }
    }
    fn field(&mut self, value: &Value, name: &str) -> Result<Value> {
        match value {
            Value::Color32(color) => Ok(Value::Number(Number::Integer(
                color.channels()[color_channel(name)?] as i128,
            ))),
            Value::ColorFloat(color) => Ok(Value::Number(Number::Float(
                color.channels()[color_channel(name)?] as f64,
            ))),
            Value::Record(fields) => fields
                .iter()
                .find(|(n, _)| names_equal(n, name))
                .map(|(_, v)| v.clone())
                .ok_or_else(|| {
                    FormulaError::InvalidReference(format!("Record field not found: {name}"))
                }),
            Value::Optional(Some(row), _) => self.field(row, name),
            Value::Optional(None, _) => Err(FormulaError::InvalidReference(format!(
                "Cannot read '{name}' from an absent JOIN row"
            ))),
            Value::Row { data, index } => {
                let c = Self::named_column(&data.schema, name).inspect_err(|_| {
                    self.record_cell_diagnostic(
                        &data.uuid,
                        Some(&data.records[*index].uuid),
                        None,
                        "missing or ambiguous row field",
                    );
                })?;
                let previous = std::mem::replace(&mut self.table_uuid, data.uuid.clone());
                let result = self.typed_column(c, &data.records[*index], &data.schema);
                self.table_uuid = previous;
                result
            }
            Value::Reference { column, value } => {
                let context = self.context.ok_or_else(|| {
                    FormulaError::InvalidReference("Reference requires project context".into())
                })?;
                context.evaluate_reference(self, column, value, name)
            }
            _ => Err(error("Field access requires a color, record or Reference")),
        }
    }
    fn invoke(
        &mut self,
        f: &Arc<Function>,
        args: Vec<Value>,
        record: &Record,
        schema: &TableSchema,
    ) -> Result<Value> {
        if args.len() != f.params.len() {
            return Err(FormulaError::ArgumentError(
                "Local function argument count mismatch".into(),
            ));
        }
        if self.budget.calls >= self.budget.limits.call_depth.min(64) {
            return Err(FormulaError::ExecutionLimit(
                "Function call depth exceeded".into(),
            ));
        }
        self.budget.charge(1, (f.env.len() + args.len() + 1) * 64)?;
        let mut bindings = f.env.to_vec();
        if let Some(name) = &f.recursive {
            bindings.push((name.clone(), Value::Function(f.clone())));
        }
        bindings.extend(f.params.iter().cloned().zip(args));
        self.budget.calls += 1;
        self.budget.callback_calls += 1;
        let result = self.eval(&f.body, &Env::with_bindings(bindings), record, schema);
        self.budget.calls -= 1;
        result
    }
    fn call(
        &mut self,
        name: &str,
        args: &[Arc<Expr>],
        env: &Env,
        record: &Record,
        schema: &TableSchema,
    ) -> Result<Value> {
        if let Some((_, value)) = env.iter().rev().find(|(n, _)| names_equal(n, name)) {
            let f = value.function(&[args.len()], name)?;
            let mut values = Vec::new();
            for a in args {
                values.push(self.eval(a, env, record, schema)?);
            }
            return self.invoke(&f, values, record, schema);
        }
        let upper = canonical(name);
        let count = |n| {
            if args.len() == n {
                Ok(())
            } else {
                Err(FormulaError::ArgumentError(format!(
                    "{name} requires {n} arguments"
                )))
            }
        };
        match upper.as_str() {
            "IF" => {
                count(3)?;
                let c = self.eval(&args[0], env, record, schema)?.truth()?;
                return self.eval(&args[if c { 1 } else { 2 }], env, record, schema);
            }
            "LET" | "LETREC" => {
                count(3)?;
                let Node::Name(binding, false) = &args[0].node else {
                    return Err(parse_error(
                        "LET/LETREC first argument must be a binding name",
                    ));
                };
                let value = self.eval(&args[1], env, record, schema)?;
                let value = if upper == "LETREC" {
                    let Value::Function(f) = value else {
                        return Err(error("LETREC requires a function"));
                    };
                    let mut f = (*f).clone();
                    f.recursive = Some(binding.clone());
                    Value::Function(Arc::new(f))
                } else {
                    value
                };
                let mut next = env.to_vec();
                next.push((binding.clone(), value));
                return self.eval(&args[2], &Env::with_bindings(next), record, schema);
            }
            _ => {}
        }
        let mut values = Vec::with_capacity(args.len());
        for a in args {
            values.push(self.eval(a, env, record, schema)?);
        }
        match upper.as_str() {
            "COLOR32" | "COLORFLOAT" | "COLOR_TO_FLOAT" | "COLOR_TO_BYTE" | "SRGB_TO_LINEAR"
            | "LINEAR_TO_SRGB" | "GAMMA_DECODE" | "GAMMA_ENCODE" | "EXPOSURE" | "LERP_COLOR"
            | "CLAMP_COLOR" => color_function(&upper, &values),
            "SEQUENCE" => {
                count(1)?;
                let text = values[0].text(&mut self.budget)?;
                let n = match Number::required(&text)? {
                    Number::Integer(n) if n >= 0 => {
                        usize::try_from(n).map_err(|_| error("SEQUENCE count is too large"))?
                    }
                    _ => return Err(error("SEQUENCE count must be a nonnegative integer")),
                };
                self.budget.items(n)?;
                self.budget.charge(n, 0)?;
                collection(
                    (1..=n)
                        .map(|n| Value::Number(Number::Integer(n as i128)))
                        .collect(),
                    Some(Arc::new(Kind::Number)),
                )
            }
            "MAP" | "FILTER" | "REDUCE" | "GROUPBY" => {
                count(if upper == "REDUCE" { 3 } else { 2 })?;
                let (items, kind) = values[0].collection()?;
                let f = values[if upper == "REDUCE" { 2 } else { 1 }].function(
                    if upper == "REDUCE" {
                        &[2, 3]
                    } else if upper == "GROUPBY" {
                        &[1]
                    } else {
                        &[1, 2]
                    },
                    name,
                )?;
                self.budget.items(items.len())?;
                if upper == "REDUCE" {
                    let mut acc = values[1].clone();
                    let kind = acc.kind();
                    if matches!(
                        kind,
                        Kind::Function | Kind::Collection(_) | Kind::Optional(_)
                    ) {
                        return Err(error("REDUCE initial must be a scalar or record"));
                    }
                    for (i, x) in items.iter().enumerate() {
                        let mut args = vec![acc, x.clone()];
                        if f.params.len() == 3 {
                            args.push(Value::Number(Number::Integer(i as i128)));
                        }
                        acc = self.invoke(&f, args, record, schema).map_err(|e| {
                            self.record_input_row(x, name);
                            self.record_callback_diagnostic(name, Some(i), None, None);
                            callback_error(name, i, None, e)
                        })?;
                        if !compatible(&kind, &acc.kind()) {
                            self.record_diagnostic(f.body.location.as_ref(), "REDUCE accumulator");
                            self.record_input_row(x, name);
                            self.record_callback_diagnostic(name, Some(i), None, None);
                            return Err(error(format!(
                                "REDUCE accumulator type changed at index {i}"
                            )));
                        }
                    }
                    return Ok(acc);
                }
                let mut out = Vec::with_capacity(items.len());
                let mut group_keys: Vec<Value> = Vec::new();
                let mut groups: Vec<Vec<Value>> = Vec::new();
                let mut group_index: std::collections::HashMap<Key, usize> =
                    std::collections::HashMap::new();
                let mut key_kind = None;
                for (i, x) in items.iter().enumerate() {
                    let mut args = vec![x.clone()];
                    if f.params.len() == 2 {
                        args.push(Value::Number(Number::Integer(i as i128)));
                    }
                    let v = self.invoke(&f, args, record, schema).map_err(|e| {
                        self.record_input_row(x, name);
                        self.record_callback_diagnostic(name, Some(i), None, None);
                        callback_error(name, i, None, e)
                    })?;
                    if upper == "FILTER" {
                        if v.truth().inspect_err(|_| {
                            self.record_diagnostic(f.body.location.as_ref(), "FILTER predicate");
                            self.record_input_row(x, name);
                            self.record_callback_diagnostic(name, Some(i), None, None);
                        })? {
                            out.push(x.clone());
                        }
                    } else if upper == "MAP" {
                        out.push(v);
                    } else {
                        valid_key(&v).inspect_err(|_| {
                            self.record_diagnostic(f.body.location.as_ref(), "GROUPBY key");
                            self.record_input_row(x, name);
                            self.record_callback_diagnostic(name, Some(i), None, None);
                        })?;
                        let k = v.kind();
                        if key_kind.as_ref().is_some_and(|old| !compatible(old, &k)) {
                            self.record_diagnostic(f.body.location.as_ref(), "GROUPBY key");
                            self.record_input_row(x, name);
                            self.record_callback_diagnostic(name, Some(i), None, None);
                            return Err(error("GROUPBY key types must be compatible"));
                        }
                        key_kind = Some(k);
                        self.budget.charge(1, 0)?;
                        let key = key_of(&v)?;
                        if let Some(&j) = group_index.get(&key) {
                            groups[j].push(x.clone());
                        } else {
                            self.budget.charge(0, 160)?;
                            group_index.insert(key, groups.len());
                            group_keys.push(v);
                            groups.push(vec![x.clone()]);
                        }
                    }
                }
                if upper == "GROUPBY" {
                    for (key, rows) in group_keys.into_iter().zip(groups) {
                        out.push(Value::Record(Arc::new(vec![
                            ("key".into(), key),
                            ("rows".into(), collection(rows, kind.clone())?),
                        ])));
                    }
                }
                collection_indexed(out, if upper == "FILTER" { kind } else { None }).map_err(
                    |(index, error)| {
                        self.record_diagnostic(f.body.location.as_ref(), "callback result");
                        if let Some(value) = items.get(index) {
                            self.record_input_row(value, name);
                        }
                        self.record_callback_diagnostic(name, Some(index), None, None);
                        error
                    },
                )
            }
            "SAME" => {
                count(2)?;
                Ok(Value::Boolean(same(&values[0], &values[1])?))
            }
            "HASROW" => {
                count(1)?;
                match &values[0] {
                    Value::Row { .. } | Value::Record(_) | Value::Optional(Some(_), _) => {
                        Ok(Value::Boolean(true))
                    }
                    Value::Optional(None, _) => Ok(Value::Boolean(false)),
                    _ => Err(error("HASROW requires a row")),
                }
            }
            "TABLE" => {
                count(1)?;
                let context = self.context.ok_or_else(|| {
                    FormulaError::InvalidReference("TABLE requires project context".into())
                })?;
                context.evaluate_table(self, &values[0])
            }
            "JOIN" => {
                count(4)?;
                let (left, lk) = values[0].collection()?;
                let (right, rk) = values[1].collection()?;
                let f = values[2].function(&[2], name)?;
                let mode = values[3].text(&mut self.budget)?.to_uppercase();
                if mode != "INNER" && mode != "LEFT" {
                    return Err(FormulaError::ArgumentError(
                        "JOIN mode must be INNER or LEFT".into(),
                    ));
                }
                for k in [lk.as_deref(), rk.as_deref()].into_iter().flatten() {
                    if !matches!(k, Kind::Row(_) | Kind::Record(_)) {
                        return Err(error("JOIN inputs must contain records"));
                    }
                }
                let right_kind = rk.unwrap_or_else(|| Arc::new(Kind::Record(Vec::new())));
                let mut out = Vec::new();
                for (li, l) in left.iter().enumerate() {
                    let mut matched = false;
                    for (ri, r) in right.iter().enumerate() {
                        self.budget.charge(1, 0)?;
                        if self
                            .invoke(&f, vec![l.clone(), r.clone()], record, schema)
                            .map_err(|e| {
                                self.record_input_row(l, "JOIN left input");
                                self.record_input_row(r, "JOIN right input");
                                self.record_callback_diagnostic(name, None, Some(li), Some(ri));
                                callback_error(name, li, Some(ri), e)
                            })?
                            .truth()
                            .inspect_err(|_| {
                                self.record_diagnostic(f.body.location.as_ref(), "JOIN predicate");
                                self.record_input_row(l, "JOIN left input");
                                self.record_input_row(r, "JOIN right input");
                                self.record_callback_diagnostic(name, None, Some(li), Some(ri));
                            })?
                        {
                            matched = true;
                            self.join_push(
                                &mut out,
                                l.clone(),
                                if mode == "LEFT" {
                                    Value::Optional(Some(Arc::new(r.clone())), right_kind.clone())
                                } else {
                                    r.clone()
                                },
                                li,
                                ri,
                            )?;
                        }
                    }
                    if !matched && mode == "LEFT" {
                        self.join_push(
                            &mut out,
                            l.clone(),
                            Value::Optional(None, right_kind.clone()),
                            li,
                            0,
                        )?;
                    }
                }
                collection(out, None)
            }
            _ => {
                if values.iter().any(Value::is_color) {
                    return Err(error(format!("{name} does not accept color values; select a channel or use a color function")));
                }
                if matches!(upper.as_str(), "SUM" | "AVG" | "MIN" | "MAX" | "ABS") {
                    if values.is_empty() || (upper == "ABS" && values.len() != 1) {
                        return Err(FormulaError::ArgumentError(format!(
                            "{name}: invalid argument count"
                        )));
                    }
                    let mut numbers = Vec::new();
                    for value in &values {
                        if let Value::Number(number) = value {
                            numbers.push(*number);
                        } else if let Some(number) = Number::parse(&value.text(&mut self.budget)?)?
                        {
                            numbers.push(number);
                        }
                    }
                    let result = match upper.as_str() {
                        "SUM" | "AVG" => {
                            let count = numbers.len();
                            let sum = numbers
                                .into_iter()
                                .try_fold(Number::Integer(0), |sum, value| {
                                    sum.binary(value, '+')
                                })?;
                            if upper == "AVG" && count != 0 {
                                sum.binary(Number::Integer(count as i128), '/')?
                            } else {
                                sum
                            }
                        }
                        "MIN" | "MAX" => {
                            let mut numbers = numbers.into_iter();
                            let mut best = numbers.next().ok_or_else(|| {
                                FormulaError::ArgumentError(format!(
                                    "{name} requires a numeric argument"
                                ))
                            })?;
                            for number in numbers {
                                let order = number.compare(best)?;
                                if (upper == "MIN" && order.is_lt())
                                    || (upper == "MAX" && order.is_gt())
                                {
                                    best = number;
                                }
                            }
                            best
                        }
                        _ => {
                            let number = *numbers.first().ok_or_else(|| {
                                FormulaError::ArgumentError(
                                    "ABS requires a numeric argument".into(),
                                )
                            })?;
                            if number.compare(Number::Integer(0))?.is_lt() {
                                number.binary(Number::Integer(-1), '*')?
                            } else {
                                number
                            }
                        }
                    };
                    self.budget.charge(values.len(), result.text().len())?;
                    return Ok(Value::Number(result));
                }
                let texts = values
                    .iter()
                    .map(|v| v.text(&mut self.budget))
                    .collect::<Result<Vec<_>>>()?;
                let output_bytes = texts
                    .iter()
                    .fold(0usize, |sum, text| sum.saturating_add(text.len()));
                self.budget.charge(
                    0,
                    if matches!(upper.as_str(), "UPPER" | "LOWER") {
                        output_bytes.saturating_mul(3)
                    } else {
                        output_bytes
                    }
                    .saturating_add(128),
                )?;
                let output = if matches!(upper.as_str(), "LOOKUP" | "COUNTIF" | "SUMIF") {
                    let context = self.context.ok_or_else(|| {
                        FormulaError::InvalidReference(format!("{name} requires project context"))
                    })?;
                    return context.evaluate_query(self, &upper, &texts);
                } else {
                    self.evaluate_function(&upper, texts)?
                };
                self.budget.charge(0, output.len())?;
                if ["CONCAT", "UPPER", "LOWER"].contains(&upper.as_str()) {
                    Ok(Value::String(output.into()))
                } else {
                    Ok(Value::Number(Number::required(&output)?))
                }
            }
        }
    }
    fn join_push(
        &mut self,
        out: &mut Vec<Value>,
        left: Value,
        right: Value,
        li: usize,
        ri: usize,
    ) -> Result<()> {
        if out.len() >= self.budget.limits.collection_items {
            self.record_callback_diagnostic("JOIN", None, Some(li), Some(ri));
            return Err(FormulaError::ExecutionLimit(format!(
                "JOIN item limit at left index {li}, right index {ri}"
            )));
        }
        self.budget.charge(0, 256).inspect_err(|_| {
            self.record_callback_diagnostic("JOIN", None, Some(li), Some(ri));
        })?;
        out.push(Value::Record(Arc::new(vec![
            ("left".into(), left),
            ("right".into(), right),
        ])));
        Ok(())
    }
}
fn valid_key(v: &Value) -> Result<()> {
    match v {
        Value::Number(_)
        | Value::String(_)
        | Value::Boolean(_)
        | Value::Color32(_)
        | Value::ColorFloat(_) => Ok(()),
        Value::Reference { column, value } => {
            let target = column.reference_config.as_ref().ok_or_else(|| {
                FormulaError::InvalidReference("Reference configuration missing".into())
            })?;
            uuid::Uuid::parse_str(&target.target_table_uuid).and_then(|_|uuid::Uuid::parse_str(value))
                .map(|_|()).map_err(|_|FormulaError::InvalidReference("SAME/GROUPBY requires a valid Reference identity; empty Reference is not a row".into()))
        }
        Value::TableReference { value, .. } => {
            uuid::Uuid::parse_str(value).map(|_| ()).map_err(|_| {
                FormulaError::InvalidReference(
                    "SAME/GROUPBY requires a valid TableRef identity".into(),
                )
            })
        }
        Value::Scalar(kind, _) if *kind != ValueType::Curve => Ok(()),
        _ => Err(error(
            "SAME/GROUPBY key must be a supported scalar or Reference",
        )),
    }
}
fn same(a: &Value, b: &Value) -> Result<bool> {
    valid_key(a)?;
    valid_key(b)?;
    Ok(match (a, b) {
        (Value::Number(a), Value::Number(b)) => match (a, b) {
            (Number::Integer(a), Number::Integer(b)) => a == b,
            (Number::Float(a), Number::Float(b)) => a == b,
            (Number::Integer(i), Number::Float(f)) | (Number::Float(f), Number::Integer(i)) => {
                f.fract() == 0.0
                    && *f >= i128::MIN as f64
                    && *f < i128::MAX as f64
                    && (*f as i128) == *i
            }
        },
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Boolean(a), Value::Boolean(b)) => a == b,
        (Value::Color32(a), Value::Color32(b)) => a.channels() == b.channels(),
        (Value::ColorFloat(a), Value::ColorFloat(b)) => a.channels() == b.channels(),
        (Value::Scalar(ka, a), Value::Scalar(kb, b)) => ka == kb && a == b,
        (Value::TableReference { value: a, .. }, Value::TableReference { value: b, .. }) => {
            identity_equal(a, b)
        }
        (
            Value::Reference {
                column: a,
                value: av,
            },
            Value::Reference {
                column: b,
                value: bv,
            },
        ) => {
            a.reference_config
                .as_ref()
                .zip(b.reference_config.as_ref())
                .is_some_and(|(a, b)| identity_equal(&a.target_table_uuid, &b.target_table_uuid))
                && identity_equal(av, bv)
        }
        _ => false,
    })
}

fn identity_equal(a: &str, b: &str) -> bool {
    match (uuid::Uuid::parse_str(a), uuid::Uuid::parse_str(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

#[derive(Hash, PartialEq, Eq)]
enum Key {
    Integer(i128),
    Float(u64),
    String(Arc<str>),
    Boolean(bool),
    Scalar(String, Arc<str>),
    Color32([u8; 4]),
    ColorFloat([u32; 4]),
    Reference(String, String),
    TableReference(String),
}
fn key_of(value: &Value) -> Result<Key> {
    valid_key(value)?;
    fn identity(value: &str) -> String {
        uuid::Uuid::parse_str(value)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| value.to_owned())
    }
    Ok(match value {
        Value::Number(Number::Integer(n)) => Key::Integer(*n),
        Value::Number(Number::Float(n))
            if n.fract() == 0.0 && *n >= i128::MIN as f64 && *n < i128::MAX as f64 =>
        {
            Key::Integer(*n as i128)
        }
        Value::Number(Number::Float(n)) => Key::Float(n.to_bits()),
        Value::String(s) => Key::String(s.clone()),
        Value::Boolean(b) => Key::Boolean(*b),
        Value::Color32(color) => Key::Color32(color.channels()),
        Value::ColorFloat(color) => Key::ColorFloat(color.channels().map(|channel| {
            // Equality treats both signed zero representations as the same value.
            if channel == 0.0 {
                0
            } else {
                channel.to_bits()
            }
        })),
        Value::Scalar(k, s) => Key::Scalar(format!("{k:?}"), s.clone()),
        Value::Reference { column, value } => Key::Reference(
            identity(
                &column
                    .reference_config
                    .as_ref()
                    .ok_or_else(|| error("Reference configuration missing"))?
                    .target_table_uuid,
            ),
            identity(value),
        ),
        Value::TableReference { value, .. } => Key::TableReference(identity(value)),
        _ => unreachable!(),
    })
}

fn callback_error(
    name: &str,
    index: usize,
    right: Option<usize>,
    source: FormulaError,
) -> FormulaError {
    if matches!(
        source,
        FormulaError::Cancelled | FormulaError::ExecutionLimit(_) | FormulaError::DataChanged(_)
    ) {
        return source;
    }
    FormulaError::EvaluationContext {
        context: match right {
            Some(right) => format!("{name}: left index {index}, right index {right} (zero-based)"),
            None => format!("{name}: element index {index} (zero-based)"),
        },
        source: Box::new(source),
    }
}

impl Expr {
    /// Snapshot policy follows the parsed operations, including interpolation.
    /// It does not select a parser or change expression semantics.
    fn requires_collection_snapshot(&self) -> bool {
        match &self.node {
            Node::Array(_) | Node::Record(_) | Node::Lambda(_, _) => true,
            Node::Call(name, arguments) => {
                matches!(
                    canonical(name).as_str(),
                    "MAP"
                        | "FILTER"
                        | "REDUCE"
                        | "SEQUENCE"
                        | "TABLE"
                        | "JOIN"
                        | "GROUPBY"
                        | "HASROW"
                        | "SAME"
                        | "LET"
                        | "LETREC"
                ) || arguments
                    .iter()
                    .any(|argument| argument.requires_collection_snapshot())
            }
            Node::String(parts) => parts.iter().any(|part| match part {
                Part::Expression(expression) => expression.requires_collection_snapshot(),
                Part::Text(_) => false,
            }),
            Node::Group(expression) | Node::Unary(_, expression) | Node::Field(expression, _) => {
                expression.requires_collection_snapshot()
            }
            Node::Binary(_, left, right) => {
                left.requires_collection_snapshot() || right.requires_collection_snapshot()
            }
            Node::If(condition, yes, no) => {
                condition.requires_collection_snapshot()
                    || yes.requires_collection_snapshot()
                    || no.requires_collection_snapshot()
            }
            Node::Number(_) | Node::Name(_, _) => false,
        }
    }
}
