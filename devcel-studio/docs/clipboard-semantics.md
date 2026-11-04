# Copying and cutting cells

## Behavior

- Ctrl/Cmd+C copies canonical displayed values, such as a formula result `75`, without localized digit separators.
- Ctrl/Cmd+X copies stored inputs, then clears the selected cells. An explicit formula such as `=LOOKUP("materials","key","marsh_hide_t01","value")*2+rarity` remains a formula and evaluates at its destination. Same-record references such as `rarity` use the destination record.
- Cells without a stored input inherit column defaults. Cutting does not materialize default formulas or their results. Cutting a single inherited cell copies an empty string without a mutation/history entry. Pasting an ordinary empty clipboard does nothing; it is not a reset-to-default command.
- To copy raw input without cutting, press F2 or double-click, copy the selected editor text, then press Esc.
- While an editor has focus, its own cut/copy/paste handling takes precedence over grid operations.

## TSV and safety

The grid uses quoted TSV. Fields containing tabs, CR, LF, or quotes are enclosed in double quotes, and internal quotes are doubled. CR/LF/CRLF inside quoted fields are preserved. Only a leading quote opens a quoted field. Malformed quoting or nonrectangular input rejects the whole operation. Import comma-separated files through the CSV workflow.

Cut freezes the selected cell identities at operation start and copies/clears that same set. Failed clipboard writes do not clear cells. Snapshot revision, project session, mutation gates, and input validation remain enforced. If a revision/session changes after copying and the mutation is rejected, the clipboard may contain the copied text while source cells remain unchanged.

When the final row of a multi-row cut is empty, the emitted TSV accounts for the paste parser removing one trailing newline, preserving the empty final row.

An explicit quoted empty field (`""`) represents one empty cell and can clear it. An ordinary empty clipboard is a no-op. To enter literal quoted text, use the cell editor or escape quotes using TSV rules. A leading `=` remains a formula even inside a quoted TSV field.

The CSV exporter also quotes lone CR characters and preserves cell-internal line endings.

