import { subscribeSettings } from '@/app/settings';
import { showOptions } from '@/app/utils/options';
import { message, localizedError, subscribeLocale, toAppError, appErrorException, type AppError } from '@/app/i18n';
import { emit, emitTo, listen, UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { PluginPerformanceMonitor } from './PluginPerformanceMonitor';
import { PluginLoader } from './PluginLoader';
import { PluginLifecycle } from './PluginLifecycle';
import { PluginManager } from './PluginManager';
import { PluginPackageTransactions } from './PluginPackageTransactions';
import { Plugin, PluginRegistryEntry, PluginEvent } from '@/app/types/pluginTypes';

const REQUEST = 'devcel-plugin-request';
const RESPONSE = 'devcel-plugin-response';
const CHANGED = 'devcel-plugin-changed';
const PLUGIN_EVENT = 'devcel-plugin-event';
const MAX_BYTES = 32 * 1024 * 1024;
type Request = { id: string; sender: string; method: string; args: any };
type Response = { id: string; kind: 'success'; value: any } | { id: string; kind: 'error'; error: AppError };

// Tauri events carry JSON, not functions, Map, File or Blob. No plugin is evaluated
// in a dialog: callback descriptors route execution to the owning main registry.
export async function encodePluginValue(value: any): Promise<any> {
  if (value instanceof Blob) {
    if (value.size > MAX_BYTES) throw localizedError(message('plugin.bridge.sizeLimit'));
    return { __pluginWire: 'blob', type: value.type, name: typeof File !== 'undefined' && value instanceof File ? value.name : undefined,
      bytes: Array.from(new Uint8Array(await value.arrayBuffer())) };
  }
  if (value instanceof Error) return { __pluginWire: 'error', error: toAppError(value) };
  if (Array.isArray(value)) return Promise.all(value.map(encodePluginValue));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encodePluginValue(item)]));
    return Object.fromEntries(entries);
  }
  return value;
}
export function decodePluginValue(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (value.__pluginWire === 'blob') return value.name !== undefined
    ? new File([new Uint8Array(value.bytes)], value.name, { type: value.type })
    : new Blob([new Uint8Array(value.bytes)], { type: value.type });
  if (value.__pluginWire === 'error') return appErrorException(value.error);
  if (Array.isArray(value)) return value.map(decodePluginValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodePluginValue(item)]));
}

