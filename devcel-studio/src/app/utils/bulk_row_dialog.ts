import { t } from '@/app/i18n';
import { captureDialogTheme } from '@/app/settings/dialogTheme';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { TableMutation } from '@/app/types/tableRules';

export interface BulkRowDialogData {
  table_name: string;
  max_count: number;
}

/** Only a Rust-held session ID crosses the URL; Rust prepares the entire mutation. */
export async function showBulkRowDialog(
  tableUuid: string,
  expectedRevision: string,
  expectedProjectSession: string,
  signal: AbortSignal,
): Promise<TableMutation | null> {
  if (signal.aborted) return null;
  const sessionId = await invoke<string>('create_bulk_row_session', { tableUuid, expectedRevision, expectedProjectSession });
  if (signal.aborted) {
    await invoke('take_bulk_row_result', { sessionId }).catch(() => {});
    return null;
  }
  const parent = getCurrentWebviewWindow();
  let dialog: WebviewWindow;
  try {
    dialog = new WebviewWindow(`bulk-rows-${sessionId}`, {
      title: t('grid.bulk.title'),
      url: `bulk_row_dialog?session_id=${encodeURIComponent(sessionId)}&dialogTheme=${encodeURIComponent(captureDialogTheme())}`,
      width: 460, height: 360, minWidth: 360, minHeight: 320,
      center: true, resizable: true, alwaysOnTop: true, focus: true,
    });
  } catch (error) {
    await invoke('take_bulk_row_result', { sessionId }).catch(() => {});
    throw error;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let created = false;
    let creationFailed = false;
    let unlistenCreated: (() => void) | undefined;
    const releaseCreated = () => {
      if (created || creationFailed) { unlistenCreated?.(); unlistenCreated = undefined; }
    };
    const unlisteners: Array<() => void> = [];
    const remember = (promise: Promise<() => void>) => {
      void promise.then(fn => { if (settled) fn(); else unlisteners.push(fn); }).catch(error => { void finish(error); });
    };
    const finish = async (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      unlisteners.splice(0).forEach(fn => fn());
      releaseCreated();
      if (error) await dialog.destroy().catch(() => {});
      try {
        const result = await invoke<TableMutation | null>('take_bulk_row_result', { sessionId });
        if (error) reject(error);
        else resolve(signal.aborted ? null : result);
      } catch (readError) { reject(error || readError); }
      if (!signal.aborted) await parent.setFocus().catch(() => {});
    };
    const abort = () => {
      // A not-yet-created window must still be destroyed once its created event arrives.
      if (created) void dialog.destroy().catch(() => {}).finally(() => finish());
    };
    // If another listener fails before window creation, retain this one long
    // enough to destroy the late window rather than leave an always-on-top orphan.
    void dialog.once('tauri://created', () => {
      created = true; releaseCreated();
      if (settled) void dialog.destroy().catch(() => {});
      else if (signal.aborted) abort();
    }).then(fn => { unlistenCreated = fn; releaseCreated(); }).catch(error => { void finish(error); });
    remember(dialog.once('tauri://destroyed', () => { void finish(); }));
    remember(dialog.once('tauri://error', event => { creationFailed = true; void finish(event.payload); }));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
