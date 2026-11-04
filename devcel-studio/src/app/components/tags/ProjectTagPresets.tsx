import { validateDataName } from '@/app/utils/validation';
import { useEffect, useRef, useState } from 'react';
import { PROJECT_TAG_FOCUS_EVENT } from '@/app/utils/project_edit_dialog';
import { listen } from '@tauri-apps/api/event';
import { getProjectSession, getProjectTags, updateProjectTag, type ProjectTagState, type ProjectTagProgress } from '@/app/commands/projectCommands';
import { t, useI18n, localizeError } from '@/app/i18n';

type Pending = { operation: 'rename' | 'delete'; name: string; newName?: string };
export function ProjectTagPresets({ expectedProjectSession, disabled, onBusyChange }: { expectedProjectSession: string; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  useI18n();
  const [state, setState] = useState<ProjectTagState | null>(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<ProjectTagProgress | null>(null);
  const [retry, setRetry] = useState(0);
  const addInput = useRef<HTMLInputElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const focusedRequest = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    let alive = true;
    const query = new URLSearchParams(window.location.search);
    if (query.get('focusTags') === '1' && query.get('projectSession') === expectedProjectSession) setFocusRequest(n => n + 1);
    const subscription = listen<{project_session: string}>(PROJECT_TAG_FOCUS_EVENT, ({payload}) => {
      if (alive && payload.project_session === expectedProjectSession) setFocusRequest(n => n + 1);
    });
    return () => { alive = false; void subscription.then(unlisten => unlisten()).catch(console.error); };
  }, [expectedProjectSession]);
  useEffect(() => {
    if (!state || disabled || busy || focusRequest === focusedRequest.current) return;
    let alive = true;
    void getProjectSession().then(session => {
      if (!alive || session?.id !== expectedProjectSession) return;
      focusedRequest.current = focusRequest;
      addInput.current?.scrollIntoView({ block: 'center' });
      addInput.current?.focus({ preventScroll: true });
    }).catch(console.error);
    return () => { alive = false; };
  }, [state, disabled, busy, focusRequest, expectedProjectSession]);
  const generation = useRef(0);
  const currentSession = useRef(expectedProjectSession); currentSession.current = expectedProjectSession;
  useEffect(() => {
    let alive = true;
    const request = ++generation.current;
    const invalidateRequests = () => { ++generation.current; };
    setState(null); setPending(null); setEditing(null); setName(''); setError('');
    void getProjectTags(expectedProjectSession).then(result => {
      if (alive && generation.current === request && result.project_session === expectedProjectSession) setState(result);
    }).catch(e => { if (alive) setError(localizeError(e)); });
    const subscription = listen<ProjectTagProgress>('project-tag-progress', ({ payload }) => {
      if (alive && running.current && payload.project_session === expectedProjectSession) setProgress(payload);
    });
    return () => { alive = false; invalidateRequests(); void subscription.then(unlisten => unlisten()).catch(console.error); };
  }, [expectedProjectSession, retry]);
  const change = async (operation: 'add' | 'rename' | 'delete', oldName: string, replacement?: string) => {
    if (running.current || disabled || !state || state.project_session !== expectedProjectSession) return;
    if (operation !== 'delete') {
      const validation = validateDataName(operation === 'rename' ? replacement ?? '' : oldName);
      if (!validation.isValid) { setError(validation.errorMessage ?? ''); return; }
    }
    const request = generation.current;
    running.current = true; setBusy(true); onBusyChange(true); setError(''); setProgress(null);
    try {
      const result = await updateProjectTag(operation, oldName, replacement, state);
      if (generation.current !== request || currentSession.current !== state.project_session) return;
      setState(result.state); setPending(null); setEditing(null); setName('');
    } catch (e) {
      if (generation.current === request) {
        setError(localizeError(e)); setPending(null);
        // A conflict must be reviewed again against the latest registry.
        try { const fresh = await getProjectTags(expectedProjectSession); if (generation.current === request) setState(fresh); } catch { /* retain the actionable mutation error */ }
      }
    } finally {
      running.current = false;
      if (generation.current === request) { setBusy(false); setProgress(null); }
      onBusyChange(false);
    }
  };
  const blocked = disabled || busy || !state;
  const addError = name ? validateDataName(name.trim()).errorMessage : undefined;
  const renameError = editing !== null ? validateDataName(newName.trim()).errorMessage : undefined;
  return <section className="space-y-3 border-t pt-5" aria-label={t('tags.presets')}>
    <h3 className="text-sm font-semibold">{t('tags.presets')}</h3>
    {error && <p role="alert" className="text-sm text-destructive">{error} {!state && <button type="button" disabled={busy} className="underline" onClick={() => setRetry(n => n + 1)}>{t('tags.retry')}</button>}</p>}
    {!state && !error && <p role="status" className="text-sm">{t('common.loading')}</p>}
    <div className="flex gap-2"><input ref={addInput} aria-label={t('tags.newName')} placeholder={t('tags.newName')} value={name} disabled={blocked} onChange={e => setName(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-2 text-sm" /><button type="button" className="rounded border px-3 text-sm disabled:opacity-50" disabled={blocked || !!addError || !name.trim() || state?.presets.includes(name.trim())} onClick={() => void change('add', name.trim())}>{t('common.add')}</button></div>
    {addError && <p role="alert" className="text-sm text-destructive">{addError}</p>}
    {renameError && <p role="alert" className="text-sm text-destructive">{renameError}</p>}
    <ul className="max-h-64 space-y-2 overflow-auto">{state?.presets.map(tag => <li key={tag} className="flex items-center gap-2 rounded border p-2 text-sm">
      {editing === tag ? <><input autoFocus aria-label={t('tags.newName')} value={newName} disabled={blocked} onChange={e => setNewName(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-2 py-1" /><button type="button" disabled={blocked || !!renameError || !newName.trim() || newName.trim() === tag || state.presets.includes(newName.trim())} className="disabled:opacity-50" onClick={() => setPending({ operation: 'rename', name: tag, newName: newName.trim() })}>{t('tags.rename')}</button><button type="button" disabled={busy} onClick={() => { setEditing(null); setPending(null); }}>{t('common.cancel')}</button></> : <><span className="min-w-0 flex-1 break-all">{tag}</span><button type="button" disabled={blocked} onClick={() => { setEditing(tag); setNewName(tag); setPending(null); }}>{t('tags.rename')}</button><button type="button" disabled={blocked} className="text-destructive" onClick={() => setPending({ operation: 'delete', name: tag })}>{t('common.delete')}</button></>}
    </li>)}</ul>
    {pending && <div role="alertdialog" aria-modal="false" aria-labelledby="tag-confirm-text" className="space-y-3 rounded border border-amber-300 p-3 text-sm">
      <p id="tag-confirm-text">{pending.operation === 'rename' ? t('tags.renameConfirm', {oldName: pending.name, newName: pending.newName!}) : t('tags.deleteConfirm', {name: pending.name})}</p>
      <div className="flex justify-end gap-3"><button type="button" disabled={busy} onClick={() => setPending(null)}>{t('common.cancel')}</button><button type="button" disabled={blocked} className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50" onClick={() => void change(pending.operation, pending.name, pending.newName)}>{t(pending.operation === 'rename' ? 'tags.rename' : 'common.delete')}</button></div>
    </div>}
    {busy && <div role="status" aria-live="polite" className="text-sm"><p>{progress?.phase === 'scanning' ? t('tags.scanning', {done: progress.scanned_tables, total: progress.total_tables}) : t('tags.saving')}</p><progress className="mt-2 w-full" {...(progress?.phase === 'scanning' && progress.total_tables > 0 ? {value: progress.scanned_tables, max: progress.total_tables} : {})} /></div>}
  </section>;
}
