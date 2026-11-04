import { shareDisplayValue } from './gridDisplayModel';
import { isTableInteractionAllowed } from '@/app/services/tableInteractionScope';
import { useI18n, message } from '@/app/i18n';
import { gridErrorNotice, resolveGridError } from './gridErrorNotice';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getTableSnapshotInvalidationVersion, retainTableSnapshotInvalidation } from '@/app/services/tableSnapshotInvalidation';
import type { TableData } from '@/app/types/tableTypes';
import type { TablePresentation } from '@/app/types/tableRules';
import { requestTableSnapshot, rememberTableSnapshot, forgetTableSnapshot,
  type AuthoritativeTableSnapshot, type TableSnapshotRequest } from '@/app/services/tableSnapshotCache';

/** Table, presentation and reuse evidence always originate in one native read. */
export function useTablePresentation(table: TableData, expectedProjectSession: string,
  onSnapshot: (snapshot: AuthoritativeTableSnapshot) => void, preparedSnapshot?: AuthoritativeTableSnapshot) {
  useI18n();
  const seed = preparedSnapshot?.projectSessionId === expectedProjectSession
    && preparedSnapshot.tableUuid === table.uuid && preparedSnapshot.table === table
    && preparedSnapshot.presentation.table_uuid === table.uuid ? preparedSnapshot : undefined;
  const [presentation, setPresentation] = useState<TablePresentation | null>(seed?.presentation ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const paused = useRef(false);
  const deferredRefresh = useRef(false);
  const refreshRequested = useRef(false);
  const dependenciesInvalidated = useRef(false);
  const activeRequest = useRef<TableSnapshotRequest | null>(null);
  const inFlight = useRef<{ promise: Promise<TablePresentation | null> } | null>(null);
  const sessionIdentity = useRef(expectedProjectSession);
  sessionIdentity.current = expectedProjectSession;
  const identity = useRef(table.uuid);
  identity.current = table.uuid;
  const current = useRef<TablePresentation | null>(seed?.invalidationVersion === getTableSnapshotInvalidationVersion(expectedProjectSession) ? seed.presentation : null);
  const basisInvalidationVersion = useRef(seed?.invalidationVersion ?? 0);
  const lastAccepted = useRef<AuthoritativeTableSnapshot | null>(seed ?? null);
  const basis = useRef<TableData | null>(seed?.table ?? null);
  const basisSession = useRef<string | null>(seed?.projectSessionId ?? null);
  const tableRef = useRef(table);
  tableRef.current = table;
  const deliver = useRef(onSnapshot);
  deliver.current = onSnapshot;
  const cancelActiveRequest = useCallback(() => { activeRequest.current?.cancel(); }, []);
  const cancel = useCallback(() => {
    generation.current += 1;
    refreshRequested.current = false;
    deferredRefresh.current = false;
    current.current = null;
    cancelActiveRequest();
    setRefreshing(false); setCancelled(true); setError(null);
  }, [cancelActiveRequest]);
  const accept = useCallback((next: TablePresentation, snapshot: TableData, invalidationVersion = getTableSnapshotInvalidationVersion(sessionIdentity.current)) => {
    if (!mounted.current || next.table_uuid !== identity.current || snapshot.uuid !== identity.current) return;
    generation.current += 1;
    cancelActiveRequest();
    current.current = invalidationVersion === getTableSnapshotInvalidationVersion(sessionIdentity.current) ? next : null;
    // A mutation response has no retained dependency proof. Never attach the old
    // token to newly committed data; the next read asks Rust for fresh evidence.
    lastAccepted.current = { table: snapshot, presentation: next, projectSessionId: sessionIdentity.current,
      tableUuid: identity.current, snapshotToken: null, retainedBytes: 0, invalidationVersion };
    forgetTableSnapshot(sessionIdentity.current, identity.current);
    basis.current = snapshot;
    basisSession.current = sessionIdentity.current;
    basisInvalidationVersion.current = invalidationVersion;
    setPresentation(next); setRefreshing(false); setCancelled(false); setError(null);
  }, [cancelActiveRequest]);
  const acceptSnapshot = useCallback((snapshot: AuthoritativeTableSnapshot) => {
    if (snapshot.invalidationVersion !== getTableSnapshotInvalidationVersion(snapshot.projectSessionId)) return null;
    const previous = lastAccepted.current;
    if (previous?.projectSessionId === snapshot.projectSessionId && previous.tableUuid === snapshot.tableUuid) {
      // The read still validates every dependency. Share only fully equal DTOs,
      // never infer equality or freshness from a root revision alone.
      snapshot = { ...snapshot, table: shareDisplayValue(previous.table, snapshot.table),
        presentation: shareDisplayValue(previous.presentation, snapshot.presentation) };
    }
    accept(snapshot.presentation, snapshot.table);
    lastAccepted.current = snapshot;
    dependenciesInvalidated.current = false;
    rememberTableSnapshot(snapshot);
    return snapshot;
  }, [accept]);
  const setPaused = useCallback((value: boolean) => {
    paused.current = value;
    if (value) { generation.current += 1; cancelActiveRequest(); }
    const deferred = deferredRefresh.current || dependenciesInvalidated.current;
    if (!value) deferredRefresh.current = false;
    return deferred;
  }, [cancelActiveRequest]);
  const isRefreshPending = useCallback(() => inFlight.current !== null || refreshRequested.current || deferredRefresh.current, []);
  const getCurrent = useCallback(() => basis.current === tableRef.current
    && basisSession.current === sessionIdentity.current
    && basisInvalidationVersion.current === getTableSnapshotInvalidationVersion(sessionIdentity.current)
    && isTableInteractionAllowed(sessionIdentity.current, identity.current) ? current.current : null, []);
  const refresh = useCallback(async (options?: { invalidateDependencies?: boolean; background?: boolean }) => {
    if (!mounted.current || expectedProjectSession !== sessionIdentity.current || table.uuid !== identity.current) return null;
    if (options?.invalidateDependencies !== false) dependenciesInvalidated.current = true;
    if (paused.current) { deferredRefresh.current = true; return null; }
    generation.current += 1;
    cancelActiveRequest();
    refreshRequested.current = true;
    current.current = null;
    // Display stays bound to its immutable basis while the write token is closed.
    setRefreshing(true); setBackgroundRefreshing(options?.background === true && basis.current !== null);
    setCancelled(false); setError(null);
    if (inFlight.current) return inFlight.current.promise;
    let finish!: (result: TablePresentation | null) => void;
    const run = { promise: new Promise<TablePresentation | null>(resolve => { finish = resolve; }) };
    inFlight.current = run;
    void (async () => {
      let result: TablePresentation | null = null;
      try {
        while (mounted.current && !paused.current && refreshRequested.current) {
          refreshRequested.current = false;
          result = null;
          const tableUuid = identity.current;
          const requestedSession = sessionIdentity.current;
          const displayed = tableRef.current;
          const ticket = generation.current;
          const known = basis.current === displayed && basisSession.current === requestedSession
            && lastAccepted.current?.tableUuid === tableUuid ? lastAccepted.current : undefined;
          const live = () => mounted.current && !paused.current && ticket === generation.current
            && tableUuid === identity.current && displayed === tableRef.current
            && sessionIdentity.current === requestedSession;
          const request = requestTableSnapshot(tableUuid, requestedSession, known ?? undefined, Promise.resolve(), error => {
            if (mounted.current && identity.current === tableUuid && sessionIdentity.current === requestedSession && !current.current) {
              setError(gridErrorNotice(message('grid.presentationFailed'), error));
            }
          });
          activeRequest.current = request;
          try {
            const snapshot = await request.promise;
            if (activeRequest.current === request) activeRequest.current = null;
            if (!live()) continue;
            // The backend compares bytes/inventory and all live dependencies,
            // even when no watcher event has arrived. No root-only shortcut.
            const accepted = acceptSnapshot(snapshot);
            if (!accepted) { refreshRequested.current = true; continue; }
            deliver.current(accepted);
            result = accepted.presentation;
          } catch (e) {
            if (live()) {
              current.current = null; setRefreshing(false);
              setError(gridErrorNotice(message('grid.presentationFailed'), e));
            }
          } finally {
            request.cancel();
            if (activeRequest.current === request) activeRequest.current = null;
          }
        }
      } finally {
        if (mounted.current && paused.current && refreshRequested.current) deferredRefresh.current = true;
        if (inFlight.current === run) { refreshRequested.current = false; inFlight.current = null; }
        finish(result);
      }
    })();
    return run.promise;
  }, [table.uuid, expectedProjectSession, acceptSnapshot, cancelActiveRequest]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1;
      refreshRequested.current = false; cancelActiveRequest(); };
  }, [cancelActiveRequest]);
  useEffect(() => {
    if (seed && lastAccepted.current !== seed) { if (!acceptSnapshot(seed)) void refresh({ background: basis.current !== null }); }
    else if (basis.current !== table || basisSession.current !== expectedProjectSession || !current.current) void refresh({ background: basis.current !== null });
    return () => { generation.current += 1; cancelActiveRequest(); };
  }, [table, expectedProjectSession, seed, refresh, acceptSnapshot, cancelActiveRequest]);
  useEffect(() => {
    const subscription = retainTableSnapshotInvalidation(expectedProjectSession, change => {
      if (!mounted.current) return;
      if (change.error) {
        generation.current += 1; cancelActiveRequest();
        current.current = null; setRefreshing(false);
        setError(gridErrorNotice(message('grid.presentationFailed'), change.error));
        return;
      }
      void refresh({ invalidateDependencies: change.tableUuid !== table.uuid, background: true });
    });
    // A change can arrive between the seeded render and this effect. The
    // session tracker retains it even while no view subscriber is attached.
    if (basisInvalidationVersion.current !== getTableSnapshotInvalidationVersion(expectedProjectSession)) void refresh({ background: basis.current !== null });
    return subscription.release;
  }, [table.uuid, expectedProjectSession, refresh, cancelActiveRequest]);
  const displayedPresentation = presentation?.table_uuid === table.uuid
    && basis.current === table && basisSession.current === expectedProjectSession ? presentation : null;
  return { presentation: displayedPresentation,
    ready: !refreshing && displayedPresentation !== null && current.current === displayedPresentation
      && basisInvalidationVersion.current === getTableSnapshotInvalidationVersion(expectedProjectSession),
    getCurrent, isRefreshPending, error: resolveGridError(error), refreshing, backgroundRefreshing: refreshing && backgroundRefreshing, cancelled, cancel, refresh, accept, setPaused };
}
