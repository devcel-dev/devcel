import { t } from '@/app/i18n';
import { getProjectSession } from '@/app/commands/projectCommands';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emitTo } from '@tauri-apps/api/event';

export const PROJECT_TAG_FOCUS_EVENT = 'project-edit-focus-tags';
let opening: Promise<WebviewWindow> | null = null;

/** Reuse the settings window; opening it never resets an existing settings draft. */
export async function showProjectEditDialog(options?: { expectedProjectSession: string; focusTags: boolean }): Promise<void> {
  const session = await getProjectSession();
  if (!session || (options && options.expectedProjectSession !== session.id)) throw new Error(t('project.sessionChanged'));
  const label = 'project-edit-dialog';
  if (!opening) {
    opening = (async () => {
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) return existing;
      const query = new URLSearchParams({ projectSession: session.id });
      if (options?.focusTags) query.set('focusTags', '1');
      const created = new WebviewWindow(label, {
        title: t('window.projectEdit'), url: `project_edit_dialog?${query}`,
        width: 500, height: 400, resizable: false, center: true, alwaysOnTop: true,
      });
      await new Promise<void>((resolve, reject) => {
        let success: (() => void) | undefined, failure: (() => void) | undefined;
        let settled = false;
        const cleanup = () => { settled = true; success?.(); failure?.(); };
        void created.once('tauri://created', () => { cleanup(); resolve(); }).then(unlisten => { if (settled) unlisten(); else success = unlisten; }).catch(reject);
        void created.once('tauri://error', event => { cleanup(); reject(event.payload); }).then(unlisten => { if (settled) unlisten(); else failure = unlisten; }).catch(reject);
      });
      return created;
    })();
  }
  const pending = opening;
  let window: WebviewWindow;
  try { window = await pending; } finally { if (opening === pending) opening = null; }
  if ((await getProjectSession())?.id !== session.id) throw new Error(t('project.sessionChanged'));
  await window.show();
  await window.setFocus();
  if (options?.focusTags) await emitTo(label, PROJECT_TAG_FOCUS_EVENT, { project_session: session.id });
}
