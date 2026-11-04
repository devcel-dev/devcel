import { t } from '@/app/i18n';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

let opening: Promise<void> | undefined;
export function showPluginManager(): Promise<void> {
  return opening ||= openManager().finally(() => { opening = undefined; });
}
async function openManager(): Promise<void> {
  const existing = await WebviewWindow.getByLabel('plugin-manager');
  if (existing) {
    await existing.show();
    await existing.unminimize();
    await existing.setFocus();
    return;
  }
  const window = new WebviewWindow('plugin-manager', {
    title: t('window.plugins'), url: 'plugin_manager', width: 960, height: 720,
    minWidth: 720, minHeight: 520, resizable: true, center: true,
    decorations: true, transparent: false, alwaysOnTop: false,
  });
  await new Promise<void>((resolve, reject) => {
    void window.once('tauri://created', () => resolve());
    void window.once('tauri://error', event => reject(new Error(String(event.payload))));
  });
}
