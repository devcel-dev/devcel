import { t } from '@/app/i18n';
import type { TableData, TableRecord } from '@/app/types/tableTypes';

/** Only known generated identity labels are suppressed. Deliberate user labels
 * and cell contents (including UUID-valued cells) are never transformed. */
export function isGeneratedRecordLabel(record: Pick<TableRecord, 'uuid' | 'label'>): boolean {
  return !record.label || record.label === record.uuid
    || record.label === `record_${record.uuid.replace(/-/g, '')}`;
}

/** A display projection, never a persisted name or a key used for navigation.
 * Prefer authored labels, then known human-readable title fields, then a stable
 * source row number. Call at render time so locale switches update the fallback. */
export function recordReferenceLabel(record: TableRecord, table: TableData, rowIndex = table.records.findIndex(row => row.uuid === record.uuid)): string {
  if (!isGeneratedRecordLabel(record)) return record.label;
  for (const name of ['name', 'title', 'display_name', 'key', 'code', 'pluginId']) {
    const column = table.schema.columns.find(column => column.data_name === name && column.data_type === 'String');
    if (!column) continue;
    const value = column.interface_origin ? record.interface_values[column.uuid] : record.values[name];
    if (value?.trim() && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
  }
  return t('grid.defaultRowLabel', { number: Math.max(0, rowIndex) + 1 });
}

/** Row headers must not invent labels from values or row numbers. */
export function recordDisplayLabel(record: TableRecord, _table?: TableData, _rowIndex?: number): string { return record.label ?? ''; }
