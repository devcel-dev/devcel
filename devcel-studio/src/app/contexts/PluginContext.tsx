import { isSettingsEditor } from '@/app/applicationMode';
import { appErrorException, t, useI18n, message, localizedError } from '@/app/i18n';
import { createContext, useContext, useEffect, useState, ReactNode, ComponentType, createElement, useMemo } from 'react';
import { PluginManager } from '@/app/services/PluginManager';
import { PluginBridge } from '@/app/services/PluginBridge';
import { showPluginPackages } from '@/app/utils/plugin_packages';
import { invoke } from '@tauri-apps/api/core';
import type { InstalledPluginPackage } from '@/app/types/pluginPackages';
import { Plugin, PluginRegistryEntry, PluginEvent, ToolbarButton, ContextMenuItem, SidePanel,
  DataExporter, DataImporter, Theme, DataProcessor, Dialog as PluginDialog } from '@/app/types/pluginTypes';
import { MenuConfiguration } from '@/app/types/menuTypes';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface PluginContextValue {
  plugins: Map<string, PluginRegistryEntry>;
  activePlugins: Map<string, PluginRegistryEntry>;
  loadPlugin: (source: string, type: 'file' | 'url' | 'code') => Promise<boolean>;
  loadPackage: (id: string) => Promise<boolean>;
  registerPlugin: (plugin: Plugin) => Promise<boolean>;
  uninstallPlugin: (id: string) => Promise<boolean>;
  menus: Map<string, MenuConfiguration>;
  toolbarButtons: ToolbarButton[];
  contextMenus: Map<string, ContextMenuItem[]>;
  sidePanels: SidePanel[];
  dialogs: PluginDialog[];
  exporters: DataExporter[];
  importers: DataImporter[];
  dataProcessors: DataProcessor[];
  themes: Theme[];
  onPluginEvent: (callback: (event: PluginEvent) => void) => () => void;
  isLoading: boolean;
  error: Error | null;
}
const PluginContext = createContext<PluginContextValue | null>(null);

export function collectPluginExtensions(plugins: Map<string, PluginRegistryEntry>) {
  const result = { menus: new Map<string, MenuConfiguration>(), toolbarButtons: [] as ToolbarButton[],
    contextMenus: new Map<string, ContextMenuItem[]>(), sidePanels: [] as SidePanel[], dialogs: [] as PluginDialog[],
    exporters: [] as DataExporter[], importers: [] as DataImporter[], dataProcessors: [] as DataProcessor[],
    themes: [] as Theme[] };
  for (const [pluginId, entry] of plugins) {
    if (entry.status !== 'active' || !entry.plugin.extensions) continue;
    const instrument = (value: any): any => {
      if (Array.isArray(value)) return value.map(instrument);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (['component', 'icon'].includes(key)) return [key, item];
        if (['getOptions', 'isVisible', 'isEnabled'].includes(key) && typeof item === 'function' && PluginBridge.getInstance().isMain) {
          return [key, (...args: any[]) => {
            const manager = PluginManager.getInstance();
            if (manager.getPlugin(pluginId)?.status !== 'active' || !manager.canRun(pluginId)) return key === 'getOptions' ? [] : false;
            return item(...args);
          }];
        }
        if (['onClick', 'export', 'import', 'process'].includes(key) && typeof item === 'function' && PluginBridge.getInstance().isMain) {
          return [key, (...args: any[]) => PluginManager.getInstance().measure(pluginId, 'api_call', async () => {
            if ((PluginManager.getInstance().getPlugin(pluginId)?.status !== 'active' || !PluginManager.getInstance().canRun(pluginId))) throw localizedError(message('plugin.context.inactive'));
            return item(...args);
          })];
        }
        return [key, instrument(item)];
      }));
    };
    const ext = instrument(entry.plugin.extensions) as NonNullable<Plugin['extensions']>;
    for (const [id, menu] of Object.entries(ext.menus || {})) result.menus.set(`${pluginId}:${id}`, menu);
    for (const [id, items] of Object.entries(ext.contextMenus || {})) result.contextMenus.set(id, [...(result.contextMenus.get(id) || []), ...items]);
    for (const key of ['toolbarButtons','sidePanels','dialogs','exporters','importers','dataProcessors','themes'] as const) {
      // IDs are local to a plugin; namespacing prevents collisions across packages.
      (result[key] as any[]).push(...(ext[key] || []).map(item => ({ ...item, id: `${pluginId}:${item.id}` })));
    }
  }
  return result;
}

