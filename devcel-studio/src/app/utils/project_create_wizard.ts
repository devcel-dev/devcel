import { captureDialogTheme } from '@/app/settings/dialogTheme';
import { t } from '@/app/i18n';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export async function showProjectCreateWizard() : Promise<void> {
    const label = 'wizard';

    var createwindow: WebviewWindow | undefined = void 0;
    try {
      createwindow = new WebviewWindow(label, {
      title: t('window.projectCreate'),
      url: `project_create_wizard?dialogTheme=${encodeURIComponent(captureDialogTheme())}`,
      width: 720,
      height: 600,
      resizable: false,
      center: true,
      alwaysOnTop: true
      });
    } catch (error) {
      console.error('error', error);
    }

    try {

    await new Promise<void>((resolve) => {
      if(createwindow) {
        createwindow.once('tauri://created', () => {
            resolve();
          });
        }
      });


    await new Promise<void>((resolve) => {
      if(createwindow) {
        createwindow.onCloseRequested(() => {
            resolve();
            createwindow?.close();
          });
        }
      });
    } catch (error) {
      if(createwindow && await createwindow.isClosable()) {
        await createwindow.close();
      }
      console.error('error', error);
    }
}
