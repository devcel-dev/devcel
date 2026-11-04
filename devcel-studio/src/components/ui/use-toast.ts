import { useSyncExternalStore } from 'react';
import type { LocalizedMessage } from '@/app/i18n';

export type ToastProps = {
  id?: string;
  title?: string | LocalizedMessage;
  description?: string | LocalizedMessage;
  variant?: 'default' | 'destructive';
  /** Zero keeps a notification until explicitly dismissed. */
  duration?: number;
};
export type ToastItem = ToastProps & { id: string; revision: number };

// Module state belongs to this webview, never another editor/settings window.
let toasts: ToastItem[] = [];
let revision = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const publish = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => toasts;

export function dismiss(toastId?: string) {
  for (const [id, timer] of timers) {
    if (!toastId || id === toastId) { clearTimeout(timer); timers.delete(id); }
  }
  toasts = toastId ? toasts.filter(item => item.id !== toastId) : [];
  publish();
}

export function toast(props: ToastProps) {
  const version = ++revision;
  const id = props.id ?? `notification-${version}`;
  const previousTimer = timers.get(id);
  if (previousTimer !== undefined) clearTimeout(previousTimer);
  timers.delete(id);
  const next = { ...props, id, revision: version };
  toasts = [...toasts.filter(item => item.id !== id), next];
  publish();
  const duration = props.duration ?? (props.variant === 'destructive' ? 0 : 4000);
  if (duration > 0) timers.set(id, setTimeout(() => {
    // An already queued timeout may belong to the previous notification.
    if (toasts.some(item => item.id === id && item.revision === version)) dismiss(id);
  }, duration));
}

export function useToast() {
  return { toasts: useSyncExternalStore(subscribe, snapshot, snapshot), toast, dismiss };
}
