/** Local editor preferences belong to the exact application release, like its native store. */
export function versionedStorageKey(key: string, appVersion: string): string {
  if (!appVersion) throw new Error('Application version is not initialized');
  return `${key}:${encodeURIComponent(appVersion)}`;
}

/** Copy valid layout preferences once. Never overwrite current edits or move old data. */
export function inheritVersionedLayout(storage: Storage, from: string, to: string): void {
  if (!from || from === to) return;
  const marker = versionedStorageKey('devcel.layout-inherited', to);
  if (storage.getItem(marker) !== null) return;
  const widths = versionedStorageKey('devcel-datagrid-column-widths', to);
  if (storage.getItem(widths) === null) {
    const raw = storage.getItem(versionedStorageKey('devcel-datagrid-column-widths', from));
    if (raw) {
      let encoded: string | undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const tables = Object.fromEntries(Object.entries(parsed).filter(([, cells]) => cells && typeof cells === 'object' && !Array.isArray(cells)).map(([table, cells]) => [table,
            Object.fromEntries(Object.entries(cells as Record<string, unknown>).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 0))]));
          encoded = JSON.stringify(tables);
        }
      } catch { /* Malformed optional layout never blocks startup. */ }
      // Storage failure propagates, so the completion marker cannot hide a lost copy.
      if (encoded !== undefined) storage.setItem(widths, encoded);
    }
  }
  const oldPrefix = `${versionedStorageKey('dataGridRowHeight_', from)}:`;
  const newPrefix = `${versionedStorageKey('dataGridRowHeight_', to)}:`;
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => key !== null);
  for (const key of keys) {
    if (!key.startsWith(oldPrefix)) continue;
    const raw = storage.getItem(key), value = Number(raw);
    const destination = newPrefix + key.slice(oldPrefix.length);
    if (raw && Number.isFinite(value) && value > 0 && storage.getItem(destination) === null) storage.setItem(destination, raw);
  }
  storage.setItem(marker, from);
}

/** Caller supplies a native-verified inherited package identity (or a built-in). */
export function inheritPluginInstallation(storage: Storage, id: string, from: string, to: string): void {
  if (!from || from === to) return;
  const marker = `${versionedStorageKey('devcel.plugins.inherited', to)}:${encodeURIComponent(id)}`;
  if (storage.getItem(marker) !== null) return;
  const source: unknown = JSON.parse(storage.getItem(versionedStorageKey('devcel.plugins.installed', from)) || '[]');
  const target = versionedStorageKey('devcel.plugins.installed', to);
  const current: unknown = JSON.parse(storage.getItem(target) || '[]');
  if (Array.isArray(source) && source.includes(id) && Array.isArray(current) && !current.includes(id)) {
    storage.setItem(target, JSON.stringify([...current.filter(value => typeof value === 'string'), id]));
  }
  storage.setItem(marker, from);
}
