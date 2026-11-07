# Input rules and conditional formatting

Configure input rules and display formatting in the shared column/field editor. Evaluation, preview, save validation, and cell presentation use the same `devcel-core` evaluator.

## Input rules

Only columns with `input_validation` participate in input-rule enforcement. Supported rules include required values, uniqueness, inclusive numeric ranges, regular expressions, and existing Select options.

Numeric limits are stored as decimal strings; 64-bit integers are not converted to JavaScript numbers or `f64` for comparison. Regex matching uses Rust regex substring semantics; use `^...$` for a complete match. String uniqueness is case-sensitive and does not normalize Unicode.

Required values treat Unicode-whitespace-only content as empty. Uniqueness excludes empty/whitespace-only values and treats equivalent numeric spellings and negative zero as equal. Empty cells use defaults under the normal display contract. Evaluated formulas and defaults participate; evaluation errors and nonfinite values do not pass validation.

### Reject, warn, and existing invalid data

Reject mode prevents newly introduced violations from being saved. Warn mode requires explicit approval for the particular operation. Canceling or closing the confirmation leaves data unchanged.

Introducing rules does not prevent users from opening and gradually repairing existing invalid data. Validation compares the new rules applied to the before-data with the after-data. It detects new invalid values, changes from invalid value A to B, new duplicate partners, and violations introduced through default/formula dependencies. Reducing a duplicate group from three rows to two is allowed.

`required` and `constraints` are export/schema-validation contracts. They do not silently enable ordinary input rejection.

### Ordinary row insertion

Toolbar, between-row, and context-menu insertion immediately creates an ordinary saved row without a separate initial-value dialog. Defaults remain references rather than being copied into explicit values, including formula and interface defaults.

For an operation that only adds new empty rows, invalid defaults do not block insertion. Required, uniqueness, and range violations appear in cell markers and table counts, including effects on existing rows caused by duplicate defaults. There is no hidden unsaved draft. Delete and undo can remove the row; redo, save, and restart preserve its normal identity.

This insertion exception does not cover cell edits, paste, explicit initial values, mixed create/edit batches, column changes, or imports. Subsequent edits enforce reject/warn rules while allowing repairs. Export constraints remain enforced.

### Saving a group of edits

Paste, cut, range clearing, and row creation with initial values validate a single candidate. No partial cells are committed. Uniqueness swaps are judged in their final state. Failure leaves files, dirty state, and history unchanged; a successful operation is one undo/redo step.

Rules and formatting are stored in TOML and participate in interface history, restore, merge, and synchronization. Tables cannot alter interface-owned input rules or base formatting. Formatting may have an explicit table override.

## Conditional formatting

Rules support equality/inequality, empty/nonempty, substring matching, numeric comparisons/ranges, top/bottom N, and two-color scales. They can set background, foreground, and bold weight.

- Earlier rules have priority; already-set attributes are retained. Stop-on-match skips subsequent rules.
- Ranking and scale populations are the saved table's evaluable finite numeric values, unaffected by search, sorting, or scrolling.
- Include-ties selects every value equal to the Nth value. Without ties, record UUID gives deterministic ordering.
- An all-equal scale uses the midpoint color. Empty, formula-error, and nonnumeric values are excluded.
- Input violations have separate markers and explanations. Formatting does not change cell values.

For interface formatting overrides, `None` means inherit, an empty rule list explicitly disables formatting, and a nonempty list supplies custom rules. Owner updates preserve table overrides.

The persisted schema has one `conditional_formatting` contract and rejects unknown input fields. Formatting and calculated cell colors are not added to Runtime JSON or generated-code schemas. Normal project/table saves retain the settings.

