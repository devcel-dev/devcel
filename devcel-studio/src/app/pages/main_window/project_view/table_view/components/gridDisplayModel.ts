import type { Column, TableData } from '@/app/types/tableTypes';
import { createEffectiveCellInputResolver } from '@/app/types/tableTypes';
import type { TablePresentation } from '@/app/types/tableRules';
import type { GridRow } from './DataGridView';

function defineDisplayField(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function copyDisplayPrefix(before: Record<string, unknown>, after: Record<string, unknown>, keys: string[], length: number) {
  // Preserve sparse array holes: Array.from would turn them into own fields.
  const array: unknown[] = [];
  if (Array.isArray(after)) array.length = after.length;
  const result: Record<string, unknown> = Array.isArray(after)
    ? array as unknown as Record<string, unknown> : {};
  for (let index = 0; index < length; index++) defineDisplayField(result, keys[index], before[keys[index]]);
  return result;
}

/** Complete JSON DTO comparison, including fields unknown to this view. This is
 * display-only structural sharing; it never replaces the authoritative basis or
 * a revision/session guard and never infers equality from the revision. */
export function shareDisplayValue<T>(previous: T | undefined, next: T): T {
  if (Object.is(previous, next)) return previous as T;
  if (previous === null || next === null || typeof previous !== 'object' || typeof next !== 'object'
    || Array.isArray(previous) !== Array.isArray(next)) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let shared: Record<string, unknown> | undefined;
  // Equal snapshots allocate no replacement DTO objects/arrays. When a later
  // field differs, preceding equal fields are already represented by `before`.
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const value = shareDisplayValue(before[key], after[key]);
    if (shared === undefined && (!Object.prototype.hasOwnProperty.call(before, key)
      || !Object.is(value, before[key]))) shared = copyDisplayPrefix(before, after, keys, index);
    if (shared !== undefined) defineDisplayField(shared, key, value);
  }
  // Deletion (including a shorter sparse array) can change shape without any
  // surviving field changing. Compare own keys and length as separate contracts.
  if (shared === undefined && (keys.length !== Object.keys(before).length
    || Array.isArray(previous) && Array.isArray(next) && previous.length !== next.length)) {
    shared = copyDisplayPrefix(before, after, keys, keys.length);
  }
  return shared === undefined ? previous : shared as T;
}

export interface GridDisplayModel {
  readonly session: string;
  readonly tableUuid: string;
  readonly columns: Column[];
  readonly rows: GridRow[];
}

export function createGridDisplayModel(previous: GridDisplayModel | undefined,
  table: TableData, presentation: TablePresentation | null, session: string): GridDisplayModel {
  if (previous?.session !== session || previous.tableUuid !== table.uuid) previous = undefined;
  const oldColumns = new Map(previous?.columns.map(column => [column.uuid, column]));
  const nextColumns = table.schema.columns.map(column => shareDisplayValue(oldColumns.get(column.uuid), column));
  const columns = previous && nextColumns.length === previous.columns.length
    && nextColumns.every((column, index) => column === previous!.columns[index]) ? previous.columns : nextColumns;
  const resolveInput = createEffectiveCellInputResolver(table);
  const oldRows = new Map(previous?.rows.map(row => [row.rowId, row]));
  const rows = table.records.map((record, rowIndex) => {
    const old = oldRows.get(record.uuid);
    const tableRecord = shareDisplayValue(old?.tableRecord, record);
    const cellPresentations = shareDisplayValue(old?.cellPresentations, presentation?.cells[record.uuid]);
    // Sparse presentations omit plain literals. An unchanged descendant record
    // can still have new effective input after an ancestor edit or reparent.
    // Check only fallback fields with this rebuild's shared, memoized resolver.
    if (old && old.rowIndex === rowIndex && old.tableRecord === tableRecord
      && old.columnDefs === columns && old.cellPresentations === cellPresentations
      && (!record.parent_uuid || columns.every(column => cellPresentations?.[column.uuid]?.display_value != null
        || old[column.uuid] === resolveInput(record, column)))) return old;
    const row: GridRow = { rowId: record.uuid, rowLabel: record.label || '', rowIndex,
      tableRecord, columnDefs: columns, cellPresentations };
    for (const column of columns) {
      row[column.uuid] = cellPresentations?.[column.uuid]?.display_value
        ?? resolveInput(record, column);
    }
    return row;
  });
  const sharedRows = previous && rows.length === previous.rows.length
    && rows.every((row, index) => row === previous!.rows[index]) ? previous.rows : rows;
  return { session, tableUuid: table.uuid, columns, rows: sharedRows };
}
