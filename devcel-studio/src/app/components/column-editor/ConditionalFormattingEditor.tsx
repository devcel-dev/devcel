import { t, useI18n, formatNumber } from '@/app/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { RuleEditorDialog } from './RuleEditorDialog';
import type { ConditionalFormatting, FormatCondition, FormattingRule, CellStyle } from '@/app/types/tableRules';

interface Props {
  value: ConditionalFormatting | null;
  baseValue: ConditionalFormatting | null;
  onChange: (value: ConditionalFormatting | null) => void;
  onNewRule: (kind: FormatCondition['kind']) => Promise<FormattingRule | undefined>;
  disabled: boolean;
  inherited: boolean;
  canOverride: boolean;
  onOpenOrigin: () => void;
}

const getConditions = (): Array<[FormatCondition['kind'], string]> => [
  ['all', t('rules.condition.all')], ['empty', t('rules.condition.empty')], ['not_empty', t('rules.condition.notEmpty')],
  ['equals', t('rules.condition.equals')], ['not_equals', t('rules.condition.notEquals')],
  ['contains', t('rules.condition.contains')], ['not_contains', t('rules.condition.notContains')],
  ['greater_than', t('rules.condition.greater')], ['greater_than_or_equal', t('rules.condition.greaterOrEqual')],
  ['less_than', t('rules.condition.less')], ['less_than_or_equal', t('rules.condition.lessOrEqual')],
  ['between', t('rules.condition.range')], ['top', t('rules.condition.top')], ['bottom', t('rules.condition.bottom')], ['color_scale', t('rules.condition.colorScale')],
];

function conditionLabel(condition: FormatCondition, conditions: ReturnType<typeof getConditions>): string {
  const label = conditions.find(([kind]) => kind === condition.kind)?.[1] || condition.kind;
  if ('value' in condition) return t('rules.conditionValue', { label, value: condition.value || t('rules.notEntered') });
  if (condition.kind === 'between') return t('rules.inclusiveRange', { min: condition.min || '…', max: condition.max || '…' });
  if (condition.kind === 'top' || condition.kind === 'bottom') return t('rules.rankSummary', { label, count: condition.count, ties: condition.include_ties ? 'yes' : 'no' });
  return label;
}

function ColorField({ id, label, value, onChange }: { id: string; label: string; value?: string | null; onChange: (value: string) => void }) {
  useI18n();
  return <div><label htmlFor={id}>{label}</label><div className="rule-color-field"><input type="color" aria-label={t('rules.selectColor', { label })} value={value || '#ffffff'} onChange={e => onChange(e.target.value)} /><input id={id} className="editor-input font-mono text-xs" value={value || ''} placeholder={t('rules.unspecified')} onChange={e => onChange(e.target.value)} /></div></div>;
}

