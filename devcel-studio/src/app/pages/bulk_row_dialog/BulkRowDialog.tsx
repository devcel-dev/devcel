import { useI18n, localizeError } from '@/app/i18n';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { BulkRowDialogData } from '@/app/utils/bulk_row_dialog';

export default function BulkRowDialog() {
  const { t } = useI18n();
  const sessionId = new URLSearchParams(window.location.search).get('session_id') || '';
  const [data, setData] = useState<BulkRowDialogData | null>(null);
  const [count, setCount] = useState('100');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const busyRef = useRef(false);
  const resolved = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void invoke<BulkRowDialogData>('get_bulk_row_session', { sessionId }).then(result => {
      if (active) setData(result);
    }).catch(e => { if (active) setError(e); });
    const unlisten = getCurrentWebviewWindow().onCloseRequested(event => {
      if (busyRef.current && !resolved.current) event.preventDefault();
    });
    return () => { active = false; void unlisten.then(fn => fn()).catch(() => {}); };
  }, [sessionId]);
  useEffect(() => { if (data) { inputRef.current?.focus(); inputRef.current?.select(); } }, [data]);

  const close = async () => {
    if (busyRef.current && !resolved.current) return;
    try { await getCurrentWebviewWindow().close(); }
    catch (e) { setError(e); }
  };
  const submit = async () => {
    if (resolved.current) { await close(); return; }
    if (busyRef.current || !data) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      // Pass the exact input to Rust. The GUI neither parses counts nor constructs records.
      await invoke('resolve_bulk_row_session', { sessionId, countInput: count });
      resolved.current = true; setSubmitted(true);
      await getCurrentWebviewWindow().close();
    } catch (e) {
      setError(e);
    } finally {
      busyRef.current = false; setBusy(false);
    }
  };

  return <form className="h-screen min-h-0 flex flex-col bg-background text-foreground" noValidate onSubmit={e => {
    e.preventDefault(); void submit();
  }} onKeyDown={e => {
    if (e.key === 'Escape' && !e.nativeEvent.isComposing && !busyRef.current) { e.preventDefault(); void close(); }
  }}>
    <header className="px-5 py-4 border-b"><h1 className="font-semibold text-lg">{t('grid.bulk.title')}</h1></header>
    <div className="min-h-0 flex-1 overflow-auto px-5 py-4 space-y-3">
      {data ? <>
        <p className="text-sm break-words">{t('grid.bulk.target', { table: data.table_name })}</p>
        <label className="block text-sm font-medium" htmlFor="row-count">{t('grid.bulk.count')}</label>
        <input ref={inputRef} id="row-count" type="text" inputMode="numeric" value={count}
          disabled={busy || submitted} onChange={e => setCount(e.target.value)} aria-describedby="row-count-hint"
          className="w-full border border-border rounded px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:bg-muted" />
        <p id="row-count-hint" className="text-xs text-muted-foreground">{t('grid.bulk.hint', { max: data.max_count })}</p>
      </> : <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {Boolean(error) && <p role="alert" className="rounded bg-red-50 border border-red-200 text-red-800 p-3 text-sm whitespace-pre-wrap">{submitted ? t('grid.bulk.closeFailed', { error: localizeError(error) }) : localizeError(error)}</p>}
    </div>
    <footer className="border-t px-5 py-3 flex justify-end gap-3">
      <button type="button" className="border rounded px-4 py-2 text-sm disabled:opacity-50" disabled={busy || submitted} onClick={() => void close()}>{t('common.cancel')}</button>
      <button type="submit" className="rounded px-4 py-2 text-sm bg-primary text-primary-foreground disabled:opacity-50" disabled={busy || !data}>{busy ? t('rules.dialog.processing') : submitted ? t('common.close') : t('grid.bulk.add')}</button>
    </footer>
  </form>;
}
