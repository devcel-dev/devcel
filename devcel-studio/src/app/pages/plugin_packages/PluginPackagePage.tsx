import { useAppSettings } from '@/app/settings';
import { showOptions } from '@/app/utils/options';
import { toAppError, t, useI18n, formatNumber, localizeError, message, resolveMessage, type LocalizedMessage } from '@/app/i18n';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ask } from '@/app/services/appDialogs';
import { open, save } from '@tauri-apps/plugin-dialog';
import { PluginBridge } from '@/app/services/PluginBridge';
import type { InstalledPluginPackage, PackagePreview } from '@/app/types/pluginPackages';
import { Button } from '@/components/ui/button';

const conflictLabels = {
  new: 'plugin.package.conflict.new', same: 'plugin.package.conflict.same', update: 'plugin.package.conflict.update',
  downgrade: 'plugin.package.conflict.downgrade', 'same-version-different-content': 'plugin.package.conflict.different',
} as const;
export function PackageMetadata({ item }: { item: Pick<InstalledPluginPackage, 'metadata' | 'digest' | 'permissions'> }) {
  useI18n();
  const { metadata } = item;
  return <div className="space-y-2 text-sm">
    <h2 className="text-lg font-semibold break-words">{metadata.name} <span className="font-normal">v{metadata.version}</span></h2>
    <p className="break-words">{metadata.description}</p>
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,3fr)] gap-2">
      <dt>ID</dt><dd className="break-all">{metadata.id}</dd>
      <dt>{t('plugin.package.author')}</dt><dd>{metadata.author}</dd>
      <dt>{t('plugin.package.devcelVersion')}</dt><dd>{metadata.devcelVersion}</dd>
      <dt>API</dt><dd>{metadata.apiVersion || t('plugin.package.unspecified')}</dd>
      <dt>{t('plugin.package.dependencies')}</dt><dd>{Object.entries(metadata.dependencies || {}).map(([id, range]) => <div key={id}>{id}: {range}</div>)}{!Object.keys(metadata.dependencies || {}).length && t('plugin.package.none')}</dd>
      <dt>{t('plugin.package.permissions')}</dt><dd>{item.permissions.join(', ')}</dd>
      <dt>SHA-256</dt><dd className="break-all font-mono text-xs select-text">{item.digest}</dd>
    </dl>
    <p className="text-xs text-muted-foreground">{t('plugin.package.digestHelp')}</p>
  </div>;
}


