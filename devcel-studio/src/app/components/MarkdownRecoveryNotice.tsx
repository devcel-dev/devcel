import { useEffect, useState } from 'react';
import { ask } from '@/app/services/appDialogs';

import { useI18n, localizeError } from '@/app/i18n';
import { markdownSaveCoordinator } from '@/app/utils/markdownSaveLifecycle';

/** Keep failed, detached drafts reachable even after a project session or filename changes. */
export function MarkdownRecoveryNotice() {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState(() => markdownSaveCoordinator.getRecoveryDrafts());

  useEffect(() => {
    const update = () => setDrafts(markdownSaveCoordinator.getRecoveryDrafts());
    const unsubscribe = markdownSaveCoordinator.subscribe(update);
    update();
    return unsubscribe;
  }, []);

  if (drafts.length === 0) return null;
  return (
    <aside role="alert" className="max-h-64 shrink-0 overflow-auto border-t border-red-300 bg-red-50 px-4 py-2 text-red-800">
      <p className="font-medium">{t('grid.markdownRecoveryTitle')}</p>
      <p className="text-sm">{t('grid.markdownRecoveryHint')}</p>
      {drafts.map(draft => (
        <details key={draft.key} className="mt-2" open>
          <summary className="cursor-pointer break-all">{draft.identity.filePath}</summary>
          <p className="text-sm">{t('project.saveFailed', { error: localizeError(draft.error) })}</p>
          <textarea
            readOnly
            value={draft.content}
            aria-label={`${t('column.unsavedChanges')}: ${draft.identity.filePath}`}
            onFocus={event => event.currentTarget.select()}
            rows={4}
            className="mt-1 w-full resize-y border border-red-300 bg-background p-2 font-mono text-sm text-foreground"
          />
          <button
            type="button"
            className="text-sm underline"
            onClick={() => {
              void ask(t('grid.markdownDiscardConfirm'), {
                title: t('grid.markdownDiscardDraft'), kind: 'warning',
                okLabel: t('grid.markdownDiscardDraft'), cancelLabel: t('common.cancel'),
              }).then(confirmed => {
                if (confirmed) markdownSaveCoordinator.discardRecoveryDraft(draft);
              }).catch(console.error);
            }}
          >
            {t('grid.markdownDiscardDraft')}
          </button>
        </details>
      ))}
    </aside>
  );
}
