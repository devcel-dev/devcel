import * as webviewWindows from '@tauri-apps/api/webviewWindow';
// These modules are already eager dependencies. Keep the asynchronous operation
// boundaries below so session and cancellation checks retain their ordering.
import type { SavedColorSwatch } from '@/app/types/colorTypes';
import { message, localizedError, type Diagnostic } from '@/app/i18n';
import { invoke } from "@tauri-apps/api/core";
import {
  InterfaceDetails,
  InterfaceChange,
  InterfaceValidation,
  InterfaceImplementation,
  InterfaceListItem,
  InterfaceRemovalImpact,
  DuplicateInterfaceCopy,
  ColumnConstraints,
} from "@/types/interface";
import { InterfaceColumn, ValueType } from "@/types/interface";
import { inputValidationReport, type InputValidationSettings, type ConditionalFormatting } from "@/app/types/tableRules";
import { confirmInputWarnings } from "@/app/utils/table_rule_dialogs";

type InterfaceTableWriteArguments = {
  interfaceUuid: string;
  tableUuid: string;
  autoAddColumns?: boolean;
  applySafeChanges?: boolean;
  reconcileAfterSync?: boolean;
  expectedProjectSession: string;
};

/** Backend reports are authoritative. A confirmation can retry only this fixed
 * operation, once; changed data or another warning returns to the caller. */
async function invokeInterfaceTableWrite(
  command: "apply_interface_to_table" | "sync_table_with_interface" | "reconcile_table_with_interface" | "remove_interface_from_table",
  args: InterfaceTableWriteArguments,
  signal?: AbortSignal,
): Promise<string> {
  const cancelled = () => localizedError(message('interface.api.cancelled'));
  if (signal?.aborted) throw cancelled();
  const fixed = Object.freeze({ ...args });
  try {
    return await invoke<string>(command, { ...fixed, acknowledgement: null });
  } catch (error) {
    const report = inputValidationReport(error);
    if (!report?.acknowledgement || report.issues.length === 0
      || report.issues.some(issue => issue.mode !== "warn" || issue.table_uuid !== fixed.tableUuid)) throw error;
    if (signal?.aborted || !await confirmInputWarnings(fixed.tableUuid, report, signal) || signal?.aborted) {
      throw cancelled();
    }
    // One retry preserves the operation, target session and exact acknowledgement.
    // A stale report is returned to the caller, never reconfirmed recursively.
    return await invoke<string>(command, { ...fixed, acknowledgement: report.acknowledgement });
  }
}

interface RustColumnStyle {
  color: string;
  font_size: number;
  width: number;
}

interface RustColumnConstraints {
  unique?: boolean;
  min_value?: number;
  max_value?: number;
  pattern?: string;
}

interface RustColumnSchema {
  read_only: boolean;
  uuid: string;
  display_name: string;
  data_name: string;
  tooltip: string;
  data_type: ValueType;
  min_version: number;
  tags: string[];
  default_value: string;
  color_swatches: SavedColorSwatch[];
  style: RustColumnStyle;
  memo_text: string;
  interface_origin?: string;
  interface_origin_name_fallback?: string;
  required?: boolean;
  constraints?: RustColumnConstraints;
  input_validation?: InputValidationSettings | null;
  conditional_formatting?: ConditionalFormatting | null;
}

function toRustConstraints(
  constraints?: ColumnConstraints
): RustColumnConstraints | undefined {
  if (!constraints) return undefined;
  const converted: RustColumnConstraints = {
    unique: constraints.unique,
    min_value: constraints.minValue,
    max_value: constraints.maxValue,
    pattern: constraints.pattern,
  };
  const hasAny =
    converted.unique !== undefined ||
    converted.min_value !== undefined ||
    converted.max_value !== undefined ||
    converted.pattern !== undefined;
  return hasAny ? converted : undefined;
}

function makeTempUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toRustColumnSchema(column: InterfaceColumn): RustColumnSchema {
  return {
    uuid: makeTempUuid(),
    read_only: false,
    display_name: column.name,
    data_name: column.name,
    tooltip: "",
    data_type: column.dataType,
    min_version: column.minVersion,
    tags: [],
    default_value: column.defaultValue ?? "",
    color_swatches: column.colorSwatches ?? [],
    style: {
      color: "#000000",
      font_size: 12,
      width: 0, // Automatic initial width; preserve explicit widths when editing.
    },
    memo_text: column.description ?? "",
    required: column.required || undefined,
    constraints: toRustConstraints(column.constraints),
    input_validation: column.inputValidation ?? null,
    conditional_formatting: column.conditionalFormatting ?? null,
  };
}

/**
 * Get the list of interfaces
 * @returns List of interfaces
 */
export async function listInterfaces(expectedProjectSession: string): Promise<InterfaceListItem[]> {
  return await invoke<InterfaceListItem[]>("list_interfaces", { expectedProjectSession });
}

/**
 * Get interface details
 * @param uuid Interface UUID
 * @returns Interface details
 */
export async function getInterfaceDetails(uuid: string, expectedProjectSession: string): Promise<InterfaceDetails> {
  return await invoke<InterfaceDetails>("get_interface_details", {
    interfaceUuid: uuid,
    expectedProjectSession,
  });
}

/**
 * Apply an interface to a table
 * @param tableUuid Table UUID
 * @param interfaceUuid Interface UUID
 * @param autoAddColumns Whether to add missing columns automatically
 * @returns Application result ("ok" or an error message)
 */
export async function applyInterfaceToTable(
  tableUuid: string,
  interfaceUuid: string,
  expectedProjectSession: string,
  autoAddColumns: boolean = true,
  signal?: AbortSignal
): Promise<string> {
  return await invokeInterfaceTableWrite("apply_interface_to_table", {

    interfaceUuid,
    autoAddColumns,
    tableUuid,
    expectedProjectSession,
  }, signal);
}

/**
 * Update an interface
 * @param interfaceUuid Interface UUID
 * @param changes Changes to apply
 * @param author Optional author
 * @param comment Optional comment
 * @returns Update result ("ok" or an error message)
 */
export async function updateInterface(
  interfaceUuid: string,
  changes: InterfaceChange[],
  expectedProjectSession: string,
  author?: string,
  comment?: string,
  expectedVersionId?: string
): Promise<string> {
  // Convert InterfaceChange to the appropriate format
  const convertedChanges = changes
    .map((change) => {
    switch (change.type) {
      case "AddColumn":
        return { AddColumn: { column: toRustColumnSchema(change.column) } };
      case "RemoveColumn":
        return { RemoveColumn: { column_name: change.columnName } };
      case "ModifyColumn":
        return {
          ModifyColumn: {
            column_name: change.columnName,
            old_type: change.oldType,
            new_type: change.newType,
          },
        };
      case "ChangeRequired":
        return {
          ChangeRequired: {
            column_name: change.columnName,
            required: change.required,
          },
        };
      case "ChangeDefault":
        return {
          ChangeDefault: {
            column_name: change.columnName,
            new_default: change.newDefault,
          },
        };
      case "ChangeColorSwatches":
        return { ChangeColorSwatches: { column_name: change.columnName, swatches: change.swatches } };
      case "ChangeMinVersion":
        return { ChangeMinVersion: { column_name: change.columnName, min_version: change.minVersion } };
      case "ChangeConstraints":
        return {
          ChangeConstraints: {
            column_name: change.columnName,
            new_constraints: toRustConstraints(change.constraints) ?? null,
          },
        };
      case "ChangeInputValidation":
        return { ChangeInputValidation: { column_name: change.columnName, settings: change.settings ?? null } };
      case "ChangeConditionalFormatting":
        return { ChangeConditionalFormatting: { column_name: change.columnName, formatting: change.formatting ?? null } };
      case "ConfigureColumn":
      case "Unknown":
        // History display records are not complete mutation payloads.
        throw localizedError(message('interface.api.displayOnlyChange'));
      case "RenameColumn":
        return {
          RenameColumn: {
            old_name: change.oldName,
            new_name: change.newName,
          },
        };
      case "ModifyColumnMeta":
        return {
          ModifyColumnMeta: {
            column_name: change.columnName,
            display_name: change.displayName ?? null,
            tooltip: change.tooltip ?? null,
            memo_text: change.memoText ?? null,
            style: null,
          },
        };
      case "ChangeDescription":
        return {
          ChangeDescription: {
            new_description: change.newDescription ?? null,
          },
        };
      case "ModifyExtends":
        return {
          ModifyExtends: {
            new_extends: change.newExtends,
          },
        };
      case "ReorderColumns":
        return {
          ReorderColumns: {
            order: change.order,
          },
        };
    }
    })
    .filter((change): change is NonNullable<typeof change> => change !== null);

  return await invoke("update_interface", {
    interfaceUuid,
    changes: convertedChanges,
    expectedVersionId,
    author,
    comment,
    expectedProjectSession,
  });
}

