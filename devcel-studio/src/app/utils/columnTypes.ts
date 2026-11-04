import { t } from '@/app/i18n';
// Shared type definitions for columns and interface fields.
// value must match the core's ValueType Debug names from get_table_data / get_interface_details.
// Single source of truth for consistent options and labels in table column and interface field editors.

export interface ColumnTypeOption {
  value: string;
  label: string;
}

// Canonical types used by the shared ColumnEditor.
export const COLUMN_TYPE_OPTIONS: ColumnTypeOption[] = [
  { value: 'I8', get label() { return t('column.type.i8'); } },
  { value: 'U8', get label() { return t('column.type.u8'); } },
  { value: 'I16', get label() { return t('column.type.i16'); } },
  { value: 'U16', get label() { return t('column.type.u16'); } },
  { value: 'I32', get label() { return t('column.type.i32'); } },
  { value: 'U32', get label() { return t('column.type.u32'); } },
  { value: 'I64', get label() { return t('column.type.i64'); } },
  { value: 'U64', get label() { return t('column.type.u64'); } },
  { value: 'F32', get label() { return t('column.type.f32'); } },
  { value: 'F64', get label() { return t('column.type.f64'); } },
  { value: 'String', get label() { return t('column.type.text'); } },
  { value: 'Boolean', get label() { return t('column.type.boolean'); } },
  { value: 'Reference', get label() { return t('column.type.reference'); } },
  { value: 'TableRef', get label() { return t('column.type.tableRef'); } },
  { value: 'Curve', get label() { return t('column.type.curve'); } },
  { value: 'Color32', get label() { return t('column.type.color32'); } },
  { value: 'ColorFloat', get label() { return t('column.type.colorFloat'); } },
];

// Display labels, including types not offered as options
const TYPE_LABEL_MAP: Record<string, string> = {
  get Select() { return t('column.type.select'); },
  get DateTime() { return t('column.type.dateTime'); },
};

export function columnTypeLabel(value: string | undefined | null): string {
  if (!value) return '';
  return COLUMN_TYPE_OPTIONS.find(option => option.value === value)?.label ?? TYPE_LABEL_MAP[value] ?? value;
}

// Picker display metadata. Ranges are guidance only; the core validates and converts values.
export type ColumnTypeCategoryId = 'basic' | 'reference' | 'special';
export type ColumnTypeFamilyId = 'string' | 'integer' | 'decimal' | 'boolean' | 'reference' | 'table-reference' | 'select' | 'color' | 'curve';

export interface ColumnTypeFamily {
  id: ColumnTypeFamilyId;
  category: ColumnTypeCategoryId;
  label: string;
  description: string;
  values: readonly string[];
  defaultValue: string;
  keywords: string;
  /** Do not suggest for new columns; show only when editing an existing column of this type. */
  existingOnly?: boolean;
}

export const COLUMN_TYPE_CATEGORIES: ReadonlyArray<{ id: ColumnTypeCategoryId; label: string }> = [
  { id: 'basic', get label() { return t('column.basic'); } },
  { id: 'reference', get label() { return t('column.type.categoryReference'); } },
  { id: 'special', get label() { return t('column.type.categorySpecial'); } },
];

export const COLUMN_TYPE_FAMILIES: readonly ColumnTypeFamily[] = [
  {
    id: 'string', category: 'basic', get label() { return t('column.type.string'); },
    get description() { return t('column.type.stringHint'); },
    values: ['String'], defaultValue: 'String', keywords: 'text テキスト 名前 説明 文章',
  },
  {
    id: 'integer', category: 'basic', get label() { return t('column.type.integer'); },
    get description() { return t('column.type.integerHint'); },
    values: ['I8', 'U8', 'I16', 'U16', 'I32', 'U32', 'I64', 'U64'], defaultValue: 'I32',
    keywords: 'int integer uint 数値 個数 HP レベル ビット 幅 符号付き 符号なし',
  },
  {
    id: 'decimal', category: 'basic', get label() { return t('column.type.decimal'); },
    get description() { return t('column.type.decimalHint'); },
    values: ['F32', 'F64'], defaultValue: 'F32', keywords: 'float double decimal 実数 浮動小数点 精度 座標 倍率',
  },
  {
    id: 'boolean', category: 'basic', get label() { return t('column.type.booleanFamily'); },
    get description() { return t('column.type.booleanHint'); },
    values: ['Boolean'], defaultValue: 'Boolean', keywords: 'bool true false はい いいえ オン オフ フラグ',
  },
  {
    id: 'reference', category: 'reference', get label() { return t('column.type.recordReference'); },
    get description() { return t('column.type.recordReferenceHint'); },
    values: ['Reference'], defaultValue: 'Reference', keywords: 'record link リンク 外部キー',
  },
  {
    id: 'table-reference', category: 'reference', get label() { return t('column.type.tableRef'); },
    get description() { return t('column.type.tableReferenceHint'); },
    values: ['TableRef'], defaultValue: 'TableRef', keywords: 'table interface テーブル インターフェース',
  },
  {
    id: 'select', category: 'reference', get label() { return t('column.type.select'); },
    get description() { return t('column.type.selectHint'); },
    values: ['Select'], defaultValue: 'Select', keywords: 'enum option 選択肢 列挙', existingOnly: true,
  },
  {
    id: 'curve', category: 'special', get label() { return t('column.type.curve'); },
    get description() { return t('column.type.curveHint'); },
    values: ['Curve'], defaultValue: 'Curve', keywords: 'curve 曲線 成長 補間',
  },
  {
    id: 'color', category: 'special', get label() { return t('column.type.colorFamily'); },
    get description() { return t('column.type.colorHint'); },
    values: ['Color32', 'ColorFloat'], defaultValue: 'Color32', keywords: 'color rgba hdr 色 カラー アルファ 精度',
  },
];

