import { useEffect, useSyncExternalStore } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useI18n } from '@/app/i18n';
import { getColorPickerSession, registerColorPickerHost, subscribeColorPicker } from '@/app/utils/color_picker_window';
import { ColorPickerPanel } from './ColorPickerPanel';
import './color-picker.css';

/** One host per application window, shared by cells and every color field. */
export function ColorPickerDialogHost() {
  const { t } = useI18n();
  const session = useSyncExternalStore(subscribeColorPicker, getColorPickerSession, getColorPickerSession);
  useEffect(registerColorPickerHost, []);
  if (!session) return null;
  return <Dialog.Root key={session.id} open onOpenChange={open => { if (!open) session.finish(null); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="color-picker-overlay" />
      <Dialog.Content className="color-picker-dialog" aria-describedby={undefined}
        onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault(); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          requestAnimationFrame(() => {
            if (!getColorPickerSession() && !session.signal.aborted && session.opener?.isConnected) session.opener.focus({ preventScroll: true });
          });
        }}>
        <ColorPickerPanel request={session.request}
          title={<Dialog.Title className="text-sm font-semibold">{t('color.title')}</Dialog.Title>}
          onApply={async value => { session.finish(value); }} onCancel={() => session.finish(null)} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
