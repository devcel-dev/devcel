import { normalizeTableData } from '@/app/types/tableTypes';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import type { PluginProject } from '@/app/types/pluginTypes';
import { PluginManager } from './PluginManager';

// Keep one canonical serialized snapshot, including for a future delete subscriber.
// Parsed table objects belong only to a dispatched payload, never to this cache.
type TableState = { uuid: string; path: string; fingerprint?: string; revision?: string };
// The persisted backend is authoritative. Multiple notifications for one save are
// coalesced, and identical snapshots do not dispatch a second lifecycle hook.
export class PluginLifecycle {
  private project: any = null;
  private tables = new Map<string, TableState>();
  private initialized = false;
  private projectRevision = 0;
  private running?: Promise<void>;
  private pending = false;
  private stopped = false;
  private requestedAll = false;
  private requestedTables = new Set<string>();
  private listeners: UnlistenFn[] = [];
  private timer?: ReturnType<typeof setInterval>;
  constructor(private manager: PluginManager) {}
  async start() {
    for (const event of ['project-opened', 'project-closed', 'project-info-updated', 'project-modified', 'p2p-data-changed', 'column-added', 'background-table-loading-complete']) {
      const unlisten = await listen<any>(event, ({ payload }) => {
        if (event === 'project-closed' || event === 'project-opened') {
          this.projectRevision++;
          // Native notifications may arrive after the initial snapshot or repeat.
          // Invalidate in-flight reads, but only the authoritative session change
          // in reconcile may dispatch close/open hooks or clear table state.
        }
        void this.refresh(payload?.table_uuid || payload?.tableUuid).catch(console.error);
      });
      if (this.stopped) unlisten(); else this.listeners.push(unlisten);
    }
    if (this.stopped) return;
    await this.refresh().catch(error => console.error('Initial plugin lifecycle snapshot failed', error));
    // Reconcile external filesystem changes and missed notifications.
    this.timer = setInterval(() => { void this.refresh().catch(console.error); }, 10000);
  }
  refresh(tableId?: string): Promise<void> {
    if (tableId) this.requestedTables.add(tableId); else this.requestedAll = true;
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.pending = true; return this.running; }
    this.running = (async () => {
      do {
        this.pending = false;
        const targets = this.requestedAll ? undefined : new Set(this.requestedTables);
        this.requestedAll = false; this.requestedTables.clear();
        await this.reconcile(targets);
      } while (this.pending && !this.stopped);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async reconcile(targets?: Set<string>) {
    const revision = this.projectRevision;
    const projects = await invoke<PluginProject[]>('get_plugin_projects');
    if (revision !== this.projectRevision) { this.pending = true; this.requestedAll = true; return; }
    const project = projects[0] || null;
    const key = (item: PluginProject | null) => item?.sessionId ?? null;
    const changedProject = key(this.project) !== key(project);
    if (this.stopped) return;
    const previousProject = this.project;
    this.project = project;
    this.manager.setHasProject(!!project);
    if (changedProject) {
      this.tables.clear();
      if (this.initialized) this.manager.setActiveTable(null);
      if (previousProject) await this.manager.dispatchLifecycle('onProjectClose', 'project-closed', previousProject);
      if (project) await this.manager.dispatchLifecycle('onProjectOpen', 'project-opened', project);
    }
    if (!project) { this.initialized = true; return; }
    const list = await invoke<Array<{ uuid: string; path: string }>>('get_table_list', { expectedProjectSession: project.sessionId });
    const next = new Map<string, TableState>();
    for (const item of list) {
      const table: TableState = { ...item };
      const old = this.tables.get(item.uuid);
      if (targets && !targets.has(item.uuid) && old) { next.set(item.uuid, { ...old, ...item }); continue; }
      try {
        const snapshot = await invoke<{ revision: string; data: string } | null>('get_plugin_table_snapshot', {
          uuid: item.uuid, expectedProjectSession: project.sessionId,
          knownRevision: old?.fingerprint === undefined ? undefined : old.revision,
        });
        if (snapshot === null) {
          if (old?.revision === undefined || old.fingerprint === undefined) throw new Error('Missing plugin table snapshot');
          table.fingerprint = old.fingerprint;
          table.revision = old.revision;
          next.set(item.uuid, table);
          continue;
        }
        const raw = snapshot.data;
        // Equality with an already canonical string proves the old parse/stringify
        // result is unchanged. A different native representation still takes the
        // original semantic comparison path (e.g. JSON numbers 1.0 versus 1).
        const fingerprint = raw === old?.fingerprint ? old.fingerprint : JSON.stringify(JSON.parse(raw));
        table.fingerprint = fingerprint === old?.fingerprint ? old.fingerprint : fingerprint;
        // Commit this pair together only after parsing/canonicalization succeeds.
        table.revision = snapshot.revision;
      } catch { // Unloaded tables still participate in create/delete detection.
        table.fingerprint = old?.fingerprint;
        table.revision = old?.revision;
      }
      next.set(item.uuid, table);
    }
    if (this.stopped) return;
    if (revision !== this.projectRevision) { this.pending = true; this.requestedAll = true; return; }
    const previous = this.tables;
    const shouldDispatch = this.initialized && !changedProject;
    const changes: Array<{ table: TableState; created: boolean }> = [];
    if (shouldDispatch) for (const [id, table] of next) {
      const old = previous.get(id);
      if (!old) changes.push({ table, created: true });
      else if ((old.fingerprint !== undefined && table.fingerprint !== old.fingerprint) || old.path !== table.path) {
        changes.push({ table, created: false });
      }
    }
    // Commit only after collection and session validation succeeded. Until here,
    // a failed/aborted reconcile leaves the entire previous snapshot available.
    this.tables = next;
    this.initialized = true;
    if (!shouldDispatch) return;
    // Changed notifications reference next; only deleted tables need old data.
    // Release replaced snapshots before awaiting any potentially slow hook.
    for (const id of next.keys()) previous.delete(id);
    for (const { table, created } of changes) {
      await this.manager.dispatchLifecycle(created ? 'onTableCreate' : 'onTableUpdate', created ? 'table-created' : 'table-updated', this.tablePayload(table, project.sessionId));
    }
    for (const [id, table] of previous) {
      if (this.manager.getAPI().app.getState().activeTable?.uuid === id) this.manager.setActiveTable(null);
      await this.manager.dispatchLifecycle('onTableDelete', 'table-deleted', this.tablePayload(table, project.sessionId));
    }
  }
  private tablePayload(table: TableState, projectSession: string) {
    // revision is an internal conditional-read token, not a new plugin payload field.
    const { revision: _revision, ...payload } = table;
    return { ...payload, data: table.fingerprint === undefined ? undefined : normalizeTableData(JSON.parse(table.fingerprint)), projectSession };
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.listeners.forEach(fn => fn()); this.listeners = []; }
}
