import { validateDataName } from '@/app/utils/validation';
import { useI18n, localizeError } from '@/app/i18n';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import React, { useState, useEffect, useRef } from 'react';

interface InlineEditDialogProps {
  isOpen: boolean;
  initialValue: string;
  position: { x: number; y: number };
  onSave: (value: string) => void | Promise<void>;
  onCancel: () => void;
  placeholder?: string;
  title?: string;
}

export const InlineEditDialog: React.FC<InlineEditDialogProps> = ({
  isOpen, initialValue, position, onSave, onCancel, placeholder, title
}) => {
  const { t } = useI18n();
  const [value, setValue] = useState(initialValue);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameError = value !== initialValue && value !== '' ? validateDataName(value).errorMessage : undefined;
  const saving = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  useEffect(() => { setValue(initialValue); setConfirmClose(false); setError(''); }, [initialValue]);
  useEffect(() => {
    if (isOpen) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [isOpen]);
  const requestClose = () => {
    if (saving.current) return;
    if (value !== initialValue) setConfirmClose(true);
    else onCancel();
  };
  useEffect(() => {
    if (!isOpen) return;
    const fit = () => {
      const rect = dialogRef.current?.getBoundingClientRect();
      if (rect) setAdjustedPosition({
        x: Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8)),
        y: Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8))
      });
    };
    fit(); window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [isOpen, position, confirmClose, error]);
  const save = async () => {
    if (nameError) return;
    if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try { await onSave(value); }
    catch (e) { setError(localizeError(e)); setConfirmClose(false); }
    finally { saving.current = false; setBusy(false); }
  };
  if (!isOpen) return null;
  return <Dialog open={isOpen} onOpenChange={open => { if (!open) requestClose(); }}>
    <DialogContent ref={dialogRef} aria-describedby={undefined}
      onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); }}
      onPointerDownOutside={event => { event.preventDefault(); requestClose(); }}
      onInteractOutside={event => event.preventDefault()}
      onEscapeKeyDown={event => {
        event.preventDefault();
        if (confirmClose) { setConfirmClose(false); inputRef.current?.focus(); }
        else requestClose();
      }}
      className="p-3 w-auto min-w-[240px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-auto"
      style={{ left: adjustedPosition.x, top: adjustedPosition.y, transform: 'none' }}>
    <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <DialogTitle className="text-sm font-medium mb-2 pr-5">{title ?? t('grid.editValueTitle')}</DialogTitle>
      <input ref={inputRef} type="text" value={value} disabled={busy} onChange={e => { setValue(e.target.value); setError(''); }} aria-invalid={!!nameError}
        placeholder={placeholder ?? t('grid.enterValue')}
        className="w-full px-3 py-1.5 border rounded-md bg-background focus:ring-2 focus:ring-ring text-sm" />
      {nameError && <p role="alert" className="text-sm text-red-600 mt-2">{nameError}</p>}
      {error && <p role="alert" className="text-sm text-red-600 mt-2 whitespace-pre-wrap">{error}</p>}
      {confirmClose && <p className="text-sm mt-2">{t('grid.saveRowLabelQuestion')}</p>}
      <div className="flex justify-end gap-2 mt-3">
        <button type="button" disabled={busy} onClick={() => confirmClose ? setConfirmClose(false) : requestClose()}
          className="px-3 py-1 text-sm border rounded">{t('common.cancel')}</button>
        {confirmClose && <button type="button" disabled={busy} onClick={onCancel}
          className="px-3 py-1 text-sm border rounded">{t('grid.discardRowLabel')}</button>}
        <button type="submit" disabled={busy || !!nameError} className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded">
          {busy ? t('grid.savingWithConfirmation') : t('common.save')}</button>
      </div>
    </form>
  </DialogContent></Dialog>;
};
