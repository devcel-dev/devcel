import { FormulaSuggestions } from '@/app/components/formula/FormulaSuggestions';
import { localizeError } from '@/app/i18n';
import { getEffectiveCellValue } from '@/app/types/tableTypes';
import { useState, useEffect, useRef } from 'react';
import { useGridEditorFocus, usePhysicalViewport } from '../DataGridViewportContext';
import { PhysicalGridNotice } from '../PhysicalGridNotice';

import type { RenderEditCellProps, ValidationResult } from '../types';
import { textEditorClassname } from './textEditor';
import { RawTextInputNotice, useRawTextInput } from './useRawTextInput';

/**
 * Text editor component with validation
 * 
 * @description
 * Extend the standard text editor with validation.
 * Validate input using the column definition's validator and validationMode.
 */
// Keep hooks on a stable React child, not on EditCell's conditional renderer call.
// The render callback identity may change without remounting the actual editor.
export default function validatedTextEditor<TRow, TSummaryRow>(props: RenderEditCellProps<TRow, TSummaryRow>) {
  return <ValidatedTextEditor {...props} />;
}

function ValidatedTextEditor<TRow, TSummaryRow>({
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

  const originalValue = initialValue;
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  // A single-line input silently strips existing line breaks before onChange.
  // Keep numeric/single-line editors unchanged, but preserve multiline raw input.
  const multiline = column.dataType === 'String' || /[\r\n]/.test(initialValue);
  const Input = multiline ? 'textarea' : 'input';
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const requestFocus = usePhysicalViewport()?.requestFocus;
  const pendingRefocus = useRef<{ timer?: ReturnType<typeof setTimeout>; cancel?: () => void }>({});
  const { value, displayValue, update, reset, blocked, alertId, replaceRange } = useRawTextInput(originalValue, multiline, inputRef);
  const hasChangedRef = useRef(false);
  
  // Auto focus and select
  useGridEditorFocus(inputRef);
  useEffect(() => () => {
    clearTimeout(pendingRefocus.current.timer);
    pendingRefocus.current.cancel?.();
  }, [requestFocus]);
  
  // Validate function
  const validate = (val: string): ValidationResult => {
    if (!column.validator) {
      return { isValid: true };
    }
    return column.validator(val);
  };
  
  // Handle value change
  const handleChange = (event: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const newValue = update(event);
    if (newValue === null) return;
    hasChangedRef.current = true;
    
    // Always update row data to allow formula input
    onRowChange({ ...row, [column.key]: newValue });
    
    // Validate on change if configured (but don't prevent input)
    if (column.validationMode === 'onChange') {
      const result = validate(newValue);
      setValidationResult(result);
    }
  };
  
  // Handle blur
  const handleBlur = () => {
    if (blocked) return;
    // Validate on blur if configured
    if (column.validationMode === 'onBlur' && hasChangedRef.current) {
      const result = validate(value);
      setValidationResult(result);
      
      // If invalid, revert to original value and refocus
      if (!result.isValid) {
        reset(originalValue);
        onRowChange({ ...row, [column.key]: originalValue });
        clearTimeout(pendingRefocus.current.timer);
        pendingRefocus.current.cancel?.();
        const element = inputRef.current;
        pendingRefocus.current = { timer: setTimeout(() => {
          if (!element?.isConnected || inputRef.current !== element) return;
          if (requestFocus) pendingRefocus.current.cancel = requestFocus(element);
          else element.focus();
        }, 0) };
        return;
      }
    }
    
    // Final validation before closing
    if (column.validator && hasChangedRef.current) {
      const result = validate(value);
      if (!result.isValid) {
        // Revert to original value
        onRowChange({ ...row, [column.key]: originalValue });
        onClose(false, false);
        return;
      }
    }
    
    // Close editor with commit
    onClose(true, false);
  };
  
  // Handle key down
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // Preserve IME confirmation and native Alt+Enter insertion in textarea.
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
    if (event.key === 'Enter') {
      // Validate before bubbling to EditCell for a single commit and navigation.
      event.preventDefault();
      // Validate on submit
      if (column.validator && hasChangedRef.current) {
        const result = validate(value);
        if (!result.isValid) {
            event.stopPropagation();
          setValidationResult(result);
          event.preventDefault();
          return;
        }
      }
      
      // Valid input bubbles; invalid input above remains in the editor.
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      // Revert to original value on escape
      onRowChange({ ...row, [column.key]: originalValue });
      onClose(false, false);
    }
  };
  
  const isError = validationResult && !validationResult.isValid;
  const errorMessage = validationResult && !validationResult.isValid
    ? localizeError(validationResult.localizedMessage ?? validationResult.errorMessage)
    : undefined;
  
  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Input
        ref={(element: HTMLInputElement | HTMLTextAreaElement | null) => { inputRef.current = element; }}
        rows={multiline ? 1 : undefined}
        wrap={multiline ? 'off' : undefined}
        className={textEditorClassname}
        value={displayValue}
        onChange={multiline ? undefined : handleChange}
        onInput={multiline ? handleChange : undefined}
        data-rdg-editor-blocked={blocked || undefined}
        data-rdg-raw-text-editor={multiline || undefined}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        aria-invalid={blocked || isError || undefined}
        aria-describedby={blocked ? alertId : isError ? 'validation-error' : undefined}
        style={isError ? {
          borderColor: '#dc2626',
          backgroundColor: '#fee2e2',
          color: '#991b1b'
        } : undefined}
      />
      <FormulaSuggestions inputRef={inputRef} disabled={blocked} onAccept={(start, end, text, caret) => { const next = replaceRange(start, end, text, caret); if (next !== null) { hasChangedRef.current = true; onRowChange({ ...row, [column.key]: next }); if (column.validationMode === 'onChange') setValidationResult(validate(next)); } }} />
    {blocked && <RawTextInputNotice id={alertId} anchorRef={wrapperRef} />}
      {!blocked && isError && errorMessage && (
        <PhysicalGridNotice
          id="validation-error"
          anchorRef={wrapperRef}
          offset={4}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: '4px',
            padding: '6px 12px',
            backgroundColor: '#991b1b',
            color: 'white',
            fontSize: '12px',
            lineHeight: 1.4,
            borderRadius: '4px',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
            zIndex: 1000,
            whiteSpace: 'normal',
            maxWidth: 'min(300px, 90vw)',
            overflowWrap: 'anywhere'
          }}
        >
          {errorMessage}
        </PhysicalGridNotice>
      )}
    </div>
  );
}