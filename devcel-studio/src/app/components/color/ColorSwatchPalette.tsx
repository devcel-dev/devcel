import { errorHasCode } from '@/app/utils/errorRecovery';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Portal as TooltipPortal } from '@radix-ui/react-tooltip';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useI18n, localizeError } from '@/app/i18n';
import { subscribeSettings, useAppSettings } from '@/app/settings';
import type { SavedColorSwatch, UserColorSwatchSnapshot } from '@/app/types/colorTypes';
import { colorPickerId } from '@/app/utils/color_picker_window';
import { ColorSwatch } from './ColorSwatch';
import { colorPreviewCss, displayChannels, type ColorInterpretation, type ColorPickerType } from './colorDisplay';

export function canSelectColorSwatch(swatch: SavedColorSwatch, type: ColorPickerType): boolean {
  const channels = displayChannels(swatch.value);
  return channels !== null && (type === 'UiColor'
    ? swatch.data_type === 'Color32' && channels[3] === 255
    : swatch.data_type === type);
}

/** Palette transactions edit the ordinary settings project. Cell color Apply stays with its owner. */
function useUserColorSwatches() {
  const [snapshot, setSnapshot] = useState<UserColorSwatchSnapshot | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const latest = useRef<UserColorSwatchSnapshot | null>(null);
  const alive = useRef(false), writing = useRef(false), reloadQueued = useRef(false), generation = useRef(0);
  const reload = useCallback(async (clearError = true) => {
    if (!alive.current) return;
    if (writing.current) { reloadQueued.current = true; return; }
    const ticket = ++generation.current;
    try {
      const result = await invoke<UserColorSwatchSnapshot>('get_user_color_swatches');
      if (!alive.current || ticket !== generation.current) return;
      latest.current = result; setSnapshot(result); setReadFailed(false); setReadError(null); if (clearError) setSaveError(null); return result;
    } catch (reason) { if (alive.current && ticket === generation.current) { setReadError(reason); setReadFailed(true); } }
  }, []);
  useEffect(() => {
    alive.current = true;
    const invalidateRequests = () => { ++generation.current; };
    let active = true;
    let unlisten: (() => void) | undefined;
    const refresh = () => { if (active) void reload(false); };
    // Ordinary table edits/Undo and other processes invalidate the shared bundle.
    // Reload the gateway revision as well, rather than retaining an obsolete CAS.
    const unsubscribeSettings = subscribeSettings(refresh);
    // Subscribe before reading so another window's successful save cannot be missed.
    void listen('user-color-swatches-changed', refresh).then(off => {
      if (!active) { off(); return; }
      unlisten = off; void reload(false);
    }).catch(reason => { if (active) { setReadError(reason); void reload(false); } });
    window.addEventListener('focus', refresh);
    return () => { active = false; alive.current = false; invalidateRequests(); unlisten?.(); unsubscribeSettings(); window.removeEventListener('focus', refresh); };
  }, [reload]);
  const save = async (expectedRevision: string, swatches: SavedColorSwatch[]) => {
    if (writing.current || !latest.current || latest.current.writable === false || !alive.current) return null;
    writing.current = true; setSaving(true); ++generation.current;
    try {
      const result = await invoke<UserColorSwatchSnapshot>('set_user_color_swatches', { expectedRevision, swatches });
      if (!alive.current) return null;
      latest.current = result; setSnapshot(result); setSaveError(null); return result;
    } catch (reason) {
      if (alive.current) { setSaveError(reason); reloadQueued.current = true; }
      return null;
    } finally {
      writing.current = false;
      if (alive.current) {
        setSaving(false);
        if (reloadQueued.current) { reloadQueued.current = false; void reload(false); }
      }
    }
  };
  return { snapshot, error: saveError ?? readError, saveError, readError, saving, save, reload, readFailed };
}

