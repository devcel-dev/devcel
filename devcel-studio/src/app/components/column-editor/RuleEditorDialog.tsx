import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { flushSync } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { t, useI18n } from '@/app/i18n';
import { registerTableNavigationBlocker } from '@/app/services/tableInteractionScope';
import { registerMainWindowCloseBlocker } from '@/app/utils/string_editor_window';
import { useSettingsCloseGuard } from '@/app/utils/useSettingsCloseGuard';

/** A child draft: existing settings apply on close, new rules on Apply. The owner saves the column. */
export function RuleEditorDialog({ title, onClose, onApply, disabled = false, busy = false, applyOnClose = false, children }: {
  title: string; onClose: () => void; onApply: () => void; disabled?: boolean; busy?: boolean; applyOnClose?: boolean; children: ReactNode;
}) {
  useI18n();
  const composition = useSettingsCloseGuard();
  const prepareClose = composition.prepareClose;
  const [trigger] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const settled = useRef(false);
  const mounted = useRef(true);
  const closing = useRef<Promise<boolean> | null>(null);
  const requestClose = useRef<(navigation?: boolean) => Promise<boolean>>(async () => false);
  const finishClose = () => {
    if (settled.current || busy && applyOnClose) return;
    settled.current = true;
    if (applyOnClose && !disabled) onApply(); else onClose();
  };
  const closeState = useRef({ busy, applyOnClose, close: finishClose, onApply, disabled });
  closeState.current = { busy, applyOnClose, close: finishClose, onApply, disabled };
  useEffect(() => {
    mounted.current = true;
    const guard = (navigation = true) => {
      if (closing.current) return closing.current;
      if (closeState.current.busy && (navigation || closeState.current.applyOnClose)) return Promise.resolve(false);
      const operation = (async () => {
        if (!await prepareClose()) return false;
        if (!mounted.current || settled.current) return true;
        if (closeState.current.busy && (navigation || closeState.current.applyOnClose)) return false;
        // Publish the child transaction before the lower-priority parent gate.
        flushSync(() => closeState.current.close());
        return true;
      })();
      closing.current = operation;
      void operation.finally(() => { if (closing.current === operation) closing.current = null; });
      return operation;
    };
    requestClose.current = guard;
    const navigation = registerTableNavigationBlocker(guard, 10);
    const windowClose = registerMainWindowCloseBlocker(guard, 10);
    return () => { mounted.current = false; navigation(); windowClose(); };
  }, [prepareClose]);
  const close = () => { void requestClose.current(false); };
  return <Dialog.Root open onOpenChange={open => { if (!open) close(); }}>
    <Dialog.Portal><Dialog.Overlay className="rule-dialog-overlay" /><Dialog.Content {...composition.captureProps} aria-describedby={undefined} className="column-editor rule-editor-dialog"
      onCloseAutoFocus={event => { event.preventDefault(); if (trigger?.isConnected) trigger.focus(); }}
      onPointerDownOutside={event => { event.preventDefault(); close(); }}
      onInteractOutside={event => event.preventDefault()}
      onEscapeKeyDown={event => {
        event.preventDefault(); event.stopPropagation();
        if (!event.isComposing && event.keyCode !== 229) close();
      }}
      onKeyDown={event => event.stopPropagation()}>
      <header className="rule-dialog-header"><Dialog.Title>{title}</Dialog.Title><button type="button" className="rule-icon-button" aria-label={t('common.close')} disabled={busy && applyOnClose} onClick={close}><X className="w-4 h-4" /></button></header>
      <div className="rule-dialog-body">{children}</div>
      <footer className="rule-dialog-footer"><button type="button" className="editor-action" disabled={busy && applyOnClose} onClick={close}>{t(applyOnClose ? 'common.close' : 'common.cancel')}</button>{!applyOnClose && <button type="button" className="editor-action editor-primary" disabled={disabled} onClick={async () => {
        if (!await prepareClose() || settled.current || closeState.current.disabled || closeState.current.busy) return;
        settled.current = true;
        closeState.current.onApply();
      }}>{t('common.apply')}</button>}</footer>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
