import { normalizeTableData } from '@/app/types/tableTypes';
import { versionedStorageKey, inheritPluginInstallation } from '@/app/settings/storageKey';
import * as projectCommands from '@/app/commands/projectCommands';
import * as tableCommands from '@/app/commands/tableCommands';
import * as tableSnapshotCache from '@/app/services/tableSnapshotCache';
import * as tableRules from '@/app/types/tableRules';
import * as tableRuleDialogs from '@/app/utils/table_rule_dialogs';
import * as fileOperations from '@/api/fileOperation';
import * as pluginFs from '@tauri-apps/plugin-fs';
// These modules are already eager dependencies. Keep the asynchronous operation
// boundaries below so session and cancellation checks retain their ordering.
import { isCompleteTheme } from '@/app/config/brand';
import { getSettingsSnapshot, initializeAppSettings } from '@/app/settings';
import { isPluginRequested, pluginSettings, scopedPluginSettings } from '@/app/settings/pluginSettings';
import type { InstalledPluginPackage } from '@/app/types/pluginPackages';
import { pluginRuntimePlan } from './pluginRuntimePlan';
import { captureProjectInteractionScope, isProjectInteractionScopeCurrent, isTableTransitionPending } from '@/app/services/tableInteractionScope';
import type { TableData } from '@/app/types/tableTypes';
import { t, message, localizedError, appErrorException, toAppError, getLocale, subscribeLocale, registerPluginMessages, translatePluginMessage } from '@/app/i18n';
import {
  Plugin,
  PluginAPI,
  PluginRegistryEntry,
  PluginEvent,
  PluginHooks,
  PluginProject
} from '@/app/types/pluginTypes';
import CSVExporterPlugin from '../plugins/examples/CSVExporterPlugin';
import { PluginPerformanceMonitor } from './PluginPerformanceMonitor';
import { PluginDependencyResolver } from './PluginDependencyResolver';
import { PluginVersionManager } from './PluginVersionManager';
import { PluginLoader } from './PluginLoader';

const errorList = (errors: unknown[]): import('@/app/types/tableRules').AppError => ({
  kind: 'diagnostics',
  diagnostics: errors.flatMap(error => {
    const value = toAppError(error);
    if (value.kind === 'diagnostics') return value.diagnostics;
    if (value.kind === 'input_validation') return value.report.issues.map(issue => issue.diagnostic);
    return [value];
  })
});

// localStorage key recording plugin IDs whose onInstall hooks have run.
// localStorage is shared by all same-origin WebviewWindow instances, including dialogs,
// so installation status is checked in one place regardless of the registering window.
const INSTALLED_PLUGINS_STORAGE_KEY = 'devcel.plugins.installed';

export class PluginManager {
  private static instance: PluginManager;
  private plugins: Map<string, PluginRegistryEntry> = new Map();
  private api: Omit<PluginAPI, 'i18n'>;
  private eventListeners: Map<string, Function[]> = new Map();
  private modalHandler: ((component: any, props: any) => Promise<any>) | null = null;

  public setModalHandler(handler: (component: any, props: any) => Promise<any>) {
    this.modalHandler = handler;
  }
  private scopedAPIs = new Map<string, PluginAPI>();
  private resources = new Map<string, Array<() => void>>();
  private activations = new Map<string, Promise<void>>();
  private commands: Map<string, Function> = new Map();
  private commandScopes = new Set<{ session: string; owner: number | null }>();
  private initialization?: Promise<void>;
  private packages = new Map<string, InstalledPluginPackage>();
  private sessionTrusted = new Set<string>();
  private failedActivations = new Map<string, string>();
  private failedStops = new Set<string>();
  private cleaningUp = false;
  private stopped = false;
  private loadedPackageDigests = new Map<string, string>();
  private activeTable: { uuid: string; projectSession: string } | null = null;
  private hasProject: boolean = false;

  private constructor() {
    this.api = this.createPluginAPI();
  }

  public static getInstance(): PluginManager {
    if (!PluginManager.instance) {
      PluginManager.instance = new PluginManager();
    }
    return PluginManager.instance;
  }

  public setActiveTable(target: { uuid: string; projectSession: string } | null) {
    this.activeTable = target ? { ...target } : null;
    this.api.events.emit('registry-changed');
  }

  private commandScopeIsCurrent(session: string): boolean {
    // A command may resume its plugin code after navigation finished. Its later
    // API calls still belong to the original generation, even with an explicit
    // UUID. Concurrent writes wait until stale commands have finished unwinding.
    return [...this.commandScopes].filter(scope => scope.session === session)
      .every(scope => isProjectInteractionScopeCurrent(session, scope.owner));
  }

