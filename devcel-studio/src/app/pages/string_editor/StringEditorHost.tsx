import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ExpandedStringEditor } from '@/app/pages/main_window/project_view/table_view/components/ExpandedStringEditor';
import { useTableMutation } from '@/app/pages/main_window/project_view/table_view/components/useTableMutation';
import { retainTableSnapshotInvalidation } from '@/app/services/tableSnapshotInvalidation';
import { localizeError } from '@/app/i18n';
import { cancelStringEditorClose, finishStringEditor, getStringEditorSnapshot, initializeStringEditor,
  isStringEditorSessionActive, subscribeStringEditor, type StringEditorInit } from '@/app/utils/string_editor_window';

/** Always mounted outside the table/project subtree so navigation cannot lose a draft. */
export function StringEditorHost({ projectSessionId }: { projectSessionId: string | null }) {
  const snapshot = useSyncExternalStore(subscribeStringEditor, getStringEditorSnapshot, getStringEditorSnapshot);
  return snapshot && <StringEditorSession key={snapshot.request.id} request={snapshot.request}
    closeRequest={snapshot.closeRequest} currentProjectSession={projectSessionId} />;
}
function StringEditorSession({ request, closeRequest, currentProjectSession }: {
  request: StringEditorInit; closeRequest: number; currentProjectSession: string | null;
}) {
  const saving = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const projectSession = useRef(currentProjectSession);
  projectSession.current = currentProjectSession;
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ownsDraft = useCallback(() => isStringEditorSessionActive(request)
    && projectSession.current === request.projectSessionId, [request]);
  const mutation = useTableMutation(request.tableUuid, request.projectSessionId, () => {
    window.dispatchEvent(new CustomEvent('table-data-changed', {
      detail: { projectSession: request.projectSessionId, tableUuid: request.tableUuid },
    }));
  }, ownsDraft);
  useEffect(() => initializeStringEditor(request, () => input.current?.focus()), [request]);
  useEffect(() => {
    let active = true;
    const subscription = retainTableSnapshotInvalidation(request.projectSessionId, change => {
      if (!saving.current && (!change.tableUuid || change.tableUuid === request.tableUuid)) setStale(true);
      if (change.error) setError(change.error);
    });
    void subscription.ready.catch(reason => { if (active) setError(reason); });
    return () => { active = false; subscription.release(); };
  }, [request]);
  async function commit(value: string, revision: string): Promise<boolean> {
    if (saving.current || !ownsDraft()) return false;
    saving.current = true;
    try {
      return await mutation.run(async () => ({
        table_uuid: request.tableUuid, expected_revision: revision,
        cells: [{ record_uuid: request.target.recordUuid, column_uuid: request.target.columnUuid, value }],
        versions: [], column_versions: [], create_records: [], delete_record_uuids: [],
      }));
    } catch (reason) { setError(reason); return false; }
    finally { saving.current = false; }
  }
  return <ExpandedStringEditor target={request.target} tableUuid={request.tableUuid} projectSessionId={request.projectSessionId}
    currentRevision={stale || !ownsDraft() ? `${request.target.revision}:stale` : request.target.revision}
    busy={mutation.busy} error={mutation.error || (error ? localizeError(error) : null)} onCommit={commit}
    onClose={() => finishStringEditor(request)} closeRequest={closeRequest}
    onCloseCancelled={() => cancelStringEditorClose(request)} inputRef={input} />;
}
