/** Promise-based in-app dialogs. Only an explicit positive action approves a request. */
export interface AppDialogOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}
export interface AppPromptOptions extends AppDialogOptions {
  validate?: (value: string) => string | undefined;
}
export interface AppDialogRequest {
  id: number;
  kind: 'alert' | 'confirm' | 'prompt';
  message: string;
  defaultValue: string;
  options: AppPromptOptions;
  opener: HTMLElement | null;
  finish: (value: string | boolean | null) => void;
  completeClose: () => void;
  canRestoreFocus: () => boolean;
}
let sequence = 0;
let requests: AppDialogRequest[] = [];
// Keep closing requests until Radix has released their focus scope. This also
// lets a request queued from inside a dialog inherit its external focus origin.
const liveRequests = new Map<number, AppDialogRequest>();
const subscribers = new Set<() => void>();
export function subscribeAppDialogs(listener: () => void) {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}
export const getAppDialog = () => requests[0] ?? null;
const notify = () => { for (const listener of subscribers) listener(); };
function enqueue(kind: AppDialogRequest['kind'], message: string, defaultValue = '', options: AppPromptOptions = {}) {
  return new Promise<string | boolean | null>(resolve => {
    let finished = false;
    let settled = false;
    let result: string | boolean | null = null;
    const focused = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ownerId = focused?.closest('[data-app-dialog]')?.getAttribute('data-app-dialog');
    const owner = ownerId ? liveRequests.get(Number(ownerId)) : undefined;
    const request: AppDialogRequest = {
      id: ++sequence, kind, message, defaultValue, options,
      opener: owner ? owner.opener : focused,
      finish: value => {
        if (finished) return;
        finished = true;
        result = value;
        requests = requests.filter(item => item !== request);
        notify();
      },
      canRestoreFocus: () => finished && !settled && sequence === request.id && requests.length === 0,
      completeClose: () => {
        // StrictMode can run a synthetic unmount while the dialog remains open.
        if (!finished || settled) return;
        settled = true;
        liveRequests.delete(request.id);
        // Promise continuations run only after onCloseAutoFocus returns and
        // Radix removes this focus scope. The caller can then focus its editor
        // without a delayed opener restoration stealing the caret afterward.
        resolve(result);
      },
    };
    liveRequests.set(request.id, request);
    requests = [...requests, request];
    notify();
  });
}
export async function appAlert(message: string, options: AppDialogOptions = {}): Promise<void> {
  await enqueue('alert', message, '', options);
}
export async function appConfirm(message: string, options: AppDialogOptions = {}): Promise<boolean> {
  return await enqueue('confirm', message, '', options) === true;
}
export async function appPrompt(message: string, defaultValue = '', options: AppPromptOptions = {}): Promise<string | null> {
  const result = await enqueue('prompt', message, defaultValue, options);
  return typeof result === 'string' ? result : null;
}

/** Compatibility for app notifications/decisions formerly shown by Tauri.
 * Keep OS file pickers in plugin-dialog; they are not app subwindows. */
interface AppMessageOptions {
  title?: string;
  kind?: 'info' | 'warning' | 'error';
  okLabel?: string;
  cancelLabel?: string;
}
export async function ask(message: string, options: AppMessageOptions | string = {}): Promise<boolean> {
  const resolved = typeof options === 'string' ? { title: options } : options;
  return appConfirm(message, { title: resolved.title, confirmLabel: resolved.okLabel, cancelLabel: resolved.cancelLabel,
    destructive: resolved.kind === 'warning' || resolved.kind === 'error' });
}
export async function message(message: string, options: AppMessageOptions | string = {}): Promise<void> {
  const resolved = typeof options === 'string' ? { title: options } : options;
  await appAlert(message, { title: resolved.title, confirmLabel: resolved.okLabel });
}
