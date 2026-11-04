import { t, useI18n, localizeError } from '@/app/i18n';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ColumnTypePickerPanel } from '@/app/components/column-editor/ColumnTypePickerPanel';
import type { ColumnTypeDialogData } from '@/app/utils/column_type_dialog';

export default function ColumnTypeDialog({ sessionId, onClose, onReturnFocus }: { sessionId: string; onClose: () => void; onReturnFocus?: () => void }) {
  useI18n();
  const [request, setRequest] = useState<ColumnTypeDialogData | null>(null);
  const [error, setError] = useState<unknown>('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const resolved = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    let active = true; mounted.current = true;
    void invoke<ColumnTypeDialogData>('get_column_type_session', { sessionId }).then(data => {
      if (active) setRequest(data);
    }).catch(reason => { if (active) setError(reason); });
    return () => { active = false; mounted.current = false; };
  }, [sessionId]);
  const finish = async (value: string | null) => {
    if (busyRef.current || resolved.current) return;
    // Closing consumes the session in the parent, even if this picker has expired.
    if (value === null) {
      resolved.current = true;
      onClose();
      return;
    }
    busyRef.current = true; setBusy(true); setError('');
    try {
      await invoke('resolve_column_type_session', { sessionId, value });
      resolved.current = true;
      if (mounted.current) onClose();
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason);
      if (!resolved.current) { busyRef.current = false; setBusy(false); }
    }
  };
  return <Dialog open onOpenChange={open => { if (!open) void finish(null); }}>
    <DialogContent aria-describedby={undefined}
      className="flex h-[min(520px,calc(100dvh-24px))] w-[min(620px,calc(100vw-24px))] max-w-none flex-col gap-0 overflow-hidden p-0 [&>button]:hidden"
      onOpenAutoFocus={event => event.preventDefault()}
      onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus?.(); }}
      onPointerDownOutside={event => { event.preventDefault(); void finish(null); }}
      onInteractOutside={event => event.preventDefault()}
      onEscapeKeyDown={event => {
        event.preventDefault(); event.stopPropagation();
        if (!event.isComposing && event.keyCode !== 229) void finish(null);
      }}
      onKeyDown={event => event.stopPropagation()}>
      <DialogTitle className="sr-only">{t('column.typePicker.heading')}</DialogTitle>
    {Boolean(error) && <div role="alert" className="shrink-0 border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-800">
      <p>{localizeError(error)}</p>
      <button type="button" className="mt-2 underline" onClick={() => void finish(null)}>{t('common.close')}</button>
    </div>}
    {request ? <ColumnTypePickerPanel value={request.value} allowSelect={request.allow_select} busy={busy} onSelect={value => void finish(value)} onCancel={() => void finish(null)} />
      : !error && <p role="status" className="p-5 text-sm">{t('common.loading')}</p>}
    </DialogContent>
  </Dialog>;
}
