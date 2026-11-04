import { settingsDisplayLabel } from '@/app/settings/displayLabels';
import { t, useI18n, localizeError } from '@/app/i18n';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { TableDialogRequest, TableDialogResult } from '@/app/types/tableRules';

export default function TableRuleDialog() {
  useI18n();
  const sessionId = new URLSearchParams(window.location.search).get('session_id') || '';
  const [request, setRequest] = useState<TableDialogRequest | null>(null);
  const [error, setError] = useState<unknown>('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const resolved = useRef(false);
  useEffect(() => {
    let active = true;
    void invoke<TableDialogRequest>('get_table_dialog_session', { sessionId }).then(data => {
      if (!active) return;
      setRequest(data);
    }).catch(e => { if (active) setError(e); });
    const unlisten = getCurrentWebviewWindow().onCloseRequested(event => {
      if (busyRef.current && !resolved.current) event.preventDefault();
    });
    return () => { active = false; void unlisten.then(fn => fn()).catch(() => {}); };
  }, [sessionId]);
  const finish = async (approved: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result: TableDialogResult = { approved };
      await invoke('resolve_table_dialog_session', { sessionId, result });
      resolved.current = true;
      await getCurrentWebviewWindow().close();
    } catch (e) {
      setError(resolved.current ? { sent: true, cause: e } : e);
      if (!resolved.current) { busyRef.current = false; setBusy(false); }
    }
  };
  return <main className="h-screen flex flex-col bg-background text-foreground" onKeyDown={e => {
    if (e.key === 'Escape' && !e.nativeEvent.isComposing && !busyRef.current) { e.preventDefault(); void finish(false); }
  }}>
    <header className="px-5 py-4 border-b"><h1 className="font-semibold text-lg">{request ? t('rules.dialog.title') : t('rules.dialog.loading')}</h1></header>
    <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
      {Boolean(error) && <p role="alert" className="rounded bg-red-50 border border-red-200 text-red-800 p-3 text-sm whitespace-pre-wrap">{error && typeof error === 'object' && 'sent' in error && 'cause' in error ? t('rules.dialog.closeFailed', { error: localizeError(error.cause) }) : localizeError(error)}</p>}
      {request?.kind === 'warning' && <>
        <ul className="space-y-3">{request.report?.issues.map((issue, index) => <li key={`${issue.rule_key}-${issue.record_uuid}-${index}`} className="border border-amber-200 bg-amber-50 rounded p-3 text-sm break-words">
          <strong>{settingsDisplayLabel(issue.column_uuid, issue.column_name)}</strong><p>{localizeError(issue)}</p><p className="mt-1 text-xs whitespace-pre-wrap">{t('rules.dialog.inputValue', { value: issue.raw_value || t('column.empty') })}</p>
          {issue.record_uuid && <p className="mt-1 text-[10px] text-muted-foreground">{t('column.rowLocation', { row: issue.record_uuid })}</p>}
        </li>)}</ul>
      </>}
    </div>
    <footer className="border-t px-5 py-3 flex justify-end gap-3">
      <button className="border rounded px-4 py-2 text-sm" disabled={busy} onClick={() => void finish(false)}>{t('common.cancel')}</button>
      <button className="rounded px-4 py-2 text-sm bg-blue-600 text-white disabled:opacity-50" disabled={busy || !request || (request.kind === 'warning' && request.report?.issues.some(issue => issue.mode === 'reject'))} onClick={() => void finish(true)}>{busy ? t('rules.dialog.processing') : t('rules.dialog.continue')}</button>
    </footer>
  </main>;
}