/**
 * Synchronize a table with an interface
 * @param tableUuid Table UUID
 * @param interfaceUuid Interface UUID
 * @param applySafeChanges Whether to apply only safe changes
 * @param reconcileAfterSync Whether to check and repair consistency after synchronization
 * @returns Synchronization result ("ok" or an error message)
 */
export async function syncTableWithInterface(
  tableUuid: string,
  interfaceUuid: string,
  expectedProjectSession: string,
  applySafeChanges: boolean = true,
  reconcileAfterSync: boolean = false,
  signal?: AbortSignal
): Promise<string> {

  const result = await invokeInterfaceTableWrite("sync_table_with_interface", {

    interfaceUuid,
    applySafeChanges,
    reconcileAfterSync,
    tableUuid,
    expectedProjectSession,
  }, signal);

  return result;
}

/**
 * Remove an interface from a table
 * @param tableUuid Table UUID
 * @param interfaceUuid Interface UUID
 * @returns Removal result message
 */
export async function removeInterfaceFromTable(
  tableUuid: string,
  interfaceUuid: string,
  expectedProjectSession: string,
  signal?: AbortSignal
): Promise<string> {
  return await invokeInterfaceTableWrite("remove_interface_from_table", {

    interfaceUuid,
    tableUuid,
    expectedProjectSession,
  }, signal);
}

/**
 * Validate interface implementation
 * @param tableUuid Table UUID
 * @param interfaceUuid Interface UUID
 * @returns Validation result
 */
export async function validateInterfaceImplementation(
  tableUuid: string,
  interfaceUuid: string,
  expectedProjectSession: string,
): Promise<InterfaceValidation> {
  interface RustColumnMismatch {
    column_name: string;
    expected_type: string;
    actual_type: string;
  }

  interface RustConstraintViolation {
    column_name: string;
    constraint_type: string;
    diagnostic: Diagnostic;
    record_uuid?: string | null;
  }

  interface RustInterfaceValidation {
    interface_uuid: string;
    is_valid: boolean;
    missing_columns: string[];
    type_mismatches: RustColumnMismatch[];
    constraint_violations: RustConstraintViolation[];
  }

  try {
    const result = await invoke<RustInterfaceValidation>("validate_interface_implementation", {

      interfaceUuid,
      tableUuid,
      expectedProjectSession,
    });

    return {
      interfaceUuid: result.interface_uuid,
      isValid: result.is_valid,
      missingColumns: result.missing_columns,
      typeMismatches: result.type_mismatches.map((m) => ({
        columnName: m.column_name,
        expectedType: m.expected_type as any,
        actualType: m.actual_type as any,
      })),
      constraintViolations: result.constraint_violations.map((v) => ({
        columnName: v.column_name,
        constraintType: v.constraint_type,
        diagnostic: v.diagnostic,
        recordUuid: v.record_uuid ?? undefined,
      })),
    };
  } catch (error) {
    console.error("Failed to validate interface implementation:", error);
    throw error;
  }
}

