import type { MenuAction, MenuBarGroup, MenuConfiguration } from '@/app/types/menuTypes';
import { pluginPredicate } from '@/app/components/plugins/PluginExtensions';
import type { PluginRegistryEntry, ToolbarButton, Dialog, Theme, DataImporter, DataProcessor } from '@/app/types/pluginTypes';

type ExtensionContributions = {
  toolbarButtons: ToolbarButton[]; dialogs: Dialog[];
  themes: Theme[]; importers: DataImporter[]; dataProcessors: DataProcessor[];
};
const openExtension = (kind: string, id: string) => {
  window.dispatchEvent(new CustomEvent('devcel-plugin-extension', { detail: { kind, id } }));
};

/** Group instrumented contributions by their owner, without parsing namespaced IDs. */
export function getPluginMenuGroup(
  activePlugins: ReadonlyMap<string, PluginRegistryEntry>,
  menus: ReadonlyMap<string, MenuConfiguration>,
  label: string,
  runAction: (action: MenuAction['onClick']) => void | Promise<void>,
  extensions?: ExtensionContributions,
): MenuBarGroup | null {
  const submenus = [...activePlugins].flatMap(([pluginId, entry]) => {
    if (entry.status !== 'active') return [];
    const groups = Object.keys(entry.plugin.extensions?.menus ?? {}).flatMap(menuId =>
      (menus.get(`${pluginId}:${menuId}`)?.groups ?? []).filter(group => group.actions.length > 0).map(group => ({
        ...group,
        id: JSON.stringify([menuId, group.id]),
        actions: group.actions.map(action => ({ ...action, onClick: () => runAction(action.onClick) })),
      })),
    );
    if (extensions) {
      const actions: MenuAction[] = [];
      for (const item of entry.plugin.extensions?.toolbarButtons ?? []) {
        const button = extensions.toolbarButtons.find(button => button.id === `${pluginId}:${item.id}`);
        if (button && pluginPredicate(button.isVisible)) actions.push({ label: button.label,
          disabled: !pluginPredicate(button.isEnabled), onClick: () => {
            if (pluginPredicate(button.isEnabled)) return runAction(button.onClick);
          } });
      }
      for (const [key, kind] of [['dialogs', 'page'],
          ['importers', 'import'], ['dataProcessors', 'process']] as const) {
        for (const local of entry.plugin.extensions?.[key] ?? []) {
          const item = extensions[key].find(item => item.id === `${pluginId}:${local.id}`);
          if (item) actions.push({ label: 'title' in item ? item.title : item.name,
            onClick: () => openExtension(kind, item.id) });
        }
      }
      if (actions.length) groups.push({ id: 'extensions', label: entry.plugin.metadata.name, actions });
    }
    return groups.length ? [{ id: pluginId, label: entry.plugin.metadata.name, groups }] : [];
  });
  return submenus.length ? { id: 'plugin-extensions', label, actions: [], submenus } : null;
}
