import { invoke } from '@tauri-apps/api/core';
import type { ColumnEditorTarget } from '@/app/components/column-editor/types';

export interface ColumnTypeDialogData { value: string; allow_select: boolean }
export interface ColumnTypeDialogPresentation { sessionId: string; finish: () => void }

/** The server-held intent stays bound to this editor's owner, UUIDs and revision. */
export async function showColumnTypeDialog(
  target: ColumnEditorTarget,
  expectedProjectSession: string,
  expectedRevision: string | null,
  value: string,
  signal: AbortSignal,
  present: (dialog: ColumnTypeDialogPresentation) => void,
): Promise<string | null> {
  if (signal.aborted) return null;
  const sessionId = await invoke<string>('create_column_type_session', { target, expectedProjectSession, expectedRevision, value });
  if (signal.aborted) {
    await invoke('take_column_type_result', { sessionId }).catch(() => {});
    return null;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      try {
        const result = await invoke<string | null>('take_column_type_result', { sessionId });
        if (error) reject(error);
        else resolve(signal.aborted ? null : result);
      } catch (readError) { reject(error || readError); }
    };
    const abort = () => { void finish(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { present({ sessionId, finish: () => { void finish(); } }); }
    catch (error) { void finish(error); }
  });
}