export interface ColumnTypeDetails {
  rangeLabel: string;
  range: string;
  example: string;
  note?: string;
}

const COLUMN_TYPE_DETAILS: Record<string, ColumnTypeDetails> = {
  Color32: { get rangeLabel() { return t('column.type.valueFormat'); }, get range() { return t('column.type.color32Range'); }, get example() { return t('column.type.color32Example'); } },
  ColorFloat: { get rangeLabel() { return t('column.type.valueFormat'); }, get range() { return t('column.type.colorFloatRange'); }, get example() { return t('column.type.colorFloatExample'); } },
  I8: { get rangeLabel() { return t('column.type.integerRange'); }, get range() { return t("column.type.details.i8.range"); }, get example() { return t("column.type.details.i8.example"); } },
  U8: { get rangeLabel() { return t('column.type.integerRange'); }, get range() { return t("column.type.details.u8.range"); }, get example() { return t("column.type.details.u8.example"); } },
  I16: { get rangeLabel() { return t('column.type.integerRange'); }, get range() { return t("column.type.details.i16.range"); }, get example() { return t("column.type.details.i16.example"); } },
  U16: { get rangeLabel() { return t('column.type.integerRange'); }, get range() { return t("column.type.details.u16.range"); }, get example() { return t("column.type.details.u16.example"); } },
  I32: { get rangeLabel() { return t('column.type.integerRange'); }, get range() { return t("column.type.details.i32.range"); }, get example() { return t("column.type.details.i32.example"); } },
  U32: { get rangeLabel() { return t('column.type.integerRange'); }, get range() { return t("column.type.details.u32.range"); }, get example() { return t("column.type.details.u32.example"); } },
  I64: {
    get rangeLabel() { return t('column.type.integerRange'); }, get range() { return t("column.type.details.i64.range"); },
    get example() { return t("column.type.details.i64.example"); },
  },
  U64: {
    get rangeLabel() { return t('column.type.integerRange'); }, get range() { return t("column.type.details.u64.range"); },
    get example() { return t("column.type.details.u64.example"); },
  },
  F32: {
    get rangeLabel() { return t('column.type.finiteRange'); }, get range() { return t("column.type.details.f32.range"); },
    get example() { return t("column.type.details.f32.example"); }, get note() { return t('column.type.singleNote'); },
  },
  F64: {
    get rangeLabel() { return t('column.type.finiteRange'); }, get range() { return t("column.type.details.f64.range"); },
    get example() { return t("column.type.details.f64.example"); }, get note() { return t('column.type.doubleNote'); },
  },
  String: { get rangeLabel() { return t('column.type.valueFormat'); }, get range() { return t('column.type.text'); }, get example() { return t('column.type.stringExample'); } },
  Boolean: { get rangeLabel() { return t('column.type.valueChoices'); }, get range() { return t("column.type.details.boolean.range"); }, get example() { return t('column.type.booleanExample'); } },
  Reference: {
    get rangeLabel() { return t('column.type.referenceTarget'); }, get range() { return t('column.type.referenceRange'); }, get example() { return t('column.type.referenceExample'); },
    get note() { return t('column.type.referenceNote'); },
  },
  TableRef: {
    get rangeLabel() { return t('column.type.referenceTarget'); }, get range() { return t('column.type.tableReferenceRange'); }, get example() { return t('column.type.tableReferenceExample'); },
    get note() { return t('column.type.tableReferenceNote'); },
  },
  Select: {
    get rangeLabel() { return t('column.type.valueChoices'); }, get range() { return t('column.type.selectRange'); }, get example() { return t('column.type.selectExample'); },
    get note() { return t('column.type.selectNote'); },
  },
  Curve: {
    get rangeLabel() { return t('column.type.valueFormat'); }, get range() { return t('column.type.curveRange'); }, get example() { return t('column.type.curveExample'); },
    get note() { return t('column.type.curveNote'); },
  },
};

export function columnTypeFamily(value: string): ColumnTypeFamily | undefined {
  return COLUMN_TYPE_FAMILIES.find((family) => family.values.includes(value));
}

export function columnTypeDetails(value: string): ColumnTypeDetails | undefined {
  return COLUMN_TYPE_DETAILS[value];
}
