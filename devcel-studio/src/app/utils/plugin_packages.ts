import { t } from '@/app/i18n';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

let opening: Promise<void> | undefined;

export function showPluginPackages(): Promise<void> {
  return opening ||= openPackages().finally(() => { opening = undefined; });
}

async function openPackages(): Promise<void> {
  const existing = await WebviewWindow.getByLabel('plugin-packages');
  if (existing) {
    await existing.show();
    await existing.unminimize();
    await existing.setFocus();
    return;
  }
  const window = new WebviewWindow('plugin-packages', {
    title: t('window.pluginPackages'), url: 'plugin_packages', width: 960, height: 760,
    minWidth: 680, minHeight: 520, resizable: true, center: true, decorations: true,
  });
  await new Promise<void>((resolve, reject) => {
    void window.once('tauri://created', () => resolve());
    void window.once('tauri://error', event => reject(new Error(String(event.payload))));
  });
}
