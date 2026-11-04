import { useRef } from 'react';
import { FormulaSuggestions } from './FormulaSuggestions';
import { insertFormulaCompletion } from '@/app/utils/formulaTokens';

/** Controlled metadata input; ordinary text retains the native input behavior. */
export function FormulaInput({ id, value, onChange, disabled, className }: {
  id: string; value: string; onChange: (value: string) => void; disabled?: boolean; className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return <><input ref={inputRef} id={id} value={value} onChange={event => onChange(event.target.value)}
    disabled={disabled} className={className} autoComplete="off" />
    <FormulaSuggestions inputRef={inputRef} disabled={disabled} onAccept={(start, end, text, caretOffset) => {
      const input = inputRef.current;
      if (!input || input.value !== value) return;
      const result = insertFormulaCompletion(value, { start, end, expected: value.slice(start, end) }, text, caretOffset);
      if (!result) return;
      onChange(result.value);
      input.value = result.value;
      input.setSelectionRange(result.caret, result.caret);
    }} /></>;
}
