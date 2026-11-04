import type { SavedColorSwatch } from '@/app/types/colorTypes';
import type { Diagnostic } from '@/app/i18n';
// Interface-related type definitions

import type { ValueType } from "@/app/types/tableTypes";
import type { InputValidationSettings, ConditionalFormatting } from "@/app/types/tableRules";
export type { ValueType };

// Basic interface information
export interface Interface {
  uuid: string;
  name: string;
  currentVersionId: string;
  description?: string;
  columns: InterfaceColumn[];
  extends: string[];
  filePath?: string;
}

// Interface column definition
export interface InterfaceColumn {
  name: string;
  dataType: ValueType;
  /** Minimum content version for this column. */
  minVersion: number;
  required: boolean;
  defaultValue?: string;
  colorSwatches?: SavedColorSwatch[];
  description?: string;
  constraints?: ColumnConstraints;
  inputValidation?: InputValidationSettings | null;
  conditionalFormatting?: ConditionalFormatting | null;
}

// Column constraints
export interface ColumnConstraints {
  unique?: boolean;
  minValue?: number;
  maxValue?: number;
  pattern?: string; // Regular expression pattern
}

// Interface version information
export interface InterfaceVersion {
  versionId: string;
  parentVersionId?: string;
  timestamp: string; // ISO 8601 format
  changes: InterfaceChange[];
  author?: string;
  comment?: string;
  mergeInfo?: MergeInfo;
}

// Merge information
export interface MergeInfo {
  secondParentId: string;
  conflictResolutions: ConflictResolution[];
}

// Conflict resolution information
export interface ConflictResolution {
  columnName: string;
  resolutionType: ResolutionType;
  description: string;
}

// Conflict resolution method
export type ResolutionType = "TakeOurs" | "TakeTheirs" | "Manual";

// Interface changes
export type InterfaceChange =
  | { type: "AddColumn"; column: InterfaceColumn }
  | { type: "RemoveColumn"; columnName: string }
  | { type: "RenameColumn"; oldName: string; newName: string }
  | { type: "ModifyColumn"; columnName: string; oldType: ValueType; newType: ValueType }
  | { type: "ChangeRequired"; columnName: string; required: boolean }
  | { type: "ChangeDefault"; columnName: string; newDefault?: string }
  | { type: "ChangeColorSwatches"; columnName: string; swatches: SavedColorSwatch[] }
  | { type: "ChangeMinVersion"; columnName: string; minVersion: number }
  | { type: "ChangeConstraints"; columnName: string; constraints?: ColumnConstraints }
  | { type: "ChangeInputValidation"; columnName: string; settings?: InputValidationSettings | null }
  | { type: "ChangeConditionalFormatting"; columnName: string; formatting?: ConditionalFormatting | null }
  | { type: "ConfigureColumn"; columnName: string }
  | { type: "Unknown"; action: string; columnName?: string }
  | {
      type: "ModifyColumnMeta";
      columnName: string;
      displayName?: string;
      tooltip?: string;
      memoText?: string;
    }
  | { type: "ChangeDescription"; newDescription?: string }
  | { type: "ModifyExtends"; newExtends: string[] }
  | { type: "ReorderColumns"; order: string[] };

// Table interface implementation information
export interface InterfaceImplementation {
  interfaceUuid: string;
  syncedVersionId: string;
  lastSyncDate: string; // ISO 8601 format
}

// Interface conformance validation result
export interface InterfaceValidation {
  interfaceUuid: string;
  isValid: boolean;
  missingColumns: string[];
  typeMismatches: ColumnMismatch[];
  constraintViolations: ConstraintViolation[];
}

// Column type mismatch information
export interface ColumnMismatch {
  columnName: string;
  expectedType: ValueType;
  actualType: ValueType;
}

// Constraint violation information
export interface ConstraintViolation {
  columnName: string;
  constraintType: string;
  diagnostic: Diagnostic;
  /** UUID of the violating record, used to jump to the relevant cell */
  recordUuid?: string;
}

// Change application result

// Type change information

// Interface list item
export interface InterfaceListItem {
  uuid: string;
  name: string;
  path: string;
  description?: string;
  column_count: number;
}

// Implementing table information
export interface ImplementingTableInfo {
  uuid: string;
  data_name: string;
  display_name: string;
}

// Interface details (backend response structure)
export interface InterfaceDetails {
  uuid: string;
  name: string;
  description?: string;
  columns: InterfaceColumnInfo[];
  extends: string[];
  current_version_id: string;
  current_version: InterfaceVersionInfo;
  version_history: InterfaceVersionInfo[];
  implementing_tables: ImplementingTableInfo[];
}

export interface InterfaceColumnInfo {
  uuid: string;
  name: string;
  display_name?: string;
  value_type: string;
  /** Minimum content version for this column. */
  min_version: number;
  default_value?: string;
  color_swatches?: SavedColorSwatch[];
  description?: string;
  color?: string;
  tooltip?: string;
  required?: boolean;
  constraints?: ColumnConstraintsResponse;
  input_validation?: InputValidationSettings | null;
  conditional_formatting?: ConditionalFormatting | null;
}

// Constraint information returned by the backend (snake_case)
export interface ColumnConstraintsResponse {
  unique?: boolean;
  min_value?: number;
  max_value?: number;
  pattern?: string;
}

// Version (branch head) information (backend response structure)

// Field-level difference information (backend response structure)
export interface FieldConflictInfo {
  field: string;
  field_label: Diagnostic;
  ours: string;
  theirs: string;
}

// Merge difference information (backend response structure)
export interface MergeConflictInfo {
  column_name: string;
  resolution_type: string;
  description: string;
  field_conflicts: FieldConflictInfo[];
}

// Merge preview (backend response structure)

// Impact of removing an interface (backend response structure)
export interface InterfaceRemovalImpact {
  columns: string[];
  value_count: number;
}

// Column removal impact (backend response structure)

// Information about another copy of the same interface (backend response structure)
export interface DuplicateInterfaceCopy {
  interface_uuid: string;
  name: string;
  canonical_path: string;
  duplicate_path: string;
}

export interface InterfaceVersionInfo {
  id: string;
  parent_version_id?: string;
  timestamp: string;
  changes: InterfaceChangeInfo[];
  author?: string;
  comment?: string;
  merge_info?: MergeInfoResponse;
}

export interface MergeInfoResponse {
  second_parent_id: string;
  conflict_resolutions: ConflictResolutionInfoResponse[];
}

export interface ConflictResolutionInfoResponse {
  column_name: string;
  resolution_type: string;
  description: string;
}

export interface InterfaceChangeInfo {
  action: string;
  min_version?: number;
  column_name?: string;
  old_type?: string;
  new_type?: string;
  details?: string;
}

