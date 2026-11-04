# Formula completion

Completion is shared by ordinary and validated cell editors, the expanded string
editor, and table/interface column default inputs. It opens only within an `=`
formula, including an expression inside `${…}`. Ordinary string contents and
completed expressions do not open a candidate list.

The native `get_formula_completion_schema` command checks the project session
before returning builtin names and schema metadata. It sends no records and never
evaluates the draft. Builtin names are checked against the real Rust dispatchers.
The frontend requests referenced schemas on demand, bounds recursive inspection,
and retires cached requests when the project or schema changes.

Candidates distinguish functions, tables, columns, local variables and record
fields. Table lookup follows UUID, internal name, then display name precedence.
Insertion quotes schema names and table strings according to the formula grammar;
labels remain readable. Ambiguous names do not resolve to an arbitrary table.
Reference chains and TableRef interface columns are inferred from their declared
schemas. LET/LETREC and callback parameters use lexical scope and shadowing;
MAP/FILTER/GROUPBY/JOIN shapes are inspected without evaluating data. Unknown or
heterogeneous values do not acquire a guessed first-item schema.

Up/Down selects a candidate, Enter/Tab accepts it, and Escape dismisses the list.
Modifier commands and IME confirmation remain owned by the editor. Changing the
draft, caret, selection or schema invalidates the old list before asynchronous
lookup proceeds. Acceptance checks the exact snapshot and token range again.
The WebView editing command preserves native Undo; non-editing DOM environments
use an explicit input adapter. Raw CR/CRLF outside the replacement is retained.
Expanded-dialog candidates remain within its focus scope.

`npm run check:formula-completion` covers token insertion, scope resolution and
real provider/input/popup components. The expanded-string, column-editor,
settings-lifecycle and project-draft suites also mount the real completion
components. Rust gates include builtin dispatch parity and session-bound schema
reads. Synthetic DOM checks are separate from native WebView geometry and IME
verification; neither substitutes for both-platform release preflight.
