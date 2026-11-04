import { appErrorException } from '@/app/i18n';
import { getSettingsSnapshot, subscribeSettings } from '@/app/settings';
import type { PluginAPI, PluginSettingValues } from '@/app/types/pluginTypes';

export function isPluginRequested(id: string): boolean {
  return getSettingsSnapshot().bundle.pluginStates[id] === true;
}
const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
/** Values are only exposed through the PluginManager's fixed owner scope. */
export const pluginSettings: PluginAPI['settings'] = {
  get: () => { throw appErrorException({ kind: 'code', code: 'plugin.settings.error.ownerRequired', params: {} }); },
  getAll: () => Object.freeze({}),
  watch: () => { throw appErrorException({ kind: 'code', code: 'plugin.settings.error.ownerRequired', params: {} }); },
  getRows: () => { throw appErrorException({ kind: 'code', code: 'plugin.settings.error.ownerRequired', params: {} }); },
  watchRows: () => { throw appErrorException({ kind: 'code', code: 'plugin.settings.error.ownerRequired', params: {} }); },
  getTable: () => { throw appErrorException({ kind: 'code', code: 'plugin.settings.error.ownerRequired', params: {} }); },
  watchTable: () => { throw appErrorException({ kind: 'code', code: 'plugin.settings.error.ownerRequired', params: {} }); },
};
export function scopedPluginSettings(pluginId: string): PluginAPI['settings'] {
  const tables = () => {
    const all = getSettingsSnapshot().bundle.pluginSettings;
    return has(all, pluginId) ? all[pluginId] : {};
  };
  const getTable: PluginAPI['settings']['getTable'] = tableId => {
    const values = tables();
    if (!has(values, tableId) || !values[tableId] || Array.isArray(values[tableId]) || typeof values[tableId] !== 'object') throw appErrorException({ kind: 'code', code: 'plugin.settings.error.singletonTable', params: { owner: pluginId, table: tableId } });
    return Object.freeze({ ...values[tableId] }) as any;
  };
  const getRows: PluginAPI['settings']['getRows'] = tableId => {
    const values = tables();
    if (!has(values, tableId) || !Array.isArray(values[tableId])) throw appErrorException({ kind: 'code', code: 'plugin.settings.error.rowsTable', params: { owner: pluginId, table: tableId } });
    return Object.freeze((values[tableId] as Array<{id:string;values:Record<string,string|number|boolean|null>}>).map(row => Object.freeze({ id: row.id, values: Object.freeze({ ...row.values }) }))) as any;
  };
  const getAll = (): Readonly<PluginSettingValues> => Object.freeze(Object.fromEntries(
    Object.entries(tables()).filter(([, values]) => !Array.isArray(values)).flatMap(([tableId, values]) => Object.entries(values).map(([key, value]) => [`${tableId}.${key}`, value]))
  ));
  const get: PluginAPI['settings']['get'] = key => {
    const values = getAll();
    if (!has(values, key)) throw appErrorException({ kind: 'code', code: 'plugin.settings.error.key', params: { owner: pluginId, key } });
    return values[key];
  };
  return {
    getTable, getRows, get, getAll,
    watchRows: (tableId, callback) => {
      let previous = JSON.stringify(getRows(tableId));
      return subscribeSettings(() => {
        const next = getRows(tableId), serialized = JSON.stringify(next);
        if (serialized !== previous) { previous = serialized; callback(next); }
      });
    },
    watch: (key, callback) => {
      let previous = get(key);
      return subscribeSettings(() => { const next = get(key); if (next !== previous) { previous = next; callback(next); } });
    },
    watchTable: (tableId, callback) => {
      let previous = JSON.stringify(getTable(tableId));
      return subscribeSettings(() => {
        const next = getTable(tableId), serialized = JSON.stringify(next);
        if (serialized !== previous) { previous = serialized; callback(next); }
      });
    },
  };
}
