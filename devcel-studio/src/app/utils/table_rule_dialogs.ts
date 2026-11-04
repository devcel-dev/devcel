import { t } from '@/app/i18n';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { TableDialogRequest, TableDialogResult, ValidationReport } from '@/app/types/tableRules';

/** The URL contains only a server-held session ID, never values or warning data. */
async function showTableRuleDialog(request: TableDialogRequest, signal?: AbortSignal): Promise<TableDialogResult | null> {
  if (signal?.aborted) return null;
  const sessionId = await invoke<string>('create_table_dialog_session', { request });
  if (signal?.aborted) {
    await invoke('take_table_dialog_result', { sessionId }).catch(() => {});
    return null;
  }
  const parent = getCurrentWebviewWindow();
  let dialog: WebviewWindow;
  try {
    dialog = new WebviewWindow(`table-rule-${sessionId}`, {
      title: request.title,
      url: `table_rule_dialog?session_id=${encodeURIComponent(sessionId)}`,
      width: 620, height: 650, minWidth: 360, minHeight: 360,
      center: true, resizable: true, alwaysOnTop: true, focus: true,
    });
  } catch (error) {
    await invoke('take_table_dialog_result', { sessionId }).catch(() => {});
    throw error;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let created = false;
    const unlisteners: Array<() => void> = [];
    const remember = (promise: Promise<() => void>) => {
      void promise.then(fn => { if (settled) fn(); else unlisteners.push(fn); }).catch(error => { void finish(error); });
    };
    const finish = async (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      unlisteners.splice(0).forEach(fn => fn());
      try {
        const result = await invoke<TableDialogResult | null>('take_table_dialog_result', { sessionId });
        if (error) reject(error);
        else resolve(signal?.aborted ? null : result);
      } catch (readError) { reject(error || readError); }
      if (!signal?.aborted) await parent.setFocus().catch(() => {});
    };
    const abort = () => { if (created) void dialog.destroy().catch(() => {}).finally(() => finish()); };
    remember(dialog.once('tauri://created', () => { created = true; if (signal?.aborted) abort(); }));
    remember(dialog.once('tauri://destroyed', () => { void finish(); }));
    remember(dialog.once('tauri://error', event => { void finish(event.payload); }));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function confirmInputWarnings(tableUuid: string, report: ValidationReport, signal?: AbortSignal): Promise<boolean> {
  const result = await showTableRuleDialog({ kind: 'warning', table_uuid: tableUuid, title: t('window.ruleWarnings'), report }, signal);
  return result?.approved === true;
}
