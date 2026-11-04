import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import type { Column } from '@/app/types/tableTypes';
import { sanitizeViewState, type ColumnFilter, type SortLevel } from './gridFilterSort';

export interface GridFilterSortState { filters: ColumnFilter[]; sorts: SortLevel[] }
const emptyState: GridFilterSortState = { filters: [], sorts: [] };
// View preferences belong to a table in a project session, never to its data DTO.
// Keep them through tab unmounts, but discard the old session on project change.
let session = '';
const tables = new Map<string, GridFilterSortState>();
function read(sessionId: string, tableUuid: string): GridFilterSortState {
  if (session !== sessionId) { session = sessionId; tables.clear(); }
  return tables.get(tableUuid) ?? emptyState;
}
export function useGridFilterSortState(sessionId: string, tableUuid: string, columns: Column[]) {
  const key = `${sessionId}/${tableUuid}`;
  const [stored, setStored] = useState(() => ({ key, state: read(sessionId, tableUuid) }));
  const current = stored.key === key ? stored.state : read(sessionId, tableUuid);
  const state = useMemo(() => sanitizeViewState(columns, current.filters, current.sorts), [columns, current]);
  useLayoutEffect(() => {
    if (session !== sessionId) { session = sessionId; tables.clear(); }
    tables.set(tableUuid, state);
    if (stored.key !== key || state.filters !== current.filters || state.sorts !== current.sorts) setStored({ key, state });
  }, [sessionId, tableUuid, key, state, current, stored.key]);
  const update = useCallback((next: GridFilterSortState) => {
    if (session !== sessionId) { session = sessionId; tables.clear(); }
    const valid = sanitizeViewState(columns, next.filters, next.sorts);
    tables.set(tableUuid, valid); setStored({ key, state: valid });
  }, [key, sessionId, tableUuid, columns]);
  return { ...state, update };
}
