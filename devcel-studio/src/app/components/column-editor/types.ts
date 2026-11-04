import type { SavedColorSwatch } from '@/app/types/colorTypes';
import type { ReferenceConfig, CurveConfig, TableRefConfig } from '@/app/types/tableTypes';
import type { Diagnostic, InputValidationSettings, ConditionalFormatting, ValidationIssue, ValidationReport, CellPresentation } from '@/app/types/tableRules';

export interface ColumnEditorTarget {
  mode: 'table' | 'interface';
  target_uuid: string;
  column_uuid: string | null;
  insert_index?: number;
}

export interface EditorColumn {
  read_only: boolean;
  uuid: string;
  display_name: string;
  data_name: string;
  data_type: string;
  min_version: number;
  tooltip: string;
  tags: string[];
  memo_text: string;
  default_value: string;
  color_swatches?: SavedColorSwatch[];
  style: { color: string; width?: number; font_size?: number };
  reference_config?: ReferenceConfig | null;
  curve_config?: CurveConfig | null;
  table_ref_config?: TableRefConfig | null;
  select_config?: { options: Array<{ value: string; label?: string }> } | null;
  input_validation?: InputValidationSettings | null;
  conditional_formatting?: ConditionalFormatting | null;
  conditional_formatting_override?: ConditionalFormatting | null;
  required?: boolean;
  constraints?: { unique?: boolean; min_value?: number | null; max_value?: number | null; pattern?: string | null } | null;
  interface_origin?: string | null;
  interface_origin_name_fallback?: string | null;
}

export interface ColumnEditorLoad {
  name: string;
  origin_name: string | null;
  implementing_tables: string[];
  column: EditorColumn;
  target: ColumnEditorTarget;
  revision: string | null;
  interface_owned: boolean;
}

export interface ColumnEditorDraft {
  /** Display label; name remains the validated internal field identifier for both target modes. */
  display_name?: string;
  read_only: boolean;
  name: string;
  column_type: string;
  /** Minimum content version, supplied with every editing request. */
  min_version: string;
  tooltip: string;
  tags: string[];
  memo_text: string;
  default_value: string;
  color_swatches: SavedColorSwatch[];
  color: string;
  font_size: number;
  reference_config: ReferenceConfig | null;
  curve_config: CurveConfig | null;
  table_ref_config: TableRefConfig | null;
  select_config: EditorColumn['select_config'];
  input_validation: InputValidationSettings | null;
  conditional_formatting: ConditionalFormatting | null;
  conditional_formatting_override: ConditionalFormatting | null;
}

export interface ColumnEditorRequest {
  target: ColumnEditorTarget;
  draft: ColumnEditorDraft;
  expected_revision: string | null;
  creation_uuid?: string | null;
  acknowledgement?: string | null;
  acknowledgements?: Record<string, string>;
}

export interface ColumnEditorPreview {
  locations?: Record<string, { table_name: string; records: Record<string, Diagnostic> }>;
  type_changed: boolean;
  total_values: number;
  valid_count: number;
  error_count: number;
  changed_count: number;
  empty_count: number;
  errors: Diagnostic[];
  input_issues: ValidationIssue[];
  input_issue_count: number;
  reject_issue_count: number;
  warning_issue_count: number;
  input_reports: Array<{ table_uuid: string; report: ValidationReport }>;
  presentation_samples: Array<{ table_uuid: string; record_uuid: string | null; column_uuid: string; presentation: CellPresentation }>;
  population_count: number;
  ranking_population_count: number;
  definition_issues: Diagnostic[];
  samples: Array<{ table_uuid: string | null; record_uuid: string | null; source: string; original_value: string; converted_value: string | null; error: Diagnostic | null }>;
}

