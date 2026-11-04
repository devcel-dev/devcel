import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import { localizeError, useI18n } from '@/app/i18n';
import { dismiss, useToast } from './use-toast';

/** One non-modal, non-focus-stealing notification host per webview. */
export function Toaster() {
  const { t } = useI18n();
  const { toasts } = useToast();
  useEffect(() => () => dismiss(), []);
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  const hasToasts = toasts.length > 0;
  useLayoutEffect(() => {
    if (!hasToasts) { setDialog(null); return; }
    // Radix modal dialogs hide outside siblings and trap focus. Keep the host
    // inside the topmost active modal so existing dialog notifications remain
    // announced, clickable and reachable by keyboard.
    const update = () => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')];
      setDialog(dialogs.reverse().find(element => !element.closest('[aria-hidden="true"]')) ?? null);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'aria-hidden'] });
    return () => observer.disconnect();
  }, [hasToasts]);
  const content = <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex max-h-[calc(100vh-2.5rem)] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col gap-2 overflow-y-auto" data-notification-host>
    {toasts.map(item => <div key={item.id} className={`pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg ${item.variant === 'destructive' ? 'border-destructive' : 'border-border'}`}>
      {item.variant === 'destructive' ? <AlertCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-destructive" /> : <CheckCircle2 aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary" />}
      <div key={item.revision} role={item.variant === 'destructive' ? 'alert' : 'status'} aria-atomic="true" className="min-w-0 flex-1 break-words [overflow-wrap:anywhere] text-sm">
        {item.title && <p className="font-semibold">{localizeError(item.title)}</p>}
        {item.description && <p className="mt-1 max-h-[50vh] overflow-y-auto whitespace-pre-wrap text-muted-foreground" tabIndex={0}>{localizeError(item.description)}</p>}
      </div>
      <button type="button" aria-label={t('notification.dismiss')} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => dismiss(item.id)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(item.id); } }}>
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>)}
  </div>;
  return dialog ? createPortal(content, dialog) : content;
}
