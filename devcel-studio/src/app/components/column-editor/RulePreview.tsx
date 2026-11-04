import { rangeBarStyle } from '@/app/utils/rangeBarStyle';
import { getLocaleDirection } from '@/app/i18n';
import { previewRecordLabel, previewTableLabel } from './previewDisplayLabels';
import { settingsDisplayLabel } from '@/app/settings/displayLabels';
import { t, useI18n, localizeError } from '@/app/i18n';
import { AlertTriangle, Eye } from 'lucide-react';
import { useId } from 'react';
import type { ColumnEditorPreview } from './types';

interface Props {
  preview: ColumnEditorPreview | null;
  kind: 'rules' | 'display';
  columnName: string;
}

export function RulePreview({ preview, kind, columnName }: Props) {
  useI18n();
  const id = useId();
  if (!preview) return null;
  const transitionIssues = preview?.input_reports?.flatMap(entry => entry.report.issues) || [];
  return <section className="rule-preview" aria-label={kind === 'rules' ? t('rules.preview.inputResults') : t('rules.preview.formatResults')}>
    <div className="rule-heading"><h3><Eye className="w-4 h-4" />{kind === 'rules' ? t('rules.preview.input') : t('rules.preview.display')}</h3></div>
    <div aria-live="polite">
      <p className="text-xs mt-3 leading-5">{t('rules.preview.counts', { rows: preview.population_count ?? 0, issues: preview.input_issue_count ?? 0, hasIssues: preview.input_issue_count ? 'yes' : 'no', rejects: preview.reject_issue_count ?? 0, warnings: preview.warning_issue_count ?? 0 })}</p>
      {kind === 'display' && <p className="editor-hint">{t('rules.preview.rankingCount', { count: preview.ranking_population_count ?? 0 })}</p>}
      {transitionIssues.length > 0 && <div className="rule-note rule-note-warning"><strong>{t('rules.preview.newViolationCount', { count: transitionIssues.length })}</strong><p className="mt-1">{t('rules.preview.transitionHint')}</p><ul className="list-disc pl-4 mt-2 space-y-1">{transitionIssues.slice(0, 5).map((issue, index) => <li key={index} className="break-all">{t('column.issueDetail', { column: settingsDisplayLabel(issue.column_uuid, issue.column_name), row: previewRecordLabel(preview, issue.table_uuid, issue.record_uuid, index), error: localizeError(issue) })}</li>)}</ul></div>}
      {Boolean(preview.input_issue_count) && <p className="editor-hint">{t('rules.preview.existingHint')}</p>}
      {(preview.definition_issues || []).length > 0 && <div className="rule-note rule-note-warning"><strong className="flex items-center gap-1"><AlertTriangle className="w-4 h-4" />{t('rules.preview.compatibility')}</strong><ul className="list-disc pl-4 mt-2 space-y-1">{preview.definition_issues.map((issue, index) => <li key={index} className="break-words">{localizeError(issue)}</li>)}</ul></div>}
      {(preview.input_issues || []).length > 0 && <details className="mt-3" open={kind === 'rules'}><summary className="text-xs font-semibold cursor-pointer">{t('rules.preview.locations', { count: preview.input_issues.length })}</summary><ul className="rule-issue-list mt-2">{preview.input_issues.map((issue, index) => <li key={`${issue.table_uuid}-${issue.record_uuid}-${issue.rule_key}-${index}`}><div className="flex flex-wrap gap-2 text-xs"><strong>{settingsDisplayLabel(issue.column_uuid, issue.column_name) || columnName}</strong><span className={issue.mode === 'reject' ? 'text-red-700' : 'text-amber-700'}>{issue.mode === 'reject' ? t('rules.preview.rejectRule') : t('rules.preview.warnRule')}</span></div><p className="text-xs mt-1 break-words">{localizeError(issue)}</p><p className="text-xs mt-1 break-all text-muted-foreground">{t('rules.preview.value', { raw: issue.raw_value || t('column.empty'), effective: issue.effective_value || t('column.empty'), changed: issue.raw_value !== issue.effective_value ? 'yes' : 'no' })}</p><p className="text-[10px] text-muted-foreground mt-1 break-all">{t('rules.preview.location', { location: previewRecordLabel(preview, issue.table_uuid, issue.record_uuid, index), table: previewTableLabel(preview, issue.table_uuid) })}</p>{issue.peers?.length > 0 && <p className="text-[10px] text-muted-foreground mt-1 break-all">{t('rules.preview.peers', { rows: issue.peers.map(peer => previewRecordLabel(preview, issue.table_uuid, peer)).join(', ') })}</p>}</li>)}</ul>{preview.input_issue_count > preview.input_issues.length && <p className="editor-hint">{t('rules.preview.showingFirst', { total: preview.input_issue_count, shown: preview.input_issues.length })}</p>}</details>}
      {(preview.presentation_samples || []).length > 0 && <div className="mt-4">
        <p id={`${id}-samples-heading`} className="text-left text-xs text-muted-foreground mb-2">{t('rules.preview.samples', { count: preview.presentation_samples.length })}</p>
        <ul className="preview-sample-list rule-preview-samples" role="list" aria-labelledby={`${id}-samples-heading`}>
          {preview.presentation_samples.map((sample, index) => {
            const cell = sample.presentation;
            return <li key={`${sample.table_uuid}-${sample.record_uuid}-${index}`} aria-labelledby={`${id}-sample-source-${index}`}>
              <dl className="preview-sample-values rule-preview-values">
                <div><dt>{t('rules.preview.row')}</dt><dd id={`${id}-sample-source-${index}`} title={t('rules.preview.sampleLocation', { table: previewTableLabel(preview, sample.table_uuid), row: previewRecordLabel(preview, sample.table_uuid, sample.record_uuid, index) })} className="text-[10px] text-muted-foreground">{previewRecordLabel(preview, sample.table_uuid, sample.record_uuid, index)}</dd></div>
                <div><dt>{columnName || t('rules.preview.cellDisplay')}</dt><dd style={{ backgroundColor: cell.style.background_color || undefined, color: cell.style.text_color || undefined, fontWeight: cell.style.bold ? 700 : undefined, ...rangeBarStyle(cell.range_bar, getLocaleDirection(), cell.style.text_color) }}><span>{cell.display_value || t('column.empty')}</span>{cell.raw_value !== cell.display_value && <span className="block text-[10px] mt-1 font-normal">{t('rules.preview.original', { value: cell.raw_value || t('column.empty') })}</span>}</dd></div>
                <div><dt>{t('rules.preview.results')}</dt><dd className="text-[11px]">{cell.formula_error ? <span className="text-red-700">{localizeError(cell.formula_error)}</span> : cell.issues.length ? <ul className="space-y-1">{cell.issues.map((issue, i) => <li key={`${issue.rule_key}-${i}`} className={issue.mode === 'reject' ? 'text-red-700' : 'text-amber-700'}>{localizeError(issue)}</li>)}</ul> : <span className="text-muted-foreground">{t('rules.preview.noIssues')}</span>}{cell.hint && <span className="block text-muted-foreground mt-1">{t('rules.preview.hintValue', { hint: cell.hint })}</span>}</dd></div>
              </dl>
            </li>;
          })}
        </ul>
      </div>}
      {Boolean(preview.population_count) && !preview.presentation_samples?.length && <p className="editor-hint">{t('rules.preview.noApplicableSamples')}</p>}
      {!preview.population_count && <p className="editor-hint">{t('rules.preview.noRows')}</p>}
    </div>
  </section>;
}
