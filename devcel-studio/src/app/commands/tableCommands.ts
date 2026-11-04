import { localizedError, message } from '@/app/i18n';
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DemandTableLoader, type TableLoadingSession } from "@/app/utils/DemandTableLoader";

const tableLoader = new DemandTableLoader(async (path, expectedProjectSession) => {
  const result = await invoke<string>('load_table', { path, expectedProjectSession });
  if (result === 'ok' && tableLoader.currentSession?.id === expectedProjectSession) {
    window.dispatchEvent(new CustomEvent('devcel-table-loaded'));
  }
  return result;
});
let suspended = false;
let sessionRequest: Promise<TableLoadingSession> | null = null;
let catalogCache: { sessionId: string; expires: number; promise: Promise<TableReference[]> } | null = null;
let catalogListenersStarted = false;
let displayCatalogCache: { sessionId: string; promise: Promise<TableReference[]> } | null = null;

export function isTableLoadingSessionCurrent(id: string): boolean {
  return !suspended && tableLoader.currentSession?.id === id;
}

export function invalidateTableCatalog(): void {
  catalogCache = null;
  displayCatalogCache = null;
  window.dispatchEvent(new CustomEvent('devcel-table-catalog-invalidated'));
}

/** Publish an authoritative local metadata edit without rereading every file.
 * The UUID remains the identity; only the presentation label changes. */
export function publishTableDisplayName(tableUuid: string, displayName: string, expectedProjectSession: string): void {
  if (!isTableLoadingSessionCurrent(expectedProjectSession)) return;
  if (catalogCache?.sessionId === expectedProjectSession) catalogCache = null;
  if (displayCatalogCache?.sessionId === expectedProjectSession) {
    const promise = displayCatalogCache.promise.then(tables => tables.map(table =>
      table.uuid === tableUuid ? { ...table, display_name: displayName } : table));
    displayCatalogCache = { sessionId: expectedProjectSession, promise };
    void promise.catch(() => { if (displayCatalogCache?.promise === promise) displayCatalogCache = null; });
  }
  // Supersede any already pending tree read before it can publish an old label.
  // The tree's debounced refresh reuses the patched promise, not another scan.
  window.dispatchEvent(new CustomEvent('devcel-table-catalog-invalidated'));
}

function ensureCatalogListeners(): void {
  if (catalogListenersStarted) return;
  catalogListenersStarted = true;
  for (const event of ['project-modified', 'project-info-updated', 'project-opened', 'project-closed', 'p2p-data-changed', 'settings-project-data-changed', 'table-updated', 'tauri://focus']) {
    void listen(event, invalidateTableCatalog).catch(error => console.error('Failed to receive table catalog update notifications:', error));
  }
}

export function setTableLoadingSession(session: TableLoadingSession | null): void {
  if (tableLoader.currentSession?.id !== session?.id) invalidateTableCatalog();
  suspended = false;
  tableLoader.setSession(session);
}

export function cancelTableLoads(): void {
  suspended = true;
  invalidateTableCatalog();
  sessionRequest = null;
  tableLoader.cancel();
}

async function getLoadingSession(expectedSessionId: string): Promise<TableLoadingSession> {
  if (suspended) throw localizedError(message('grid.loading.switchingProject'));
  const current = tableLoader.currentSession;
  if (current) {
    if (current.id !== expectedSessionId) throw localizedError(message('grid.loading.sessionChanged'));
    return current;
  }
  // Separate dialog windows have their own JS context. Check the authoritative
  // session and coalesce simultaneous cells without assuming MainWindow exists.
  if (!sessionRequest) {
    const revision = tableLoader.revision;
    const request = invoke<TableLoadingSession | null>('get_project_session').then(session => {
      if (suspended || revision !== tableLoader.revision) throw localizedError(message('grid.loading.sessionChanged'));
      if (!session) throw localizedError(message('grid.loading.noProject'));
      setTableLoadingSession(session);
      return session;
    });
    sessionRequest = request;
    void request.then(() => { if (sessionRequest === request) sessionRequest = null; }, () => { if (sessionRequest === request) sessionRequest = null; });
  }
  const session = await sessionRequest;
  if (session.id !== expectedSessionId) throw localizedError(message('grid.loading.sessionChanged'));
  return session;
}

