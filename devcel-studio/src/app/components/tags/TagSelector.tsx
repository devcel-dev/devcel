import { changedTagNameError } from '@/app/utils/validation';
import { useEffect, useId, useRef, useState } from 'react';
import { showProjectEditDialog } from '@/app/utils/project_edit_dialog';
import { listen } from '@tauri-apps/api/event';
import * as Popover from '@radix-ui/react-popover';
import { getProjectTags } from '@/app/commands/projectCommands';
import { t, useI18n, localizeError } from '@/app/i18n';

/** Shared tag selector. Unknown persisted entries remain editable;
 * only the project registry can create new selectable names. */
export function TagSelector({ value, onChange, expectedProjectSession, originalValue, disabled = false }: {
  value: string[]; onChange: (tags: string[]) => void; expectedProjectSession: string; originalValue?: readonly string[]; disabled?: boolean;
}) {
  useI18n();
  const id = useId();
  const initial = useRef({ session: expectedProjectSession, tags: [...value] });
  if (initial.current.session !== expectedProjectSession) initial.current = { session: expectedProjectSession, tags: [...value] };
  const originalTags = originalValue ?? initial.current.tags;
  const nameError = changedTagNameError(value, originalTags);
  const [registry, setRegistry] = useState<{session: string; names: string[]} | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [openingManager, setOpeningManager] = useState(false);
  const managerRunning = useRef(false);
  const [managerError, setManagerError] = useState('');
  const [retry, setRetry] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    const invalidateRequests = () => { ++generation.current; };
    setRegistry(null); setError(''); setOpen(false); setQuery(''); setEditingIndex(null);
    const load = async () => {
      const request = ++generation.current;
      try {
        const result = await getProjectTags(expectedProjectSession);
        if (alive && request === generation.current && result.project_session === expectedProjectSession) {
          setRegistry({ session: result.project_session, names: result.presets }); setError('');
        }
      } catch (e) { if (alive && request === generation.current) { setRegistry(null); setError(localizeError(e)); } }
    };
    const subscription = listen<{project_session: string}>('project-tags-changed', event => {
      if (event.payload.project_session === expectedProjectSession) void load();
    });
    void load();
    return () => { alive = false; invalidateRequests(); void subscription.then(unlisten => unlisten()).catch(console.error); };
  }, [expectedProjectSession, retry]);
  const names = registry?.session === expectedProjectSession ? registry.names : null;
  const blocked = disabled || !names;
  const commitOrphan = (index: number) => {
    if (originalTags.includes(value[index])) { setEditingIndex(null); return; }
    const normalized = value[index].trim();
    if (normalized && changedTagNameError([normalized], originalTags)) return;
    // Normalize only this edited entry; unrelated legacy values stay byte-exact.
    const duplicate = value.some((name, i) => i !== index && name === normalized);
    onChange(!normalized || duplicate ? value.filter((_, i) => i !== index)
      : value.map((name, i) => i === index ? normalized : name));
    setEditingIndex(null);
  };
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));
  return <div className="space-y-2" aria-label={t('metadata.tags')}>
    <div className="flex flex-wrap gap-2">{value.map((name, index) => <div key={index} className="inline-flex max-w-full items-center gap-1 rounded border bg-muted px-2 py-1 text-sm">
      {names && (!names.includes(name) || editingIndex === index) ? <input aria-label={t('tags.unregistered')} className="min-w-16 max-w-full rounded border bg-background px-1" value={name} disabled={blocked}
        onFocus={() => setEditingIndex(index)} onBlur={event => {
          // A remove action owns the next update. Normalizing here could remove
          // this slot and retarget its pending click to the next tag.
          if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.dataset.tagRemoveOwner === id) {
            setEditingIndex(null);
          } else commitOrphan(index);
        }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitOrphan(index); trigger.current?.focus(); } }}
        onChange={event => {
          const next = event.target.value;
          onChange(value.map((entry, i) => i === index ? next : entry));
          // Keep the input while typing through a registered prefix; classify
          // on blur/Enter so the user can finish correcting an orphan name.
        }} /> : <span className="break-all">{name}</span>}
      <button type="button" data-tag-remove-owner={id} onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()} aria-label={t('tags.remove', {name})} className="rounded px-1 disabled:opacity-50" disabled={blocked} onClick={() => remove(index)}>×</button>
    </div>)}</div>
    <Popover.Root open={open && !blocked} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button ref={trigger} type="button" disabled={blocked} className="w-full rounded border bg-background px-3 py-2 text-start text-sm disabled:opacity-50">{names ? t('tags.select') : t('common.loading')} <span aria-hidden="true">▾</span></button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="z-[100] w-72 max-w-[calc(100vw-32px)] rounded-lg border bg-background p-2 shadow-lg" align="start" sideOffset={4}>
        <input id={id} aria-label={t('tags.search')} placeholder={t('tags.search')} className="mb-2 w-full rounded border bg-background px-2 py-1 text-sm" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="max-h-56 overflow-auto">{names?.filter(name => name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(name => <label key={name} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"><input type="checkbox" checked={value.includes(name)} onChange={event => onChange(event.target.checked ? [...value, name] : value.filter(entry => entry !== name))} /><span className="break-all">{name}</span></label>)}
        {names && !names.some(name => name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p className="p-2 text-sm text-muted-foreground">{t('tags.noMatches')}</p>}</div>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    <button type="button" className="text-sm text-primary underline disabled:opacity-50" disabled={disabled || openingManager} onClick={async () => {
      if (managerRunning.current) return;
      const request = generation.current;
      managerRunning.current = true; setOpeningManager(true); setManagerError('');
      try { await showProjectEditDialog({ expectedProjectSession, focusTags: true }); }
      catch (e) { if (generation.current === request) setManagerError(localizeError(e)); }
      finally { managerRunning.current = false; setOpeningManager(false); }
    }}>{t('tags.manage')}</button>
    {nameError && <p role="alert" className="text-sm text-destructive">{nameError}</p>}
    {managerError && <p role="alert" className="text-sm text-destructive">{managerError}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{t('tags.loadFailed')}: {error} <button type="button" disabled={disabled} className="underline" onClick={() => setRetry(n => n + 1)}>{t('tags.retry')}</button></p>}
  </div>;
}
