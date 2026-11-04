import { t, useI18n, localizeError } from '@/app/i18n';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { columnTypeFamily, columnTypeLabel } from '@/app/utils/columnTypes';
import { showColumnTypeDialog, type ColumnTypeDialogPresentation } from '@/app/utils/column_type_dialog';
import ColumnTypeDialog from '@/app/pages/column_type_dialog/ColumnTypeDialog';
import type { ColumnEditorTarget } from './types';

export interface ColumnTypePickerHandle { cancel: () => boolean }
export interface ColumnTypePickerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  target: ColumnEditorTarget;
  expectedProjectSession: string;
  expectedRevision: string | null;
}

/** The nested in-app chooser collects intent; only the column editor saves it. */
export const ColumnTypePicker = forwardRef<ColumnTypePickerHandle, ColumnTypePickerProps>(function ColumnTypePicker(
  { value, onChange, disabled = false, target, expectedProjectSession, expectedRevision }, ref,
) {
  useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const operation = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<ColumnTypeDialogPresentation | null>(null);
  const [error, setError] = useState<unknown>('');
  const context = JSON.stringify([expectedProjectSession, target, expectedRevision, value, disabled]);
  const focusContext = JSON.stringify([expectedProjectSession, target, expectedRevision]);
  const currentFocusContext = useRef(focusContext);
  currentFocusContext.current = focusContext;
  const currentContext = useRef(context);
  currentContext.current = context;

  useImperativeHandle(ref, () => ({ cancel: () => {
    const active = operation.current;
    if (!active) return false;
    active.abort();
    operation.current = null;
    setOpen(false); setDialog(null);
    triggerRef.current?.focus();
    return true;
  } }), []);
  useEffect(() => {
    setOpen(false); setDialog(null); setError('');
    return () => { operation.current?.abort(); operation.current = null; };
  }, [context]);

  const show = async () => {
    if (disabled || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setOpen(true); setError('');
    try {
      const selected = await showColumnTypeDialog(target, expectedProjectSession, expectedRevision, value, controller.signal, next => {
        if (!controller.signal.aborted && currentContext.current === context) setDialog(next);
        else controller.abort();
      });
      if (!controller.signal.aborted && currentContext.current === context && selected !== null && selected !== value) onChange(selected);
    } catch (reason) {
      if (!controller.signal.aborted && currentContext.current === context) setError(reason);
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setOpen(false); setDialog(null);
        if (!controller.signal.aborted && currentContext.current === context) triggerRef.current?.focus();
      }
    }
  };

  return <div className="min-w-0">
    <Button ref={triggerRef} type="button" variant="outline" disabled={disabled} aria-busy={open}
      aria-label={t('column.typePicker.triggerLabel', { type: columnTypeLabel(value) || t('column.typePicker.unselected') })}
      aria-haspopup="dialog" aria-expanded={open}
      className="h-9 w-full justify-between gap-2 border-border bg-background px-3 text-left text-foreground hover:border-primary/30 hover:bg-accent/50"
      onClick={() => void show()}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{columnTypeFamily(value)?.label ?? (columnTypeLabel(value) || t('column.typePicker.select'))}</span>
        {value && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{value}</span>}
      </span>
      <ChevronsUpDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
    </Button>
    {dialog && <ColumnTypeDialog key={dialog.sessionId} sessionId={dialog.sessionId} onClose={dialog.finish}
      onReturnFocus={() => { if (currentFocusContext.current === focusContext && triggerRef.current?.isConnected && !triggerRef.current.disabled) triggerRef.current.focus(); }} />}
    {Boolean(error) && <p role="alert" className="mt-2 text-xs text-red-700">{localizeError(error)}</p>}
  </div>;
});
