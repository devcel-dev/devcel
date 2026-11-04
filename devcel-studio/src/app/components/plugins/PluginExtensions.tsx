import { t, useI18n, localizeError, localizedError, message as i18nMessage } from '@/app/i18n';
import React, { Component, ReactNode, useEffect, useState } from 'react';
import { usePlugins, useSidePanels, useContextMenus } from '@/app/contexts/PluginContext';
import { PluginManager } from '@/app/services/PluginManager';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ask, message } from '@/app/services/appDialogs';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';

export async function runPluginAction(action: () => unknown | Promise<unknown>) {
  try { await action(); } catch (error) { await message(localizeError(error), { title: t('plugin.extensions.errorTitle'), kind: 'error' }); }
}
export function pluginPredicate(predicate?: (...args: any[]) => boolean, context?: any) {
  try { return predicate ? predicate(context) : true; } catch (error) { console.error('Plugin predicate failed', error); return false; }
}
function ExtensionError({ error }: { error: unknown }) {
  useI18n();
  return <p role="alert" className="text-red-600 p-2 break-words">{localizeError(error)}</p>;
}
class ExtensionBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? <ExtensionError error={this.state.error} /> : this.props.children; }
}
export function PluginOptions({ schema, value, onChange }: { schema: any[]; value: Record<string, any>; onChange: (value: Record<string, any>) => void }) {
  useI18n();
  return <div className="space-y-2">{schema.map(option => <label key={option.name} className="flex flex-wrap gap-2 items-center text-sm">
    <span>{option.label || option.name}</span>
    {option.type === 'boolean' ? <input type="checkbox" checked={value[option.name] ?? option.default ?? false} onChange={e => onChange({ ...value, [option.name]: e.target.checked })} />
      : option.type === 'select' ? <select className="border rounded p-1 bg-background" value={value[option.name] ?? option.default ?? ''} onChange={e => onChange({ ...value, [option.name]: e.target.value })}>
        {(option.options || []).map((item: any) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select> : <input className="border rounded p-1 bg-background" type={option.type === 'number' ? 'number' : 'text'} value={value[option.name] ?? option.default ?? ''} onChange={e => onChange({ ...value, [option.name]: option.type === 'number' ? Number(e.target.value) : e.target.value })} />}
  </label>)}</div>;
}
export function pluginOptions(schema: any[], values: Record<string, any>) { return { ...Object.fromEntries(schema.map(item => [item.name, item.default])), ...values }; }

export function PluginSidebar({ position }: { position: 'left' | 'right' }) {
  useI18n();
  const panels = useSidePanels(position).filter(panel => panel.component && pluginPredicate(panel.isVisible));
  if (!panels.length) return null;
  return <aside className="shrink-0 border-x overflow-auto" style={{ width: Math.min(500, Math.max(160, panels[0].defaultWidth || 240)) }}>
    {panels.map(panel => <section key={panel.id}><h2 className="font-medium p-2 border-b">{panel.title}</h2><ExtensionBoundary key={panel.id}>{panel.component}</ExtensionBoundary></section>)}
  </aside>;
}
export function PluginContextItems({ context, onClose }: { context: any; onClose: () => void }) {
  useI18n();
  const items = [...useContextMenus('table-context'), ...useContextMenus(`${context.type || 'row'}-context`)];
  return <>{items.filter(item => pluginPredicate(item.isVisible, context)).map((item, i) => <React.Fragment key={`${item.id}:${i}`}>
    {item.separator && <hr />}
    <button className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 disabled:opacity-40" disabled={!pluginPredicate(item.isEnabled, context)} onClick={() => {
      if (!pluginPredicate(item.isEnabled, context)) return;
      onClose(); void runPluginAction(() => item.onClick(context));
    }}>{item.icon}{item.label}</button>
  </React.Fragment>)}</>;
}