/**
 * Table data reference
 */
export interface TableReference {
  path: string;
  uuid: string;
  data_name: string;
  display_name: string;
}

/**
 * Load the table at the specified path
 * @param tablePath Path to the table file
 * @returns "ok" on success, or an error message on failure
 */
export async function loadTable(tablePath: string, expectedProjectSession: string): Promise<string> {
  const session = await getLoadingSession(expectedProjectSession);
  return tableLoader.ensure(tablePath, session.id);
}

/**
 * Get the list of loaded tables
 * @returns List of loaded tables
 */
export async function getLoadedTables(expectedProjectSession: string): Promise<TableReference[]> {
  return await invoke<TableReference[]>("get_loaded_tables", { expectedProjectSession });
}

/**
 * Reload the table with the specified UUID
 * @param tableUuid Table UUID
 * @returns "ok" on success, or an error message on failure
 */
export async function reloadTable(tableUuid: string): Promise<string> {
  return await invoke<string>("reload_table", { uuid: tableUuid });
}

/**
 * Change a table's display name
 * @param tableUuid Table UUID
 * @param newName New display name
 * @returns "ok" on success, or an error message on failure
 */
export async function renameTableDisplayName(tableUuid: string, newName: string, expectedProjectSession: string): Promise<string> {
  const result = await invoke<string>("rename_table_display_name", { tableUuid, newName, expectedProjectSession });
  if (result === 'ok') invalidateTableCatalog();
  return result;
}

/** Metadata discovery is explicit. It never fills the content-loading queue. */
export async function getTableCatalog(expectedProjectSession: string): Promise<TableReference[]> {
  const session = await getLoadingSession(expectedProjectSession);
  ensureCatalogListeners();
  if (catalogCache?.sessionId === session.id && catalogCache.expires > Date.now()) return catalogCache.promise;
  const revision = tableLoader.revision;
  const promise = invoke<TableReference[]>('get_table_catalog', { expectedProjectSession: session.id }).then(tables => {
    if (revision !== tableLoader.revision) throw localizedError(message('grid.loading.sessionChanged'));
    if (catalogCache?.promise === promise) catalogCache.expires = Date.now() + 5000;
    return tables;
  });
  catalogCache = { sessionId: session.id, expires: Infinity, promise };
  void promise.catch(() => { if (catalogCache?.promise === promise) catalogCache = null; });
  return promise;
}

/** Display-only discovery is cached until an actual source/focus invalidation.
 * It never loads records, and is deliberately not used for reference integrity. */
export async function getTableDisplayCatalog(expectedProjectSession: string): Promise<TableReference[]> {
  const session = await getLoadingSession(expectedProjectSession);
  ensureCatalogListeners();
  if (displayCatalogCache?.sessionId === session.id) return displayCatalogCache.promise;
  const revision = tableLoader.revision;
  const promise = invoke<TableReference[]>('get_table_display_catalog', { expectedProjectSession: session.id }).then(tables => {
    if (revision !== tableLoader.revision) throw localizedError(message('grid.loading.sessionChanged'));
    return tables;
  });
  displayCatalogCache = { sessionId: session.id, promise };
  void promise.catch(() => { if (displayCatalogCache?.promise === promise) displayCatalogCache = null; });
  return promise;
}

/** Resolve a reference target from metadata, then load only that requested table. */
export async function loadTableByUuid(tableUuid: string, expectedProjectSession: string): Promise<void> {
  const session = await getLoadingSession(expectedProjectSession);
  const catalog = await getTableCatalog(session.id);
  const table = catalog.find(item => item.uuid === tableUuid);
  if (!table) throw localizedError(message('grid.loading.referenceNotFound'));
  const result = await loadTable(table.path, session.id);
  if (result !== 'ok') throw new Error(result);
}
