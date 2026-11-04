import type { SavedColorSwatch, ColorSwatchColumnContext } from '@/app/types/colorTypes';
import type { ColorPickerType } from '@/app/components/color/colorDisplay';
export interface ColorPickerRequest { type: ColorPickerType; value: string; label: string; readonly?: boolean; formula?: boolean; columnSwatches?: SavedColorSwatch[]; columnContext?: ColorSwatchColumnContext }
export interface ColorPickerSession { id: string; request: ColorPickerRequest; opener: HTMLElement | null; signal: AbortSignal; finish: (value: string | null) => void }

/** WebKit's local native origin may expose getRandomValues without randomUUID. */
export function colorPickerId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let session: ColorPickerSession | null = null;
const listeners = new Set<() => void>();
export const getColorPickerSession = () => session;
export const subscribeColorPicker = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = () => { for (const listener of listeners) listener(); };
let hosts = 0;
/** Defer teardown so a StrictMode effect replay does not cancel an active draft. */
export function registerColorPickerHost(): () => void {
  hosts += 1;
  return () => { hosts -= 1; queueMicrotask(() => { if (hosts === 0) session?.finish(null); }); };
}

/** Returns a draft scalar inside the existing app window. The owner retains all
 * UUID/session/revision mutation authority. Superseded or aborted drafts never apply. */
export function showColorPicker(request: ColorPickerRequest, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null);
  session?.finish(null);
  return new Promise(resolve => {
    let settled = false;
    const entry: ColorPickerSession = { id: colorPickerId(), request, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null, signal, finish: value => {
      if (settled || (value !== null && request.readonly)) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (session === entry) { session = null; publish(); }
      resolve(signal.aborted ? null : value);
    } };
    const abort = () => entry.finish(null);
    signal.addEventListener('abort', abort, { once: true });
    session = entry;
    publish();
  });
}
