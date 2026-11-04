import type { Column, ValueType } from '@/app/types/tableTypes';
import type { GridRow } from './DataGridView';

/** View state only. The authoritative records and their stored order never change. */
export interface FilterCondition {
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
    | 'greater_than' | 'greater_than_or_equal' | 'less_than' | 'less_than_or_equal'
    | 'between' | 'empty' | 'not_empty';
  value?: string;
  max?: string;
}
export interface ColumnFilter {
  columnUuid: string;
  dataType: ValueType;
  /** Undefined means all values; an empty selection intentionally matches no rows. */
  values?: string[];
  conditions?: FilterCondition[];
  join?: 'and' | 'or';
}
export interface SortLevel {
  columnUuid: string;
  dataType: ValueType;
  direction: 'asc' | 'desc';
}

type Scalar = string | number | bigint;
type SortKey = { rank: number; value: Scalar };
const integers = new Set<ValueType>(['U8', 'I8', 'U16', 'I16', 'U32', 'I32', 'U64', 'I64']);
const floats = new Set<ValueType>(['F32', 'F64']);
const sortable = new Set<ValueType>([...integers, ...floats, 'String', 'Boolean', 'Select', 'DateTime', 'Reference', 'TableRef']);
const textOperators = new Set<FilterCondition['operator']>(['contains', 'not_contains', 'starts_with', 'ends_with']);
const orderedOperators = new Set<FilterCondition['operator']>(['greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between']);
const operators = new Set<FilterCondition['operator']>(['equals', 'not_equals', 'empty', 'not_empty', ...textOperators, ...orderedOperators]);
const collator = new Intl.Collator(undefined, { usage: 'sort' });
const isOrdered = (type: ValueType) => integers.has(type) || floats.has(type) || type === 'DateTime';
const isText = (type: ValueType) => type === 'String' || type === 'Select' || type === 'Reference' || type === 'TableRef';
const textValue = (value: unknown): string => value == null ? '' : String(value);
const hasError = (row: GridRow, columnUuid: string): boolean => row.cellPresentations?.[columnUuid]?.formula_error != null;
const sameItems = <T,>(left: readonly T[], right: readonly T[]) => left.length === right.length && left.every((item, index) => item === right[index]);

export function canSortColumn(column: Column): boolean {
  return sortable.has(column.data_type);
}

/** Explicit ISO dates/local date-times use a timezone-independent wall-clock
 * order; RFC3339 offsets compare as instants. Preserve submillisecond precision.
 * DateTime permits arbitrary source strings, so never let Date.parse guess them. */
function dateValue(text: string): bigint | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/i.exec(text.trim());
  if (!match) return undefined;
  const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '', zone] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  let offset = 0;
  if (zone && zone.toUpperCase() !== 'Z') {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return undefined;
    offset = (hours * 60 + minutes) * (zone[0] === '-' ? -1 : 1);
  }
  return BigInt(date.getTime() - offset * 60_000) * 1_000_000n + BigInt(fraction.padEnd(9, '0'));
}

function scalarValue(value: string, type: ValueType): Scalar | undefined {
  if (integers.has(type)) {
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) return undefined;
    const integer = BigInt(text);
    return type.startsWith('U') && integer < 0n ? undefined : integer;
  }
  if (floats.has(type)) {
    const text = value.trim();
    if (/^[+-]?(?:inf|infinity)$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined;
    const number = Number(text);
    return Number.isNaN(number) ? undefined : number;
  }
  if (type === 'Boolean') return value === 'true' ? 1 : value === 'false' ? 0 : undefined;
  if (type === 'DateTime') return dateValue(value);
  return value;
}

function compareScalars(left: Scalar, right: Scalar): number {
  if (typeof left === 'string' && typeof right === 'string') return collator.compare(left, right);
  return left < right ? -1 : left > right ? 1 : 0;
}

function columnLabel(column: Column, value: string): string {
  return column.data_type === 'Select'
    ? column.select_config?.options.find(option => option.value === value)?.label ?? value : value;
}