export function ColorSwatchPalette({ type, interpretation, exposure, current, columnSwatches, disabled, onSelect, onEscape }: {
  type: ColorPickerType; interpretation: ColorInterpretation; exposure: number;
  current: Pick<SavedColorSwatch, 'data_type' | 'value'> | null;
  columnSwatches?: SavedColorSwatch[]; disabled: boolean; onSelect: (swatch: SavedColorSwatch) => void; onEscape?: () => void;
}) {
  const { t } = useI18n();
  const settings = useAppSettings();
  const user = useUserColorSwatches();
  const [scope, setScope] = useState<'user' | 'column'>(() => type !== 'UiColor' && columnSwatches?.length ? 'column' : 'user');
  const [editing, setEditing] = useState<string | null>(null);
  const [editedName, setEditedName] = useState('');
  const [editingRevision, setEditingRevision] = useState('');
  const [managing, setManaging] = useState(false);
  const [tooltipKey, setTooltipKey] = useState<string | null>(null);
  const paletteId = useId();
  const scroll = useRef<HTMLDivElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const previousScope = useRef(scope);
  useEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    if (scroll.current) scroll.current.scrollTop = 0;
    tabList.current?.querySelector<HTMLElement>('[data-state="active"]')?.focus({ preventScroll: true });
  }, [scope]);
  const changeScope = (value: string) => {
    setTooltipKey(null); setManaging(false); setScope(value as 'user' | 'column');
  };
  const keepTileVisible = (button: HTMLButtonElement) => {
    const viewport = scroll.current;
    if (!viewport) return;
    const tile = button.getBoundingClientRect(), frame = viewport.getBoundingClientRect();
    if (tile.top < frame.top) viewport.scrollTop += tile.top - frame.top;
    else if (tile.bottom > frame.bottom) viewport.scrollTop += tile.bottom - frame.bottom;
  };
  const chooseManagementTarget = (id: string) => {
    const item = user.snapshot?.swatches.find(candidate => candidate.id === id);
    setEditing(item?.id ?? null); setEditedName(item?.name ?? ''); setEditingRevision(user.snapshot?.revision ?? '');
  };
  const hasColumn = type !== 'UiColor' && columnSwatches !== undefined;
  // A broken source must not hide the validated runtime palette on first open.
  // Without a strict gateway revision these fallback colors are selectable only.
  const items = scope === 'column' && hasColumn ? columnSwatches : user.snapshot?.swatches ?? settings.bundle.userSwatches;
  const locked = disabled || user.saving;
  const stale = errorHasCode(user.error, ['color.swatches.stale', 'settings.staleGeneration', 'settings.staleRevision']);
  const canManage = !locked && user.snapshot !== null && user.snapshot.writable !== false && !user.readFailed && !stale;
  const editIndex = user.snapshot?.swatches.findIndex(item => item.id === editing) ?? -1;
  const edited = editIndex >= 0 ? user.snapshot!.swatches[editIndex] : null;
  const add = async () => {
    if (!canManage || !current || user.snapshot!.swatches.length >= 256) return;
    const name = t('column.swatches.defaultName', { index: String(user.snapshot!.swatches.length + 1) });
    await user.save(user.snapshot!.revision, [...user.snapshot!.swatches, { id: colorPickerId(), name, ...current }]);
  };
  const rename = async () => {
    if (!canManage || !edited || !editedName.trim()) return;
    if (await user.save(editingRevision, user.snapshot!.swatches.map(item => item.id === edited.id ? { ...item, name: editedName } : item))) setEditing(null);
  };
  const remove = async () => {
    if (!canManage || !edited) return;
    if (await user.save(editingRevision, user.snapshot!.swatches.filter(item => item.id !== edited.id))) setEditing(null);
  };
  const move = async (offset: number) => {
    const target = editIndex + offset;
    if (!canManage || !edited || target < 0 || target >= user.snapshot!.swatches.length) return;
    const next = [...user.snapshot!.swatches]; [next[editIndex], next[target]] = [next[target], next[editIndex]];
    const result = await user.save(editingRevision, next);
    if (result) setEditingRevision(result.revision);
  };
  const iconClass = 'rounded border border-input p-1.5 hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';
  return <section data-color-swatches className={`flex flex-1 flex-col gap-2 border-t border-border pt-2 ${scope === 'user' && managing ? 'min-h-40' : 'min-h-24'}`} aria-label={t('color.swatches.title')}>
    <Tabs value={scope} onValueChange={changeScope} className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <TabsList className="h-8" ref={tabList} aria-label={t('color.swatches.title')}>
          <TabsTrigger type="button" value="user" className="border border-transparent data-[state=active]:border-border">{t('color.swatches.user')}</TabsTrigger>
          {hasColumn && <TabsTrigger type="button" value="column" className="border border-transparent data-[state=active]:border-border">{t('color.swatches.column')}</TabsTrigger>}
        </TabsList>
        {scope === 'user' && <div className="flex items-center gap-1">
          <button type="button" data-swatch-add disabled={!canManage || !current || (user.snapshot?.swatches.length ?? 0) >= 256}
            aria-label={t('color.swatches.add')} title={t('color.swatches.add')} onClick={() => void add()} className={iconClass}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" disabled={!canManage} aria-pressed={managing} aria-controls={`${paletteId}-management`}
          className={`${iconClass} flex items-center gap-1 text-xs`} onClick={() => { setTooltipKey(null); setManaging(value => !value); }}>
          <Pencil className="h-3 w-3" aria-hidden="true" />{t('color.swatches.manage')}</button></div>}
      </div>
      <TabsContent value={scope} className="mt-0 min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {!(scope === 'user' && managing) && <TooltipProvider delayDuration={150} skipDelayDuration={0}>
        <div ref={scroll} data-swatch-scroll className="h-full min-h-9 overflow-y-auto overscroll-contain rounded border border-border p-1">
          <div role="list" data-swatch-grid className="relative grid grid-cols-[repeat(auto-fill,1.5rem)] gap-1"
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-swatch-select]')];
              const index = buttons.indexOf(event.target as HTMLButtonElement);
              if (index < 0) return;
              const columns = Math.max(1, Math.floor((event.currentTarget.clientWidth + 4) / 28));
              const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
              const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : event.key === 'ArrowLeft' ? index + (rtl ? 1 : -1) : event.key === 'ArrowRight' ? index + (rtl ? -1 : 1)
                : event.key === 'ArrowUp' ? index - columns : event.key === 'ArrowDown' ? index + columns : null;
              if (target === null) return;
              event.preventDefault(); event.stopPropagation();
              const button = buttons[Math.max(0, Math.min(buttons.length - 1, target))];
              button?.focus({ preventScroll: true }); if (button) keepTileVisible(button);
            }}>
            {items.map(item => {
              const channels = displayChannels(item.value);
              const compatible = canSelectColorSwatch(item, type), blocked = locked || !compatible;
              const selected = current?.data_type === item.data_type && current.value === item.value;
              const css = channels ? colorPreviewCss(channels, item.data_type, interpretation, exposure) : null;
              const key = `${scope}:${item.id}`;
              return <div key={key} role="listitem" data-swatch-id={item.id} className="h-6 w-6">
                <Tooltip open={tooltipKey === key} onOpenChange={open => setTooltipKey(previous => open ? key : previous === key ? null : previous)}>
                  <TooltipTrigger asChild>
                    <button type="button" data-swatch-select aria-disabled={blocked} aria-pressed={selected} aria-label={item.name}
                      onClick={() => { if (!blocked) onSelect(item); }} onFocus={event => keepTileVisible(event.currentTarget)}
                      className="h-6 w-6 rounded border border-border p-0.5 aria-pressed:border-foreground aria-pressed:bg-muted aria-pressed:ring-2 aria-pressed:ring-ring focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-40">
                      <ColorSwatch color={css} className="h-full w-full rounded-sm border-0" />
                    </button>
                  </TooltipTrigger>
                  <TooltipPortal><TooltipContent side="top" className="color-picker-tooltip max-w-xs break-words" onEscapeKeyDown={event => {
                    if (!event.isComposing && onEscape) { event.preventDefault(); onEscape(); }
                  }}>{item.name}{!compatible && <span className="ml-2 opacity-80">{t(type === 'UiColor' ? 'color.swatches.opaqueOnly' : 'color.swatches.typeMismatch')}</span>}</TooltipContent></TooltipPortal>
                </Tooltip>
              </div>;
            })}
          </div>
          {items.length === 0 && <span className="text-xs text-muted-foreground">{scope === 'user' && !user.snapshot && !user.error ? t('common.loading') : t('color.swatches.empty')}</span>}
        </div>
      </TooltipProvider>}
    {scope === 'user' && managing && <div id={`${paletteId}-management`} data-swatch-management className="space-y-2 rounded border border-border p-2">
      <select data-swatch-target value={editing ?? ''} disabled={!canManage} aria-label={t('color.swatches.choose')}
        className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs" onChange={event => chooseManagementTarget(event.target.value)}>
        <option value="">{t('color.swatches.choose')}</option>
        {editing && !edited && <option value={editing}>{editedName}</option>}
        {user.snapshot?.swatches.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      {editing !== null && <div className="flex flex-wrap items-center gap-2" data-swatch-editor>
        <input value={editedName} disabled={!canManage} aria-label={t('color.swatches.name')} className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1.5 text-xs"
          onChange={event => setEditedName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void rename(); } }} />
        <button type="button" disabled={!canManage || !edited || !editedName.trim()} aria-label={t('common.save')} className={iconClass} onClick={() => void rename()}><Check className="h-3 w-3" aria-hidden="true" /></button>
        <button type="button" disabled={!canManage || !edited || editIndex === 0} aria-label={t('column.swatches.moveUp', { name: edited?.name ?? editedName })} className={iconClass} onClick={() => void move(-1)}><ArrowUp className="h-3 w-3" aria-hidden="true" /></button>
        <button type="button" disabled={!canManage || !edited || editIndex === user.snapshot!.swatches.length - 1} aria-label={t('column.swatches.moveDown', { name: edited?.name ?? editedName })} className={iconClass} onClick={() => void move(1)}><ArrowDown className="h-3 w-3" aria-hidden="true" /></button>
        <button type="button" disabled={!canManage || !edited} aria-label={t('column.swatches.remove', { name: edited?.name ?? editedName })} className={iconClass} onClick={() => void remove()}><Trash2 className="h-3 w-3" aria-hidden="true" /></button>
        <button type="button" aria-label={t('common.close')} className={iconClass} onClick={() => setEditing(null)}><X className="h-3 w-3" aria-hidden="true" /></button>
      </div>}
    </div>}
    {(user.error != null || user.snapshot?.warning != null || (editing !== null && !edited)) && <div className="mt-2 flex items-start gap-2"><p role="alert" className="min-w-0 break-words text-xs text-destructive whitespace-pre-wrap">{[user.snapshot?.warning, user.saveError, user.readError].filter(value => value != null).map(value => localizeError(value)).join('\n') || t('color.swatches.stale')}</p>
      {(!user.snapshot || user.snapshot.writable === false || user.readFailed || stale || (editing !== null && !edited)) && <button type="button" disabled={user.saving} className="shrink-0 text-xs underline" onClick={() => { void user.reload().then(result => { if (result) setEditingRevision(result.revision); }); }}>{t('color.swatches.reload')}</button>}</div>}
      </TabsContent>
    </Tabs>
  </section>;
}
