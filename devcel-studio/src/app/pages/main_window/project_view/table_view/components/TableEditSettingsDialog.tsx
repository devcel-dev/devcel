import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { LockKeyhole, ChevronRight } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { localizeError, useI18n } from '@/app/i18n';
import { settingsDisplayLabel } from '@/app/settings/displayLabels';
import type { TableData, TableEditPermissions } from '@/app/types/tableTypes';
import { registerTableNavigationBlocker } from '@/app/services/tableInteractionScope';
import { registerMainWindowCloseBlocker } from '@/app/utils/string_editor_window';
import { useSettingsCloseGuard } from '@/app/utils/useSettingsCloseGuard';
import { tableSettingsDraft, settingsDraftEqual, rebaseSettingsDraft, type EditSettingsDraft } from '@/app/utils/settingsDraftLifecycle';
export type { EditSettingsDraft } from '@/app/utils/settingsDraftLifecycle';

export interface EditSettingsOwner { table: TableData; revision: string }
const permissionLabels = [
  ['add_columns', 'table.edit.addColumns'], ['delete_columns', 'table.edit.deleteColumns'],
  ['add_rows', 'table.edit.addRows'], ['delete_rows', 'table.edit.deleteRows'], ['edit_cells', 'table.edit.editCells'],
] as const;

