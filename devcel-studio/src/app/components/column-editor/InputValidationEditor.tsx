import { t, useI18n, formatNumber } from '@/app/i18n';
import { useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { InputRule, InputValidationSettings } from '@/app/types/tableRules';
import type { EditorColumn } from './types';
import { RuleEditorDialog } from './RuleEditorDialog';

interface Props {
  value: InputValidationSettings | null;
  onChange: (value: InputValidationSettings | null) => void;
  disabled: boolean;
  inherited: boolean;
  columnType: string;
  constraintColumn: EditorColumn;
  showSchemaConstraints?: boolean;

}

const RULES: Array<{ kind: InputRule['kind']; label: string; description: string }> = [
  { kind: 'required', get label() { return t('rules.required'); }, get description() { return t('rules.requiredHint'); } },
  { kind: 'unique', get label() { return t('rules.unique'); }, get description() { return t('rules.uniqueHint'); } },
  { kind: 'number_range', get label() { return t('rules.condition.range'); }, get description() { return t('rules.rangeHint'); } },
  { kind: 'pattern', get label() { return t('rules.pattern'); }, get description() { return t('rules.patternHint'); } },
  { kind: 'select_choices', get label() { return t('rules.selectChoices'); }, get description() { return t('rules.selectChoicesHint'); } },
];

function newInputRule(kind: InputRule['kind']): InputRule {
  switch (kind) {
    case 'number_range': return { kind, min: null, max: null };
    case 'pattern': return { kind, pattern: '' };
    default: return { kind };
  }
}

export function InputValidationEditor({ value: storedValue, onChange, disabled, columnType, constraintColumn, showSchemaConstraints = true }: Props) {
  useI18n();
  const id = useId();
  const [nextKind, setNextKind] = useState<InputRule['kind']>('required');
  const [ruleDraft, setRuleDraft] = useState<{ index: number; rule: InputRule } | null>(null);
  const [behaviorDraft, setBehaviorDraft] = useState<InputValidationSettings | null>(null);
  const value: InputValidationSettings = storedValue ?? { enabled: true, mode: 'reject', message: '', hint: '', rules: [] };
  const change = (patch: Partial<InputValidationSettings>) => {
    if (value) onChange({ ...value, ...patch });
  };
  const updateRule = (index: number, rule: InputRule) => {
    if (value) change({ rules: value.rules.map((entry, i) => i === index ? rule : entry) });
  };
  const hasConstraints = constraintColumn.required || Boolean(constraintColumn.constraints && (constraintColumn.constraints.unique || constraintColumn.constraints.min_value != null || constraintColumn.constraints.max_value != null || constraintColumn.constraints.pattern));

  return <div>
    <div className="editor-section">
      <div className="rule-heading"><h3>{t('rules.listHeading')} <span className="rule-count">{formatNumber(value?.rules.length || 0)}</span></h3>{value.rules.length > 0 && <label className="rule-check" htmlFor={`${id}-enabled`}><input id={`${id}-enabled`} type="checkbox" checked={value.enabled !== false} disabled={disabled} onChange={e => change({ enabled: e.target.checked })} />{t('rules.enable')}</label>}</div>
      {value === null ? <div className="rule-empty">{t('rules.inputDisabled')}</div> : <div className="min-w-0 mt-3">
        <div className="space-y-3">
          {value.rules.map((rule, index) => {
            const definition = RULES.find(entry => entry.kind === rule.kind);
            const editable = rule.kind === 'number_range' || rule.kind === 'pattern';
            const summary = rule.kind === 'number_range'
              ? t('rules.inclusiveRange', { min: rule.min ?? '…', max: rule.max ?? '…' })
              : rule.kind === 'pattern' ? rule.pattern || t('rules.notEntered') : definition?.description;
            const contents = <><span className="rule-summary-label">{definition?.label || rule.kind}</span><span className="rule-summary-value" title={summary}>{summary}</span></>;
            return <div key={`${index}-${rule.kind}`}>
              <div className="input-rule-row">
                {editable ? <button type="button" className="rule-summary-button" aria-haspopup="dialog" onClick={() => setRuleDraft({ index, rule: { ...rule } })}>{contents}</button>
                  : <div className="rule-summary-button">{contents}</div>}
                <button type="button" disabled={disabled} className="rule-icon-button rule-delete" aria-label={t('rules.deleteNthInput', { index: index + 1 })} title={t('rules.delete')} onClick={() => change({ rules: value.rules.filter((_, i) => i !== index) })}><Trash2 className="w-4 h-4" /></button>
              </div>
              {rule.kind === 'select_choices' && columnType !== 'Select' && <p className="rule-note rule-note-warning">{t('rules.notSelectHint')}</p>}
            </div>;
          })}
          {value.rules.length === 0 && <p className="rule-empty">{t('rules.inputEmpty')}</p>}
        </div>
        <div className="rule-add-row mt-3"><label className="sr-only" htmlFor={`${id}-rule-kind`}>{t('rules.addInput')}</label><select id={`${id}-rule-kind`} disabled={disabled} className="editor-input" value={nextKind} onChange={e => setNextKind(e.target.value as InputRule['kind'])}>{RULES.map(rule => <option key={rule.kind} value={rule.kind}>{rule.label}</option>)}</select><button type="button" disabled={disabled} className="editor-action inline-flex gap-1 items-center justify-center" onClick={() => { const rule = newInputRule(nextKind); if (rule.kind === 'number_range' || rule.kind === 'pattern') setRuleDraft({ index: value.rules.length, rule }); else change({ rules: [...value.rules, rule] }); }}><Plus className="w-4 h-4" />{t('rules.add')}</button></div>
        <div className="rule-column-settings"><p className="rule-settings-label">{t('rules.columnSettings')}</p>
          <button type="button" className="rule-summary-button rule-settings-row" aria-haspopup="dialog" onClick={() => setBehaviorDraft({ ...value })}>
            <span className="rule-summary-label">{t('rules.inputBehavior')}</span>
            <span className="rule-summary-value">{t(value.mode === 'reject' ? 'rules.reject' : 'rules.warn')}{value.hint ? ` · ${t('rules.inputHelp')}` : ''}{value.message ? ` · ${t('rules.message')}` : ''}</span><span aria-hidden="true">›</span>
          </button>
        </div>
      </div>}
    </div>
    {ruleDraft && <RuleEditorDialog applyOnClose={ruleDraft.index < (value?.rules.length ?? 0)} title={t('rules.editInputRule')} onClose={() => setRuleDraft(null)} disabled={disabled || value === null} onApply={() => { if (!disabled && value) { if (ruleDraft.index === value.rules.length) change({ rules: [...value.rules, ruleDraft.rule] }); else updateRule(ruleDraft.index, ruleDraft.rule); } setRuleDraft(null); }}>
      <fieldset disabled={disabled}><h3 className="rule-dialog-rule-name">{RULES.find(rule => rule.kind === ruleDraft.rule.kind)?.label}</h3>
        {ruleDraft.rule.kind === 'number_range' && <div className="rule-field-grid">
          <div><label htmlFor={`${id}-min`}>{t('rules.minimumInclusive')}</label><input id={`${id}-min`} className="editor-input" inputMode="decimal" placeholder={t('rules.noMinimum')} value={ruleDraft.rule.min ?? ''} onChange={e => { if (ruleDraft.rule.kind === 'number_range') setRuleDraft({ ...ruleDraft, rule: { ...ruleDraft.rule, min: e.target.value === '' ? null : e.target.value } }); }} /></div>
          <div><label htmlFor={`${id}-max`}>{t('rules.maximumInclusive')}</label><input id={`${id}-max`} className="editor-input" inputMode="decimal" placeholder={t('rules.noMaximum')} value={ruleDraft.rule.max ?? ''} onChange={e => { if (ruleDraft.rule.kind === 'number_range') setRuleDraft({ ...ruleDraft, rule: { ...ruleDraft.rule, max: e.target.value === '' ? null : e.target.value } }); }} /></div>
        </div>}
        {ruleDraft.rule.kind === 'pattern' && <div><label htmlFor={`${id}-pattern`}>{t('rules.pattern')}</label><input id={`${id}-pattern`} className="editor-input font-mono text-xs" autoComplete="off" spellCheck={false} value={ruleDraft.rule.pattern} onChange={e => setRuleDraft({ ...ruleDraft, rule: { kind: 'pattern', pattern: e.target.value } })} /></div>}
      </fieldset>
    </RuleEditorDialog>}
    {behaviorDraft && <RuleEditorDialog applyOnClose title={t('rules.inputBehavior')} onClose={() => setBehaviorDraft(null)} disabled={disabled || value === null} onApply={() => { if (!disabled && value) change({ mode: behaviorDraft.mode, hint: behaviorDraft.hint, message: behaviorDraft.message }); setBehaviorDraft(null); }}>
      <fieldset disabled={disabled}>        <div className="editor-section mt-3"><label htmlFor={`${id}-hint`}>{t('rules.inputHelp')}</label><textarea id={`${id}-hint`} className="editor-input" rows={2} placeholder={t('rules.hintExample')} value={behaviorDraft.hint} onChange={e => setBehaviorDraft({ ...behaviorDraft, hint: e.target.value })} /></div>
        <div className="editor-section"><h3>{t('rules.onViolation')}</h3><div className="flex flex-wrap gap-x-5 gap-y-2"><label className="rule-check"><input type="radio" name={`${id}-mode`} value="reject" checked={behaviorDraft.mode === 'reject'} onChange={() => setBehaviorDraft({ ...behaviorDraft, mode: 'reject' })} />{t('rules.reject')}</label><label className="rule-check"><input type="radio" name={`${id}-mode`} value="warn" checked={behaviorDraft.mode === 'warn'} onChange={() => setBehaviorDraft({ ...behaviorDraft, mode: 'warn' })} />{t('rules.warn')}</label></div>{behaviorDraft.mode === 'warn' && <p className="editor-hint mb-3">{t('rules.warningHint')}</p>}<label htmlFor={`${id}-message`}>{t('rules.message')}</label><textarea id={`${id}-message`} className="editor-input" rows={2} placeholder={t('rules.messagePlaceholder')} value={behaviorDraft.message} onChange={e => setBehaviorDraft({ ...behaviorDraft, message: e.target.value })} /></div></fieldset>
    </RuleEditorDialog>}
    {showSchemaConstraints && hasConstraints && <SchemaConstraints column={constraintColumn} />}
  </div>;
}


/** Source-schema requirements are separate from editable Studio input rules. */
export function SchemaConstraints({ column }: { column: EditorColumn }) {
  useI18n();
  const c = column.constraints;
  const configured = column.required || c?.unique || c?.min_value != null || c?.max_value != null || Boolean(c?.pattern);
  return <section className="editor-section rule-constraints">
    <h3>{t('rules.constraintsSummary', { configured: configured ? 'yes' : 'no' })}</h3>
    {configured && <><p className="editor-hint">{t('rules.constraintsHint')}</p><dl className="rule-constraints-values">
      {column.required && <><dt>{t('rules.constraintsRequired')}</dt><dd>{t('rules.constraintsRequired')}</dd></>}
      {c?.unique && <><dt>{t('rules.duplicates')}</dt><dd>{t('rules.noDuplicates')}</dd></>}
      {c?.min_value != null && <><dt>{t('rules.minimum')}</dt><dd>{formatNumber(c.min_value)}</dd></>}
      {c?.max_value != null && <><dt>{t('rules.maximum')}</dt><dd>{formatNumber(c.max_value)}</dd></>}
      {c?.pattern && <><dt>{t('rules.constraintsPattern')}</dt><dd className="font-mono break-all">{c.pattern}</dd></>}
    </dl></>}
  </section>;
}
