import { canReloadDefinition } from '@/app/utils/errorRecovery';
import { FormulaInput } from '@/app/components/formula/FormulaInput';
import { FormulaCompletionProvider } from '@/app/components/formula/FormulaCompletionProvider';
import { normalizeColumn } from '@/app/types/tableTypes';
import { previewRecordLabel, previewTableLabel } from './previewDisplayLabels';
import { changedTagNameError, validateDataName } from '@/app/utils/validation';
import { TagSelector } from '@/app/components/tags/TagSelector';
import { settingsDisplayLabel } from '@/app/settings/displayLabels';
import { Switch } from '@/components/ui/switch';
import { ColumnColorSwatches } from './ColumnColorSwatches';
import { ColorField } from '@/app/components/color/ColorField';
import { isColorType } from '@/app/components/color/colorDisplay';
import { captureTableInteractionScope, isTableInteractionScopeCurrent, registerTableNavigationBlocker } from '@/app/services/tableInteractionScope';
import { t, useI18n, localizeError, message, resolveMessage, type LocalizedMessage } from '@/app/i18n';
import { useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Columns3, LockKeyhole, X, ExternalLink } from 'lucide-react';
import { ReferenceConfigSelector } from '@/app/components/ReferenceConfigSelector';
import { listInterfaces, openInterfaceInEditor } from '@/api/interface';
import { ColumnTypePicker, type ColumnTypePickerHandle } from './ColumnTypePicker';
import { InputValidationEditor, SchemaConstraints } from './InputValidationEditor';
import { ConditionalFormattingEditor } from './ConditionalFormattingEditor';
import { RulePreview } from './RulePreview';
import { confirmInputWarnings } from '@/app/utils/table_rule_dialogs';
import { columnDraftStore } from '@/app/utils/columnDraftLifecycle';
import { registerMainWindowCloseBlocker } from '@/app/utils/string_editor_window';
import { useSettingsCloseGuard } from '@/app/utils/useSettingsCloseGuard';
import { inputValidationReport, type FormatCondition, type FormattingRule } from '@/app/types/tableRules';
import type { ColumnEditorDraft, ColumnEditorLoad, ColumnEditorPreview, ColumnEditorRequest, ColumnEditorTarget } from './types';
import './column-editor.css';

interface Props {
  expectedProjectSession: string;
  target: ColumnEditorTarget;
  initialTab?: string;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
  onDelete?: () => Promise<boolean>;
  deleteDisabledReason?: string;
}

const getTabs = () => [['basic', t('column.basic')], ['rules', t('column.inputRules')], ['display', t('column.displayFormat')], ['origin', t('column.originTargets')]] as const;
const COLORS = ['#ffffff', '#e3f2fd', '#e8f5e8', '#fffde7', '#f5f5f5', '#ffe5e5', '#f3e5ff', '#fff0e5', '#e5f5ff', '#ffeee5'];
const storageKey = (target: ColumnEditorTarget) => `devcel:column-draft:${target.mode}:${target.target_uuid}:${target.column_uuid || `new:${target.insert_index ?? 'end'}`}`;

interface DraftCache { schemaVersion: 1; draft: ColumnEditorDraft; selectText: string; revision: string | null }
function isCurrentDraftCache(value: unknown): value is DraftCache {
  if (!value || typeof value !== 'object') return false;
  const cache = value as Partial<DraftCache>;
  if (cache.schemaVersion !== 1 || typeof cache.selectText !== 'string'
    || !(cache.revision === null || typeof cache.revision === 'string')
    || !cache.draft || typeof cache.draft !== 'object') return false;
  const draft = cache.draft as unknown as Record<string, unknown>;
  const strings = ['display_name', 'name', 'column_type', 'tooltip', 'memo_text', 'default_value', 'color'];
  if (draft.display_name !== undefined && typeof draft.display_name !== 'string') return false;
  const configs = ['reference_config', 'curve_config', 'table_ref_config', 'select_config',
    'input_validation', 'conditional_formatting', 'conditional_formatting_override'];
  const swatches = draft.color_swatches;
  return Array.isArray(swatches) && swatches.every(value => value && typeof value === 'object'
    && typeof value.id === 'string' && typeof value.name === 'string'
    && (value.data_type === 'Color32' || value.data_type === 'ColorFloat') && typeof value.value === 'string')
    && Array.isArray(draft.tags) && draft.tags.every(tag => typeof tag === 'string')
    && typeof draft.font_size === 'number'
    && typeof draft.read_only === 'boolean'
    && typeof draft.min_version === 'string'
    && strings.every(field => typeof draft[field] === 'string')
    && configs.every(field => draft[field] === null || (typeof draft[field] === 'object' && !Array.isArray(draft[field])));
}