function sortKey(row: GridRow, column: Column, labels?: ReadonlyMap<string, string>): SortKey {
  const text = textValue(row[column.uuid]);
  if (hasError(row, column.uuid)) return { rank: 3, value: '' };
  if (text === '') return { rank: 1, value: '' };
  const value = scalarValue(text, column.data_type);
  if (value === undefined) return { rank: 2, value: '' };
  return { rank: 0, value: column.data_type === 'Select' ? columnLabel(column, text)
    : column.data_type === 'Reference' || column.data_type === 'TableRef' ? labels?.get(text) ?? value : value };
}

function compareKeys(left: SortKey, right: SortKey, direction: 'asc' | 'desc'): number {
  // Missing, invalid and formula-error cells remain last in either direction.
  if (left.rank !== right.rank) return left.rank - right.rank;
  return (direction === 'desc' ? -1 : 1) * compareScalars(left.value, right.value);
}

export function validateCondition(condition: FilterCondition, type: ValueType): boolean {
  if (!operators.has(condition.operator)) return false;
  if (condition.operator === 'empty' || condition.operator === 'not_empty') return true;
  if (typeof condition.value !== 'string') return false;
  if (textOperators.has(condition.operator)) return isText(type);
  if (orderedOperators.has(condition.operator) && !isOrdered(type)) return false;
  if (scalarValue(condition.value, type) === undefined) return false;
  if (condition.operator === 'between') {
    if (typeof condition.max !== 'string') return false;
    const max = scalarValue(condition.max, type);
    return max !== undefined && compareScalars(scalarValue(condition.value, type)!, max) <= 0;
  }
  return true;
}

/** Discard stale UUID/type-bound state after schema changes. Retain absent value
 * candidates: a temporary data refresh must not silently broaden the selection. */
export function sanitizeViewState(columns: readonly Column[], filters: ColumnFilter[], sorts: SortLevel[]): { filters: ColumnFilter[]; sorts: SortLevel[] } {
  const byUuid = new Map(columns.map(column => [column.uuid, column]));
  const seenFilters = new Set<string>(), seenSorts = new Set<string>();
  const nextFilters: ColumnFilter[] = [];
  for (const filter of filters) {
    const column = byUuid.get(filter.columnUuid);
    if (!column || column.data_type !== filter.dataType || seenFilters.has(filter.columnUuid)) continue;
    seenFilters.add(filter.columnUuid);
    const values = filter.values === undefined ? undefined : [...new Set(filter.values.filter(value => typeof value === 'string'))];
    const conditions = filter.conditions?.filter(condition => validateCondition(condition, column.data_type)).slice(0, 2);
    if (values === undefined && !conditions?.length) continue;
    const join = filter.join === 'or' ? 'or' : filter.join === 'and' ? 'and' : undefined;
    const unchanged = (values === undefined || sameItems(values, filter.values!))
      && (conditions === undefined || sameItems(conditions, filter.conditions!)) && join === filter.join;
    nextFilters.push(unchanged ? filter : { ...filter, values, conditions, join });
  }
  const nextSorts = sorts.filter(sort => {
    const column = byUuid.get(sort.columnUuid);
    if (!column || column.data_type !== sort.dataType || !canSortColumn(column)
      || (sort.direction !== 'asc' && sort.direction !== 'desc') || seenSorts.has(sort.columnUuid)) return false;
    seenSorts.add(sort.columnUuid);
    return true;
  });
  return { filters: sameItems(filters, nextFilters) ? filters : nextFilters, sorts: sameItems(sorts, nextSorts) ? sorts : nextSorts };
}

