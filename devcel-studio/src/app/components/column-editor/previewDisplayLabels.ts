import { localizeError, t } from '@/app/i18n';
import type { ColumnEditorPreview } from './types';

export function previewTableLabel(preview: ColumnEditorPreview | null, tableUuid: string | null): string {
  return tableUuid && preview?.locations?.[tableUuid]?.table_name || t('column.table');
}
export function previewRecordLabel(preview: ColumnEditorPreview | null, tableUuid: string | null, recordUuid: string | null, sampleIndex?: number): string {
  if (!recordUuid) return t('column.defaultValue');
  const label = tableUuid && preview?.locations?.[tableUuid]?.records[recordUuid];
  return label ? localizeError(label) : sampleIndex === undefined ? t('column.unknown') : t('rules.preview.sampleIndex', { index: sampleIndex + 1 });
}
