//! Bounded error sidecars. Error variants remain stable for callers that match them.
//!
//! Source ranges are UTF-8 byte offsets into the complete original cell input,
//! including its leading `=`. Locations never retain or copy the formula text.
use crate::types::FormulaError;
use std::fmt::Write;
use std::sync::{Arc, OnceLock};

const MAX_FRAMES: usize = 32;
const MAX_LABEL_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FormulaSourceSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FormulaCellIdentity {
    pub table_uuid: Option<String>,
    pub row_uuid: Option<String>,
    pub column_uuid: Option<String>,
    /// Supplied column name when no schema UUID can be established.
    pub column_label: Option<String>,
}
impl FormulaCellIdentity {
    fn new(table: &str, row: Option<&str>, column: Option<&str>) -> Self {
        let copy = |s: &str| (!s.is_empty()).then(|| bounded(s));
        Self {
            table_uuid: copy(table),
            row_uuid: row.and_then(copy),
            column_uuid: column.and_then(copy),
            column_label: None,
        }
    }
}

/// A parsed location carries its source-cell provenance through deferred closures.
/// The cell is finalized as its evaluation scope exits; no borrowed pointers are
/// dereferenced, and source text is never retained.
#[derive(Clone, Debug)]
pub struct FormulaSourceLocation {
    pub span: FormulaSourceSpan,
    source: Arc<OnceLock<FormulaCellIdentity>>,
}
impl FormulaSourceLocation {
    pub fn cell(&self) -> Option<&FormulaCellIdentity> {
        self.source.get()
    }
}

/// Lightweight parse-time map. Addresses are used only for containment checks,
/// never to read memory; callers must pass live substrings of the current source.
#[derive(Clone, Debug)]
pub(crate) struct FormulaSourceContext {
    base: usize,
    len: usize,
    offset: usize,
    boundaries: Option<Arc<[usize]>>,
    source: Arc<OnceLock<FormulaCellIdentity>>,
}
impl FormulaSourceContext {
    fn range(&self, text: &str) -> Option<(usize, usize)> {
        let start = (text.as_ptr() as usize).checked_sub(self.base)?;
        let end = start.checked_add(text.len())?;
        (end <= self.len).then_some((start, end))
    }
    fn original_offset(&self, offset: usize) -> Option<usize> {
        let offset = self.offset.checked_add(offset)?;
        match &self.boundaries {
            Some(map) => map.get(offset).copied(),
            None => Some(offset),
        }
    }
    pub(crate) fn location(&self, text: &str) -> Option<FormulaSourceLocation> {
        let (start, end) = self.range(text)?;
        Some(FormulaSourceLocation {
            span: FormulaSourceSpan {
                start: self.original_offset(start)?,
                end: self.original_offset(end)?,
            },
            source: self.source.clone(),
        })
    }
    /// Map the exact result of Excel-style `raw.replace("\"\"", "\"")`.
    /// This composes with previous maps, including nested interpolation strings.
    /// Mismatched/unknown text returns None rather than guessing an offset.
    pub(crate) fn remap_doubled_quotes(&self, raw: &str, decoded: &str) -> Option<Self> {
        let (raw_start, _) = self.range(raw)?;
        if !raw.contains("\"\"") {
            if raw != decoded {
                return None;
            }
            return Some(Self {
                base: decoded.as_ptr() as usize,
                len: decoded.len(),
                offset: self.offset + raw_start,
                boundaries: self.boundaries.clone(),
                source: self.source.clone(),
            });
        }
        let mut boundaries = Vec::with_capacity(decoded.len().saturating_add(1));
        boundaries.push(self.original_offset(raw_start)?);
        let mut raw_at = 0;
        let mut decoded_at = 0;
        while raw_at < raw.len() {
            let paired_quote = raw.as_bytes()[raw_at..].starts_with(b"\"\"");
            let byte = raw.as_bytes()[raw_at];
            if decoded.as_bytes().get(decoded_at) != Some(&byte) {
                return None;
            }
            raw_at += if paired_quote { 2 } else { 1 };
            decoded_at += 1;
            boundaries.push(self.original_offset(raw_start + raw_at)?);
        }
        if decoded_at != decoded.len() {
            return None;
        }
        Some(Self {
            base: decoded.as_ptr() as usize,
            len: decoded.len(),
            offset: 0,
            boundaries: Some(boundaries.into()),
            source: self.source.clone(),
        })
    }
}