export function PluginPackagePage() {
  useI18n();
  const selections = useAppSettings().bundle.pluginStates;
  const [installed, setInstalled] = useState<InstalledPluginPackage[]>([]);
  const [removed, setRemoved] = useState<InstalledPluginPackage[]>([]);
  const [preview, setPreview] = useState<{ path: string; data: PackagePreview } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replace, setReplace] = useState(false);
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<unknown[]>([]);
  const [notice, setNotice] = useState<string | LocalizedMessage>('');
  const busyRef = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const selected = installed.find(item => item.metadata.id === selectedId);
  const refresh = async () => {
    const token = ++generation.current;
    const [items, history] = await Promise.all([
      invoke<InstalledPluginPackage[]>('list_installed_plugin_packages'),
      invoke<InstalledPluginPackage[]>('list_removed_plugin_packages'),
    ]);
    if (alive.current && token === generation.current) { setInstalled(items); setRemoved(history); }
  };
  useEffect(() => {
    alive.current = true;
    const invalidateRequests = () => { ++generation.current; };
    void refresh().catch(e => { if (alive.current) setErrors([e]); });
    const unsubscribe = PluginBridge.getInstance().subscribe(() => { void refresh().catch(e => { if (alive.current) setErrors([e]); }); });
    let disposed = false;
    let stopClose: (() => void) | undefined;
    void getCurrentWebviewWindow().onCloseRequested(event => {
      if (busyRef.current) { event.preventDefault(); setNotice(message('plugin.package.closeBlocked')); }
    }).then(stop => { if (!disposed) stopClose = stop; else stop(); }).catch(() => {});
    return () => { disposed = true; alive.current = false; invalidateRequests(); unsubscribe(); stopClose?.(); };
  }, []);
  useEffect(() => { setTrust(false); }, [selectedId, selected?.digest]);
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setErrors([]); setNotice('');
    try { await action(); }
    catch (e) { if (alive.current) setErrors([e]); }
    finally {
      try { await refresh(); } catch (e) { if (alive.current) setErrors(previous => [...previous, message('plugin.package.refreshError', { error: toAppError(e) })]); }
      busyRef.current = false; if (alive.current) setBusy(false);
    }
  };
  const clearPreview = () => { setPreview(null); setReplace(false); };
  const chooseZip = () => run(async () => {
    clearPreview(); setSelectedId(null);
    const path = await open({ title: t('plugin.package.chooseTitle'), multiple: false, filters: [{ name: t('plugin.package.zipFilter'), extensions: ['zip'] }] });
    if (typeof path !== 'string') return;
    const data = await invoke<PackagePreview>('preview_plugin_package', { path });
    setPreview({ path, data });
  });
  const install = () => run(async () => {
    if (!preview) return;
    const item = await PluginBridge.request('packageInstall', {
      path: preview.path, expectedDigest: preview.data.digest,
      conflictPolicy: preview.data.conflict === 'downgrade' ? 'allow-downgrade' : replace ? 'replace' : 'reject',
    }) as InstalledPluginPackage;
    clearPreview(); setSelectedId(item.metadata.id); setTrust(false);
    if (item.resourceWarning) setErrors([item.resourceWarning]);
    setNotice(item.enabled ? message('plugin.package.executionAllowed') : message('plugin.package.installedNotice'));
  });
  const activate = () => run(async () => {
    if (!selected || (!selected.approved && !trust)) return;
    await PluginBridge.request('packageActivate', { id: selected.metadata.id, digest: selected.digest, allowFullAppAccess: trust });
    setTrust(false); setNotice(message('plugin.package.executionAllowed'));
  });
  const remove = () => run(async () => {
    if (!selected) return;
    if (!await ask(t('plugin.package.confirmRemove', { name: selected.metadata.name, version: selected.metadata.version }), { title: t('plugin.package.removeTitle'), kind: 'warning' })) return;
    await PluginBridge.request('packageRemove', { id: selected.metadata.id, expectedDigest: selected.digest });
    setSelectedId(null); setNotice(message('plugin.package.removedNotice'));
  });
  const rollback = (item: InstalledPluginPackage, removed = false) => run(async () => {
    if (!await ask(t('plugin.package.confirmRestore', { name: item.metadata.name }), { title: t('plugin.package.restoreTitle'), kind: 'warning' })) return;
    const restored = await PluginBridge.request('packageRollback', { id: item.metadata.id,
      expectedDigest: removed ? null : item.digest, expectedRestoreDigest: removed ? item.digest : item.rollbackDigest }) as InstalledPluginPackage;
    setSelectedId(restored.metadata.id); setTrust(false); clearPreview(); setNotice(message('plugin.package.restored', { version: restored.metadata.version }));
  });
  const exportZip = () => run(async () => {
    const directory = await open({ title: t('plugin.package.folderTitle'), directory: true, recursive: true, multiple: false });
    if (typeof directory !== 'string') return;
    const destination = await save({ title: t('plugin.package.saveTitle'), defaultPath: 'plugin.zip', filters: [{ name: t('plugin.package.zipFilter'), extensions: ['zip'] }] });
    if (!destination) return;
    const result = await invoke<PackagePreview>('export_plugin_package', { directory, destination });
    setNotice(message('plugin.package.exported', { name: result.metadata.name, version: result.metadata.version, path: destination, digest: result.digest }));
  });
  const needsReplace = !!preview && !['new', 'same'].includes(preview.data.conflict);
  return <main className="h-screen overflow-auto bg-background text-foreground p-6 space-y-5">
    <header className="space-y-2">
      <h1 className="text-2xl font-bold">{t('plugin.package.title')}</h1>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={chooseZip}>{t('plugin.package.choose')}</Button>
        <Button variant="outline" disabled={busy} onClick={exportZip}>{t('plugin.package.export')}</Button>
        <Button variant="outline" disabled={busy} onClick={() => run(refresh)}>{t('plugin.package.refresh')}</Button>
      </div>
    </header>
    {busy && <p role="status">{t('plugin.package.busy')}</p>}
    {errors.length > 0 && <p role="alert" className="whitespace-pre-wrap break-words rounded border border-red-400 bg-red-50 dark:bg-red-950 p-3 text-red-800 dark:text-red-200">{errors.map(error => localizeError(error)).join('\n')}</p>}
    {notice && <p role="status" className="whitespace-pre-wrap break-words rounded border p-3">{resolveMessage(notice)}</p>}
    {preview && <section aria-label={t('plugin.package.preview')} className="rounded border p-4 space-y-4">
      <PackageMetadata item={preview.data} />
      <p className="break-all text-xs">{t('plugin.package.source', { path: preview.path })}</p>
      <p>{t('plugin.package.size', { count: preview.data.entryCount, size: formatNumber(preview.data.expandedBytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</p>
      <p className="font-medium">{preview.data.installedVersion ? t('plugin.package.currentVersion', { conflict: t(conflictLabels[preview.data.conflict]), version: preview.data.installedVersion }) : t(conflictLabels[preview.data.conflict])}</p>
      <p>{t('plugin.package.compatibility', { status: preview.data.compatible ? t('plugin.package.compatible') : t('plugin.package.incompatible') })}</p>
      {preview.data.compatibilityErrors.map((item, index) => <p key={index} className="text-red-600">{localizeError(item)}</p>)}
      {preview.data.dependencyIssues.length > 0 && <div className="rounded border border-amber-500 p-3"><p>{t('plugin.package.dependencyHelp')}</p>{preview.data.dependencyIssues.map((item, index) => <p key={index}>{localizeError(item)}</p>)}</div>}
      <p className="text-sm rounded border border-amber-500 p-3">{t('plugin.package.accessWarning')}</p>
      {needsReplace && <label className="flex items-start gap-2"><input type="checkbox" checked={replace} disabled={busy} onChange={e => setReplace(e.target.checked)} />{t(preview.data.conflict === 'downgrade' ? 'plugin.package.allowDowngrade' : 'plugin.package.allowReplace')}</label>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => { clearPreview(); setNotice(''); }}>{t('plugin.package.back')}</Button>
        <Button disabled={busy || !preview.data.compatible || (needsReplace && !replace)} onClick={install}>{preview.data.conflict === 'same' ? t('plugin.package.showInstalled') : t('plugin.package.installDisabled')}</Button>
      </div>
    </section>}
    <div className="grid gap-5 md:grid-cols-[240px_1fr]">
      <section aria-label={t('plugin.package.installed')} className="space-y-2">
        <h2 className="font-semibold">{t('plugin.package.installedCount', { count: installed.length })}</h2>
        {installed.length === 0 && <p className="text-sm text-muted-foreground">{t('plugin.package.empty')}</p>}
        {installed.map(item => <button type="button" key={item.metadata.id} disabled={busy} aria-pressed={selectedId === item.metadata.id} className={`w-full text-left rounded border p-3 break-words ${selectedId === item.metadata.id ? 'border-primary bg-muted' : ''}`} onClick={() => { clearPreview(); setSelectedId(item.metadata.id); setTrust(false); }}>
          <strong>{item.metadata.name}</strong><br /><span className="text-sm">v{item.metadata.version} · {item.enabled ? t('plugin.package.executionAllowed') : t('plugin.package.executionBlocked')} · {item.approved ? t('plugin.package.approved') : t('plugin.package.unapproved')}</span>
        </button>)}
      </section>
      {selected && <section aria-label={t('plugin.package.details')} className="rounded border p-4 space-y-4 min-w-0">
        <p className="text-sm">{t('plugin.package.permissionHelp')}</p>
        <p>{t('plugin.details.enable')}: {t(selections[selected.metadata.id] === true ? 'plugin.enabled' : 'plugin.disabled')}</p>
        <Button variant="outline" disabled={busy} onClick={() => run(showOptions)}>{t('plugin.settings.openProject')}</Button>
        <PackageMetadata item={selected} /><p className="text-sm rounded border border-amber-500 p-3">{t('plugin.package.accessWarning')}</p>
          {!selected.approved && <label className="flex items-start gap-2"><input type="checkbox" aria-label={t('plugin.package.approveAccess')} checked={trust} disabled={busy} onChange={e => setTrust(e.target.checked)} /><span>{t('plugin.package.trust')}</span></label>}
          <div className="flex flex-wrap gap-2">
            {selected.enabled ? <Button disabled={busy} variant="outline" onClick={() => run(async () => { await PluginBridge.request('packageDeactivate', { id: selected.metadata.id }); setNotice(message('plugin.package.executionBlocked')); })}>{t('plugin.package.revokeExecution')}</Button> : <Button disabled={busy || (!selected.approved && !trust)} onClick={activate}>{selected.approved ? t('plugin.package.allowExecution') : t('plugin.package.approveExecution')}</Button>}
            <Button disabled={busy || !selected.canRollback} variant="outline" onClick={() => rollback(selected)}>{t('plugin.package.restorePrevious')}</Button>
            <Button disabled={busy} variant="destructive" onClick={remove}>{t('plugin.package.remove')}</Button>
          </div>
      </section>}
    </div>
    {removed.length > 0 && <section className="space-y-2" aria-label={t('plugin.package.removed')}><h2 className="font-semibold">{t('plugin.package.removedTitle')}</h2>{removed.map(item => <div key={item.metadata.id} className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"><span>{item.metadata.name} v{item.metadata.version}</span><Button disabled={busy} variant="outline" onClick={() => rollback(item, true)}>{t('plugin.package.restoreDisabled')}</Button></div>)}</section>}
    <details className="text-sm"><summary>{t('plugin.package.zipHelpTitle')}</summary><p className="mt-2">{t('plugin.package.zipHelp')}</p></details>
  </main>;
}
