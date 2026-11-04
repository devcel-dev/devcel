import { listen } from '@tauri-apps/api/event';

export interface TableSnapshotInvalidation { tableUuid?: string; error?: unknown }
interface Tracker {
  active: boolean; refs: number; version: number; ready: Promise<void>;
  subscribers: Set<(change: TableSnapshotInvalidation) => void>;
  dispose: () => void;
}
const trackers = new Map<string, Tracker>();

/** One subscription group survives the old-view teardown/new-view mount gap. */
export function retainTableSnapshotInvalidation(projectSession: string,
  subscriber?: (change: TableSnapshotInvalidation) => void): { ready: Promise<void>; release: () => void } {
  let tracker = trackers.get(projectSession);
  if (!tracker) {
    const created: Tracker = { active: true, refs: 0, version: 0, ready: Promise.resolve(), subscribers: new Set(), dispose: () => {} };
    tracker = created;
    trackers.set(projectSession, created);
    const changed = (session: string | undefined, tableUuid?: string, error?: unknown) => {
      if (!created.active || session !== projectSession) return;
      created.version += 1;
      for (const notify of created.subscribers) notify({ tableUuid, error });
    };
    const subscriptions = [
      listen<{ project_session: string }>('project-tags-changed', ({ payload }) => {
        changed(payload?.project_session);
      }),
      listen<{ project_session: string; error?: unknown }>('formula-sources-changed', ({ payload }) => {
        changed(payload?.project_session, undefined, payload?.error);
      }),
      listen<{ project_session: string; table_uuid?: string }>('p2p-data-changed', ({ payload }) => {
        changed(payload?.project_session, payload?.table_uuid);
      }),
      listen<{ project_session: string; table_uuids: string[] }>('settings-project-data-changed', ({ payload }) => {
        // One ordinary transaction may replace both palettes and their reference
        // sources. Invalidate the session once, including dependent presentations.
        changed(payload?.project_session);
      }),
      listen<{ projectSession: string; tableUuid?: string }>('column-added', ({ payload }) => {
        changed(payload?.projectSession, payload?.tableUuid);
      }),
      listen<{ projectSession: string }>('interface-column-added', ({ payload }) => {
        changed(payload?.projectSession);
      }),
    ];
    const localChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ projectSession?: string; tableUuid?: string }>).detail;
      changed(detail?.projectSession, detail?.tableUuid);
    };
    window.addEventListener('table-data-changed', localChanged);
    const unlisteners: Array<() => void> = [];
    created.ready = Promise.all(subscriptions.map(subscription => subscription.then(unlisten => {
      if (created.active) unlisteners.push(unlisten); else unlisten();
    }))).then(() => {});
    // Keep registration errors observable by the acquisition waiting for ready,
    // while preventing an unhandled rejection if it is retired before any read.
    void created.ready.catch(error => changed(projectSession, undefined, error));
    created.dispose = () => {
      created.active = false;
      window.removeEventListener('table-data-changed', localChanged);
      for (const unlisten of unlisteners) unlisten();
    };
  }
  tracker.refs += 1;
  if (subscriber) tracker.subscribers.add(subscriber);
  const owner = tracker;
  let released = false;
  return { ready: owner.ready, release: () => {
    if (released) return;
    released = true;
    if (subscriber) owner.subscribers.delete(subscriber);
    owner.refs -= 1;
    if (owner.refs === 0) {
      owner.dispose();
      if (trackers.get(projectSession) === owner) trackers.delete(projectSession);
    }
  } };
}

export function getTableSnapshotInvalidationVersion(projectSession: string): number {
  return trackers.get(projectSession)?.version ?? 0;
}

export function waitTableSnapshotInvalidationReady(projectSession: string): Promise<void> {
  return trackers.get(projectSession)?.ready ?? Promise.resolve();
}
