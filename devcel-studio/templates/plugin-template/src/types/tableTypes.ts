import type { SavedColorSwatch } from './colorTypes';
import type { InputValidationSettings, ConditionalFormatting } from './tableRules';
/** Current JSON DTOs serialized by devcel-core; omitted configs are opt-in features. */
export interface ColumnStyle {
  color: string;
  font_size: number;
  width: number;
}

export interface ColumnConstraints {
  unique?: boolean;
  min_value?: number;
  max_value?: number;
  pattern?: string;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectConfig {
  options: SelectOption[];
}

export interface Column {
  read_only: boolean;
  /** Minimum content version for this column. */
  min_version: number;
  uuid: string;
  display_name: string;
  data_name: string;
  data_type: ValueType;
  tooltip: string;
  tags: string[];
  default_value: string;
  /** Authoring-only named RGBA candidates; an omitted array is empty. */
  color_swatches?: SavedColorSwatch[];
  style: ColumnStyle;
  memo_text: string;
  /** Unlike the opt-in configs below, None is serialized as an explicit null. */
  reference_config: ReferenceConfig | null;
  /** TableRef settings: Interface required of the referenced table */
  table_ref_config?: TableRefConfig;
  /** Curve settings: Fixed y values for the start and end points */
  curve_config?: CurveConfig;
  select_config?: SelectConfig;
  /** UUID of the interface this column originates from */
  interface_origin?: string;
  /** Fallback display name when the interface is deleted */
  interface_origin_name_fallback?: string;
  required?: boolean;
  constraints?: ColumnConstraints;
  input_validation?: InputValidationSettings | null;
  conditional_formatting?: ConditionalFormatting | null;
  conditional_formatting_override?: ConditionalFormatting | null;
}

export interface TableRecord {
  uuid: string;
  parent_uuid: string;
  label: string;
  min_version: number;
  tags: string[];
  /** Regular column values (column name -> value) */
  values: Record<string, string>;
  /** Interface-derived column values (column UUID -> value) */
  interface_values: Record<string, string>;
  memo_texts: Record<string, string>;
}

export interface TableEditPermissions {
  add_columns: boolean;
  delete_columns: boolean;
  add_rows: boolean;
  delete_rows: boolean;
  edit_cells: boolean;
}

export interface TableMetadata {
  initial_transposed: boolean;
  edit_permissions: TableEditPermissions;
  parent_uuid: string;
  data_name: string;
  interface_order: string[];
}

export interface InterfaceImplementation {
  interface_uuid: string;
  synced_version_id: string;
  last_sync_date: string;
  /** null denotes a current, not-yet-computed fingerprint, e.g. after duplication. */
  effective_fingerprint: string | null;
}

export interface TableSchema {
  columns: Column[];
}

export interface TableData {
  uuid: string;
  display_name: string;
  description: string;
  metadata: TableMetadata;
  interface_implementations: Record<string, InterfaceImplementation>;
  schema: TableSchema;
  records: TableRecord[];
}

/**
 * Read a stored raw input using Rust Record::get_cell_value keys.
 * Resolve parents and defaults with resolveEffectiveCellInput.
 */
export function getEffectiveCellValue(record: TableRecord, column: Column): string {
  if (column.interface_origin) {
    return record.interface_values?.[column.uuid] ?? '';
  }
  return record.values[column.data_name] ?? '';
}

export function hasLocalCellValue(record: TableRecord, column: Column): boolean {
  const map = column.interface_origin ? record.interface_values : record.values;
  const key = column.interface_origin ? column.uuid : column.data_name;
  return Object.prototype.hasOwnProperty.call(map ?? {}, key) && map[key] !== '';
}
/** Create once per immutable projection/export. Never retain across table mutations. */
export function createEffectiveCellInputResolver(table: TableData): (record: TableRecord, column: Column) => string {
  const byUuid = new Map(table.records.map(record => [record.uuid, record]));
  const columns = new Map<string, Map<string, string>>();
  return (record, column) => {
    let resolved = columns.get(column.uuid);
    if (!resolved) { resolved = new Map(); columns.set(column.uuid, resolved); }
    const known = resolved.get(record.uuid);
    if (known !== undefined) return known;
    const path: string[] = [];
    const visited = new Set<string>();
    let current = record;
    let value = '';
    while (true) {
      const cached = resolved.get(current.uuid);
      if (cached !== undefined) { value = cached; break; }
      if (visited.has(current.uuid)) break;
      visited.add(current.uuid); path.push(current.uuid);
      if (hasLocalCellValue(current, column)) { value = getEffectiveCellValue(current, column); break; }
      if (!current.parent_uuid) { value = column.default_value; break; }
      const parent = byUuid.get(current.parent_uuid);
      if (!parent) break;
      current = parent;
    }
    for (const uuid of path) resolved.set(uuid, value);
    return value;
  };
}
/** Single-cell convenience; bulk callers must share a scoped resolver. */
export function resolveEffectiveCellInput(table: TableData, record: TableRecord, column: Column): string {
  return createEffectiveCellInputResolver(table)(record, column);
}

/**
 * Reflect a column value locally in a record for optimistic display updates
 * For persistence, the backend's set_record_value routes values to the correct map
 */
export function setEffectiveCellValue(record: TableRecord, column: Column, value: string): void {
  if (value === '') {
    if (column.interface_origin) delete record.interface_values?.[column.uuid];
    else delete record.values[column.data_name];
    return;
  }
  if (column.interface_origin) {
    if (!record.interface_values) {
      record.interface_values = {};
    }
    record.interface_values[column.uuid] = value;
  } else {
    record.values[column.data_name] = value;
  }
}

// Reference column configuration
export interface ReferenceConfig {
  target_table_uuid: string;
  display_column_uuid: string | null;
}

// TableRef settings: Interface required of the referenced table
export interface TableRefConfig {
  interface_uuid: string;
}

// Curve settings: Fixed y values for the start (x=0) and end (x=1)
export interface CurveConfig {
  start_value: number;
  end_value: number;
}

// Reference option for dropdown
export interface ReferenceOption {
  uuid: string;
  display_value: string;
}

// Reference integrity check result
export interface ReferenceIntegrityCheck {
  record_uuid: string;
  referencing_records: ReferencingRecord[];
  can_delete: boolean;
  delete_impact: DeleteImpact;
}

export interface ReferencingRecord {
  table_uuid: string;
  table_name: string;
  record_uuid: string;
  record_display_value: string;
  column_uuid: string;
  column_name: string;
  on_delete_action: 'Restrict';
}

export interface DeleteImpact {
  affected_record_count: number;
  restrict_count: number;
}

// Value types available in Devcel
// Must match the canonical serialization names in devcel-core.
// Use the names defined here as type identifiers.
export type ValueType =
  | 'None'
  | 'String'
  | 'U8' | 'I8' | 'U16' | 'I16' | 'U32' | 'I32' | 'U64' | 'I64'
  | 'F32' | 'F64'
  | 'Boolean'
  | 'Color32'
  | 'ColorFloat'
  | 'Select'
  | 'DateTime'
  | 'Curve'
  | 'Reference'
  | 'TableRef';

/** Exclude self and descendants in one iterative pass, without following each ancestor chain. */
export function eligibleParentRecords(records: readonly TableRecord[], recordUuid: string): TableRecord[] {
  const children = new Map<string, string[]>();
  for (const row of records) {
    const parentUuid = row.parent_uuid;
    const siblings = children.get(parentUuid);
    if (siblings) siblings.push(row.uuid); else children.set(parentUuid, [row.uuid]);
  }
  const excluded = new Set<string>();
  const pending = [recordUuid];
  while (pending.length) {
    const uuid = pending.pop()!;
    if (excluded.has(uuid)) continue;
    excluded.add(uuid);
    for (const child of children.get(uuid) ?? []) pending.push(child);
  }
  return records.filter(row => !excluded.has(row.uuid));
}

/** Sparse core wire fields are expanded once at the receiving boundary. */
type ColumnDefaults = Pick<Column, 'min_version' | 'display_name' | 'tooltip' | 'tags' | 'memo_text'>;
export type ColumnWire = Omit<Column, keyof ColumnDefaults> & Partial<ColumnDefaults>;
export type RecordWire = Omit<TableRecord, 'parent_uuid' | 'label' | 'min_version' | 'tags' | 'interface_values' | 'memo_texts'> & Partial<TableRecord>;
export type TableDataWire = Omit<TableData, 'metadata' | 'schema' | 'records'> & {
  metadata: Omit<TableMetadata, 'parent_uuid'> & { parent_uuid?: string };
  schema: { columns: ColumnWire[] }; records: RecordWire[];
};
export function normalizeColumn<T extends Partial<ColumnDefaults>>(column: T): T & ColumnDefaults {
  if (column.min_version !== undefined && column.display_name !== undefined && column.tooltip !== undefined
    && column.tags !== undefined && column.memo_text !== undefined) return column as T & ColumnDefaults;
  return { ...column, min_version: column.min_version ?? 0, display_name: column.display_name ?? '',
    tooltip: column.tooltip ?? '', tags: column.tags ?? [], memo_text: column.memo_text ?? '' };
}
export function normalizeRecord(record: RecordWire): TableRecord {
  if (record.parent_uuid !== undefined && record.label !== undefined && record.min_version !== undefined
    && record.tags !== undefined && record.interface_values !== undefined && record.memo_texts !== undefined) return record as TableRecord;
  return { ...record, parent_uuid: record.parent_uuid ?? '', label: record.label ?? '', min_version: record.min_version ?? 0,
    tags: record.tags ?? [], interface_values: record.interface_values ?? {}, memo_texts: record.memo_texts ?? {} };
}
export function normalizeTableData(table: TableDataWire): TableData {
  const columns = table.schema.columns.map(normalizeColumn);
  const records = table.records.map(normalizeRecord);
  const metadata = table.metadata.parent_uuid === undefined ? { ...table.metadata, parent_uuid: '' } : table.metadata as TableMetadata;
  if (metadata === table.metadata && columns.every((c, i) => c === table.schema.columns[i]) && records.every((r, i) => r === table.records[i])) return table as TableData;
  return { ...table, metadata, schema: { ...table.schema, columns }, records };
}
