import { invoke } from '@tauri-apps/api/core';
import type { ReferenceOption, TableData } from '@/app/types/tableTypes';

export interface ReferenceOptionsRequest {
  tableUuid: string;
  columnUuid: string;
  expectedProjectSession: string;
  targetTableUuid: string | undefined;
  displayColumnUuid: string | null | undefined;
}

export interface ReferenceOptionsIndex {
  options: readonly ReferenceOption[];
  byUuid: ReadonlyMap<string, { option: ReferenceOption; index: number }>;
}

interface CachedColumn {
  configKey: string;
  promise: Promise<ReferenceOptionsIndex>;
}

interface ReferenceGeneration {
  key: string;
  columns: Map<string, CachedColumn>;
}

// Keep only the current generation per immutable table snapshot. Old snapshots and
// their candidate lists can be collected when the grid no longer holds them.
const generations = new WeakMap<TableData, ReferenceGeneration>();

export async function fetchReferenceOptions(request: ReferenceOptionsRequest): Promise<ReferenceOptionsIndex> {
  const options = await invoke<ReferenceOption[]>('get_reference_options_command', {
    tableUuid: request.tableUuid,
    columnUuid: request.columnUuid,
    expectedProjectSession: request.expectedProjectSession,
  });
  const byUuid = new Map<string, { option: ReferenceOption; index: number }>();
  options.forEach((option, index) => {
    // Match the old findIndex behavior if a backend response has duplicate UUIDs.
    if (!byUuid.has(option.uuid)) byUuid.set(option.uuid, { option, index });
  });
  return { options, byUuid };
}

export function getReferenceOptions(
  request: ReferenceOptionsRequest,
  tableData?: TableData,
  refreshVersion = 0,
): Promise<ReferenceOptionsIndex> {
  // Callers without an authoritative snapshot cannot establish a cache lifetime.
  if (!tableData) return fetchReferenceOptions(request);

  const key = JSON.stringify([request.expectedProjectSession, request.tableUuid, refreshVersion]);
  let generation = generations.get(tableData);
  if (!generation || generation.key !== key) {
    generation = { key, columns: new Map() };
    generations.set(tableData, generation);
  }
  const configKey = JSON.stringify([request.targetTableUuid, request.displayColumnUuid]);
  const cached = generation.columns.get(request.columnUuid);
  if (cached?.configKey === configKey) return cached.promise;

  const columns = generation.columns;
  const entry: CachedColumn = { configKey, promise: fetchReferenceOptions(request) };
  columns.set(request.columnUuid, entry);
  // A failed read must not poison the generation. A late failure may only remove
  // its own entry, never a newer configuration's successful request.
  void entry.promise.catch(() => {
    if (columns.get(request.columnUuid) === entry) columns.delete(request.columnUuid);
  });
  return entry.promise;
}