/**
 * Get the interfaces implemented by a table
 * @param tableUuid Table UUID
 * @returns List of interface implementation information
 */
export async function getTableInterfaces(
  tableUuid: string,
  expectedProjectSession: string
): Promise<InterfaceImplementation[]> {
  try {
    interface RustInterfaceImplementation {
      interface_uuid: string;
      synced_version_id: string;
      last_sync_date: string;
    }

    const result = await invoke<RustInterfaceImplementation[]>("get_table_interfaces", { tableUuid, expectedProjectSession });
    // Rust returns an array directly, so map it to the appropriate type
    return result.map(item => ({
      interfaceUuid: item.interface_uuid,
      syncedVersionId: item.synced_version_id,
      lastSyncDate: item.last_sync_date,
    }));
  } catch (error) {
    console.warn("getTableInterfaces error:", error);
    throw error;
  }
}

/**
 * Open an interface file for editing
 * @param interfaceUuid Interface UUID
 */
export async function openInterfaceInEditor(interfaceUuid: string, expectedProjectSession: string): Promise<void> {
  const interfaces = await listInterfaces(expectedProjectSession);
  const matches = interfaces.filter(item => item.uuid === interfaceUuid);
  if (matches.length !== 1) throw localizedError(matches.length ? message('interface.api.ambiguousName') : message('interface.api.notFound'));
  const { emitTo } = await import('@tauri-apps/api/event');
  await emitTo('main', 'devcel-open-interface', { ...matches[0], projectSession: expectedProjectSession });
  const { WebviewWindow } = await Promise.resolve().then(() => webviewWindows);
  const main = await WebviewWindow.getByLabel('main');
  await main?.setFocus();
}

/**
 * Get the impact of removing an interface from a table
 * (columns removed and number of entered values lost)
 */
export async function previewInterfaceRemovalImpact(
  tableUuid: string,
  interfaceUuid: string,
  expectedProjectSession: string
): Promise<InterfaceRemovalImpact> {
  return await invoke<InterfaceRemovalImpact>("preview_interface_removal_impact", {
    tableUuid,
    interfaceUuid,
    expectedProjectSession,
  });
}

/**
 * Detect same-name column conflicts before applying an interface
 * @returns List of column names that would duplicate existing names
 */
export async function checkInterfaceNameCollisions(
  tableUuid: string,
  interfaceUuid: string,
  expectedProjectSession: string,
  precedingInterfaceUuids: string[] = [],
): Promise<string[]> {
  return await invoke<string[]>("check_interface_name_collisions", {
    tableUuid,
    interfaceUuid,
    expectedProjectSession,
    precedingInterfaceUuids,
  });
}

/**
 * Detect other copies of the same interface, such as conflict copies, within the project
 */
export async function findDuplicateInterfaceCopies(expectedProjectSession: string): Promise<DuplicateInterfaceCopy[]> {
  return await invoke<DuplicateInterfaceCopy[]>("find_duplicate_interface_copies", { expectedProjectSession });
}

/**
 * Import history from an external interface file
 * (preparation for merging copies of the same interface diverged through file synchronization)
 * @param interfaceUuid Interface UUID
 * @param sourcePath Absolute path of the source interface file
 * @returns Number of imported versions
 */
export async function importInterfaceHistory(
  interfaceUuid: string,
  sourcePath: string,
  expectedProjectSession: string,
  deleteSource: boolean = false
): Promise<number> {
  return await invoke<number>("import_interface_history", {
    interfaceUuid,
    sourcePath,
    expectedProjectSession,
    deleteSource,
  });
}

