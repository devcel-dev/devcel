import { useEffect, useId, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { localizeError, useI18n } from '@/app/i18n';
import { columnDraftStore } from '@/app/utils/columnDraftLifecycle';
import { registerTableNavigationBlocker } from '@/app/services/tableInteractionScope';
import { registerMainWindowCloseBlocker } from '@/app/utils/string_editor_window';
import { useSettingsCloseGuard } from '@/app/utils/useSettingsCloseGuard';
import { canReloadDefinition } from '@/app/utils/errorRecovery';

export function DescriptionEditor({ draftKey, value, revision, disabled = false, label, onRead, onSave, onEditingChange }: {
  draftKey: string; value: string; revision: string; disabled?: boolean; label: string;
  onRead: () => Promise<{ value: string; revision: string }>;
  onSave: (value: string, revision: string) => Promise<void>;
  onEditingChange?: (editing: boolean) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const lifetime = useRef(0), mounted = useRef(false);
  const isCurrent = (ticket: number) => mounted.current && lifetime.current === ticket;
  const [descriptionDraft, setDescriptionDraft] = useState<{ value: string; original: string; version: string } | null>(null);
  const [descriptionError, setDescriptionError] = useState<unknown>(null);
  const descriptionSaving = useRef(false);
  const [descriptionDiscard, setDescriptionDiscard] = useState(false);
  const [latestDescription, setLatestDescription] = useState<{ value: string; version: string } | null>(null);
  const descriptionKey = draftKey;
  const { prepareClose, captureProps: descriptionCaptureProps } = useSettingsCloseGuard();
  const descriptionState = useRef({ draft: descriptionDraft, busy });
  descriptionState.current = { draft: descriptionDraft, busy };
  const clearDescription = () => {
    columnDraftStore.remove(descriptionKey); setDescriptionDraft(null); setDescriptionError(null);
    setLatestDescription(null); setDescriptionDiscard(false);
  };
  const discardDescription = () => {
    if (descriptionSaving.current || descriptionState.current.busy) return;
    clearDescription();
  };
  const keepEditing = () => {
    if (descriptionSaving.current || descriptionState.current.busy) return;
    setDescriptionDiscard(false);
  };
  useEffect(() => {
    const guard = async () => {
      if (!await prepareClose()) return false;
      if (descriptionState.current.busy || descriptionSaving.current) return false;
      const draft = descriptionState.current.draft;
      if (draft && draft.value !== draft.original) { setDescriptionDiscard(true); return false; }
      return true;
    };
    const navigation = registerTableNavigationBlocker(guard);
    const close = registerMainWindowCloseBlocker(guard);
    return () => { navigation(); close(); };
  }, [prepareClose]);

  useEffect(() => {
    mounted.current = true;
    setDescriptionDraft(null); setDescriptionError(null); setLatestDescription(null); setDescriptionDiscard(false);
    setBusy(false); descriptionSaving.current = false;
    const cached = columnDraftStore.read(draftKey);
    if (cached) {
      try {
        const draft = JSON.parse(cached);
        if (typeof draft.value === 'string' && typeof draft.original === 'string' && typeof draft.version === 'string') setDescriptionDraft(draft);
      } catch { /* Retain unreadable drafts for the existing project recovery guard. */ }
    }
    return () => { mounted.current = false; lifetime.current += 1; };
  }, [draftKey]);
  useEffect(() => () => { onEditingChange?.(false); }, [onEditingChange]);
  const editing = descriptionDraft !== null;
  useEffect(() => { onEditingChange?.(editing); }, [editing, onEditingChange]);
  const compareDescription = async () => {
    const ticket = lifetime.current;
    if (busy || descriptionSaving.current || !isCurrent(ticket)) return;
    descriptionSaving.current = true; setBusy(true);
    try {
      const latest = await onRead();
      if (isCurrent(ticket)) setLatestDescription({ value: latest.value, version: latest.revision });
    } catch (reason) { if (isCurrent(ticket)) setDescriptionError(reason); }
    finally { if (isCurrent(ticket)) { descriptionSaving.current = false; setBusy(false); } }
  };

  const saveDescription = async (reviewed = false) => {
    const ticket = lifetime.current;
    if (!descriptionDraft || descriptionSaving.current || busy || disabled || !isCurrent(ticket)) return;
    if (canReloadDefinition(descriptionError) && (!reviewed || !latestDescription)) return;
    if (descriptionDraft.value === descriptionDraft.original && !reviewed) { discardDescription(); return; }
    descriptionSaving.current = true; setBusy(true); setDescriptionError(null);
    try {
      await onSave(descriptionDraft.value, reviewed && latestDescription ? latestDescription.version : descriptionDraft.version);
      if (!isCurrent(ticket)) return;
      clearDescription();
    } catch (reason) {
      if (isCurrent(ticket)) { setDescriptionError(reason); setLatestDescription(null); }
    } finally {
      if (isCurrent(ticket)) { descriptionSaving.current = false; setBusy(false); }
    }
  };

  return <div data-description-editor>
          {descriptionDraft ? <form {...descriptionCaptureProps} className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); void saveDescription(); }}>
            <label htmlFor={`${id}-description`} className="block text-xs">{label}</label>
            <textarea id={`${id}-description`} autoFocus rows={3} disabled={busy}
              className="block w-full resize-y rounded border border-input bg-background px-2 py-1 text-sm"
              value={descriptionDraft.value} onChange={event => { const next = { ...descriptionDraft, value: event.target.value }; setDescriptionDraft(next); if (next.value === next.original) columnDraftStore.remove(descriptionKey); else columnDraftStore.write(descriptionKey, JSON.stringify(next)); if (!canReloadDefinition(descriptionError)) setDescriptionError(null); }}
              onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && !busy) { event.preventDefault(); discardDescription(); } }} />
            {descriptionError != null && <p role="alert" className="text-xs text-red-700 dark:text-red-300 whitespace-pre-wrap">{localizeError(descriptionError)}</p>}
            {canReloadDefinition(descriptionError) && !latestDescription && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void compareDescription()}>{t('common.reload')}</Button>}
            {latestDescription && <div className="space-y-2 rounded border border-border p-2">
              <p className="text-xs font-medium">{t('column.currentValue')}</p>
              <p data-description-latest className="whitespace-pre-wrap break-words text-sm">{latestDescription.value || '—'}</p>
              <Button type="button" size="sm" disabled={busy} onClick={() => void saveDescription(true)}>{t('common.retry')}</Button>
            </div>}
            {descriptionDiscard && <div role="alert" className="space-y-2 text-sm">
              <p>{t('column.unsavedChanges')}</p>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={keepEditing}>{t('column.keepEditing')}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={discardDescription}>{t('column.discardAndClose')}</Button>
            </div>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy || disabled || canReloadDefinition(descriptionError)}>{t('common.save')}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={discardDescription}>{t('common.cancel')}</Button>
            </div>
          </form> : <div className="mt-1 flex items-start gap-2">
            <p className="min-w-0 whitespace-pre-wrap break-words text-xs text-muted-foreground">{value || label}</p>
            <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1 text-xs"
              disabled={busy || disabled} aria-label={`${label} ${t('common.edit')}`}
              onClick={() => { setDescriptionDraft({ value, original: value, version: revision }); setDescriptionError(null); }}>
              <Pencil className="h-3 w-3" />{t('common.edit')}
            </Button>
          </div>}
  </div>;
}
