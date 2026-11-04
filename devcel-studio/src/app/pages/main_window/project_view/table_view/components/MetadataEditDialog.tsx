import { recordReferenceLabel } from '@/app/utils/recordDisplayLabel';
import { changedTagNameError } from '@/app/utils/validation';
import { TagSelector } from '@/app/components/tags/TagSelector';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useI18n } from '@/app/i18n';
import { eligibleParentRecords, type TableData } from '@/app/types/tableTypes';
import { registerTableNavigationBlocker } from '@/app/services/tableInteractionScope';
import { registerMainWindowCloseBlocker } from '@/app/utils/string_editor_window';
export interface MetadataOwner { kind: 'tags' | 'memo' | 'parent'; recordUuid: string; columnUuid?: string; revision: string; table: TableData }
export function MetadataEditDialog({ owner, expectedProjectSession, busy, error, onClose, onSave }: { expectedProjectSession: string; owner: MetadataOwner; busy: boolean; error: string; onClose: () => void; onSave: (value: string, tags: string[]) => Promise<boolean> }) {
  const { t } = useI18n();
  const record = owner.table.records.find(record => record.uuid === owner.recordUuid)!;
  const initial = owner.kind === 'tags' ? JSON.stringify(record.tags) : owner.kind === 'parent' ? record.parent_uuid : record.memo_texts[owner.columnUuid!] ?? '';
  const [value, setValue] = useState(initial);
  const tagError = owner.kind === 'tags' ? changedTagNameError(JSON.parse(value), record.tags) : undefined;
  const [discard, setDiscard] = useState(false);
  const current = useRef({ busy, dirty: value !== initial }); current.current = { busy, dirty: value !== initial };
  const saving = useRef(false);
  const close = () => { if (current.current.busy || saving.current) return; if (current.current.dirty) setDiscard(true); else onClose(); };
  useEffect(() => { const guard = () => { if (current.current.busy || saving.current) return false; if (current.current.dirty) { setDiscard(true); return false; } return true; }; const a = registerTableNavigationBlocker(guard); const b = registerMainWindowCloseBlocker(guard); return () => { a(); b(); }; }, []);
  const title = t(owner.kind === 'tags' ? 'metadata.tags' : owner.kind === 'memo' ? 'metadata.cellMemo' : 'metadata.parent');
  const eligible = useMemo(() => owner.kind === 'parent' ? eligibleParentRecords(owner.table.records, owner.recordUuid) : [], [owner.kind, owner.table.records, owner.recordUuid]);
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent aria-describedby={undefined} className="sm:max-w-[420px]" onPointerDownOutside={event => { event.preventDefault(); close(); }}>
    <DialogTitle className="mb-3 font-semibold">{title}</DialogTitle>
    {owner.kind === 'tags' ? <TagSelector originalValue={record.tags} value={JSON.parse(value)} onChange={tags => setValue(JSON.stringify(tags))} expectedProjectSession={expectedProjectSession} disabled={busy} /> : owner.kind === 'parent' ? <select aria-label={title} className="w-full rounded border bg-background p-2" value={value} disabled={busy} onChange={event => setValue(event.target.value)}><option value="">{t('metadata.detach')}</option>{eligible.map(row => <option key={row.uuid} value={row.uuid}>{recordReferenceLabel(row, owner.table)}</option>)}</select> : <textarea aria-label={title} autoFocus rows={4} className="w-full resize-y rounded border bg-background p-2" value={value} disabled={busy} onChange={event => setValue(event.target.value)} />}
    {error && <p role="alert" className="mt-2 whitespace-pre-wrap text-sm text-red-700">{error}</p>}
    {discard && <div role="alert" className="mt-3 text-sm"><p>{t('column.unsavedChanges')}</p><button type="button" onClick={() => setDiscard(false)}>{t('common.cancel')}</button><button type="button" className="ms-4 text-red-700" onClick={onClose}>{t('column.discardAndClose')}</button></div>}
    <DialogFooter className="mt-4"><button className="rounded border px-3 py-2 text-sm" disabled={busy} onClick={close}>{t('common.cancel')}</button><button className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={busy || !!tagError || value === initial} onClick={async () => { if (saving.current || tagError) return; saving.current = true; try { if (await onSave(value, owner.kind === 'tags' ? JSON.parse(value) : [])) onClose(); } finally { saving.current = false; } }}>{t(busy ? 'common.saving' : 'common.save')}</button></DialogFooter>
  </DialogContent></Dialog>;
}