function matchesCondition(row: GridRow, column: Column, condition: FilterCondition): boolean {
  const text = textValue(row[column.uuid]);
  // A failed formula is not an empty value, even when its error display is blank.
  if (hasError(row, column.uuid)) return false;
  if (condition.operator === 'empty') return text === '';
  if (condition.operator === 'not_empty') return text !== '';
  const expected = condition.value!;
  if (textOperators.has(condition.operator)) {
    const actual = columnLabel(column, text).toLocaleLowerCase(), query = expected.toLocaleLowerCase();
    switch (condition.operator) {
      case 'contains': return actual.includes(query);
      case 'not_contains': return !actual.includes(query);
      case 'starts_with': return actual.startsWith(query);
      case 'ends_with': return actual.endsWith(query);
    }
  }
  const actual = scalarValue(text, column.data_type), value = scalarValue(expected, column.data_type);
  if (actual === undefined || value === undefined) return false;
  if (typeof actual === 'string' && typeof value === 'string') {
    const equal = actual.toLocaleLowerCase() === value.toLocaleLowerCase();
    if (condition.operator === 'equals') return equal;
    if (condition.operator === 'not_equals') return !equal;
  }
  const comparison = compareScalars(actual, value);
  switch (condition.operator) {
    case 'equals': return comparison === 0;
    case 'not_equals': return comparison !== 0;
    case 'greater_than': return comparison > 0;
    case 'greater_than_or_equal': return comparison >= 0;
    case 'less_than': return comparison < 0;
    case 'less_than_or_equal': return comparison <= 0;
    case 'between': return comparison >= 0 && compareScalars(actual, scalarValue(condition.max!, column.data_type)!) <= 0;
    default: return false;
  }
}

/** Apply filters and stable multi-level sorting to an already-authoritative
 * display projection. No record, row, column or input-array mutation occurs. */
export function filterSortRows(rows: GridRow[], columns: readonly Column[], filters: ColumnFilter[], sorts: SortLevel[],
  labels?: ReadonlyMap<string, ReadonlyMap<string, string>>): GridRow[] {
  const state = sanitizeViewState(columns, filters, sorts);
  if (!state.filters.length && !state.sorts.length) return rows;
  const byUuid = new Map(columns.map(column => [column.uuid, column]));
  const predicates = state.filters.map(filter => {
    const column = byUuid.get(filter.columnUuid)!;
    const values = filter.values === undefined ? undefined : new Set(filter.values);
    return (row: GridRow) => {
      if (values && !values.has(textValue(row[column.uuid]))) return false;
      const conditions = filter.conditions;
      if (!conditions?.length) return true;
      return filter.join === 'or'
        ? conditions.some(condition => matchesCondition(row, column, condition))
        : conditions.every(condition => matchesCondition(row, column, condition));
    };
  });
  let result = predicates.length ? rows.filter(row => predicates.every(matches => matches(row))) : rows;
  if (result.length === rows.length) result = rows;
  if (!state.sorts.length || result.length < 2) return result;
  const levels = state.sorts.map(sort => ({ column: byUuid.get(sort.columnUuid)!, direction: sort.direction }));
  const decorated = result.map((row, index) => ({ row, index, keys: levels.map(level => sortKey(row, level.column, labels?.get(level.column.uuid))) }));
  decorated.sort((left, right) => {
    for (let index = 0; index < levels.length; index++) {
      const compared = compareKeys(left.keys[index], right.keys[index], levels[index].direction);
      if (compared !== 0) return compared;
    }
    return left.index - right.index;
  });
  return decorated.every((entry, index) => entry.row === result[index]) ? result : decorated.map(entry => entry.row);
}

/** Candidate identity always stays the canonical displayed value, including
 * references. The caller may resolve reference labels without changing values. */
export function collectFilterValues(rows: readonly GridRow[], column: Column): { value: string; label: string }[] {
  const candidates = new Map<string, { value: string; label: string; key: SortKey }>();
  for (const row of rows) {
    const value = textValue(row[column.uuid]), key = sortKey(row, column);
    const existing = candidates.get(value);
    if (!existing) candidates.set(value, { value, label: columnLabel(column, value), key });
    else if (key.rank < existing.key.rank) existing.key = key;
  }
  return [...candidates.values()].sort((left, right) => compareKeys(left.key, right.key, 'asc'))
    .map(({ value, label }) => ({ value, label }));
}