export class PluginBridge {
  private static instance: PluginBridge;
  readonly isMain: boolean;
  private readonly label: string;
  private connected?: Promise<void>;
  private ready: Promise<void> = Promise.resolve();
  private callbacks = new Map<string, { pluginId: string; fn: Function }>();
  private observers = new Set<() => void>();
  private eventObservers = new Set<(event: PluginEvent) => void>();
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private mutations: Promise<any> = Promise.resolve();
  private lifecycle?: PluginLifecycle;
  private sequence = 0;
  private packages?: PluginPackageTransactions;
  private listeners: UnlistenFn[] = [];
  private permissionTimer?: ReturnType<typeof setInterval>;
  private refreshRunning?: Promise<void>;
  private refreshPending = false;
  private disposed = false;
  private constructor() {
    try { this.label = getCurrentWebviewWindow().label; } catch { this.label = 'main'; }
    this.isMain = this.label === 'main';
  }
  static request(method: string, args: any = {}): Promise<any> { return this.getInstance().request(method, args); }
  static getInstance(): PluginBridge { return this.instance ||= new PluginBridge(); }
  subscribe(handler: () => void): () => void { this.observers.add(handler); return () => this.observers.delete(handler); }
  onPluginEvent(handler: (event: PluginEvent) => void): () => void { this.eventObservers.add(handler); return () => this.eventObservers.delete(handler); }
  private pluginEvent(event: PluginEvent) { this.eventObservers.forEach(handler => { try { handler(event); } catch (error) { console.error(error); } }); }
  private changed() { this.observers.forEach(fn => fn()); }
  connect(): Promise<void> { return this.connected ||= this.connectOnce(); }
  private async connectOnce(): Promise<void> {
    if (this.isMain) {
      const manager = PluginManager.getInstance();
      this.listeners.push(await listen<Request>(REQUEST, async ({ payload }) => {
        if (!payload || typeof payload.id !== 'string' || typeof payload.sender !== 'string') return;
        let response: Response;
        try { await this.ready; response = { id: payload.id, kind: 'success', value: await encodePluginValue(await this.dispatch(payload.method, decodePluginValue(payload.args))) }; }
        catch (error) { response = { id: payload.id, kind: 'error', error: toAppError(error) }; }
        await emitTo(payload.sender, RESPONSE, response).catch(console.error);
      }));
      this.listeners.push(manager.subscribe(() => { this.changed(); void emit(CHANGED).catch(console.error); }));
      // Refresh translated descriptors without reinitializing or reactivating plugins.
      this.listeners.push(subscribeLocale(() => { this.changed(); void emit(CHANGED).catch(console.error); }));
      this.listeners.push(manager.getAPI().events.on('plugin-event', (event: PluginEvent) => {
        this.pluginEvent(event);
        void emit(PLUGIN_EVENT, { type: event.type, pluginId: event.pluginId, timestamp: event.timestamp, error: event.error ? toAppError(event.error) : undefined }).catch(console.error);
      }));
      // Settings invalidations join the same queue as explicit package transactions.
      this.listeners.push(subscribeSettings(this.refreshPermissions));
      window.addEventListener('focus', this.refreshPermissions);
      // Separate Studio processes do not share Tauri events. Reconcile missed package changes.
      this.permissionTimer = setInterval(this.refreshPermissions, 10_000);
      this.ready = manager.initialize();
      await this.ready;
      this.lifecycle = new PluginLifecycle(manager);
      await this.lifecycle.start().catch(error => { console.error('Plugin lifecycle listener failed', error); });
    } else {
      this.listeners.push(await listen<Response>(RESPONSE, ({ payload }) => {
        const call = this.pending.get(payload.id);
        if (!call) return;
        this.pending.delete(payload.id); clearTimeout(call.timer);
        if (payload.kind === 'error') call.reject(appErrorException(payload.error)); else call.resolve(decodePluginValue(payload.value));
      }));
      this.listeners.push(await listen(CHANGED, () => this.changed()));
      this.listeners.push(await listen<any>(PLUGIN_EVENT, ({ payload }) => this.pluginEvent({ ...payload, error: payload.error ? appErrorException(payload.error) : undefined })));
    }
    window.addEventListener('beforeunload', () => this.dispose(), { once: true });
  }
  private refreshPermissions = () => {
    if (!this.isMain || this.disposed) return;
    this.refreshPending = true;
    if (this.refreshRunning) return;
    // At most one pending refresh, even if a native read takes longer than the interval.
    this.refreshRunning = this.ready.then(async () => {
      while (this.refreshPending && !this.disposed) {
        this.refreshPending = false;
        await this.dispatch('reconcileSettings', {}).catch(console.error);
      }
    }).catch(console.error).finally(() => {
      this.refreshRunning = undefined;
      if (this.refreshPending && !this.disposed) this.refreshPermissions();
    });
  };
  async request(method: string, args: any = {}): Promise<any> {
    if (this.disposed) throw localizedError(message('plugin.bridge.closed'));
    await this.connect();
    if (this.isMain) return this.dispatch(method, args);
    const id = `${this.label}:${Date.now()}:${++this.sequence}`;
    const encoded = await encodePluginValue(args);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(localizedError(message('plugin.bridge.timeout', { method }))); }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      emitTo('main', REQUEST, { id, sender: this.label, method, args: encoded }).catch(error => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  private dispatch(method: string, args: any): Promise<any> {
    if (!['reconcileSettings', 'uninstall', 'loadSource', 'loadPackage', 'packageInstall', 'packageActivate', 'packageDeactivate', 'packageRemove', 'packageRollback'].includes(method)) return this.handle(method, args);
    const result = this.mutations.then(() => {
      if (this.disposed) throw localizedError(message('plugin.bridge.closed'));
      return this.handle(method, args);
    }).finally(() => {
      if (method.startsWith('package')) { this.changed(); void emit(CHANGED).catch(console.error); }
    });
    this.mutations = result.catch(() => undefined);
    return result;
  }
  private async handle(method: string, args: any): Promise<any> {
    const manager = PluginManager.getInstance();
    const packages = this.packages ||= new PluginPackageTransactions(manager);
    switch (method) {
      case 'snapshot': return this.snapshot();
      case 'diagnostics': return { metrics: [...PluginPerformanceMonitor.getInstance().getAllAggregatedMetrics().values()], resolution: manager.getDependencyResolver().resolveDependencies(), graph: manager.getDependencyResolver().generateGraphVisualization() };
      case 'reconcileSettings': return manager.reconcileSettings();
      case 'uninstall': {
        // Installed packages must use the digest-bound confirmation in package management.
        if ((await packages.list()).some(item => item.metadata.id === args.id)) throw localizedError(message('plugin.transaction.packageChanged'));
        return manager.uninstallPlugin(args.id);
      }
      case 'loadSource': {
        if (args.trusted !== true) throw localizedError(message('plugin.bridge.trustRequired'));
        const loader = PluginLoader.getInstance();
        const result = args.type === 'file' ? await loader.loadFromFile(args.source, true)
          : args.type === 'url' ? await loader.loadFromUrl(args.source, true)
          : await loader.loadFromCode(args.source, `inline:${Date.now()}`, true);
        if (!result.success || !result.plugin) throw result.error || localizedError(message('plugin.manager.error.invalidPlugin'));
        await manager.registerPlugin(result.plugin, { trustedSession: true });
        return manager.reconcileSettings();
      }
      case 'loadPackage': return packages.activate(args.id);
      case 'packageInstall': return packages.install(args);
      case 'packageActivate': return packages.activate(args.id, args.digest, args.allowFullAppAccess);
      case 'packageDeactivate': return packages.deactivate(args.id);
      case 'packageRemove': return packages.remove(args.id, args.expectedDigest);
      case 'packageRollback': return packages.rollback(args.id, args.expectedDigest, args.expectedRestoreDigest);
      case 'callback': {
        const callback = this.callbacks.get(args.token);
        if (!callback || (manager.getPlugin(callback.pluginId)?.status !== 'active' || !manager.canRun(callback.pluginId))) throw localizedError(message('plugin.bridge.inactive'));
        return manager.measure(callback.pluginId, 'api_call', async () => callback.fn(...args.values));
      }
      default: throw localizedError(message('plugin.bridge.unknownRequest', { method }));
    }
  }
  private describe(value: any, pluginId: string, path: string): any {
    if (typeof value === 'function') {
      const token = `${pluginId}:${path}`;
      this.callbacks.set(token, { pluginId, fn: value });
      return { __pluginCallback: token };
    }
    if (Array.isArray(value)) return value.map((item, i) => this.describe(item, pluginId, `${path}.${i}`));
    if (value && typeof value === 'object') {
      const result: Record<string, any> = {};
      for (const [key, item] of Object.entries(value)) {
        // React elements/components remain in main; dialog descriptors omit them.
        if (key === 'component' || key === 'icon') continue;
        if (key === 'getOptions' && typeof item === 'function') {
          const manager = PluginManager.getInstance();
          try { result.optionValues = manager.getPlugin(pluginId)?.status === 'active' && manager.canRun(pluginId) ? item() : []; } catch { result.optionValues = []; }
        } else if ((key === 'isVisible' || key === 'isEnabled') && typeof item === 'function') {
          const manager = PluginManager.getInstance();
          try { result[`${key}Value`] = manager.getPlugin(pluginId)?.status === 'active' && manager.canRun(pluginId) ? item() : false; } catch { result[`${key}Value`] = false; }
        } else result[key] = this.describe(item, pluginId, `${path}.${key}`);
      }
      return result;
    }
    return value;
  }
  private snapshot() {
    this.callbacks.clear();
    const manager = PluginManager.getInstance();
    return { plugins: Array.from(manager.getPlugins(), ([id, entry]) => ({ id, metadata: entry.plugin.metadata,
      status: entry.status, settings: entry.settings, error: entry.error ? toAppError(entry.error) : undefined, loadTime: entry.loadTime,
      extensions: this.describe(entry.plugin.extensions || {}, id, 'extensions') })) };
  }
  hydrate(value: any): any {
    if (!value || typeof value !== 'object') return value;
    if (value.__pluginCallback) return (...values: any[]) => this.request('callback', { token: value.__pluginCallback, values });
    if (Array.isArray(value)) return value.map(item => this.hydrate(item));
    const result: any = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.hydrate(item)]));
    if ('optionValues' in result) result.getOptions = () => result.optionValues;
    for (const key of ['isVisible', 'isEnabled']) if (`${key}Value` in result) result[key] = () => result[`${key}Value`];
    return result;
  }
  async getPlugins(): Promise<Map<string, PluginRegistryEntry>> {
    if (this.isMain) { await this.connect(); return PluginManager.getInstance().getPlugins(); }
    const snapshot = await this.request('snapshot');
    return new Map(snapshot.plugins.map((entry: any) => [entry.id, {
      status: entry.status, settings: entry.settings, error: entry.error ? appErrorException(entry.error) : undefined, loadTime: entry.loadTime,
      plugin: { metadata: entry.metadata, extensions: this.hydrate(entry.extensions), activate: showOptions, deactivate: showOptions } as Plugin
    }]));
  }
  dispose() {
    this.disposed = true; this.refreshPending = false;
    window.removeEventListener('focus', this.refreshPermissions);
    if (this.permissionTimer) clearInterval(this.permissionTimer);
    this.lifecycle?.stop();
    if (this.isMain) void PluginManager.getInstance().cleanup().catch(console.error);
    this.listeners.forEach(unlisten => unlisten()); this.listeners = [];
    this.pending.forEach(call => { clearTimeout(call.timer); call.reject(localizedError(message('plugin.bridge.closed'))); });
    this.pending.clear(); this.observers.clear(); this.eventObservers.clear();
  }
}
