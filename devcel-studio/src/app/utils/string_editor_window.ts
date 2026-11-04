import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { t } from '@/app/i18n';
import type { StringEditorTarget } from '@/app/pages/main_window/project_view/table_view/components/ExpandedStringEditor';

export interface StringEditorRequest { target: StringEditorTarget; tableUuid: string; projectSessionId: string }
export interface StringEditorInit extends StringEditorRequest { id: string }
export interface StringEditorSnapshot { request: StringEditorInit; closeRequest: number }
interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
interface EditorSession {
  request: StringEditorInit;
  opening: Deferred<void>;
  close?: Deferred<boolean>;
  focus?: () => void;
  opener: HTMLElement | null;
}
// This ownership outlives the originating grid, table tab and React mounts.
let activeEditor: EditorSession | undefined;
let snapshot: StringEditorSnapshot | null = null;
const subscribers = new Set<() => void>();
let mainWindowClosing: symbol | undefined;
let mainWindowGuardOwner: symbol | undefined;
let mainWindowGuardReady = false;
function publish(next: StringEditorSnapshot | null) {
  snapshot = next;
  for (const notify of subscribers) notify();
}
export function subscribeStringEditor(notify: () => void): () => void {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}
export function getStringEditorSnapshot(): StringEditorSnapshot | null { return snapshot; }
/** Exact frozen request identity includes the cell UUIDs, table and project session. */
export function isStringEditorSessionActive(request: StringEditorInit): boolean {
  return activeEditor?.request === request;
}
export function initializeStringEditor(request: StringEditorInit, focus: () => void): () => void {
  const editor = activeEditor;
  if (!editor || editor.request !== request) return () => {};
  editor.focus = focus;
  editor.opening.resolve();
  return () => { if (editor.focus === focus) editor.focus = undefined; };
}
export function finishStringEditor(request: StringEditorInit): void {
  const editor = activeEditor;
  if (!editor || editor.request !== request) return;
  activeEditor = undefined;
  publish(null);
  editor.opening.resolve();
  editor.close?.resolve(true);
  if (!mainWindowClosing) queueMicrotask(() => { if (editor.opener?.isConnected) editor.opener.focus(); });
}
export function cancelStringEditorClose(request: StringEditorInit): void {
  const editor = activeEditor;
  if (!editor || editor.request !== request) return;
  editor.close?.resolve(false);
  editor.close = undefined;
}
/** randomUUID is secure-context-only in WebKit; the fallback uses secure bytes. */
export function stringEditorId(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  if (typeof source?.getRandomValues !== 'function') throw new Error(t('grid.stringEditorOpenFailed'));
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Opens exactly one in-app editor; another click never replaces its draft. */
export async function showStringEditor(request: StringEditorRequest): Promise<void> {
  if (activeEditor) {
    activeEditor.focus?.();
    return activeEditor.opening.promise;
  }
  if (mainWindowClosing || !mainWindowGuardReady || subscribers.size === 0) throw new Error(t('grid.stringEditorOpenFailed'));
  const fixed = Object.freeze({ id: stringEditorId(), tableUuid: request.tableUuid,
    projectSessionId: request.projectSessionId, target: Object.freeze({
      recordUuid: request.target.recordUuid, columnUuid: request.target.columnUuid,
      label: request.target.label, value: request.target.value, revision: request.target.revision,
    }) });
  const editor: EditorSession = { request: fixed, opening: deferred<void>(),
    opener: document.activeElement instanceof HTMLElement ? document.activeElement : null };
  activeEditor = editor;
  publish({ request: fixed, closeRequest: 0 });
  return editor.opening.promise;
}
/** Cancellation keeps the active editor and all recovery drafts. */
export function requestCloseStringEditor(): Promise<boolean> {
  const editor = activeEditor;
  if (!editor) return Promise.resolve(true);
  if (subscribers.size === 0) return Promise.reject(new Error(t('grid.stringEditorCloseFailed')));
  if (editor.close) return editor.close.promise;
  editor.close = deferred<boolean>();
  const promise = editor.close.promise;
  editor.focus?.();
  publish({ request: editor.request, closeRequest: (snapshot?.closeRequest ?? 0) + 1 });
  return promise;
}

/** Mounted main-window editors participate without adding native listeners. */
type MainWindowCloseBlocker = () => boolean | Promise<boolean>;
const mainWindowCloseBlockers = new Map<MainWindowCloseBlocker, number>();
export function registerMainWindowCloseBlocker(blocker: MainWindowCloseBlocker, priority = 0): () => void {
  mainWindowCloseBlockers.set(blocker, priority);
  return () => { mainWindowCloseBlockers.delete(blocker); };
}
async function mainWindowEditorsAllowClose(): Promise<boolean> {
  for (const [blocker] of Array.from(mainWindowCloseBlockers).sort((a, b) => b[1] - a[1])) if (!await blocker()) return false;
  return true;
}

/** The main window must have one close listener for all draft owners. Tauri
 * creates a distinct CloseRequestedEvent for every listener and destroys the
 * window when any one listener fails to prevent its own event. */
export function installMainWindowCloseGuard(
  flush: () => Promise<void>,
  onError: (error: unknown) => void | Promise<unknown>,
): () => void {
  const parent = getCurrentWebviewWindow();
  let active = true;
  let closing = false;
  const owner = Symbol();
  mainWindowGuardOwner = owner;
  mainWindowGuardReady = false;
  const report = (reason: unknown) => {
    if (active) void Promise.resolve().then(() => onError(reason)).catch(console.error);
  };
  const subscription = parent.onCloseRequested(event => {
    // Always prevent, including duplicate requests and an effect being disposed
    // while asynchronous native listener registration is still completing.
    event.preventDefault();
    if (!active || closing) return;
    closing = true;
    mainWindowClosing = owner;
    void (async () => {
      while (active) {
        if (!await mainWindowEditorsAllowClose()) return;
        if (!await requestCloseStringEditor() || !active || !await mainWindowEditorsAllowClose()) return;
        await flush();
        if (!active || !await mainWindowEditorsAllowClose()) return;
        // The main UI can open another editor during an asynchronous Markdown
        // flush. Its decision and any new Markdown work need the same guard.
        if (activeEditor) continue;
        // All decisions succeeded. Destroy deliberately rather than emitting a
        // second close request and racing independently-wrapped listeners.
        await parent.destroy();
        return;
      }
    })().catch(report).finally(() => { closing = false; if (mainWindowClosing === owner) mainWindowClosing = undefined; });
  });
  void subscription.then(() => { if (active && mainWindowGuardOwner === owner) mainWindowGuardReady = true; }).catch(report);
  return () => {
    active = false;
    if (mainWindowClosing === owner) mainWindowClosing = undefined;
    if (mainWindowGuardOwner === owner) { mainWindowGuardOwner = undefined; mainWindowGuardReady = false; }
    void subscription.then(unlisten => unlisten()).catch(() => {});
  };
}
