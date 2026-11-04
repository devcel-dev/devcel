import { useEffect, useMemo, useState } from 'react';
import type { Column, TableData } from '@/app/types/tableTypes';
import { fetchReferenceOptions, getReferenceOptions, type ReferenceOptionsIndex } from './referenceOptions';

const emptyOptions: ReferenceOptionsIndex = { options: [], byUuid: new Map() };

interface UseReferenceOptionsProps {
  column: Column;
  tableUuid: string;
  expectedProjectSession: string;
  tableData?: TableData;
  refreshVersion?: number;
  enabled?: boolean;
  shared?: boolean;
}

export function useReferenceOptions({
  column, tableUuid, expectedProjectSession, tableData, refreshVersion = 0,
  enabled = true, shared = false,
}: UseReferenceOptionsProps) {
  const targetTableUuid = column.reference_config?.target_table_uuid;
  const displayColumnUuid = column.reference_config?.display_column_uuid;
  const request = useMemo(() => ({
    tableUuid, columnUuid: column.uuid, expectedProjectSession,
    targetTableUuid, displayColumnUuid, tableData, refreshVersion, enabled, shared,
  }), [tableUuid, column.uuid, expectedProjectSession, targetTableUuid, displayColumnUuid,
    tableData, refreshVersion, enabled, shared]);
  // A new request snapshot gets a distinct token, without retaining the snapshot
  // in old results. The description names the request but does not define equality.
  const requestIdentity = useMemo(() => Symbol(`${request.expectedProjectSession}/${request.tableUuid}/${request.columnUuid}`), [request]);
  const [refresh, setRefresh] = useState<{ requestIdentity: symbol } | null>(null);
  const refreshToken = refresh?.requestIdentity === requestIdentity ? refresh : null;
  // Explicit refreshes of an otherwise unchanged request also invalidate results.
  const identity = useMemo(() => ({ requestIdentity, refreshToken }), [requestIdentity, refreshToken]);
  const displayScope = JSON.stringify([tableUuid, column.uuid, expectedProjectSession, targetTableUuid, displayColumnUuid]);
  const [result, setResult] = useState<{
    displayScope: string;
    identity: typeof identity;
    data: ReferenceOptionsIndex;
    failed: boolean;
  } | null>(null);
  const shouldLoad = enabled && !!targetTableUuid;

  useEffect(() => {
    if (!shouldLoad) {
      setResult(null);
      return;
    }
    let cancelled = false;
    // Renderers share a generation. Editors and explicit refreshes always read
    // current backend candidates, including when reopened on the same snapshot.
    const pending = shared && !refreshToken
      ? getReferenceOptions(request, tableData, refreshVersion)
      : fetchReferenceOptions(request);
    void pending.then(data => {
      if (!cancelled) setResult({ identity, displayScope, data, failed: false });
    }, error => {
      if (cancelled) return;
      console.error('Failed to load reference options:', error);
      setResult({ identity, displayScope, data: emptyOptions, failed: true });
    });
    return () => { cancelled = true; };
  }, [identity, request, shouldLoad, shared, refreshToken, tableData, refreshVersion, displayScope]);

  // Hide the previous scope's options immediately, before effects clean up.
  const current = shouldLoad && result?.identity === identity ? result : null;
  const loading = shouldLoad && !current;
  // Only read-only renderers retain the last settled labels while verifying a
  // new snapshot. Pickers never offer stale candidates, and target/session
  // changes hide old labels immediately, before effect cleanup.
  const displayed = current ?? (shared && shouldLoad && result?.displayScope === displayScope && !result.failed ? result : null);
  return {
    data: displayed?.data ?? emptyOptions,
    failed: current?.failed ?? false,
    loading,
    refreshing: loading && refreshToken !== null,
    refresh: () => setRefresh({ requestIdentity }),
  };
}