  public setHasProject(value: boolean) {
    this.hasProject = value;
  }

  // Create the plugin API
  private createPluginAPI(): Omit<PluginAPI, 'i18n'> {
    return {
      app: {
        get version() { return getSettingsSnapshot().appVersion; },
        name: 'Devcel Studio',
        getState: () => {
          // Return application state
          return {
            hasProject: this.hasProject,
            activeTable: this.activeTable ? { ...this.activeTable } : null
          };
        }
      },
      project: {
        getCurrent: async () => {
          try {
            const info = await Promise.resolve().then(() => projectCommands).then(m => m.getProjectInfo());
            return info;
          } catch {
            return null;
          }
        },
        getAll: async () => {
          // Projects currently open in this Studio window: Zero or one.
          const { invoke } = await import('@tauri-apps/api/core');
          return await invoke<PluginProject[]>('get_plugin_projects');
        },
        create: async (config: any) => {
          await Promise.resolve().then(() => projectCommands).then(m => m.createProject(config));
        },
        open: async (path: string) => {
          await Promise.resolve().then(() => projectCommands).then(m => m.openProject(path));
        },
        save: async () => {
          await Promise.resolve().then(() => projectCommands).then(m => m.saveProject());
        },
        close: async () => {
          await Promise.resolve().then(() => projectCommands).then(m => m.closeProject());
        }
      },
      ui: {
        showNotification: async (message: string, type = 'info') => {
          const { message: showMessage } = await import('@/app/services/appDialogs');
          // Normalize plugin notification kinds for the shared in-app dialog.
          // Map the plugin API's 'success' to 'info'.
          const kind: 'info' | 'warning' | 'error' =
            type === 'warning' || type === 'error' ? type : 'info';
          await showMessage(message, { kind });
        },
        showDialog: async (dialogId: string, props?: any) => {
          const extension = this.getAllExtensions().dialogs.find((item: any) => item.id === dialogId);
          if (extension && this.modalHandler) return this.modalHandler(() => extension.component, { ...props, title: extension.title });
          // Simple implementation operating as a confirmation dialog
          const { ask } = await import('@/app/services/appDialogs');
          const message = props?.message || t('plugin.confirmQuestion');
          const title = props?.title || t('common.confirm');
          const type = props?.type || 'info';

          return await ask(message, {
            title,
            kind: type
          });
        },
        showSaveDialog: async (options?: any) => {
          const { save } = await import('@tauri-apps/plugin-dialog');
          return await save(options);
        },
        showModal: async (component: any, props?: any) => {
          if (this.modalHandler) {
            return await this.modalHandler(component, props);
          }
          console.warn('Plugin API: No modal handler registered');
          return null;
        },
        registerCommand: (id: string, handler: Function) => {
          if (this.commands.has(id)) {
            console.warn(`Command ${id} is already registered. Overwriting.`);
          }
          this.commands.set(id, handler);
        },
        executeCommand: async (id: string, ...args: any[]) => {
          if (isTableTransitionPending()) throw localizedError(message('grid.waitForPresentation'));
          const handler = this.commands.get(id);
          if (handler) {
            const target = this.activeTable;
            const commandScope = target ? { session: target.projectSession, owner: captureProjectInteractionScope(target.projectSession) } : null;
            if (commandScope) this.commandScopes.add(commandScope);
            try {
              return await handler(...args);
            } catch (error) {
              console.error(`Error executing command ${id}:`, error);
              throw error;
            } finally { if (commandScope) this.commandScopes.delete(commandScope); }
          } else {
            console.warn(`Command not found: ${id}`);
            return null;
          }
        }
      },
      data: {
        getTable: async (tableUuid: string, expectedProjectSession: string) => {
          const { invoke } = await import('@tauri-apps/api/core');
          return invoke<TableData>('get_table_data', { uuid: tableUuid, expectedProjectSession }).then(normalizeTableData);
        },
        getTableSnapshot: async (tableUuid: string, expectedProjectSession: string) => {
          const { loadTableByUuid } = await Promise.resolve().then(() => tableCommands);
          await loadTableByUuid(tableUuid, expectedProjectSession);
          const { requestTableSnapshot } = await Promise.resolve().then(() => tableSnapshotCache);
          const snapshot = await requestTableSnapshot(tableUuid, expectedProjectSession).promise;
          return { table: snapshot.table, revision: snapshot.presentation.revision };
        },
        updateTable: async (targetId: string, data: TableData, expectedProjectSession: string, expectedRevision: string) => {
          const scopeOwner = captureProjectInteractionScope(expectedProjectSession);
          const live = () => isProjectInteractionScopeCurrent(expectedProjectSession, scopeOwner)
            && this.commandScopeIsCurrent(expectedProjectSession);
          if (!live()) throw localizedError(message('grid.waitForPresentation'));
          if (!targetId) {
            throw localizedError(message('plugin.manager.error.noTable'));
          }
          const { invoke } = await import('@tauri-apps/api/core');
          // Delegate validation, persistence, Undo, and P2P synchronization to the backend; return failures to the caller.
          const fixed = JSON.parse(JSON.stringify(data));
          if (!live()) throw localizedError(message('grid.waitForPresentation'));
          try {
            await invoke<void>('update_plugin_table', { tableUuid: targetId, data: fixed, acknowledgement: null, expectedProjectSession, expectedRevision });
          } catch (error) {
            const { inputValidationReport } = await Promise.resolve().then(() => tableRules);
            if (!live()) throw localizedError(message('grid.waitForPresentation'));
            const report = inputValidationReport(error);
            if (!report?.acknowledgement || report.issues.some(issue => issue.mode === 'reject')) throw error;
            const { confirmInputWarnings } = await Promise.resolve().then(() => tableRuleDialogs);
            if (!live()) throw localizedError(message('grid.waitForPresentation'));
            if (!await confirmInputWarnings(targetId, report)) throw localizedError(message('plugin.manager.error.cancelled'));
            if (!live()) throw localizedError(message('grid.waitForPresentation'));
            await invoke<void>('update_plugin_table', { tableUuid: targetId, data: fixed, acknowledgement: report.acknowledgement, expectedProjectSession, expectedRevision });
          }
        },
        createTable: async (config: { path: string }, expectedProjectSession: string) => {
          const scopeOwner = captureProjectInteractionScope(expectedProjectSession);
          const live = () => isProjectInteractionScopeCurrent(expectedProjectSession, scopeOwner)
            && this.commandScopeIsCurrent(expectedProjectSession);
          if (!live()) throw localizedError(message('grid.waitForPresentation'));
          const { fileOperation } = await Promise.resolve().then(() => fileOperations);
          if (!live()) throw localizedError(message('grid.waitForPresentation'));
          const created = await fileOperation({ type: 'Create', file_type: 'Table', path: config.path }, expectedProjectSession);
          if (created.file_type !== 'Table') throw new Error('Unexpected created file type');
          const { invalidateTableCatalog } = await Promise.resolve().then(() => tableCommands);
          invalidateTableCatalog();
          return created.uuid;
        },
        deleteTable: async (tableUuid: string, expectedProjectSession: string) => {
          const scopeOwner = captureProjectInteractionScope(expectedProjectSession);
          const live = () => isProjectInteractionScopeCurrent(expectedProjectSession, scopeOwner)
            && this.commandScopeIsCurrent(expectedProjectSession);
          if (!live()) throw localizedError(message('grid.waitForPresentation'));
          const { invoke } = await import('@tauri-apps/api/core');
          if (!live()) throw localizedError(message('grid.waitForPresentation'));
          await invoke<void>('delete_plugin_table', { tableUuid, expectedProjectSession });
          const { invalidateTableCatalog } = await Promise.resolve().then(() => tableCommands);
          invalidateTableCatalog();
        }
      },
      settings: pluginSettings,
      fs: {
        readFile: async (path: string) => {
          const { readTextFile } = await Promise.resolve().then(() => pluginFs);
          return await readTextFile(path);
        },
        writeFile: async (path: string, content: string) => {
          const { writeTextFile } = await Promise.resolve().then(() => pluginFs);
          await writeTextFile(path, content);
        },
        exists: async (path: string) => {
          const { exists } = await Promise.resolve().then(() => pluginFs);
          return await exists(path);
        },
        mkdir: async (path: string) => {
          const { mkdir } = await Promise.resolve().then(() => pluginFs);
          await mkdir(path, { recursive: true });
        },
        readDir: async (path: string) => {
          const { readDir } = await Promise.resolve().then(() => pluginFs);
          const entries = await readDir(path);
          return entries.map(e => e.name);
        }
      },
      events: {
        on: (event: string, handler: Function) => {
          if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
          }
          this.eventListeners.get(event)!.push(handler);
          return () => {
            const handlers = this.eventListeners.get(event);
            if (handlers) {
              const index = handlers.indexOf(handler);
              if (index > -1) {
                handlers.splice(index, 1);
              }
            }
          };
        },
        emit: (event: string, ...args: any[]) => {
          const handlers = this.eventListeners.get(event);
          if (handlers) {
            handlers.forEach(handler => {
              try {
                const result = handler(...args);
                if (result && typeof result.then === 'function') Promise.resolve(result).catch(error => console.error(`Async plugin event handler failed: ${event}`, error));
              } catch (error) {
                console.error(`Error in event handler for ${event}:`, error);
              }
            });
          }
        },
        once: (event: string, handler: Function) => {
          let unsubscribe = () => {};
          const onceHandler = (...args: any[]) => {
            unsubscribe();
            handler(...args);
          };
          unsubscribe = this.api.events.on(event, onceHandler);
          return unsubscribe;
        }
      }
    };
  }

  // Read the set of initially installed plugin IDs from localStorage
  private loadInstalledPluginIds(): Set<string> {
    try {
      const raw = localStorage.getItem(versionedStorageKey(INSTALLED_PLUGINS_STORAGE_KEY, getSettingsSnapshot().appVersion));
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set(parsed) : new Set();
    } catch {
      return new Set();
    }
  }

  // Persist the plugin's initial installation status
  private markPluginInstalled(pluginId: string): void {
    const ids = this.loadInstalledPluginIds();
    if (ids.has(pluginId)) return;
    ids.add(pluginId);
    try {
      localStorage.setItem(
        versionedStorageKey(INSTALLED_PLUGINS_STORAGE_KEY, getSettingsSnapshot().appVersion),
        JSON.stringify(Array.from(ids))
      );
    } catch (error) {
      console.warn('Failed to persist installed plugin state:', error);
    }
  }

  // Clear installation status on uninstall
  private unmarkPluginInstalled(pluginId: string): void {
    const ids = this.loadInstalledPluginIds();
    if (!ids.delete(pluginId)) return;
    try {
      localStorage.setItem(
        versionedStorageKey(INSTALLED_PLUGINS_STORAGE_KEY, getSettingsSnapshot().appVersion),
        JSON.stringify(Array.from(ids))
      );
    } catch (error) {
      console.warn('Failed to persist installed plugin state:', error);
    }
  }

  public async dispatchLifecycle(hook: keyof PluginHooks, event: string, data: any): Promise<void> {
    this.api.events.emit(event, data);
    for (const [id, entry] of this.getActivePlugins()) {
      const handler = entry.plugin.hooks?.[hook];
      if (!this.canRun(id) || !handler) continue;
      try { await this.measure(id, 'event_handler', async () => (handler as Function)(this.scopedAPI(id), data)); }
      catch (error) {
        entry.error = error instanceof Error ? error : appErrorException(error);
        this.emitPluginEvent('error', id, entry.plugin, entry.error);
        // One plugin's failed hook must not suppress another plugin's hook.
      }
    }
  }

  public async measure<T>(id: string, operation: 'activation' | 'deactivation' | 'api_call' | 'event_handler', fn: () => Promise<T>): Promise<T> {
    const monitor = PluginPerformanceMonitor.getInstance();
    const measurement = monitor.startMeasurement(id, operation);
    try { const value = await fn(); monitor.endMeasurement(measurement, true); return value; }
    catch (error) { monitor.endMeasurement(measurement, false, error instanceof Error ? error : appErrorException(error)); throw error; }
  }

  public getDependencyResolver(): PluginDependencyResolver {
    const resolver = new PluginDependencyResolver();
    for (const entry of this.plugins.values()) resolver.addPlugin(entry.plugin);
    return resolver;
  }

  private scopedAPI(id: string): PluginAPI {
    const existing = this.scopedAPIs.get(id);
    if (existing) return existing;
    const track = (cleanup: () => void) => { this.resources.set(id, [...(this.resources.get(id) || []), cleanup]); return cleanup; };
    const canDispatch = () => this.plugins.get(id)?.status === 'active' && this.canRun(id);
    const settings = scopedPluginSettings(id);
    const api: PluginAPI = { ...this.api,
      i18n: {
        getLocale,
        subscribe: callback => track(subscribeLocale(() => { if (canDispatch()) callback(getLocale()); })),
        registerMessages: messages => track(registerPluginMessages(id, messages)),
        t: (key, values, fallback) => translatePluginMessage(id, key, values, fallback)
      }, ui: { ...this.api.ui,
      registerCommand: (command, handler) => {
        if (this.commands.has(command)) throw localizedError(message('plugin.manager.error.commandRegistered', { command }));
        const guarded = (...args: any[]) => {
          if (!this.canRun(id) || this.plugins.get(id)?.status !== 'active') throw localizedError(message('plugin.bridge.inactive'));
          return handler(...args);
        };
        this.commands.set(command, guarded);
        track(() => { if (this.commands.get(command) === guarded) this.commands.delete(command); });
      }
    }, events: { ...this.api.events,
      on: (event, handler) => track(this.api.events.on(event, (...args: any[]) => { if (canDispatch()) return handler(...args); })),
      // A blocked event does not consume once. Runtime stop still releases the subscription.
      once: (event, handler) => { let off = () => {}; off = track(this.api.events.on(event, (...args: any[]) => {
        if (!canDispatch()) return;
        off(); return handler(...args);
      })); return off; }
    }, settings: { ...settings, watchRows: (tableId, callback) => track(settings.watchRows(tableId, value => { if (canDispatch()) callback(value); })), watchTable: (tableId, callback) => track(settings.watchTable(tableId, value => { if (canDispatch()) callback(value); })), watch: (key, callback) => track(settings.watch(key, value => { if (canDispatch()) callback(value); })) } };
    this.scopedAPIs.set(id, api);
    return api;
  }
  private releaseResources(id: string) {
    for (const cleanup of this.resources.get(id) || []) { try { cleanup(); } catch (error) { console.error(error); } }
    this.resources.delete(id); this.scopedAPIs.delete(id);
  }

  /** Registration never runs hooks or changes preferences/permissions. */
  public async registerPlugin(plugin: Plugin, options: { trustedSession?: boolean } = {}): Promise<void> {
    const id = plugin.metadata.id;
    if (this.stopped) throw localizedError(message('plugin.bridge.closed'));
    if (!/^[a-z0-9._-]+$/.test(id) || typeof plugin.activate !== 'function' || typeof plugin.deactivate !== 'function') throw localizedError(message('plugin.manager.error.invalidDefinition'));
    PluginVersionManager.getInstance().validateMetadata(plugin.metadata);
    if (plugin.extensions?.themes?.some(theme => !isCompleteTheme(theme))) throw localizedError(message('plugin.manager.error.invalidDefinition'));
    if (this.plugins.has(id)) throw localizedError(message('plugin.manager.error.registered', { id }));
    if (options.trustedSession) this.sessionTrusted.add(id);
    this.plugins.set(id, { plugin, status: 'installed', settings: { enabled: isPluginRequested(id) }, loadTime: Date.now() });
    this.emitPluginEvent('installed', id, plugin);
  }

  private metadata() {
    const result = new Map([...this.plugins].map(([id, entry]) => [id, entry.plugin.metadata]));
    for (const [id, item] of this.packages) result.set(id, item.metadata);
    return result;
  }
  private permitted(id: string): boolean {
    if (this.failedStops.has(id)) return false;
    if (['csv-exporter'].includes(id)) return true;
    const item = this.packages.get(id);
    return item ? item.approved && item.enabled : this.sessionTrusted.has(id);
  }
  public canRun(id: string): boolean {
    return !this.stopped && !this.cleaningUp && pluginRuntimePlan(this.metadata(), isPluginRequested, key => this.permitted(key)).ready.has(id);
  }
  private activationKey(id: string) {
    const settings = getSettingsSnapshot();
    return `${settings.generation}:${settings.revision}:${this.packages.get(id)?.digest ?? 'builtin'}`;
  }

  private registryState(): string {
    // Only serializable native metadata and public runtime state, never plugin callbacks.
    const state = {
      packages: [...this.packages].sort(([a], [b]) => a.localeCompare(b)),
      plugins: [...this.plugins].map(([id, entry]) => [id, entry.status, entry.settings.enabled,
        entry.error ? toAppError(entry.error) : null, this.loadedPackageDigests.get(id) ?? null]),
    };
    return JSON.stringify(state, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  }

  /** Called only on the main bridge's serialized mutation queue. */
  public async reconcileSettings(retry = false, requiredId?: string): Promise<void> {
    if (this.stopped || this.cleaningUp) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const packages = await invoke<InstalledPluginPackage[]>('list_installed_plugin_packages');
    if (this.stopped) return;
    const previousState = this.registryState();
    this.packages = new Map(packages.map(item => [item.metadata.id, item]));
    // Carry verified install bookkeeping even for disabled packages, so skipping
    // activation in an intermediate app release does not rerun onInstall later.
    for (const item of packages) {
      if (item.migratedFromVersion) {
        try { inheritPluginInstallation(localStorage, item.metadata.id, item.migratedFromVersion, getSettingsSnapshot().appVersion); }
        catch (error) { console.warn('Plugin installation bookkeeping migration deferred:', error); }
      }
    }
    if (retry && requiredId) this.failedActivations.delete(requiredId);
    for (const [id, entry] of this.plugins) {
      const enabled = isPluginRequested(id);
      if (entry.settings.enabled !== enabled) entry.settings = { enabled };
    }
    const plan = pluginRuntimePlan(this.metadata(), isPluginRequested, id => this.permitted(id));
    // Stop dependents first, including definitions whose installed content changed.
    const obsolete = new Set([...this.loadedPackageDigests].filter(([id, digest]) => this.packages.get(id)?.digest !== digest).map(([id]) => id));
    const mustStop = new Set([...this.plugins].filter(([id, entry]) => entry.status === 'active' && (!plan.ready.has(id) || obsolete.has(id))).map(([id]) => id));
    for (const id of obsolete) for (const dependent of this.getDependencyResolver().analyzeRemovalImpact(id).cascadeRemovals) mustStop.add(dependent);
    const stopOrder = this.getDependencyResolver().resolveDependencies().order;
    for (const id of [...(stopOrder.length ? stopOrder : this.plugins.keys())].reverse()) {
      if (mustStop.has(id)) await this.deactivatePlugin(id);
    }
    for (const id of obsolete) this.discardPackageDefinition(id);
    const failures: unknown[] = [];
    for (const id of plan.order) {
      if (!this.canRun(id)) continue; // A newer table snapshot can arrive during any await.
      if (this.failedActivations.get(id) === this.activationKey(id)) continue;
      const attemptKey = this.activationKey(id);
      try {
        if (this.packages.has(id) && !this.plugins.has(id)) await this.loadPackage(id);
        if (!this.canRun(id)) continue;
        await this.activatePlugin(id);
      } catch (error) { this.failedActivations.set(id, attemptKey); failures.push(error); }
    }
    for (const [id, entry] of this.plugins) {
      if (entry.status === 'active' || this.failedStops.has(id)) continue;
      if (isPluginRequested(id) && !this.canRun(id)) {
        const error = localizedError(message('plugin.settings.blocked'));
        if (entry.status !== 'error' || JSON.stringify(toAppError(entry.error)) !== JSON.stringify(toAppError(error))) {
          entry.status = 'error'; entry.error = error;
        }
      } else if (!isPluginRequested(id)) { entry.status = 'inactive'; entry.error = undefined; }
    }
    // Poll every time for safety, but do not disturb open UI when nothing changed.
    if (previousState !== this.registryState()) this.api.events.emit('registry-changed');
    if (failures.length) console.error('Plugin reconciliation errors', errorList(failures));
    if (requiredId && this.canRun(requiredId) && this.plugins.get(requiredId)?.status !== 'active') {
      throw this.plugins.get(requiredId)?.error ?? localizedError(message('plugin.settings.blocked'));
    }
  }

  /** Runtime only. Dependencies must already be active; never enable them implicitly. */
  public activatePlugin(id: string): Promise<void> {
    const running = this.activations.get(id);
    if (running) return running;
    const operation = this.activateSingle(id).finally(() => this.activations.delete(id));
    this.activations.set(id, operation); return operation;
  }
  private async activateSingle(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) throw localizedError(message('plugin.manager.error.missing', { id }));
    if (!this.canRun(id)) throw localizedError(message('plugin.settings.blocked'));
    if (entry.status === 'active') return;
    for (const dependency of Object.keys(entry.plugin.metadata.dependencies || {})) {
      if (!this.canRun(dependency) || this.plugins.get(dependency)?.status !== 'active') throw localizedError(message('plugin.settings.blocked'));
    }
    const request = this.activationKey(id);
    try {
      PluginVersionManager.getInstance().validateMetadata(entry.plugin.metadata);
      if (entry.plugin.extensions?.themes?.some(theme => !isCompleteTheme(theme))) throw localizedError(message('plugin.manager.error.invalidDefinition'));
      entry.status = 'loading';
      await this.measure(id, 'activation', async () => {
        if (entry.plugin.hooks?.onInstall && !this.loadInstalledPluginIds().has(id)) {
          await entry.plugin.hooks.onInstall(this.scopedAPI(id)); this.markPluginInstalled(id);
        }
        if (request !== this.activationKey(id) || !this.canRun(id)) throw localizedError(message('plugin.settings.blocked'));
        if (entry.plugin.hooks?.onActivate) await entry.plugin.hooks.onActivate(this.scopedAPI(id));
        if (request !== this.activationKey(id) || !this.canRun(id)) throw localizedError(message('plugin.settings.blocked'));
        await entry.plugin.activate(this.scopedAPI(id));
      });
      if (request !== this.activationKey(id) || !this.canRun(id)) throw localizedError(message('plugin.settings.blocked'));
      entry.status = 'active'; entry.error = undefined;
      this.emitPluginEvent('activated', id, entry.plugin);
    } catch (error) {
      entry.status = 'error'; entry.error = error instanceof Error ? error : appErrorException(error);
      try { await entry.plugin.deactivate(); } catch (stopError) { this.failedStops.add(id); console.error(stopError); }
      this.releaseResources(id); this.emitPluginEvent('error', id, entry.plugin, entry.error); throw error;
    }
  }

  /** Runtime only; the table selection and installation safety latch are untouched. */
  public async deactivatePlugin(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry || entry.status !== 'active') return;
    const dependents = this.getDependencyResolver().analyzeRemovalImpact(id).cascadeRemovals.filter(key => this.plugins.get(key)?.status === 'active' || this.failedStops.has(key));
    if (dependents.length) throw localizedError(message('plugin.manager.error.deactivateDependents', { plugins: dependents.join(', ') }));
    try {
      await this.measure(id, 'deactivation', async () => {
        if (entry.plugin.hooks?.onDeactivate) await entry.plugin.hooks.onDeactivate(this.scopedAPI(id));
        await entry.plugin.deactivate();
      });
      this.releaseResources(id); entry.status = 'inactive'; entry.error = undefined;
      this.emitPluginEvent('deactivated', id, entry.plugin);
    } catch (error) {
      this.failedStops.add(id); entry.status = 'error'; entry.error = error instanceof Error ? error : appErrorException(error);
      this.releaseResources(id); this.emitPluginEvent('error', id, entry.plugin, entry.error); throw error;
    }
  }

  // Drop an already stopped package definition after replacing/restoring its ZIP.
  // Keeping stale code registered could execute it through dependency activation.
  public discardPackageDefinition(pluginId: string): void {
    const entry = this.plugins.get(pluginId);
    if (entry?.status === 'active' || entry?.status === 'loading') throw localizedError(message('plugin.manager.error.stopBeforeReplace'));
    if (entry) {
      this.releaseResources(pluginId);
      this.plugins.delete(pluginId);
    }
    this.loadedPackageDigests.delete(pluginId);
    this.sessionTrusted.delete(pluginId);
    this.api.events.emit('registry-changed');
  }

  // Uninstall a plugin
  public async uninstallPlugin(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) {
      throw localizedError(message('plugin.manager.error.missing', { id: pluginId }));
    }

    try {
      const dependents = this.getDependencyResolver().analyzeRemovalImpact(pluginId).cascadeRemovals;
      if (dependents.length) throw localizedError(message('plugin.manager.error.uninstallDependents', { plugins: dependents.join(', ') }));
      // Deactivate first if active
      if (entry.status === 'active') {
        await this.deactivatePlugin(pluginId);
      }

      // Run the uninstall hook
      if (entry.plugin.hooks?.onUninstall) {
        await entry.plugin.hooks.onUninstall(this.scopedAPI(pluginId));
      }

      this.releaseResources(pluginId);
      this.plugins.delete(pluginId);
      this.loadedPackageDigests.delete(pluginId);
      this.sessionTrusted.delete(pluginId);
      // Also clear persisted installation status so onInstall runs on the next registration
      this.unmarkPluginInstalled(pluginId);
      this.emitPluginEvent('uninstalled', pluginId, entry.plugin);

    } catch (error) {
      console.error(`Failed to uninstall plugin ${pluginId}:`, error);
      throw error;
    }
  }

  // Get the plugin list
  public getPlugins(): Map<string, PluginRegistryEntry> {
    return new Map(this.plugins);
  }

  // Get active plugins
  public getActivePlugins(): Map<string, PluginRegistryEntry> {
    const activePlugins = new Map<string, PluginRegistryEntry>();
    for (const [id, entry] of this.plugins) {
      if (entry.status === 'active' && this.canRun(id)) {
        activePlugins.set(id, entry);
      }
    }
    return activePlugins;
  }

  // Get a specific plugin
  public getPlugin(pluginId: string): PluginRegistryEntry | undefined {
    return this.plugins.get(pluginId);
  }

  // Send a plugin event
  private emitPluginEvent(type: PluginEvent['type'], pluginId: string, plugin?: Plugin, error?: Error): void {
    const event: PluginEvent = {
      type,
      pluginId,
      plugin,
      error,
      timestamp: Date.now()
    };

    this.api.events.emit('registry-changed');
    this.api.events.emit('plugin-event', event);
    this.api.events.emit(`plugin-${type}`, event);
  }

  // Get all active plugins
  public getAllExtensions(): any {
    const extensions = {
      menus: new Map(),
      toolbarButtons: [] as any[],
      contextMenus: new Map(),
      sidePanels: [] as any[],
      dialogs: [] as any[],
      dataProcessors: [] as any[],
      exporters: [] as any[],
      importers: [] as any[],
      themes: [] as any[],
    };

    for (const [_id, entry] of this.getActivePlugins()) {
      if (entry.plugin.extensions) {
        const ext = entry.plugin.extensions;

        if (ext.menus) {
          for (const [menuId, config] of Object.entries(ext.menus)) {
            extensions.menus.set(menuId, config);
          }
        }

        if (ext.toolbarButtons) {
          extensions.toolbarButtons.push(...ext.toolbarButtons);
        }

        if (ext.contextMenus) {
          for (const [contextId, items] of Object.entries(ext.contextMenus)) {
            if (!extensions.contextMenus.has(contextId)) {
              extensions.contextMenus.set(contextId, []);
            }
            extensions.contextMenus.get(contextId)!.push(...items);
          }
        }

        if (ext.sidePanels) extensions.sidePanels.push(...ext.sidePanels);
        if (ext.dialogs) extensions.dialogs.push(...ext.dialogs);
        if (ext.dataProcessors) extensions.dataProcessors.push(...ext.dataProcessors);
        if (ext.exporters) extensions.exporters.push(...ext.exporters);
        if (ext.importers) extensions.importers.push(...ext.importers);
        if (ext.themes) extensions.themes.push(...ext.themes);
      }
    }

    return extensions;
  }


  public subscribe(handler: () => void): () => void {
    return this.api.events.on('registry-changed', handler);
  }

  public getAPI(): Omit<PluginAPI, 'i18n'> { return this.api; }

  // main Webview only. Other windows use PluginBridge and never evaluate code.
  public initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.initializeOnce();
    return this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    await initializeAppSettings();
    for (const plugin of [CSVExporterPlugin]) {
      const settings = getSettingsSnapshot();
      if (settings.migratedFromVersion) {
        try { inheritPluginInstallation(localStorage, plugin.metadata.id, settings.migratedFromVersion, settings.appVersion); }
        catch (error) { console.warn('Built-in installation bookkeeping migration deferred:', error); }
      }
      if (!this.plugins.has(plugin.metadata.id)) await this.registerPlugin(plugin);
    }
    await this.reconcileSettings().catch(error => { console.error('Plugin startup failed', error); this.api.events.emit('package-load-error', error); });
  }

  /** Load only current, explicitly permitted content. Starting is a separate step. */
  public async loadPackage(id: string): Promise<void> {
    if (['csv-exporter'].includes(id)) throw localizedError(message('plugin.manager.error.builtInReplacement'));
    const item = this.packages.get(id);
    if (!item || !this.canRun(id)) throw localizedError(message('plugin.settings.blocked'));
    const { invoke } = await import('@tauri-apps/api/core');
    const source = await invoke<{ metadata: Plugin['metadata']; code: string; trusted: boolean; digest: string }>(
      'get_installed_plugin_source', { pluginId: id, expectedDigest: item.digest });
    if (!this.canRun(id)) return;
    if (source.trusted !== true || source.metadata.id !== id || source.digest !== item.digest) throw localizedError(message('plugin.manager.error.untrusted'));
    if (this.loadedPackageDigests.get(id) === source.digest && this.plugins.has(id)) return;
    const result = await PluginLoader.getInstance().loadFromCode(source.code, `${id}:${source.digest}`, true);
    if (!result.success || !result.plugin) throw result.error || localizedError(message('plugin.manager.error.invalidPlugin'));
    if (result.plugin.metadata.id !== id || result.plugin.metadata.version !== source.metadata.version) throw localizedError(message('plugin.manager.error.manifestMismatch'));
    result.plugin.metadata = source.metadata;
    await this.registerPlugin(result.plugin);
    this.loadedPackageDigests.set(id, source.digest);
  }

  // Cleanup
  public async cleanup(): Promise<void> {
    if (this.cleaningUp) return;
    this.cleaningUp = true; this.stopped = true;

    const order = this.getDependencyResolver().resolveDependencies().order;
    for (const pluginId of (order.length ? order : [...this.plugins.keys()]).reverse()) {
      const entry = this.plugins.get(pluginId)!;
      if (entry.status === 'active') {
        try {
          await this.deactivatePlugin(pluginId);
        } catch (error) {
          console.error(`Error deactivating plugin ${pluginId} during cleanup:`, error);
        }
      }
    }

    for (const id of this.plugins.keys()) this.releaseResources(id);
    this.plugins.clear(); this.packages.clear(); this.sessionTrusted.clear(); this.failedActivations.clear(); this.failedStops.clear(); this.loadedPackageDigests.clear();
    this.initialization = undefined;
    this.cleaningUp = false;
    this.eventListeners.clear();

  }
}
