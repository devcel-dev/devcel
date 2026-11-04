import { normalizeTableData } from '@/app/types/tableTypes';
import { localizedError, message } from '@/app/i18n';
import { getTableSnapshotInvalidationVersion, retainTableSnapshotInvalidation } from './tableSnapshotInvalidation';
import { invoke } from '@tauri-apps/api/core';
import type { MutationResult, TableRuleSnapshotResponse } from '@/app/types/tableRules';

/** Immutable GUI references from one authoritative native read, never a write model. */
export interface AuthoritativeTableSnapshot extends MutationResult {
  projectSessionId: string;
  tableUuid: string;
  snapshotToken: string | null;
  retainedBytes: number;
  invalidationVersion: number;
}

const MAX_SNAPSHOTS = 8;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const snapshots = new Map<string, AuthoritativeTableSnapshot>();
let retainedBytes = 0;
const keyFor = (session: string, uuid: string) => JSON.stringify([session, uuid]);

export function forgetTableSnapshot(session: string, uuid: string): void {
  const key = keyFor(session, uuid);
  const previous = snapshots.get(key);
  if (previous) retainedBytes -= previous.retainedBytes;
  snapshots.delete(key);
}

export function clearTableSnapshots(session: string): void {
  for (const snapshot of snapshots.values()) {
    if (snapshot.projectSessionId === session) forgetTableSnapshot(session, snapshot.tableUuid);
  }
}

export function rememberTableSnapshot(snapshot: AuthoritativeTableSnapshot): void {
  forgetTableSnapshot(snapshot.projectSessionId, snapshot.tableUuid);
  // Native evidence overflow/unavailability explicitly disables reuse. The byte
  // weight bounds retained logical payload, not allocator or process RSS.
  if (snapshot.table.uuid !== snapshot.tableUuid || snapshot.presentation.table_uuid !== snapshot.tableUuid
    || !snapshot.projectSessionId || !snapshot.snapshotToken || !Number.isSafeInteger(snapshot.retainedBytes)
    || snapshot.retainedBytes <= 0 || snapshot.retainedBytes > MAX_RETAINED_BYTES) return;
  while (snapshots.size >= MAX_SNAPSHOTS || retainedBytes + snapshot.retainedBytes > MAX_RETAINED_BYTES) {
    const oldest = snapshots.values().next().value as AuthoritativeTableSnapshot | undefined;
    if (!oldest) break;
    forgetTableSnapshot(oldest.projectSessionId, oldest.tableUuid);
  }
  snapshots.set(keyFor(snapshot.projectSessionId, snapshot.tableUuid), snapshot);
  retainedBytes += snapshot.retainedBytes;
}

export function getTableSnapshot(session: string, uuid: string): AuthoritativeTableSnapshot | undefined {
  const key = keyFor(session, uuid);
  const snapshot = snapshots.get(key);
  if (snapshot) { snapshots.delete(key); snapshots.set(key, snapshot); }
  return snapshot;
}

export interface TableSnapshotRequest {
  promise: Promise<AuthoritativeTableSnapshot>;
  cancel: () => void;
}

/** Reserve synchronously at selection, before React can replace the grid. */
export function requestTableSnapshot(
  tableUuid: string,
  projectSessionId: string,
  known?: AuthoritativeTableSnapshot,
  beforeRead: Promise<unknown> = Promise.resolve(),
  onCancellationError: (error: unknown) => void = console.error,
): TableSnapshotRequest {
  const invalidation = retainTableSnapshotInvalidation(projectSessionId);
  let evaluationId: string | null = null;
  let cancelled = false;
  let cancellationSent = false;
  let completed = false;
  const cancel = () => {
    cancelled = true;
    if (evaluationId === null || cancellationSent || completed) return;
    cancellationSent = true;
    void invoke<boolean>('cancel_table_rule_snapshot', {
      evaluationId, tableUuid, expectedProjectSession: projectSessionId,
    }).catch(onCancellationError);
  };
  const reservation = invoke<string>('prepare_table_rule_snapshot', {
    tableUuid, expectedProjectSession: projectSessionId,
  }).then(id => { evaluationId = id; if (cancelled) cancel(); return id; });
  const promise = (async () => {
    try {
      // Rejected synchronization still releases a reservation whose ACK is late.
      const [id] = await Promise.all([reservation, beforeRead, invalidation.ready]);
      if (cancelled) throw localizedError(message('grid.loading.cancelled'));
      const reusable = known?.projectSessionId === projectSessionId && known.tableUuid === tableUuid
        && known.table.uuid === tableUuid && known.presentation.table_uuid === tableUuid ? known : undefined;
      const invalidationVersion = getTableSnapshotInvalidationVersion(projectSessionId);
      const response = await invoke<TableRuleSnapshotResponse>('get_table_rule_snapshot', {
        evaluationId: id, tableUuid, expectedProjectSession: projectSessionId,
        knownSnapshotToken: reusable?.snapshotToken ?? null,
      });
      completed = true;
      if (cancelled) throw localizedError(message('grid.loading.cancelled'));
      let data: MutationResult;
      switch (response.kind) {
        case 'unchanged':
          if (!reusable) throw localizedError(message('grid.snapshotInvalid'));
          data = reusable;
          break;
        case 'presentation':
          if (!reusable || response.presentation.revision !== reusable.presentation.revision) {
            throw localizedError(message('grid.snapshotInvalid'));
          }
          data = { table: reusable.table, presentation: response.presentation };
          break;
        case 'snapshot': data = { ...response, table: normalizeTableData(response.table) }; break;
        default: throw localizedError(message('grid.snapshotInvalid'));
      }
      if (data.table.uuid !== tableUuid || data.presentation.table_uuid !== tableUuid) {
        throw localizedError(message('grid.snapshotChanged'));
      }
      return { table: data.table, presentation: data.presentation, tableUuid, projectSessionId,
        snapshotToken: response.snapshot_token, retainedBytes: response.retained_bytes, invalidationVersion };
    } finally {
      // Running native requests retire themselves. Failed/abandoned registration
      // remains cancellable, including its ACK arriving after beforeRead failed.
      if (!completed) cancel();
      invalidation.release();
    }
  })();
  return { promise, cancel };
}
