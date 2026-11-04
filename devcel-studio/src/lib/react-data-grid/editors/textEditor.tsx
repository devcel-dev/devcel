import { FormulaSuggestions } from '@/app/components/formula/FormulaSuggestions';
import { getEffectiveCellValue } from '@/app/types/tableTypes';
import { useRef } from 'react';
import { useGridEditorFocus } from '../DataGridViewportContext';

import type { RenderEditCellProps } from '../types';
import { RawTextInputNotice, useRawTextInput } from './useRawTextInput';

// Exported class name for import by consumers
import { textEditorClassname } from './textEditorStyles';
export { textEditorClassname };

/**
 * Text editor component
 * Input field used when editing a data grid cell
 * 
 * @description
 * This component provides the following features:
 * - Cell value editing
 * - Automatic focus and select-all
 * - Enter to confirm editing, Alt+Enter for a newline
 * - Esc to cancel, handled by the onClose keydown event
 * - Confirm editing when focus leaves
 * 
 * @param row - Row data being edited
 * @param column - Column definition being edited
 * @param onRowChange - Callback when row data changes
 * @param onClose - Callback when the editor closes (confirm or cancel)
 */
// Keep hooks on a stable React child, not on EditCell's conditional renderer call.
// The render callback identity may change without remounting the actual editor.
export default function textEditor<TRow, TSummaryRow>(props: RenderEditCellProps<TRow, TSummaryRow>) {
  return <TextEditor {...props} />;
}

function TextEditor<TRow, TSummaryRow>({
  row,
  column,
  onRowChange,
  onClose
}: RenderEditCellProps<TRow, TSummaryRow>) {
  // Edit raw stored input, not a computed/default display value. UUID lookup also
  // covers interface-owned columns and avoids stale formula cache substitution.
  const tableRow = row as any;
  const columnDef = tableRow.columnDefs?.find((candidate: any) => candidate.uuid === column.key);
  const raw = tableRow.cellPresentations?.[column.key]?.raw_value
    ?? (columnDef && tableRow.tableRecord ? getEffectiveCellValue(tableRow.tableRecord, columnDef) : undefined);
  const initialValue = raw ?? String(row[column.key as keyof TRow] ?? '');

  // A single-line input silently strips existing line breaks before onChange.
  // Keep numeric/single-line editors unchanged, but preserve multiline raw input.
  const multiline = column.dataType === 'String' || /[\r\n]/.test(initialValue);
  const Input = multiline ? 'textarea' : 'input';
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { displayValue, update, blocked, alertId, replaceRange } = useRawTextInput(initialValue, multiline, inputRef);
  
  // Auto focus and select
  useGridEditorFocus(inputRef);
  
  const handleChange = (event: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = update(event);
    if (next !== null) onRowChange({ ...row, [column.key]: next });
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
    <Input
      ref={(element: HTMLInputElement | HTMLTextAreaElement | null) => { inputRef.current = element; }}
      rows={multiline ? 1 : undefined}
      wrap={multiline ? 'off' : undefined}
      className={textEditorClassname}
      // Display the current cell value, or the formula for formula cells
      value={displayValue}
      // Reflect input changes in internal state
      onChange={multiline ? undefined : handleChange}
      onInput={multiline ? handleChange : undefined}
      aria-invalid={blocked || undefined}
      aria-describedby={blocked ? alertId : undefined}
      data-rdg-editor-blocked={blocked || undefined}
        data-rdg-raw-text-editor={multiline || undefined}
      onKeyDown={(event) => {
        // IME confirmation belongs to the composition, not the grid. WebKit can
        // report isComposing=false on the final keydown while keyCode stays 229.
        if (event.nativeEvent.isComposing || event.keyCode === 229
          || (multiline && event.key === 'Enter' && event.altKey)) {
          event.stopPropagation();
          return;
        }
        if (blocked && event.key !== 'Escape') {
          event.stopPropagation();
          if (event.key === 'Enter' || event.key === 'Tab') event.preventDefault();
          return;
        }
        // Let EditCell commit Enter, without inserting a trailing newline.
        if (event.key === 'Enter') event.preventDefault();
      }}
      // Confirm on blur (first argument true: commit; second false: not the Enter key)
      onBlur={() => { if (!blocked) onClose(true, false); }}
    />
    <FormulaSuggestions inputRef={inputRef} disabled={blocked} onAccept={(start, end, text, caret) => { const next = replaceRange(start, end, text, caret); if (next !== null) onRowChange({ ...row, [column.key]: next }); }} />
    {blocked && <RawTextInputNotice id={alertId} anchorRef={wrapperRef} />}
    </div>
  );
}