export function ColumnEditor({ expectedProjectSession, target, initialTab = 'basic', onClose, onSaved, onDelete, deleteDisabledReason }: Props) {
  useI18n();
  const composition = useSettingsCloseGuard();
  const prepareClose = composition.prepareClose;

  const [loaded, setLoaded] = useState<ColumnEditorLoad | null>(null);
  const [draft, setDraft] = useState<ColumnEditorDraft | null>(null);
  const [initial, setInitial] = useState('');
  const [tab, setTab] = useState(initialTab);
  const [error, setError] = useState<unknown>('');
  const [nameValidationRequested, setNameValidationRequested] = useState(false);
  const [unsupportedDraft, setUnsupportedDraft] = useState(false);
  const errorText = typeof error === 'function' ? error() : localizeError(error);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | LocalizedMessage>('');
  const [editorReset, setEditorReset] = useState(0);
  const [preview, setPreview] = useState<ColumnEditorPreview | null>(null);
  const [selectText, setSelectText] = useState('');
  const [interfaces, setInterfaces] = useState<Array<{ uuid: string; name: string }>>([]);
  const [interfaceError, setInterfaceError] = useState<unknown>('');
  const busyRef = useRef(false);
  const closeRequest = useRef<Promise<boolean> | null>(null);
  const requestSettingsClose = useRef<() => Promise<boolean>>(async () => false);
  const saveCurrent = useRef<() => Promise<boolean>>(async () => false);
  const activeRef = useRef(true);
  const warningAbortRef = useRef<AbortController | null>(null);
  const allowNativeClose = useRef(false);
  const closeState = useRef({ dirty: false, onClose, unsupportedDraft: false, key: '' });
  const [windowClosePending, setWindowClosePending] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const typePickerRef = useRef<ColumnTypePickerHandle>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const loadGeneration = useRef(0);
  const errorRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const key = `${expectedProjectSession}:${storageKey(target)}`;
  const dirty = draft !== null && JSON.stringify({ draft, selectText }) !== initial;
  closeState.current = { dirty, onClose, unsupportedDraft, key };
  const editing = Boolean(target.column_uuid);
  const locked = loaded?.interface_owned ?? false;
  const isInterface = target.mode === 'interface';
  const interfaceRelated = isInterface || locked;
  const TABS = getTabs().filter(([value]) => value !== 'origin' || interfaceRelated);
  useEffect(() => {
    if (loaded && !interfaceRelated && tab === 'origin') setTab('basic');
  }, [loaded, interfaceRelated, tab]);
  const reviewed = !!preview && !preview.error_count && !preview.errors.length;
  const typeChanged = !!loaded && !!draft && editing && draft.column_type !== loaded.column.data_type;
  const nameError = nameValidationRequested && draft && loaded && !locked
    && (!editing || draft.name !== loaded.column.data_name) ? validateDataName(draft.name).errorMessage : undefined;
  const tagError = draft && loaded ? changedTagNameError(draft.tags, loaded.column.tags ?? []) : undefined;

  // Parent renders may recreate the target object without changing its identity.
  const loadTarget = useMemo(() => ({
    mode: target.mode, target_uuid: target.target_uuid, column_uuid: target.column_uuid,
    ...(target.insert_index === undefined ? {} : { insert_index: target.insert_index }),
  }), [target.mode, target.target_uuid, target.column_uuid, target.insert_index]);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      setError(''); setNameValidationRequested(false); setUnsupportedDraft(false); setNotice('');
      const data = await invoke<ColumnEditorLoad>('load_column_editor', { target: loadTarget, expectedProjectSession });
      if (!activeRef.current || loadGeneration.current !== generation) return;
      setEditorReset(value => value + 1);
      const c = normalizeColumn(data.column);
      data.column = c;
      const next: ColumnEditorDraft = {
        display_name: editing ? c.display_name : '',
        name: editing ? c.data_name : '', column_type: c.data_type,
        min_version: String(c.min_version), read_only: c.read_only,
        tooltip: c.tooltip || '', memo_text: c.memo_text || '', default_value: c.default_value || '',
        color_swatches: c.color_swatches ?? [],
        tags: c.tags ?? [], font_size: c.style?.font_size ?? 12,
        color: c.style?.color || '', reference_config: c.reference_config || null,
        curve_config: c.curve_config || null, table_ref_config: c.table_ref_config || null,
        select_config: c.select_config || null,
        input_validation: c.input_validation ?? null,
        conditional_formatting: c.conditional_formatting ?? null,
        conditional_formatting_override: c.conditional_formatting_override ?? null,
      };
      const select = c.select_config ? JSON.stringify(c.select_config.options, null, 2) : '';
      setLoaded(data);
      setInitial(JSON.stringify({ draft: next, selectText: select }));
      let cached: string | null = null;
      let recovered: unknown = null;
      try {
        cached = columnDraftStore.read(key);
        if (cached !== null) recovered = JSON.parse(cached);
      } catch { /* Invalid caches are rejected below; unavailable storage still permits editing. */ }
      if (cached !== null && !isCurrentDraftCache(recovered)) {
        setDraft(null); setUnsupportedDraft(true);
        setError(message('column.unsupportedDraft'));
        return;
      }
      if (isCurrentDraftCache(recovered)) {
        // Restore only current draft fields, never confirmation/acknowledgement state.
        const restored = Object.fromEntries(Object.keys(next).map(field => [field, recovered.draft[field as keyof ColumnEditorDraft]])) as unknown as ColumnEditorDraft;
        restored.display_name = recovered.draft.display_name ?? next.display_name;
        restored.min_version = next.min_version;
        restored.color_swatches = data.interface_owned ? next.color_swatches : recovered.draft.color_swatches;
        setDraft(restored); setSelectText(recovered.selectText);
        if (recovered.revision === data.revision) {
          setNotice(message('column.restoreNotice'));
        } else {
          setLoaded({ ...data, revision: recovered.revision });
          setError(message('column.staleNotice'));
        }
      } else {
        setDraft(next); setSelectText(select);
      }
      setPreview(null);
    } catch (e) { if (activeRef.current && loadGeneration.current === generation) setError(e); }
  }, [key, loadTarget, editing, expectedProjectSession]);

  useEffect(() => { void load(); return () => { loadGeneration.current += 1; }; }, [load]);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; warningAbortRef.current?.abort(); };
  }, []);
  useEffect(() => registerTableNavigationBlocker(async () => {
    if (target.column_uuid) return requestSettingsClose.current();
    if (!await prepareClose()) return false;
    if (busyRef.current) { setNotice(message('column.waitForSave')); return false; }
    if (closeState.current.dirty) { setConfirmDiscard(true); return false; }
    return true;
  }), [target.column_uuid, prepareClose]);
  useEffect(() => registerMainWindowCloseBlocker(async () => {
    if (allowNativeClose.current) return true;
    if (editing) return requestSettingsClose.current();
    if (!await prepareClose()) return false;
    if (typePickerRef.current?.cancel()) return false;
    if (busyRef.current) { setNotice(message('column.waitForSave')); return false; }
    if (closeState.current.dirty) { setWindowClosePending(true); setConfirmDiscard(true); return false; }
    return true;
  }), [editing, prepareClose]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (nameError && tab === 'basic') nameRef.current?.focus(); }, [nameError, tab]);
  // A completed load focuses the current Basic form; draft typing/tab changes do not.
  const focusLoadedName = useEffectEvent(() => { if (draft && tab === 'basic') nameRef.current?.focus(); });
  useEffect(() => { focusLoadedName(); }, [loaded]);
  useEffect(() => {
    if (!draft || !loaded) return;
    try {
      if (dirty) columnDraftStore.write(key, JSON.stringify({ schemaVersion: 1, draft, selectText, revision: loaded.revision }));
      else columnDraftStore.remove(key);
    } catch { /* Storage availability does not prevent editing. */ }
  }, [draft, selectText, dirty, key, loaded]);
  useEffect(() => {
    if (draft?.column_type !== 'TableRef') return;
    let active = true;
    setInterfaceError('');
    listInterfaces(expectedProjectSession).then(list => {
      if (active) setInterfaces(list.map(i => ({ uuid: i.uuid, name: i.name })));
    }).catch(e => { if (active) setInterfaceError(e); });
    return () => { active = false; };
  }, [draft?.column_type, expectedProjectSession]);

  const close = () => {
    if (editing) { void requestSettingsClose.current(); return; }
    void (async () => {
      if (!await prepareClose() || busyRef.current) return;
      if (typePickerRef.current?.cancel()) return;
      const state = closeState.current;
      if (state.dirty) { setConfirmDiscard(true); return; }
      if (!state.unsupportedDraft) columnDraftStore.remove(state.key);
      state.onClose();
    })();
  };
  const discard = () => {
    columnDraftStore.remove(key);
    allowNativeClose.current = true;
    onClose();
    if (windowClosePending) void getCurrentWebviewWindow().close();
  };
  const change = (patch: Partial<ColumnEditorDraft>) => {
    setDraft(prev => prev ? { ...prev, ...patch } : prev);
    setPreview(null); setError(''); setConfirmDiscard(false); setWindowClosePending(false);
  };
  const request = (): ColumnEditorRequest => {
    if (!draft || !loaded) throw new Error(t('column.notLoaded'));
    // JSON text is collected here; all schema/value validation remains in Rust.
    const select_config = draft.column_type === 'Select' ? (selectText.trim() ? { options: JSON.parse(selectText) } : null) : null;
    return { target, creation_uuid: editing ? null : loaded.column.uuid, expected_revision: loaded.revision, draft: { ...draft, select_config, reference_config: draft.column_type === 'Reference' ? draft.reference_config : null, curve_config: draft.column_type === 'Curve' ? draft.curve_config : null, table_ref_config: draft.column_type === 'TableRef' ? draft.table_ref_config : null } };
  };
  const check = async (save: boolean) => {
    const scopeOwner = target.mode === 'table' ? captureTableInteractionScope(expectedProjectSession, target.target_uuid) : 0;
    const liveScope = () => target.mode !== 'table' || isTableInteractionScopeCurrent(expectedProjectSession, target.target_uuid, scopeOwner);
    if (busyRef.current || !draft || !loaded || !liveScope()) return false;
    setNameValidationRequested(true);
    if (!locked && (!editing || draft.name !== loaded.column.data_name) && !validateDataName(draft.name).isValid) {
      setTab('basic'); setError(''); return false;
    }
    if (tagError) { setTab('basic'); setError(tagError); return false; }
    busyRef.current = true; setBusy(true); setError(''); setConfirmDiscard(false);
    try {
      const req = request();
      const result = await invoke<ColumnEditorPreview>('preview_column_editor', { request: req, expectedProjectSession });
      if (!activeRef.current || !liveScope()) return false;
      setPreview(result);
      if (result.errors.length || result.error_count) {
        setError(() => () => result.errors.map(error => localizeError(error)).join('\n') || t('column.unsupportedValues', { count: result.error_count }));
        return false;
      }
      // The Save action provides the conversion review; no separate Check action is needed.
      if (!save) return false;
      if (typeChanged && !reviewed) {
        setTab('basic');
        setNotice(message('column.typeChangeReady'));
        requestAnimationFrame(() => {
          previewRef.current?.focus();
          previewRef.current?.scrollIntoView({ block: 'nearest' });
        });
        return false;
      }
      const reports = result.input_reports || [];
      const issues = reports.flatMap(entry => entry.report.issues);
      const rejects = issues.filter(issue => issue.mode === 'reject');
      if (rejects.length) {
        setError(() => () => t('column.newViolations', { count: rejects.length, details: rejects.slice(0, 5).map((issue, index) => t('column.issueDetail', { column: settingsDisplayLabel(issue.column_uuid, issue.column_name), row: previewRecordLabel(result, issue.table_uuid, issue.record_uuid, index), error: localizeError(issue) })).join('\n') }));
        return false;
      }
      if (issues.length) {
        const controller = new AbortController();
        warningAbortRef.current = controller;
        const approved = await confirmInputWarnings(isInterface ? reports[0]?.table_uuid || '' : target.target_uuid, { issues, acknowledgement: null }, controller.signal);
        warningAbortRef.current = null;
        if (!approved || !activeRef.current || !liveScope()) { if (activeRef.current) setNotice(message('column.warningCancelled')); return false; }
        // Approval is scoped to this immutable preview request, never the editable draft or cache.
        req.acknowledgements = Object.fromEntries(reports.flatMap(entry => entry.report.acknowledgement ? [[entry.table_uuid, entry.report.acknowledgement]] : []));
        if (!isInterface) req.acknowledgement = req.acknowledgements[target.target_uuid] || null;
      }
      if (!liveScope()) return false;
      await invoke<{ column_uuid: string }>('save_column_editor', { request: req, expectedProjectSession });
      if (!activeRef.current || !liveScope()) return false;
      columnDraftStore.remove(key);
      // Successful persistence must not turn into a retryable save because refresh/event delivery failed.
      const notification = (isInterface
        ? emit('interface-column-added', { interfaceUuid: target.target_uuid, projectSession: expectedProjectSession })
        : emit('column-added', { tableUuid: target.target_uuid, projectSession: expectedProjectSession })).catch(() => {});
      // Local presentation must not wait for event delivery to another window.
      // Start both notifications in the same turn so their reads can coalesce.
      const presentation = Promise.resolve().then(() => onSaved?.()).catch(() => {});
      // Keep the native editor alive until its outgoing event has been delivered.
      await notification;
      allowNativeClose.current = true;
      onClose();
      await presentation;
      return true;
    } catch (e) {
      const report = inputValidationReport(e);
      setError(report ? () => () => t('column.revalidationNeeded', { details: report.issues.slice(0, 5).map((issue, index) => t('column.issueDetail', { column: settingsDisplayLabel(issue.column_uuid, issue.column_name), row: previewRecordLabel(preview, issue.table_uuid, issue.record_uuid, index), error: localizeError(issue) })).join('\n') }) : e);
      return false;
    }
    finally { warningAbortRef.current?.abort(); warningAbortRef.current = null; busyRef.current = false; setBusy(false); }
  };
  saveCurrent.current = () => check(true);
  requestSettingsClose.current = () => {
    if (closeRequest.current) return closeRequest.current;
    const operation = (async () => {
      if (!await prepareClose() || busyRef.current) return false;
      if (typePickerRef.current?.cancel()) return false;
      columnDraftStore.remove(closeState.current.key);
      allowNativeClose.current = true;
      closeState.current.onClose();
      return true;
    })();
    closeRequest.current = operation;
    void operation.finally(() => { if (closeRequest.current === operation) closeRequest.current = null; });
    return operation;
  };
  const newFormattingRule = async (kind: FormatCondition['kind']): Promise<FormattingRule | undefined> => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setConfirmDiscard(false);
    try {
      const rule = await invoke<FormattingRule>('new_formatting_rule', { kind });
      return activeRef.current ? rule : undefined;
    } catch (e) { setError(e); return undefined; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const displayTableName = loaded ? (isInterface ? loaded.name : settingsDisplayLabel(loaded.target.target_uuid, loaded.name)) : '';
  const displayColumnName = draft && loaded ? (isInterface ? draft.display_name || draft.name : settingsDisplayLabel(loaded.column.uuid, draft.display_name || draft.name)) : '';
  const field = (name: string, label: string, value: string, onChange: (value: string) => void, multiline = false, disabled = locked) => (
    <div className="editor-field"><label htmlFor={`${id}-${name}`}>{label}</label>{(name === 'default' || name === 'existing-default') ? <FormulaInput id={`${id}-${name}`} className="editor-input" value={value} onChange={onChange} disabled={disabled || busy} /> : multiline
      ? <textarea id={`${id}-${name}`} className="editor-input" rows={3} value={value} onChange={e => onChange(e.target.value)} disabled={disabled || busy} />
      : <input id={`${id}-${name}`} dir={name === 'color' ? 'ltr' : undefined} className="editor-input" value={value} onChange={e => onChange(e.target.value)} disabled={disabled || busy} />}</div>
  );

  return <FormulaCompletionProvider session={expectedProjectSession} tableUuid={target.mode === 'table' ? target.target_uuid : 'interface:' + target.target_uuid}><aside {...composition.captureProps} ref={ref} className="column-editor" aria-label={isInterface ? t('column.fieldSettings') : t('column.settings')} onKeyDown={e => {
    if (e.key === 'Escape' && !e.defaultPrevented && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); close(); }
  }}>
    <header className="editor-header">
      <Columns3 className="w-4 h-4 text-primary shrink-0" />
      <div className="min-w-0 flex-1"><h2 className="font-semibold text-sm">{t('column.editorTitle', { target: isInterface ? 'field' : 'column', action: editing ? 'edit' : 'add' })}</h2>
        <p className="text-[11px] leading-4 text-muted-foreground truncate">{displayTableName || (isInterface ? t('column.interface') : t('column.table'))}{displayColumnName ? ` › ${displayColumnName}` : ''}</p></div>
      <button type="button" className="p-1 rounded hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('column.closeSettings')} disabled={busy} onClick={close}><X className="w-4 h-4" /></button>
    </header>
    {!draft || !loaded ? <div className="p-5 text-sm">{errorText ? <><p role="alert" className="text-red-700">{errorText}</p><button className="editor-action mt-4" onClick={() => { if (unsupportedDraft) columnDraftStore.remove(key); void load(); }}>{t(unsupportedDraft ? 'column.reloadDiscard' : 'common.reload')}</button></> : t('column.loadingSettings')}</div> : <>
      <div role="tablist" aria-label={t('column.settingsCategories')} className="editor-tabs">
        {TABS.map(([value, label], i) => <button key={value} type="button" ref={el => { tabRefs.current[i] = el; }} className="editor-tab" id={`${id}-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls={`${id}-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={e => {
          let next = i;
          if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
          else if (e.key === 'ArrowLeft') next = (i + TABS.length - 1) % TABS.length;
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = TABS.length - 1;
          else return;
          e.preventDefault(); setTab(TABS[next][0]); tabRefs.current[next]?.focus(); tabRefs.current[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }}>{label}</button>)}
      </div>
      <div className="editor-body">

        {notice && <p role="status" className="text-xs text-blue-700 bg-blue-50 p-3 rounded mb-4">{resolveMessage(notice)}</p>}
        {errorText && <div ref={errorRef} tabIndex={-1} role="alert" className="mb-3 whitespace-pre-wrap text-xs leading-5 text-red-700 dark:text-red-300">{errorText}{canReloadDefinition(error) && <button type="button" className="editor-action block mt-2" onClick={() => { columnDraftStore.remove(key); void load(); }}>{t('column.reloadDiscard')}</button>}</div>}
        <section role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0}>
          {tab === 'basic' && <div className="editor-basic">
            <div className="editor-section editor-basic-identity"><div className="editor-field"><label htmlFor={`${id}-name`}>{t('column.fieldName')}</label>
              <input ref={nameRef} id={`${id}-name`} className="editor-input" aria-invalid={!!nameError} aria-describedby={nameError ? `${id}-name-error` : undefined} value={draft.name} onChange={e => change({ name: e.target.value })} disabled={locked || busy} autoComplete="off" placeholder={isInterface ? t('column.fieldNameExample') : t('column.nameExample')} />{nameError && <p id={`${id}-name-error`} role="alert" className="text-xs text-red-700 dark:text-red-300">{nameError}</p>}</div>
              {field('display-label', t('column.displayName'), draft.display_name ?? '', display_name => change({ display_name }))}

            </div>
            <p className="editor-hint">{t('column.identityHint')}</p>

            <div className="editor-section"><div className="editor-field"><span className="editor-field-label">{t('column.dataTypeLabel')}</span>
              <ColumnTypePicker ref={typePickerRef} target={target} expectedProjectSession={expectedProjectSession} expectedRevision={loaded.revision} value={draft.column_type} onChange={column_type => change({ column_type })} disabled={locked || busy} /></div>
              <div className="mt-3">
                {draft.column_type === 'Reference' ? <fieldset disabled={locked || busy}><ReferenceConfigSelector expectedProjectSession={expectedProjectSession} config={draft.reference_config || undefined} onChange={reference_config => change({ reference_config })} /></fieldset>
                  : draft.column_type === 'TableRef' ? <><label htmlFor={`${id}-table-ref`}>{t('reference.requiredInterface')}</label><select id={`${id}-table-ref`} className="editor-input" value={draft.table_ref_config?.interface_uuid || ''} onChange={e => change({ table_ref_config: { interface_uuid: e.target.value } })} disabled={locked || busy}><option value="">{t('reference.selectInterface')}</option>{interfaces.map(i => <option key={i.uuid} value={i.uuid}>{i.name}</option>)}</select>{Boolean(interfaceError) && <p role="alert" className="text-xs text-red-700 mt-2">{t('reference.listFailed', { error: localizeError(interfaceError) })}</p>}</>
                  : draft.column_type === 'Curve' ? <><div className="grid grid-cols-2 gap-3">{(['start_value', 'end_value'] as const).map((part, i) => <div key={part}><label htmlFor={`${id}-${part}`}>{i === 0 ? t('curve.startXZero') : t('curve.endXOne')}</label><input id={`${id}-${part}`} className="editor-input" type="number" step="any" value={draft.curve_config?.[part] ?? i} onChange={e => change({ curve_config: { start_value: draft.curve_config?.start_value ?? 0, end_value: draft.curve_config?.end_value ?? 1, [part]: e.target.valueAsNumber } })} disabled={locked || busy} /></div>)}</div></>
                  : field('default', t('column.defaultValue'), draft.default_value, default_value => change({ default_value }))}
                {isColorType(draft.column_type) && !draft.default_value.trimStart().startsWith('=') && <div className="mt-2"><ColorField type={draft.column_type} value={draft.default_value} columnSwatches={draft.color_swatches} label={t('column.defaultValue')} context={`${key}:${loaded.revision}`} disabled={locked || busy} onChange={default_value => change({ default_value })} /></div>}
                {['Reference', 'TableRef', 'Curve'].includes(draft.column_type) && draft.default_value && <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3">
                  {field('existing-default', t('column.savedDefault'), draft.default_value, default_value => change({ default_value }), false)}
                  <p className="editor-hint">{t('column.keepDefaultHint')}</p>
                  <button type="button" className="editor-action mt-2" disabled={locked || busy} onClick={() => change({ default_value: '' })}>{t('column.clearDefault')}</button>
                </div>}
                {draft.column_type === 'Select' && <div><label htmlFor={`${id}-select`}>{t('column.selectJson')}</label><textarea id={`${id}-select`} className="editor-input font-mono text-xs" rows={5} value={selectText} disabled={locked || busy} onChange={e => { setSelectText(e.target.value); setPreview(null); setError(''); }} /><p className="editor-hint">{t('column.selectJsonHint', { example: `\u2066${JSON.stringify([{ value: 'fire', label: t('column.selectExampleLabel') }])}\u2069` })}</p></div>}
              </div>
            </div>
            {<div className="editor-section">
              <div className="editor-field"><label htmlFor={`${id}-read-only`}>{t('table.edit.readOnly')}</label>
                <Switch id={`${id}-read-only`} checked={draft.read_only} disabled={busy || isInterface}
                  onCheckedChange={read_only => change({ read_only })} /></div>
            </div>}
            <div className="editor-section editor-descriptions">{<div><label className="editor-label">{t('metadata.tags')}</label><TagSelector originalValue={loaded.column.tags ?? []} value={draft.tags} onChange={tags => change({ tags })} expectedProjectSession={expectedProjectSession} disabled={busy || isInterface} /></div>}{field('tooltip', t('column.tooltip'), draft.tooltip, tooltip => change({ tooltip }))}{field('description', t('column.extendedDescription'), draft.memo_text, memo_text => change({ memo_text }), true)}</div>
            {isInterface && <p className="editor-hint">{t('column.tableOnlySettingsHint')}</p>}
            {isColorType(draft.column_type) && <ColumnColorSwatches type={draft.column_type} value={draft.color_swatches} onChange={color_swatches => change({ color_swatches })} context={`${key}:${loaded.revision}:${editorReset}`} disabled={locked || busy} />}
            {typeChanged && <div className="mb-3 p-2 rounded border border-amber-200 bg-amber-50 text-xs text-amber-900"><strong>{t('column.typeChangeReview')}</strong><p className="mt-1">{t('column.typeChangeHint', { before: loaded.column.data_type, after: draft.column_type })}</p></div>}
            {preview && <div ref={previewRef} tabIndex={-1} className={`mb-3 rounded border p-2 text-xs ${preview.error_count || preview.errors.length ? 'border-red-200 bg-red-50' : 'border-blue-200 bg-blue-50'}`} aria-live="polite">
              <strong id={`${id}-preview-heading`}>{t('column.reviewChanges')}</strong>
              <p className="mt-1">{t('column.previewCounts', { total: preview.total_values, errors: preview.error_count, changed: preview.changed_count, empty: preview.empty_count })}</p>
              {preview.samples.length > 0 && <ul className="preview-sample-list preview-conversion-samples mt-3" role="list" aria-labelledby={`${id}-preview-heading`}>
                {[...preview.samples].sort((a, b) => Number(!!b.error) - Number(!!a.error)).slice(0, 8).map((s, i) => <li key={`${s.table_uuid}-${s.record_uuid}-${s.source}-${i}`} aria-labelledby={`${id}-preview-source-${i}`}>
                  <p id={`${id}-preview-source-${i}`} className="p-1 text-[10px] text-muted-foreground break-all" title={s.source === 'default' ? t('column.defaultValue') : previewTableLabel(preview, s.table_uuid)}>{s.source === 'default' ? t('column.defaultValue') : previewRecordLabel(preview, s.table_uuid, s.record_uuid, i)}</p>
                  <dl className="preview-sample-values preview-conversion-values">
                    <div><dt>{t('column.currentValue')}</dt><dd>{s.original_value || t('column.empty')}</dd></div>
                    <div><dt>{t('column.convertedValue')}</dt><dd className={s.error ? 'text-red-700' : undefined}>{s.error ? localizeError(s.error) : s.converted_value || t('column.empty')}</dd></div>
                  </dl>
                </li>)}
              </ul>}
            </div>}
            <>{preview && Boolean(preview.input_issue_count) && <p className="rule-note mb-4">{t('column.inputIssueCount', { count: preview.input_issue_count })}<button type="button" className="underline" onClick={() => setTab('rules')}>{t('column.viewIssueLocations')}</button></p>}</>
          </div>}
          {tab === 'rules' && <><InputValidationEditor key={`${key}-${loaded.revision}-${editorReset}`} value={draft.input_validation} onChange={input_validation => change({ input_validation })} disabled={locked || busy} inherited={locked} columnType={draft.column_type} constraintColumn={loaded.column} showSchemaConstraints={!interfaceRelated} /><RulePreview preview={preview} kind="rules" columnName={displayColumnName} /></>}
          {tab === 'display' && <><ConditionalFormattingEditor key={`${key}-${loaded.revision}-${editorReset}`} value={locked && !isInterface ? draft.conditional_formatting_override : draft.conditional_formatting} baseValue={draft.conditional_formatting} onChange={value => change(locked && !isInterface ? { conditional_formatting_override: value } : { conditional_formatting: value })} onNewRule={newFormattingRule} disabled={busy} inherited={locked} canOverride={locked && !isInterface} onOpenOrigin={() => setTab('origin')} /><RulePreview preview={preview} kind="display" columnName={displayColumnName} /><details className="editor-section rule-base-color"><summary>{t('column.displayColor')}</summary><div className="mt-3"><p className="editor-hint mb-3">{t('column.colorScopeHint', { scope: isInterface ? 'interface' : 'table' })}</p><div className="flex flex-wrap gap-2">{COLORS.map(color => <button key={color} type="button" aria-label={t('column.colorSwatch', { color })} aria-pressed={draft.color.toLowerCase() === color} disabled={busy} className={`w-9 h-9 rounded border-2 ${draft.color.toLowerCase() === color ? 'border-primary ring-2 ring-primary/20' : 'border-border'}`} style={{ backgroundColor: color }} onClick={() => change({ color })} />)}</div><div className="mt-3 space-y-2"><ColorField value={draft.color} label={t('column.displayColor')} context={`${key}:${loaded.revision}`} disabled={busy} onChange={color => change({ color })} /><details><summary className="cursor-pointer text-xs text-muted-foreground">{t('column.colorCode')}</summary>{field('color', t('column.colorCode'), draft.color, color => change({ color }), false, false)}</details></div><button className="editor-action" type="button" disabled={busy} onClick={() => change({ color: '' })}>{t('column.restoreTypeColor')}</button><div className="mt-4 rounded-lg border border-border p-4 text-center" style={{ backgroundColor: draft.color || '#f8fafc' }}><span className="rounded bg-background/90 px-3 py-1 text-foreground">{displayColumnName || t('column.name')} · {draft.default_value || draft.column_type}</span></div></div></details></>}
          {tab === 'origin' && <>{locked && <div className="mb-4 p-3 rounded-lg bg-blue-50 text-blue-900 text-xs leading-5 flex gap-2"><LockKeyhole className="w-4 h-4 shrink-0 mt-0.5" /><div>{t('column.managedBy', { name: loaded.origin_name || loaded.column.interface_origin_name_fallback || t('column.interface') })}{isInterface ? t('column.originFormattingHint') : t('column.localFormattingHint')}<button type="button" className="block underline mt-1" onClick={() => setTab('origin')}>{t('column.viewOrigin')}</button></div></div>}<SchemaConstraints column={loaded.column} /><div className="editor-section"><h3>{t('column.origin')}</h3><p className="font-medium">{locked ? loaded.origin_name || t('column.interface') : isInterface ? loaded.name : t('column.tableOwned')}</p>{locked && <p className="editor-hint">{isInterface ? t('column.interfaceInheritedHint') : t('column.tableInheritedHint')}</p>}{locked && loaded.column.interface_origin && <button type="button" className="editor-action mt-3 inline-flex items-center gap-2" onClick={async () => { try { await openInterfaceInEditor(loaded.column.interface_origin!, expectedProjectSession); } catch (e) { setError(e); } }}><ExternalLink className="w-3 h-3" />{t('column.openOrigin')}</button>}</div><div className="editor-section"><h3>{t('column.targets')}</h3>{isInterface ? <><p className="editor-hint">{t('column.syncHint')}</p>{loaded.implementing_tables?.length ? <ul className="space-y-2 mt-3">{loaded.implementing_tables.map((name, i) => <li key={i} className="p-2 border rounded text-sm break-all">{name}</li>)}</ul> : <p className="text-sm mt-3 text-muted-foreground">{t('column.noImplementations')}</p>}</> : <p>{displayTableName}</p>}</div></>}
        </section>
      </div>
      {confirmDelete && <div role="alert" className="px-3 py-2 border-t border-red-200 bg-red-50 text-xs text-red-900"><p>{t('column.deleteWarning', { target: isInterface ? 'field' : 'column' })}</p><div className="flex gap-2 mt-2"><button type="button" className="editor-action" disabled={busy} onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button><button type="button" className="editor-action" disabled={busy} onClick={async () => { if (busyRef.current || !onDelete) return; busyRef.current = true; setBusy(true); try { if (await onDelete()) discard(); } catch (e) { setError(e); } finally { busyRef.current = false; setBusy(false); } }}>{t('column.confirmDelete')}</button></div></div>}
      {confirmDiscard && <div role="alert" className="px-3 py-2 border-t border-amber-200 bg-amber-50 text-xs text-amber-900"><p>{windowClosePending ? t('column.discardWindow') : t('column.discardEditor')}</p><div className="flex gap-2 mt-2"><button type="button" className="editor-action" disabled={busy} onClick={() => { setConfirmDiscard(false); setWindowClosePending(false); }}>{t('column.keepEditing')}</button><button type="button" className="editor-action" disabled={busy} onClick={discard}>{t('column.discardAndClose')}</button></div></div>}
      <footer className="editor-footer">
        <span role="status" className="editor-status">{busy ? t('column.checkingSaving') : dirty ? t('column.unsavedChanges') : ''}</span>
        {onDelete && editing && !locked && <button type="button" className="text-xs text-red-600 px-2 py-1 disabled:opacity-50" title={deleteDisabledReason} disabled={busy || Boolean(deleteDisabledReason)} onClick={() => { setConfirmDelete(true); setConfirmDiscard(false); }}>{t('common.delete')}</button>}
        <button type="button" className="editor-action" disabled={busy} onClick={close}>{t('common.cancel')}</button>
        {<button type="button" className="editor-action editor-primary" disabled={busy || !!tagError} onClick={async () => { if (await prepareClose()) await saveCurrent.current(); }}>{t(editing ? 'common.save' : 'common.add')}</button>}
      </footer>
    </>}
  </aside></FormulaCompletionProvider>;
}