#[derive(Clone, Debug)]
pub struct FormulaDiagnosticFrame {
    /// None for a literal cell or when exact source mapping is unavailable.
    pub location: Option<FormulaSourceLocation>,
    /// The actual failing cell, distinct from a caller's source location.
    pub cell: Option<FormulaCellIdentity>,
    pub operation: String,
    /// Zero-based collection positions, never human-facing row numbers.
    pub element_index: Option<usize>,
    pub left_index: Option<usize>,
    pub right_index: Option<usize>,
}

#[derive(Clone, Debug, Default)]
pub struct FormulaDiagnostic {
    pub root: Option<FormulaCellIdentity>,
    /// Innermost failure first, followed by bounded source/callback call sites.
    pub frames: Vec<FormulaDiagnosticFrame>,
    pub truncated: bool,
}
impl FormulaDiagnostic {
    /// Display integration is opt-in; the original FormulaError is unchanged.
    pub fn format_error(&self, error: &FormulaError) -> String {
        let mut text = format!("{error:?}");
        if let Some(root) = &self.root {
            text.push_str(" [root");
            write_cell(&mut text, root);
            text.push(']');
        }
        for frame in &self.frames {
            text.push_str(" [");
            text.push_str(&frame.operation);
            if let Some(cell) = frame.cell.as_ref().or_else(|| {
                frame
                    .location
                    .as_ref()
                    .and_then(FormulaSourceLocation::cell)
            }) {
                write_cell(&mut text, cell);
            }
            if let Some(location) = &frame.location {
                let _ = write!(
                    text,
                    " source bytes {}..{}",
                    location.span.start, location.span.end
                );
            }
            if let Some(index) = frame.element_index {
                let _ = write!(text, " element index {index} (zero-based)");
            }
            if let Some(index) = frame.left_index {
                let _ = write!(text, " left index {index} (zero-based)");
            }
            if let Some(index) = frame.right_index {
                let _ = write!(text, " right index {index} (zero-based)");
            }
            text.push(']');
        }
        if self.truncated {
            text.push_str(" [additional diagnostic frames omitted]");
        }
        text
    }
}
fn write_cell(text: &mut String, cell: &FormulaCellIdentity) {
    for (name, value) in [
        ("table", &cell.table_uuid),
        ("row", &cell.row_uuid),
        ("column", &cell.column_uuid),
        ("column label", &cell.column_label),
    ] {
        if let Some(value) = value {
            let _ = write!(text, " {name}={value}");
        }
    }
}
fn bounded(text: &str) -> String {
    let mut end = text.len().min(MAX_LABEL_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

struct ActiveSource {
    base: usize,
    len: usize,
    provenance: Option<Arc<OnceLock<FormulaCellIdentity>>>,
}
#[derive(Default)]
pub(crate) struct DiagnosticState {
    // The common scalar root does not allocate a source-stack Vec.
    root_source: Option<ActiveSource>,
    dependencies: Vec<ActiveSource>,
    pub(crate) last: Option<FormulaDiagnostic>,
}
impl DiagnosticState {
    pub(crate) fn begin(&mut self, formula: &str) {
        let source = ActiveSource {
            base: formula.as_ptr() as usize,
            len: formula.len(),
            provenance: None,
        };
        if self.root_source.is_none() {
            self.last = None;
            self.root_source = Some(source);
        } else {
            self.dependencies.push(source);
        }
    }
    pub(crate) fn has_provenance(&self) -> bool {
        self.dependencies
            .last()
            .or(self.root_source.as_ref())
            .is_some_and(|source| {
                source
                    .provenance
                    .as_ref()
                    .is_some_and(|p| Arc::strong_count(p) > 1)
            })
    }
    pub(crate) fn context(&mut self) -> Option<FormulaSourceContext> {
        let source = self.dependencies.last_mut().or(self.root_source.as_mut())?;
        Some(FormulaSourceContext {
            base: source.base,
            len: source.len,
            offset: 0,
            boundaries: None,
            source: source
                .provenance
                .get_or_insert_with(|| Arc::new(OnceLock::new()))
                .clone(),
        })
    }
    pub(crate) fn location(&mut self, text: &str) -> Option<FormulaSourceLocation> {
        self.context()?.location(text)
    }
    pub(crate) fn finish(
        &mut self,
        table: &str,
        row: Option<&str>,
        column: Option<&str>,
        column_label: Option<&str>,
        failed: bool,
    ) {
        let source = self
            .dependencies
            .pop()
            .or_else(|| self.root_source.take())
            .expect("balanced formula source scope");
        let cell = || {
            let mut cell = FormulaCellIdentity::new(table, row, column);
            if column.is_none() {
                cell.column_label = column_label.filter(|label| !label.is_empty()).map(bounded);
            }
            cell
        };
        if let Some(provenance) = source.provenance {
            // Once the AST and any error/closure locations are gone, nobody
            // can observe this identity. Do not allocate it on scalar success.
            if Arc::strong_count(&provenance) > 1 {
                let _ = provenance.set(cell());
            }
        }
        if failed && self.root_source.is_none() {
            self.last
                .get_or_insert_with(FormulaDiagnostic::default)
                .root = Some(cell());
        } else if self.root_source.is_none() {
            self.last = None;
        }
    }
    pub(crate) fn record(&mut self, location: Option<&FormulaSourceLocation>, operation: &str) {
        let diagnostic = self.last.get_or_insert_with(FormulaDiagnostic::default);
        if diagnostic.frames.last().is_some_and(|frame| {
            (frame.operation == operation || operation == "expression")
                && match (&frame.location, location) {
                    (Some(a), Some(b)) => a.span == b.span && Arc::ptr_eq(&a.source, &b.source),
                    (None, None) => true,
                    _ => false,
                }
        }) {
            return;
        }
        if diagnostic.frames.len() >= MAX_FRAMES {
            diagnostic.truncated = true;
            return;
        }
        diagnostic.frames.push(FormulaDiagnosticFrame {
            location: location.cloned(),
            cell: None,
            operation: bounded(operation),
            element_index: None,
            left_index: None,
            right_index: None,
        });
    }
    pub(crate) fn record_cell(
        &mut self,
        table: &str,
        row: Option<&str>,
        column: Option<&str>,
        operation: &str,
    ) {
        let diagnostic = self.last.get_or_insert_with(FormulaDiagnostic::default);
        // Already-finalized dependency errors are more precise than a caller's
        // attempted target. Keep those, while supplementing a bare callsite.
        if diagnostic
            .frames
            .iter()
            .any(|f| f.cell.is_some() || f.location.as_ref().is_some_and(|l| l.cell().is_some()))
        {
            return;
        }
        if diagnostic.frames.len() >= MAX_FRAMES {
            diagnostic.truncated = true;
            return;
        }
        diagnostic.frames.insert(
            0,
            FormulaDiagnosticFrame {
                location: None,
                cell: Some(FormulaCellIdentity::new(table, row, column)),
                operation: bounded(operation),
                element_index: None,
                left_index: None,
                right_index: None,
            },
        );
    }
    pub(crate) fn complete_table(&mut self, table: &str) {
        if table.is_empty() {
            return;
        }
        let Some(diagnostic) = self.last.as_mut() else {
            return;
        };
        if let Some(root) = diagnostic.root.as_mut() {
            if root.table_uuid.is_none() {
                root.table_uuid = Some(bounded(table));
            }
        }
        for frame in &mut diagnostic.frames {
            let cell = frame.cell.as_ref().or_else(|| {
                frame
                    .location
                    .as_ref()
                    .and_then(FormulaSourceLocation::cell)
            });
            if let Some(cell) = cell.filter(|cell| cell.table_uuid.is_none()) {
                let mut cell = cell.clone();
                cell.table_uuid = Some(bounded(table));
                frame.cell = Some(cell);
            }
        }
    }
    pub(crate) fn callback(
        &mut self,
        operation: &str,
        element: Option<usize>,
        left: Option<usize>,
        right: Option<usize>,
    ) {
        let diagnostic = self.last.get_or_insert_with(FormulaDiagnostic::default);
        if diagnostic.frames.last().is_some_and(|frame| {
            frame.location.is_none()
                && frame.cell.is_none()
                && frame.operation == operation
                && frame.element_index == element
                && frame.left_index == left
                && frame.right_index == right
        }) {
            return;
        }
        if diagnostic.frames.len() >= MAX_FRAMES {
            diagnostic.truncated = true;
            return;
        }
        diagnostic.frames.push(FormulaDiagnosticFrame {
            location: None,
            cell: None,
            operation: bounded(operation),
            element_index: element,
            left_index: left,
            right_index: right,
        });
    }
}