const emptyPluginContext: PluginContextValue = {
  plugins: new Map(), activePlugins: new Map(), ...collectPluginExtensions(new Map()),
  isLoading: false, error: null,
  loadPlugin: async () => false, loadPackage: async () => false, registerPlugin: async () => false,
  uninstallPlugin: async () => false,
  onPluginEvent: () => () => {},
};
export function PluginProvider({ children }: { children: ReactNode }) {
  return isSettingsEditor()
    ? <PluginContext.Provider value={emptyPluginContext}>{children}</PluginContext.Provider>
    : <StandardPluginProvider>{children}</StandardPluginProvider>;
}
function StandardPluginProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const [plugins, setPlugins] = useState(new Map<string, PluginRegistryEntry>());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [modal, setModal] = useState<{ component: ComponentType<any>; props: any; resolve: (value: any) => void } | null>(null);
  const bridge = PluginBridge.getInstance();
  const manager = PluginManager.getInstance();
  const extensionSnapshot = useMemo(() => ({ locale, extensions: collectPluginExtensions(plugins) }), [plugins, locale]);
  const extensions = extensionSnapshot.extensions;
  const activePlugins = useMemo(() => new Map([...plugins].filter(([, entry]) => entry.status === 'active')), [plugins]);
  const refresh = async () => { setPlugins(await bridge.getPlugins()); };
  const operation = async (fn: () => Promise<any>): Promise<boolean> => {
    setIsLoading(true); setError(null);
    try { await fn(); await refresh(); return true; }
    catch (e) { setError(appErrorException(e)); return false; }
    finally { setIsLoading(false); }
  };
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const update = async () => {
      const current = ++generation;
      try { const entries = await bridge.getPlugins(); if (alive && current === generation) setPlugins(entries); }
      catch (e) { if (alive) setError(appErrorException(e)); }
    };
    const unsubscribe = bridge.subscribe(() => { void update(); });
    if (bridge.isMain) manager.setModalHandler((component, props) => new Promise(resolve => {
      setModal(previous => { previous?.resolve(null); return { component, props, resolve }; });
    }));
    void update().finally(() => { if (alive) setIsLoading(false); });
    // StrictMode remount must not deactivate or re-evaluate every installed plugin.
    return () => { alive = false; unsubscribe(); };
  }, [bridge, manager]);
  const finishModal = (value: any) => { modal?.resolve(value); setModal(null); };
  const contextValue: PluginContextValue = {
    plugins, activePlugins, ...extensions, isLoading, error,
    loadPlugin: (source, type) => operation(async () => {
      const { ask } = await import('@/app/services/appDialogs');
      const approved = await ask(t('plugin.context.trustWarning'), { title: t('plugin.context.trustTitle'), kind: 'warning' });
      if (!approved) throw localizedError(message('plugin.context.cancelled'));
      await bridge.request('loadSource', { source, type, trusted: true });
    }),
    loadPackage: id => operation(() => bridge.request('loadPackage', { id })),
    registerPlugin: plugin => operation(async () => {
      if (!bridge.isMain) throw localizedError(message('plugin.context.dialogRegistration'));
      await manager.registerPlugin(plugin, { trustedSession: true });
      await bridge.request('reconcileSettings');
    }),
    uninstallPlugin: id => operation(async () => {
      if ((await invoke<InstalledPluginPackage[]>('list_installed_plugin_packages')).some(item => item.metadata.id === id)) {
        await showPluginPackages();
        return;
      }
      await bridge.request('uninstall', { id });
    }),
    onPluginEvent: callback => bridge.onPluginEvent(callback)
  };
  return <PluginContext.Provider value={contextValue}>{children}
    <Dialog open={!!modal} onOpenChange={open => { if (!open) finishModal(null); }}>
      <DialogContent aria-describedby={undefined} className="max-w-3xl">
        <DialogHeader><DialogTitle>{modal?.props?.title || t('plugin.context.modalTitle')}</DialogTitle></DialogHeader>
        {modal && createElement(modal.component, { ...modal.props, onClose: () => finishModal(null), onConfirm: finishModal })}
      </DialogContent>
    </Dialog>
  </PluginContext.Provider>;
}
export function usePlugins(): PluginContextValue {
  const context = useContext(PluginContext);
  if (!context) throw localizedError(message('plugin.context.providerRequired'));
  return context;
}
export function useToolbarButtons() { return [...usePlugins().toolbarButtons].sort((a, b) => (a.order || 0) - (b.order || 0)); }
export function useContextMenus(contextId: string) { return usePlugins().contextMenus.get(contextId) || []; }
export function useSidePanels(position?: 'left' | 'right') { return usePlugins().sidePanels.filter(panel => !position || (panel.position || 'right') === position).sort((a, b) => (a.order || 0) - (b.order || 0)); }
export function useExporters() { return usePlugins().exporters; }
export function useImporters() { return usePlugins().importers; }
export function useThemes() { return usePlugins().themes; }
