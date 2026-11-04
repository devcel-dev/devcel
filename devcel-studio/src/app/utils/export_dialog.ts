import { t } from '@/app/i18n';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export async function showExportDialog(expectedProjectSession: string, tableUuid?: string): Promise<void> {
  const params = new URLSearchParams({ expectedProjectSession });
  if (tableUuid) params.set('uuid', tableUuid);
  const url = `export_dialog?${params}`;

  const exportDialog = new WebviewWindow('export-dialog', {
    title: t('window.export'),
    url: url,
    width: 480,
    height: 600,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    decorations: true,
    skipTaskbar: true
  });

  // Wait for the dialog to be created
  await exportDialog.once('tauri://created', () => {
  });

  // Error handling
  exportDialog.once('tauri://error', (e) => {
    console.error('Failed to create export dialog:', e);
  });
}
