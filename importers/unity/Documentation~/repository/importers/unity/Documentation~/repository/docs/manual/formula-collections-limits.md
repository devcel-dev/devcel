# Collection evaluation limits and SDK details

[Manual](README.md) / [Collection reference and examples](formula-collections-reference.md)

This page covers evaluation budgets, detailed diagnostics, and SDK snapshot boundaries. For building formulas, start with the [collection reference](formula-collections-reference.md).

## Limits, errors, and cancellation

Default budgets for one root-cell evaluation:

| Resource | Limit |
| --- | ---: |
| Formula UTF-8 length | 1 MiB |
| Syntax depth | 128 |
| Function-call depth | 64 |
| Expression, callback, and scan steps | 2,000,000 |
| Elements in one collection | 100,000 |
| Cumulative logical charge for expressions and intermediate values | 64 MiB |
| Live logical reservation for the source inventory | 64 MiB, separate budget |
| Concurrent source/parsing reservations for typed TABLE values | 256 MiB |

Nested operations, dependent cells, and recursion share the same budget. Combined execution depth across syntax, runtime AST, and dependent cells also has a safety limit of 128. A formula can reach that limit before making 64 function calls. On hosts with small thread stacks, evaluation allocates additional stack space and charges it to the execution budget.

Limits produce errors rather than truncated values. Memory accounting is a deterministic logical charge, not a cap on allocator activity or process RSS:

- Formula parsing, temporary values, string copies, and additional stack space use the 64 MiB cumulative budget.
- Source-inventory search scratch space and retained indexes use a separate live-reservation budget with the same `allocated_bytes` setting.
- Typed `TABLE` source parsing uses a separate 256 MiB live-reservation budget. The combined budgets can exceed 64 MiB.
- Parsing an unloaded table reserves 32 times the source length before allocation and releases that reservation on completion, failure, or cancellation. With the default budget, a single source can use approximately 8 MiB before other live reservations are considered.
- Lazy-row backing reserves an estimated retained size until its last owner releases it. Already loaded or cached tables are checked against the backing they actually need.
- Paths using only `LOOKUP`, `COUNTIF`, and `SUMIF` retain their existing source-size behavior. Logical accounting can reach a limit before actual live memory does.

Failure in any element fails the whole formula. A partial total is not saved as a successful result. Callback element indexes start at zero. Correct the formula and reevaluate the cell after an error.

Use **Cancel** to stop an active screen calculation. A retry is a new evaluation; cancellation of an earlier request does not cancel its replacement.

Full, Minimal, and streaming exports use the same evaluator. For the same data and version, final cell values and error meanings agree. An allow-invalid option does not replace a formula failure with a default value.

## SDK evaluation boundaries

A root evaluation that actually uses collections verifies source contents and the table inventory as a strict snapshot. If a scalar formula reaches a collection through a dependent cell, it also verifies consistency with disk sources read earlier in the evaluation.

Independent scalar-only evaluations retain their smaller cache and refresh behavior. To calculate several SDK values from one snapshot, wrap the work with `ProjectFormulaContext::begin_snapshot` and `finish_snapshot`. Treat values as provisional until `finish_snapshot` succeeds, and check its error result. Studio preview and export use this batch boundary.

## Source positions and row diagnostics

Cell error details identify the root cell and the failing dependent cell by table, row, and column UUID. They also include the operator or function, callback element index, and left/right indexes for a join. Name-based APIs that cannot resolve a column UUID identify a column label instead.

`source bytes start..end` is a zero-based, end-exclusive UTF-8 byte range in the original cell formula, including its leading `=`. It is not a character count or screen cursor position. For example, `1/0` in `="前${1/0}"` occupies `source bytes 7..10`. This Unicode example illustrates why byte offsets and character positions differ. Positions map back to the original formula even through nested interpolation and doubled quote expansion.

For failures in a `TABLE` row or reference target, diagnostics distinguish the actual data UUIDs from the calling formula's position. Literal cells have no formula span. Unknown UUIDs and positions that cannot be mapped precisely are omitted.

SDK accessors include:

- `FormulaEngine::last_diagnostic()`
- `FormulaEngine::take_diagnostic()`
- `FormulaEngine::format_error(&error)`
- `ProjectFormulaContext::last_diagnostic()`
- `ProjectFormulaContext::format_error(&error)`

Diagnostics are sidecar data: existing `FormulaError` variants, including `Cancelled`, `ExecutionLimit`, and `DataChanged`, retain their meaning. The next successful evaluation clears the previous diagnostic.

A diagnostic retains at most 32 frames, prioritizing the deepest failure, with each label limited to 256 UTF-8 bytes. It indicates when an oversized call trace has been shortened. Full formula text is not retained or duplicated solely for diagnostics.