export function TableEditSettingsDialog({ owner, busy, error, onClose, onSave, onOrientationChange, open = true, onOpenInterfaces }: {
  owner: EditSettingsOwner; busy: boolean; error: string;
  open?: boolean; onOpenInterfaces?: () => void;
  onClose: () => void; onSave: (draft: EditSettingsDraft) => Promise<boolean>;
  onOrientationChange?: (transposed: boolean) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const id = useId();
  const composition = useSettingsCloseGuard();
  const baseline = useRef(tableSettingsDraft(owner.table));
  const [draft, setDraft] = useState<EditSettingsDraft>(() => tableSettingsDraft(owner.table));
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState('');
  const current = useRef({ draft, busy, onClose, onSave, onOrientationChange });
  current.current = { draft, busy, onClose, onSave, onOrientationChange };
  const applying = useRef<Promise<boolean> | null>(null);
  const closeRequested = useRef(false);
  const changingOrientation = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const idleWaiters = useRef<Array<(ready: boolean) => void>>([]);
  useLayoutEffect(() => {
    if (!busy) idleWaiters.current.splice(0).forEach(resolve => resolve(true));
  }, [busy, owner.revision]);
  useLayoutEffect(() => {
    const next = tableSettingsDraft(owner.table);
    const previous = baseline.current;
    baseline.current = next;
    setDraft(value => rebaseSettingsDraft(value, previous, next));
  }, [owner.table, owner.revision]);

  const apply = useRef<(close: boolean) => Promise<boolean>>(async () => false);
  apply.current = (close: boolean) => {
    if (applying.current) { closeRequested.current ||= close; return applying.current; }
    closeRequested.current = close;
    const operation = (async () => {
      if (!await composition.prepareClose()) return false;
      if (changingOrientation.current) {
        if (!await changingOrientation.current) return false;
        // Mutation completion precedes React's owner/busy commit. Wait for the
        // coherent authoritative render before submitting the remaining draft.
        if (current.current.busy && !await new Promise<boolean>(resolve => idleWaiters.current.push(resolve))) return false;
      }
      if (!mounted.current || current.current.busy) return false;
      const snapshot = current.current.draft;
      if (!snapshot.display_name.trim()) { setLocalError(t('validation.nameRequired')); return false; }
      if (!settingsDraftEqual(snapshot, baseline.current)) {
        setPending(true); setLocalError('');
        try {
          if (!await current.current.onSave(snapshot) || !mounted.current) return false;
          baseline.current = snapshot;
        } catch (reason) { if (mounted.current) setLocalError(localizeError(reason)); return false; }
        finally { if (mounted.current) setPending(false); }
      }
      if (closeRequested.current) current.current.onClose();
      return true;
    })();
    applying.current = operation;
    void operation.finally(() => { if (applying.current === operation) applying.current = null; });
    return operation;
  };
  useEffect(() => {
    mounted.current = true;
    const waiters = idleWaiters.current;
    const guard = () => apply.current(true);
    const navigation = registerTableNavigationBlocker(guard);
    const windowClose = registerMainWindowCloseBlocker(guard);
    return () => { mounted.current = false; waiters.splice(0).forEach(resolve => resolve(false)); navigation(); windowClose(); };
  }, []);
  const close = () => { void apply.current(true); };
  const toggle = (key: keyof TableEditPermissions, enabled: boolean) => setDraft(value => ({
    ...value, edit_permissions: { ...value.edit_permissions, [key]: enabled },
  }));
  const changeOrientation = (value: boolean) => {
    if (current.current.busy || changingOrientation.current || applying.current || value === draft.initial_transposed) return;
    const previous = draft.initial_transposed;
    setDraft(currentDraft => ({ ...currentDraft, initial_transposed: value }));
    if (!onOrientationChange) return;
    setPending(true); setLocalError('');
    const operation = (async () => {
      try {
        const saved = await onOrientationChange(value);
        if (!mounted.current) return false;
        if (!saved) { setDraft(currentDraft => ({ ...currentDraft, initial_transposed: previous })); return false; }
        baseline.current = { ...baseline.current, initial_transposed: value };
        return true;
      } catch (reason) {
        if (mounted.current) { setLocalError(localizeError(reason)); setDraft(currentDraft => ({ ...currentDraft, initial_transposed: previous })); }
        return false;
      } finally { if (mounted.current) setPending(false); }
    })();
    changingOrientation.current = operation;
    void operation.finally(() => { if (changingOrientation.current === operation) changingOrientation.current = null; });
  };
  const disabled = busy || pending;
  return <Dialog open={open} onOpenChange={isOpen => { if (!isOpen) close(); }}>
    <DialogContent {...composition.captureProps} className="flex w-[min(680px,calc(100vw-32px))] max-w-none max-h-[calc(100dvh-32px)] flex-col gap-0 overflow-hidden rounded-xl p-0" aria-describedby={undefined}
        onPointerDownOutside={event => { event.preventDefault(); close(); }}>
        <div className="flex shrink-0 items-start gap-3 border-b px-5 py-4 pe-12"><LockKeyhole className="mt-1 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1"><DialogTitle className="font-semibold">{t('table.edit.settings')}</DialogTitle>
          <p className="mt-1 text-sm text-muted-foreground break-words">{settingsDisplayLabel(owner.table.uuid, owner.table.display_name)}</p></div>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-5 space-y-4">
        {onOpenInterfaces && <button type="button" disabled={disabled} onClick={async () => {
          if (await apply.current(false) && mounted.current && !closeRequested.current) onOpenInterfaces();
        }} title={t('grid.interfaceActions')} className="flex items-center gap-3 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">
          <span>{t('grid.interfaces')}</span><ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>}
        <div className="space-y-3">
          <label className="block text-sm">{t('table.edit.displayName')}<input className="mt-1 w-full rounded border bg-background p-2" disabled={disabled} value={draft.display_name} onChange={event => { setLocalError(''); setDraft(value => ({ ...value, display_name: event.target.value })); }} /></label>
        </div>
        <fieldset disabled={disabled}><legend className="mb-2 text-sm font-medium">{t('table.edit.initialView')}</legend>
          <div className="flex flex-wrap gap-2">{[false, true].map(value => <label key={String(value)} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 ${draft.initial_transposed === value ? 'border-primary bg-primary/5' : 'border-border'}`}>
            <input type="radio" name={`${id}-initial-view`} checked={draft.initial_transposed === value} onChange={() => changeOrientation(value)} />
            {t(value ? 'grid.transpose' : 'table.edit.normalView')}
          </label>)}</div>
        </fieldset>
        <h3 className="mb-2 text-sm font-medium">{t('table.edit.allowedActions')}</h3>
        <div className="grid grid-cols-1 gap-x-5 rounded-lg border sm:grid-cols-2">{permissionLabels.map(([key, label]) => <div key={key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
          <label htmlFor={`${id}-${key}`}>{t(label)}</label>
          <Switch id={`${id}-${key}`} disabled={disabled} checked={draft.edit_permissions[key]} onCheckedChange={enabled => toggle(key, enabled)} />
        </div>)}</div>
        {(localError || error) && <p role="alert" className="mt-4 text-sm text-red-700 whitespace-pre-wrap">{localError || error}</p>}
        </div>
        <div className="flex shrink-0 justify-end border-t px-5 py-3"><button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={close}>{t(disabled ? 'common.saving' : 'common.close')}</button></div>
      </DialogContent>
  </Dialog>;
}