export function ConditionalFormattingEditor({ value, baseValue, onChange, onNewRule, disabled, inherited, canOverride, onOpenOrigin }: Props) {
  useI18n();
  const id = useId();
  const conditions = getConditions();
  const [nextKind, setNextKind] = useState<FormatCondition['kind']>('between');
  const [selected, setSelected] = useState<FormattingRule | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [pending, setPending] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  const [editingEmptyOverride, setEditingEmptyOverride] = useState(false);
  const customDraft = useRef<ConditionalFormatting | null>(value);
  const [settings, setSettings] = useState<{ value: ConditionalFormatting | null; emptyOverride: boolean; custom: ConditionalFormatting | null } | null>(null);
  const modeFor = (current: ConditionalFormatting | null, emptyOverride: boolean) => !canOverride ? 'base' : current === null ? 'inherit' : current.rules.length === 0 && !emptyOverride ? 'off' : 'custom';
  const mode = modeFor(value, editingEmptyOverride);
  const settingsMode = settings ? modeFor(settings.value, settings.emptyOverride) : mode;
  const effective = canOverride && mode === 'inherit' ? baseValue : value;
  const editable = !disabled && (!inherited || (canOverride && mode === 'custom'));
  const rules = effective?.rules || [];
  const update = (rule: FormattingRule) => onChange({ rules: rules.map(entry => entry.id === rule.id ? rule : entry) });
  const updateCondition = (condition: FormatCondition) => setSelected(current => current ? { ...current, condition } : current);
  const updateStyle = (patch: Partial<CellStyle>) => setSelected(current => current ? { ...current, style: { ...current.style, ...patch } } : current);
  const closeRule = () => { request.current += 1; setPending(false); setSelected(null); };
  const openRule = (rule: FormattingRule, newRule = false) => {
    request.current += 1;
    setPending(false);
    setIsNew(newRule);
    setSelected({ ...rule, condition: { ...rule.condition }, style: { ...rule.style } });
  };
  const changeCondition = async (kind: FormatCondition['kind']) => {
    const token = ++request.current;
    setPending(true);
    try {
      const rule = await onNewRule(kind);
      if (token === request.current && rule) updateCondition(rule.condition);
    } finally {
      if (token === request.current) setPending(false);
    }
  };
  const move = (index: number, direction: number) => {
    const next = [...rules];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    onChange({ rules: next });
  };
  const add = async () => {
    if (!editable || pending) return;
    const token = ++request.current;
    setPending(true);
    try {
      const rule = await onNewRule(nextKind);
      if (token === request.current && rule) openRule(rule, true);
    } finally {
      if (token === request.current) setPending(false);
    }
  };
  const applySettings = () => {
    if (!settings || disabled) return;
    if (!inherited || canOverride) {
      customDraft.current = settings.custom;
      setEditingEmptyOverride(settings.emptyOverride);
      onChange(settings.value);
    }
    setSettings(null);
  };
  const summary = mode === 'inherit' ? t('rules.inherit') : mode === 'off' ? t('rules.disableTable') : value === null ? t('rules.unset') : rules.length ? t('rules.formatCount', { count: rules.length }) : t('rules.explicitlyDisabled');

  return <div className="editor-section">
    <div className="rule-heading"><h3>{t('rules.listHeading')} <span className="rule-count">{formatNumber(rules.length)}</span></h3><span className="rule-scope">{t('rules.priorityOrder')}</span></div>
    <div className="mt-3 space-y-2" aria-label={t('rules.priorityOrder')}>
      {rules.map((rule, index) => {
        const label = conditions.find(([kind]) => kind === rule.condition.kind)?.[1] || rule.condition.kind;
        const detail = conditionLabel(rule.condition, conditions);
        return <div key={rule.id} className={`format-rule-row ${rule.enabled ? '' : 'is-disabled'}`}>
        <label className="rule-check" title={rule.enabled ? t('rules.enabled') : t('rules.disabled')}><input type="checkbox" checked={rule.enabled} disabled={!editable} aria-label={t('rules.enableNth', { index: index + 1 })} onChange={e => update({ ...rule, enabled: e.target.checked })} /><span className="text-xs text-muted-foreground">{formatNumber(index + 1)}</span></label>
        <button type="button" className="format-rule-select" aria-haspopup="dialog" title={detail} onClick={() => openRule(rule)}><span className="format-rule-swatch" style={{ backgroundColor: rule.condition.kind === 'color_scale' || rule.condition.kind === 'between' ? rule.condition.low_color : rule.style.background_color || undefined, color: rule.style.text_color || undefined, fontWeight: rule.style.bold ? 700 : 400 }}>Aa</span><span className="format-rule-summary"><span>{label}</span><span className="format-rule-detail">{rule.condition.kind === 'color_scale' ? `${t('rules.minimum')} → ${t('rules.maximum')}` : detail !== label ? detail : ''}{rule.stop_if_true && <> · {t('rules.stopShort')}</>}</span></span></button>
        <div className="rule-row-actions"><button type="button" className="rule-icon-button" disabled={!editable || index === 0} aria-label={t('rules.moveNthUp', { index: index + 1 })} title={t('rules.moveUp')} onClick={() => move(index, -1)}><ArrowUp className="w-3.5 h-3.5" /></button><button type="button" className="rule-icon-button" disabled={!editable || index === rules.length - 1} aria-label={t('rules.moveNthDown', { index: index + 1 })} title={t('rules.moveDown')} onClick={() => move(index, 1)}><ArrowDown className="w-3.5 h-3.5" /></button><button type="button" className="rule-icon-button" disabled={!editable} aria-label={t('rules.deleteNthFormatting', { index: index + 1 })} title={t('rules.deleteFormatting')} onClick={() => { setEditingEmptyOverride(true); onChange({ rules: rules.filter(entry => entry.id !== rule.id) }); }}><Trash2 className="w-3.5 h-3.5" /></button></div>
      </div>; })}
      {rules.length === 0 && <p className="rule-empty">{mode === 'off' ? t('rules.tableDisabled') : mode === 'inherit' || inherited && !canOverride ? t('rules.sourceEmpty') : t('rules.addToStart')}</p>}
    </div>
    {(!inherited || canOverride && mode === 'custom') && <div className="rule-add-row mt-3"><label className="sr-only" htmlFor={`${id}-add`}>{t('rules.addCondition')}</label><select id={`${id}-add`} className="editor-input" disabled={!editable || pending} value={nextKind} onChange={e => setNextKind(e.target.value as FormatCondition['kind'])}>{conditions.map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}</select><button type="button" className="editor-action inline-flex items-center justify-center gap-1" disabled={!editable || pending} onClick={() => void add()}><Plus className="w-4 h-4" />{t('rules.add')}</button></div>}
    <div className="rule-column-settings"><p className="rule-settings-label">{t('rules.columnSettings')}</p><button type="button" className="rule-summary-button rule-settings-row" aria-haspopup="dialog" onClick={() => { request.current += 1; setPending(false); setSettings({ value, emptyOverride: editingEmptyOverride, custom: customDraft.current }); }}>
      <span className="rule-summary-label">{t('rules.formattingSettings')}</span><span className="rule-summary-value">{t('rules.tableScope')} · {summary}</span><ChevronRight className="w-4 h-4" aria-hidden="true" />
    </button></div>
    {settings && <RuleEditorDialog busy={disabled} applyOnClose title={t('rules.formattingSettings')} onClose={() => setSettings(null)} disabled={disabled || inherited && !canOverride} onApply={applySettings}>
    {canOverride ? <div className="rule-source mt-3"><label htmlFor={`${id}-source`}>{t('rules.tableMode')}</label><select id={`${id}-source`} className="editor-input" disabled={disabled} value={settingsMode} onChange={e => {
      const next = e.target.value;
      setSettings(current => {
        if (!current) return current;
        const custom = settingsMode === 'custom' ? current.value : current.custom;
        return { custom, emptyOverride: next === 'custom', value: next === 'inherit' ? null : next === 'off' ? { rules: [] } : custom?.rules.length ? custom : { rules: [...(baseValue?.rules || [])] } };
      });
    }}><option value="inherit">{t('rules.inherit')}</option><option value="off">{t('rules.disableTable')}</option><option value="custom">{t('rules.customTable')}</option></select>{settingsMode !== 'off' && <p className="editor-hint">{settingsMode === 'inherit' ? t('rules.inheritHint') : t('rules.customHint')}</p>}<button type="button" className="text-xs underline mt-2" disabled={disabled} onClick={() => { applySettings(); onOpenOrigin(); }}>{t('column.viewOrigin')}</button></div>
      : inherited ? <p className="rule-note">{t('rules.baseHint')}<button type="button" className="underline ml-1" disabled={disabled} onClick={() => { applySettings(); onOpenOrigin(); }}>{t('column.viewOrigin')}</button></p>
      : <div className="flex flex-wrap gap-2 mt-3 items-center"><span className="text-xs text-muted-foreground">{settings.value === null ? t('rules.unset') : (settings.value?.rules.length || 0) ? t('rules.formatCount', { count: (settings.value?.rules.length || 0) }) : t('rules.explicitlyDisabled')}</span>{settings.value !== null && <button type="button" disabled={disabled} className="text-xs underline" onClick={() => setSettings({ ...settings, value: null })}>{t('rules.clearNewFormatting')}</button>}{(settings.value === null || (settings.value?.rules.length || 0) > 0) && <button type="button" disabled={disabled} className="text-xs underline" onClick={() => setSettings({ ...settings, value: { rules: [] } })}>{t('rules.disableFormatting')}</button>}</div>}
    </RuleEditorDialog>}
    {selected && <RuleEditorDialog busy={pending} applyOnClose={!isNew} title={t('rules.editFormattingRule')} onClose={closeRule} disabled={!editable || pending} onApply={() => {
      if (!editable || pending) return;
      setEditingEmptyOverride(true);
      if (isNew) onChange({ rules: [...rules, selected] });
      else update(selected);
      closeRule();
    }}><fieldset className="min-w-0" disabled={!editable || pending}>
      <label htmlFor={`${id}-condition`}>{t('rules.condition')}</label><select id={`${id}-condition`} className="editor-input" value={selected.condition.kind} onChange={e => void changeCondition(e.target.value as FormatCondition['kind'])}>{conditions.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select>
      {'value' in selected.condition && <div className="mt-3"><label htmlFor={`${id}-value`}>{t('rules.compareValue')}</label><input id={`${id}-value`} dir={['greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal'].includes(selected.condition.kind) ? 'ltr' : 'auto'} className="editor-input" value={selected.condition.value} onChange={e => { if ('value' in selected.condition) updateCondition({ ...selected.condition, value: e.target.value }); }} /></div>}
      {selected.condition.kind === 'between' && <div className="rule-field-grid mt-3"><div><label htmlFor={`${id}-low`}>{t('rules.minimumInclusive')}</label><input id={`${id}-low`} className="editor-input" inputMode="decimal" value={selected.condition.min} onChange={e => { if (selected.condition.kind === 'between') updateCondition({ ...selected.condition, min: e.target.value }); }} /></div><div><label htmlFor={`${id}-high`}>{t('rules.maximumInclusive')}</label><input id={`${id}-high`} className="editor-input" inputMode="decimal" value={selected.condition.max} onChange={e => { if (selected.condition.kind === 'between') updateCondition({ ...selected.condition, max: e.target.value }); }} /></div></div>}
      {selected.condition.kind === 'between' && <><div className="rule-field-grid mt-3">
        <ColorField id={`${id}-range-low`} label={t('rules.minimumColor')} value={selected.condition.low_color ?? '#93c5fd'} onChange={color => { if(selected.condition.kind==='between') updateCondition({...selected.condition,low_color:color}); }} />
        <ColorField id={`${id}-range-high`} label={t('rules.maximumColor')} value={selected.condition.high_color ?? '#2563eb'} onChange={color => { if(selected.condition.kind==='between') updateCondition({...selected.condition,high_color:color}); }} />
        <ColorField id={`${id}-range-out`} label={t('rules.outOfRangeColor')} value={selected.condition.out_of_range_color ?? '#dc2626'} onChange={color => { if(selected.condition.kind==='between') updateCondition({...selected.condition,out_of_range_color:color}); }} />
      </div><p className="editor-hint">{t('rules.rangeBarHint')}</p></>}
      {(selected.condition.kind === 'top' || selected.condition.kind === 'bottom') && <div className="mt-3"><label htmlFor={`${id}-count`}>{t('rules.rankCount')}</label><input id={`${id}-count`} className="editor-input" type="number" min={1} max={4294967295} step={1} value={Number.isFinite(selected.condition.count) ? selected.condition.count : ''} onChange={e => { if (selected.condition.kind === 'top' || selected.condition.kind === 'bottom') updateCondition({ ...selected.condition, count: e.target.valueAsNumber }); }} /><label className="rule-check mt-3"><input type="checkbox" checked={selected.condition.include_ties} onChange={e => { if (selected.condition.kind === 'top' || selected.condition.kind === 'bottom') updateCondition({ ...selected.condition, include_ties: e.target.checked }); }} />{t('rules.includeTies')}</label><p className="editor-hint">{t('rules.tiesHint')}</p></div>}
      {selected.condition.kind === 'color_scale' && <><div className="rule-field-grid mt-3"><ColorField id={`${id}-scale-low`} label={t('rules.minimumColor')} value={selected.condition.low_color} onChange={color => { if (selected.condition.kind === 'color_scale') updateCondition({ ...selected.condition, low_color: color }); }} /><ColorField id={`${id}-scale-high`} label={t('rules.maximumColor')} value={selected.condition.high_color} onChange={color => { if (selected.condition.kind === 'color_scale') updateCondition({ ...selected.condition, high_color: color }); }} /></div><p className="editor-hint">{t('rules.colorScaleHint')}</p></>}
      <div className="mt-3 pt-3 border-t border-border"><h4 className="text-xs font-semibold mb-3">{t('rules.appearance')}</h4><div className="rule-field-grid">{selected.condition.kind !== 'color_scale' && selected.condition.kind !== 'between' && <ColorField id={`${id}-background`} label={t('rules.backgroundColor')} value={selected.style.background_color} onChange={color => updateStyle({ background_color: color || undefined })} />}<ColorField id={`${id}-text`} label={t('rules.textColor')} value={selected.style.text_color} onChange={color => updateStyle({ text_color: color || undefined })} /><div><label htmlFor={`${id}-bold`}>{t('rules.fontWeight')}</label><select id={`${id}-bold`} className="editor-input" value={selected.style.bold === undefined || selected.style.bold === null ? 'inherit' : selected.style.bold ? 'bold' : 'normal'} onChange={e => updateStyle({ bold: e.target.value === 'inherit' ? undefined : e.target.value === 'bold' })}><option value="inherit">{t('rules.unspecified')}</option><option value="bold">{t('rules.bold')}</option><option value="normal">{t('rules.normal')}</option></select></div></div></div>
      <label className="rule-check mt-3"><input type="checkbox" checked={selected.stop_if_true} onChange={e => setSelected({ ...selected, stop_if_true: e.target.checked })} />{t('rules.stopIfTrue')}</label>
    </fieldset></RuleEditorDialog>}
  </div>;
}
