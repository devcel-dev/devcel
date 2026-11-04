export type Diagnostic = { kind: 'code'; code: string; params: Record<string, unknown> } | { kind: 'text'; text: string };
import type { Column, TableData, TableDataWire } from './tableTypes';

/** DTOs mirror devcel_core::cell_rules. Values and rule evaluation stay in Rust. */
export type ValidationMode = 'reject' | 'warn';
export type InputRule =
  | { kind: 'required' | 'unique' | 'select_choices' }
  | { kind: 'number_range'; min: string | null; max: string | null }
  | { kind: 'pattern'; pattern: string };
export interface InputValidationSettings { enabled?: boolean; mode: ValidationMode; message: string; hint: string; rules: InputRule[] }
export interface CellStyle { background_color?: string; text_color?: string; bold?: boolean }
export type FormatCondition =
  | { kind: 'all' | 'empty' | 'not_empty' }
  | { kind: 'equals' | 'not_equals' | 'greater_than' | 'greater_than_or_equal' | 'less_than' | 'less_than_or_equal' | 'contains' | 'not_contains'; value: string }
  | { kind: 'between'; min: string; max: string; low_color?: string; high_color?: string; out_of_range_color?: string }
  | { kind: 'top' | 'bottom'; count: number; include_ties: boolean }
  | { kind: 'color_scale'; low_color: string; high_color: string };
export interface FormattingRule { id: string; enabled: boolean; condition: FormatCondition; style: CellStyle; stop_if_true: boolean }
export interface ConditionalFormatting { rules: FormattingRule[] }
export interface ValidationIssue {
  diagnostic: Diagnostic;
  table_uuid: string; column_uuid: string; column_name: string; record_uuid: string | null;
  kind: string; mode: ValidationMode; raw_value: string; effective_value: string;
  rule_key: string; peers: string[]; peer_count?: number;
}
export interface ValidationReport { issues: ValidationIssue[]; acknowledgement: string | null }
export interface RangeBar { fraction: number; color: string; out_of_range: boolean }
export interface CellPresentation { range_bar?: RangeBar; raw_value: string; display_value: string; style: CellStyle; issues: ValidationIssue[]; formula_error: Diagnostic | null; hint: string }
export interface TablePresentation { table_uuid: string; revision: string; cells: Record<string, Record<string, CellPresentation>>; definition_issues: Diagnostic[]; issue_count: number }
export interface CellPatch { record_uuid: string; column_uuid: string; value: string }
export interface ColumnVersionPatch { column_uuid: string; min_version: string }
export interface VersionPatch { record_uuid: string; min_version: string }
export interface InitialValue { column_uuid: string; value: string }
export interface CreateRecord { record_uuid: string; values: InitialValue[]; before_record_uuid?: string | null }
export interface RecordDraft { table_uuid: string; record_uuid: string; revision: string; values: InitialValue[]; columns: Column[] }
export interface TableMutation {
  table_uuid: string; expected_revision: string; cells: CellPatch[]; versions: VersionPatch[]; column_versions?: ColumnVersionPatch[];
  create_records: CreateRecord[]; delete_record_uuids: string[]; acknowledgement?: string | null;
}
export interface MutationResult { table: TableData; presentation: TablePresentation }
/** The native token covers root and all persisted/live formula source evidence. */
export type TableRuleSnapshotResponse =
  | { kind: 'unchanged'; snapshot_token: string | null; retained_bytes: number }
  | { kind: 'presentation'; snapshot_token: string | null; retained_bytes: number; presentation: TablePresentation }
  | { kind: 'snapshot'; snapshot_token: string | null; retained_bytes: number; table: TableDataWire; presentation: TablePresentation };
export interface TableDialogRequest { kind: 'warning'; table_uuid: string; title: string; report?: ValidationReport }
export interface TableDialogResult { approved: boolean }
export type AppError = Diagnostic
  | { kind: 'input_validation'; report: ValidationReport }
  | { kind: 'diagnostics'; diagnostics: Diagnostic[] };

export function inputValidationReport(error: unknown): ValidationReport | null {
  if (error && typeof error === 'object' && 'appError' in error) error = error.appError;
  if (!error || typeof error !== 'object' || !('kind' in error) || error.kind !== 'input_validation'
    || !('report' in error) || !error.report || typeof error.report !== 'object') return null;
  const report = error.report as ValidationReport;
  return Array.isArray(report.issues) ? report : null;
}

