import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '@/app/i18n';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getAppDialog, subscribeAppDialogs, type AppDialogRequest } from '@/app/services/appDialogs';

function AppDialog({ request }: { request: AppDialogRequest }) {
  const { t } = useI18n();
  const inputId = useId();
  const [value, setValue] = useState(request.defaultValue);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const accept = () => {
    if (request.kind === 'prompt') {
      const problem = request.options.validate?.(value);
      if (problem) { setError(problem); input.current?.focus(); return; }
      request.finish(value);
    } else request.finish(true);
  };
  return <Dialog open onOpenChange={open => { if (!open) request.finish(null); }}>
    <DialogContent ref={element => { if (element) content.current = element; }} data-app-dialog={request.id} className="z-[1001]" overlayClassName="z-[1000]" role={request.kind === 'prompt' ? 'dialog' : 'alertdialog'}
      onEscapeKeyDown={event => { if (event.isComposing || event.keyCode === 229) event.preventDefault(); }}
      onOpenAutoFocus={event => {
        event.preventDefault();
        if (request.kind === 'prompt') { input.current?.focus(); input.current?.select(); }
        else cancel.current?.focus();
      }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        // StrictMode cleanup is not a real close while this content is mounted.
        if (content.current?.isConnected) return;
        try {
          const focused = document.activeElement;
          const unclaimed = !focused || focused === document.body || !focused.isConnected || content.current?.contains(focused);
          // A newer dialog or an explicitly focused control owns focus now.
          // Restore synchronously before settling, never in a later frame.
          if (request.canRestoreFocus() && unclaimed && request.opener?.isConnected) request.opener.focus({ preventScroll: true });
        } finally { request.completeClose(); }
      }}>
      <DialogHeader>
        <DialogTitle>{request.options.title ?? (request.kind === 'alert' ? 'Devcel Studio' : t('common.confirm'))}</DialogTitle>
        <DialogDescription className="whitespace-pre-wrap [overflow-wrap:anywhere]">{request.message}</DialogDescription>
      </DialogHeader>
      {request.kind === 'prompt' ? <form className="grid min-w-0 gap-4" onSubmit={event => { event.preventDefault(); accept(); }}>
        <label className="sr-only" htmlFor={inputId}>{request.message}</label>
        <Input ref={input} id={inputId} value={value} aria-invalid={!!error} aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={event => { setValue(event.target.value); setError(undefined); }} />
        {error && <p id={`${inputId}-error`} role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => request.finish(null)}>{request.options.cancelLabel ?? t('common.cancel')}</Button>
          <Button type="submit">{request.options.confirmLabel ?? t('common.confirm')}</Button>
        </DialogFooter>
      </form> : <DialogFooter>
        {request.kind === 'confirm' && <Button ref={cancel} type="button" variant="outline" onClick={() => request.finish(null)}>{request.options.cancelLabel ?? t('common.cancel')}</Button>}
        <Button ref={request.kind === 'alert' ? cancel : undefined} type="button" variant={request.options.destructive ? 'destructive' : 'default'} onClick={accept}>
          {request.options.confirmLabel ?? t('common.confirm')}
        </Button>
      </DialogFooter>}
    </DialogContent>
  </Dialog>;
}
/** Mounted once per application window, alongside its router and theme. */
export function AppDialogHost() {
  const request = useSyncExternalStore(subscribeAppDialogs, getAppDialog, getAppDialog);
  return request ? <AppDialog key={request.id} request={request} /> : null;
}