export function PluginExtensionHost() {
  useI18n();
  const { dialogs, importers, dataProcessors } = usePlugins();
  const api = PluginManager.getInstance().getAPI();
  const [page, setPage] = useState('');
  const [operationId, setOperationId] = useState('');
  const [options, setOptions] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const selectedPage = dialogs.find(item => item.id === page);
  const importer = importers.find(item => `import:${item.id}` === operationId);
  const processor = dataProcessors.find(item => `process:${item.id}` === operationId);
  const schema = importer?.getOptions?.() || [];
  useEffect(() => {
    const handle = (event: Event) => {
      const { kind, id } = (event as CustomEvent<{ kind: string; id: string }>).detail;
      if (kind === 'page' && dialogs.some(item => item.id === id)) setPage(id);
      if (!busy && ((kind === 'import' && importers.some(item => item.id === id)) ||
          (kind === 'process' && dataProcessors.some(item => item.id === id)))) {
        setOperationId(`${kind}:${id}`); setOptions({});
      }
    };
    window.addEventListener('devcel-plugin-extension', handle);
    return () => window.removeEventListener('devcel-plugin-extension', handle);
  }, [dialogs, importers, dataProcessors, busy]);
  const processTable = async () => {
    if (busy || (!importer && !processor)) return;
    setBusy(true);
    try {
      const activeTable = api.app.getState().activeTable;
      if (!activeTable) throw localizedError(i18nMessage('plugin.extensions.selectTable'));
      const { uuid: tableId, projectSession } = activeTable;
      const snapshot = await api.data.getTableSnapshot(tableId, projectSession);
      const data = snapshot.table;
      if (!data) throw localizedError(i18nMessage('plugin.extensions.loadTable'));
      const original = JSON.stringify(data);
      let output: any;
      if (importer) {
        const path = await open({ multiple: false, filters: [{ name: importer.name, extensions: importer.supportedExtensions.map(extension => extension.replace(/^\./, '')) }] });
        if (!path || Array.isArray(path)) return;
        const bytes = await readFile(path);
        const file = new File([bytes], path.split(/[/\\]/).pop() || 'input', { type: importer.supportedMimeTypes[0] || '' });
        output = await importer.import(file, pluginOptions(schema, options));
      } else {
        if (processor!.supportedTypes.length && !processor!.supportedTypes.some(type => ['table', 'json', '*'].includes(type))) throw localizedError(i18nMessage('plugin.extensions.unsupportedTable'));
        output = await processor!.process(data, options);
      }
      if (output == null) throw localizedError(i18nMessage('plugin.extensions.noData'));
      if (!(await ask(t('plugin.extensions.confirmUpdate', { name: data.display_name || tableId }), { title: t('plugin.extensions.confirmTitle'), kind: 'warning' }))) return;
      if ((await api.project.getCurrent())?.sessionId !== projectSession || JSON.stringify(await api.data.getTable(tableId, projectSession)) !== original) throw localizedError(i18nMessage('plugin.extensions.changed'));
      await api.data.updateTable(tableId, output, projectSession, snapshot.revision);
      setOperationId('');
    } finally { setBusy(false); }
  };
  return <>
  <Dialog open={!!selectedPage} onOpenChange={open => { if (!open) setPage(''); }}><DialogContent aria-describedby={undefined} className="max-w-3xl"><DialogHeader><DialogTitle>{selectedPage?.title}</DialogTitle></DialogHeader><ExtensionBoundary key={page}>{selectedPage?.component || <p>{t('plugin.extensions.emptyView')}</p>}</ExtensionBoundary></DialogContent></Dialog>
  <Dialog open={!!(importer || processor)} onOpenChange={open => { if (!open && !busy) setOperationId(''); }}><DialogContent aria-describedby={undefined}><DialogHeader><DialogTitle>{importer?.name || processor?.name}</DialogTitle></DialogHeader><p>{importer?.description || processor?.description}</p><PluginOptions schema={schema} value={options} onChange={setOptions} /><Button disabled={busy} onClick={() => void runPluginAction(processTable)}>{busy ? t('plugin.extensions.working') : t('plugin.extensions.run')}</Button></DialogContent></Dialog>
  </>;
}
