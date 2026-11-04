import { versionedStorageKey } from '@/app/settings/storageKey';
import { useAppSettings } from '@/app/settings';
import { showOptions } from '@/app/utils/options';
import { toAppError, t, useI18n, localizeError, message, resolveMessage, type LocalizedMessage } from '@/app/i18n';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { readTextFile } from '@tauri-apps/plugin-fs';
import type { InstalledPluginPackage, PluginCatalog } from '@/app/types/pluginPackages';
import { PluginBridge } from '@/app/services/PluginBridge';
import { showPluginPackages } from '@/app/utils/plugin_packages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const CACHE_KEY = 'devcel-plugin-catalog-cache-v1';
const readCache = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };

export function PluginCatalogView() {
  useI18n();
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [source, setSource] = useState<string | LocalizedMessage>('');
  const [installed, setInstalled] = useState<InstalledPluginPackage[]>([]);
  const settings = useAppSettings();
  const url = settings.bundle.values.pluginCatalogUrl;
  const cacheKey = versionedStorageKey(CACHE_KEY, settings.appVersion);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>('');
  const [notice, setNotice] = useState<string | LocalizedMessage>('');
  const busyRef = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const refreshInstalled = async () => {
    const values = await invoke<InstalledPluginPackage[]>('list_installed_plugin_packages');
    if (alive.current) setInstalled(values);
  };
  useEffect(() => {
    alive.current = true;
    const invalidateRequests = () => { ++generation.current; };
    const token = ++generation.current;
    void refreshInstalled().catch(e => { if (alive.current) setError(e); });
    const unsubscribe = PluginBridge.getInstance().subscribe(() => { void refreshInstalled().catch(e => { if (alive.current) setError(e); }); });
    const cache = readCache(cacheKey);
    if (cache) void invoke<PluginCatalog>('validate_plugin_catalog', { json: cache }).then(value => {
      if (alive.current && token === generation.current) { setCatalog(value); setSource(message('plugin.catalog.cacheSource')); }
    }).catch(e => { if (alive.current && token === generation.current) setError(message('plugin.catalog.invalidCache', { error: toAppError(e) })); });
    return () => { alive.current = false; invalidateRequests(); unsubscribe(); };
  }, [cacheKey]);
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; generation.current++; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { if (alive.current) setError(e); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const accept = (value: PluginCatalog, label: string | LocalizedMessage) => {
    if (!alive.current) return;
    setCatalog(value); setSource(label);
    try { localStorage.setItem(cacheKey, JSON.stringify(value)); }
    catch { setNotice(message('plugin.catalog.cacheSaveFailed')); }
  };
  const importCatalog = () => run(async () => {
    const path = await open({ title: t('plugin.catalog.openTitle'), multiple: false, filters: [{ name: t('plugin.catalog.fileFilter'), extensions: ['json'] }] });
    if (typeof path !== 'string') return;
    const json = await readTextFile(path);
    const result = await invoke<PluginCatalog>('validate_plugin_catalog', { json });
    accept(result, message('plugin.catalog.localSource', { path }));
  });
  const fetchCatalog = () => run(async () => {
    // HTTPS, response size, redirects and format are validated in Rust.
    const requestedUrl = url.trim();
    const result = await invoke<PluginCatalog>('fetch_plugin_catalog', { url: requestedUrl });
    if (!alive.current) return;
    accept(result, requestedUrl);
  });
  const entries = (catalog?.plugins || []).filter(item => `${item.metadata.id} ${item.metadata.name} ${item.metadata.author} ${item.metadata.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="h-full overflow-auto p-5 space-y-5">
    <header className="space-y-2"><h2 className="text-xl font-semibold">{t('plugin.catalog.title')}</h2>
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={importCatalog}>{t('plugin.catalog.openJson')}</Button><Button variant="outline" disabled={busy} onClick={() => run(showPluginPackages)}>{t('plugin.catalog.openPackages')}</Button></div>
    </header>
    <div className="rounded border p-4 space-y-2">
      <p className="text-sm font-medium">{t('plugin.catalog.url')}</p>
      <p className="break-all select-text text-sm">{url || t('plugin.catalog.noConfiguredUrl')}</p>
      <div className="flex gap-2 flex-wrap">
        <Button disabled={busy || !url} onClick={fetchCatalog}>{t('plugin.catalog.fetch')}</Button>
        <Button variant="outline" disabled={busy} onClick={() => run(showOptions)}>{t('plugin.settings.openProject')}</Button>
      </div>
    </div>
    {busy && <p role="status">{t('plugin.catalog.loading')}</p>}
    {!!error && <p role="alert" className="whitespace-pre-wrap break-words text-red-600">{localizeError(error)}</p>}
    {notice && <p role="status">{resolveMessage(notice)}</p>}
    <section aria-label={t('plugin.catalog.localPackages')} className="rounded border p-4 space-y-2"><h3 className="font-semibold">{t('plugin.catalog.localCount', { count: installed.length })}</h3>
      {installed.map(item => <p key={item.metadata.id} className="text-sm break-words">{item.metadata.name} v{item.metadata.version} · {item.approved ? t('plugin.package.approved') : t('plugin.package.unapproved')} · {item.enabled ? t('plugin.package.executionAllowed') : t('plugin.package.executionBlocked')}</p>)}
    </section>
    {catalog ? <>
      <div className="flex flex-col gap-2"><p className="text-xs break-all select-text">{t('plugin.catalog.source', { source: resolveMessage(source) })}</p><Input aria-label={t('plugin.catalog.search')} placeholder={t('plugin.catalog.searchPlaceholder')} value={query} onChange={e => setQuery(e.target.value)} /><p className="text-sm">{t('plugin.catalog.count', { count: entries.length })}</p></div>
      {entries.map(entry => { const current = installed.find(item => item.metadata.id === entry.metadata.id); return <article key={entry.metadata.id} className="rounded border p-4 space-y-2">
        <h3 className="font-semibold break-words">{entry.metadata.name} v{entry.metadata.version}</h3>
        <p className="text-sm">{entry.metadata.description}</p><p className="text-xs">{t('plugin.catalog.author', { id: entry.metadata.id, author: entry.metadata.author })}</p>
        <p className="text-sm">Devcel: {entry.metadata.devcelVersion} / API: {entry.metadata.apiVersion || t('plugin.package.unspecified')}</p>
        {Object.entries(entry.metadata.dependencies || {}).map(([id, range]) => <p className="text-xs" key={id}>{t('plugin.catalog.dependency', { id, range })}</p>)}
        {current && <p className="text-sm">{t(entry.digest ? (entry.digest === current.digest ? 'plugin.catalog.installedSame' : 'plugin.catalog.installedDifferent') : 'plugin.catalog.installedNoDigest', { version: current.metadata.version })}</p>}
        {entry.digest && <p className="text-xs break-all font-mono select-text">SHA-256: {entry.digest}</p>}
        {entry.downloadUrl ? <><p className="text-xs break-all select-text">{t('plugin.catalog.downloadUrl', { url: entry.downloadUrl })}</p><Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { await openExternal(entry.downloadUrl!); setNotice(message('plugin.catalog.browserOpened')); })}>{t('plugin.catalog.openDownload')}</Button></> : <p className="text-sm text-muted-foreground">{t('plugin.catalog.noDownload')}</p>}
      </article>; })}
      {!entries.length && <p>{t('plugin.catalog.noMatches')}</p>}
      <Button variant="outline" disabled={busy} onClick={() => run(async () => { localStorage.removeItem(cacheKey); setCatalog(null); setSource(''); setNotice(message('plugin.catalog.cacheCleared')); })}>{t('plugin.catalog.clear')}</Button>
    </> : <p className="text-sm text-muted-foreground">{t('plugin.catalog.empty')}</p>}
    <details className="text-xs"><summary>{t('plugin.catalog.schemaTitle')}</summary><p className="mt-2">{t('plugin.catalog.schemaHelp')}</p></details>
  </section>;
}
