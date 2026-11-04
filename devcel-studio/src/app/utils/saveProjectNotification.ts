import { flushProjectSaveParticipants } from './projectSaveParticipants';
import { getProjectSession, saveProject } from '@/app/commands/projectCommands';
import { message, toAppError } from '@/app/i18n';
import { toast } from '@/components/ui/use-toast';

let request = 0;
/** Explicit saves only: background/automatic writes stay quiet. */
export async function saveProjectWithNotification() {
  const ticket = ++request;
  let sessionId: string | undefined;
  const isCurrent = async () => ticket === request && (!sessionId || (await getProjectSession())?.id === sessionId) && ticket === request;
  try {
    sessionId = (await getProjectSession())?.id;
    if (!sessionId) throw new Error('no project open');
    if (!await flushProjectSaveParticipants(sessionId) || !await isCurrent()) return;
    await saveProject(sessionId);
    // Failure to verify the owner after a successful write is not a save failure.
    if (!await isCurrent().catch(() => false)) return;
    toast({ id: 'project-save', title: message('notification.saved') });
  } catch (error) {
    // Navigation or a newer request makes this completion obsolete. A failed
    // session check must not hide the original save error or reject an event handler.
    let current = ticket === request;
    try { current = await isCurrent(); } catch { /* retain original error */ }
    if (!current || ticket !== request) return;
    toast({ id: 'project-save', title: message('common.error'), description: message('project.saveFailed', { error: toAppError(error) }), variant: 'destructive', duration: 0 });
  }
}
