import { DescriptionEditor } from './DescriptionEditor';
import { appAlert } from '@/app/services/appDialogs';
import { useI18n, localizeError, localizedError, message } from '@/app/i18n';
import React, { useState, useEffect, useCallback, useId, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Package, RefreshCw, AlertCircle, Plus, Trash2, MoreVertical, GripVertical, Pencil,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ColumnEditor } from "@/app/components/column-editor/ColumnEditor";
import "@/app/components/interface/interface-lists.css";
import type { ColumnEditorTarget } from "@/app/components/column-editor/types";
import { updateInterface } from "@/api/interface";
import { InterfaceChange } from "@/types/interface";
import { columnTypeLabel } from "@/app/utils/columnTypes";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface InterfaceViewProps {
  expectedProjectSession: string;
  filePath: string;
  fileName: string;
  interfaceUuid: string;
}

interface InterfaceColumnInfo {
  display_name?: string | null;
  uuid: string;
  name: string;
  value_type: string;
  default_value?: any;
  description?: string;
  color?: string;
  tooltip?: string;
  curve_config?: {start_value:number;end_value:number};
  table_ref_config?: {interface_uuid:string};
  select_config?: {options:Array<{value:string;label?:string}>};
}

interface InterfaceDetails {
  name: string;
  description?: string;
  columns: InterfaceColumnInfo[];
  current_version: {
    id: string;
    timestamp: string;
    changes: Array<{ action: string; column_name?: string; old_type?: string; new_type?: string }>;
  };
  implementing_tables: string[];
}

export const InterfaceView: React.FC<InterfaceViewProps> = ({ expectedProjectSession, filePath, fileName, interfaceUuid }) => {
  const { t } = useI18n();
  const id = useId();
  const [interfaceData, setInterfaceData] = useState<InterfaceDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [columnToDelete, setColumnToDelete] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<ColumnEditorTarget | null>(null);
  const identity = `${expectedProjectSession ?? ''}\0${interfaceUuid}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const mounted = useRef(false);
  const lifetime = useRef(0);
  const readRequest = useRef(0);
  const isCurrent = useCallback((ticket: number) => mounted.current
    && lifetime.current === ticket && currentIdentity.current === identity, [identity]);
  useEffect(() => {
    mounted.current = true;
    setInterfaceData(null); setBusy(false); setColumnToDelete(null); setEditorTarget(null);
    return () => { mounted.current = false; lifetime.current += 1; readRequest.current += 1; };
  }, [identity]);

  // Reorder with HTML5 dragging. Keep the source in a ref so onDrop does not read stale state.
  const dragIndexRef = useRef<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const loadInterfaceData = useCallback(async () => {
    const ticket = lifetime.current;
    if (!isCurrent(ticket)) return;
    const request = ++readRequest.current;
    const live = () => isCurrent(ticket) && request === readRequest.current;
    try {
      setLoading(true);
      setError(null);
      const details = await invoke<InterfaceDetails>('get_interface_details', { interfaceUuid, expectedProjectSession });
      if (live()) setInterfaceData(details);
    } catch (err) {
      if (!live()) return;
      console.error('Failed to load interface data:', err);
      setError(err);
    } finally {
      if (live()) setLoading(false);
    }
  }, [interfaceUuid, expectedProjectSession, isCurrent]);

  useEffect(() => {
    loadInterfaceData();
    const unlisten = listen('interface-column-added', (event) => {
      const payload = event.payload as { interfaceUuid: string };
      if (payload.interfaceUuid === interfaceUuid) loadInterfaceData();
    });
    const history = listen('interface-history-applied', () => { void loadInterfaceData(); });
    const remote = listen('p2p-data-changed', () => { void loadInterfaceData(); });
    return () => { unlisten.then(fn => fn()); remote.then(fn => fn()); history.then(fn => fn()); };
  }, [filePath, fileName, interfaceUuid, loadInterfaceData]);

  const handleAddColumn = () => {
    setEditorTarget(current => current || { mode: 'interface', target_uuid: interfaceUuid, column_uuid: null });
  };

  const applyChanges = useCallback(async (changes: InterfaceChange[], comment: string) => {
    const ticket = lifetime.current;
    if (!isCurrent(ticket)) return false;
    if (changes.length === 0) return true;
    readRequest.current += 1;
    setBusy(true);
    try {
      const result = await updateInterface(interfaceUuid, changes, expectedProjectSession, undefined, comment);
      if (!isCurrent(ticket)) return false;
      if (result !== 'ok') { await appAlert(t('interface.view.changeFailed', { error: localizeError(result) })); return false; }
      await loadInterfaceData();
      return isCurrent(ticket);
    } catch (err) {
      if (!isCurrent(ticket)) return false;
      console.error('Failed to update interface:', err);
      await appAlert(t('interface.view.changeFailed', { error: localizeError(err) }));
      return false;
    } finally {
      if (isCurrent(ticket)) setBusy(false);
    }
  }, [interfaceUuid, expectedProjectSession, loadInterfaceData, isCurrent, t]);

  const confirmRemoveColumn = async () => {
    if (!columnToDelete || !isCurrent(lifetime.current)) return;
    const name = columnToDelete;
    setColumnToDelete(null);
    await applyChanges([{ type: 'RemoveColumn', columnName: name }], `Remove column "${name}"`);
  };

  const commitReorder = async (from: number, to: number) => {
    if (!interfaceData || from === to || !isCurrent(lifetime.current)) return;
    const names = interfaceData.columns.map((c) => c.name);
    const [moved] = names.splice(from, 1);
    names.splice(to, 0, moved);
    setInterfaceData((prev) => {
      if (!prev) return prev;
      const cols = [...prev.columns];
      const [m] = cols.splice(from, 1);
      cols.splice(to, 0, m);
      return { ...prev, columns: cols };
    });
    await applyChanges([{ type: 'ReorderColumns', order: names }], 'Change column order');
  };

  if (loading && !interfaceData) {
    return <div className="flex items-center justify-center h-full"><div className="text-muted-foreground">{t('common.loading')}</div></div>;
  }
  if (error !== null && !interfaceData) {
    return (
      <div className="p-4">
        <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>{t('common.error')}</AlertTitle><AlertDescription>{localizeError(error)}</AlertDescription></Alert>
      </div>
    );
  }
  if (!interfaceData) {
    return <div className="flex items-center justify-center h-full"><div className="text-muted-foreground">{t('interface.view.noData')}</div></div>;
  }

  return (
    <div className={`column-workspace ${editorTarget ? 'is-editing' : ''}`}>
    <div className="column-workspace-main h-full flex flex-col">
      {/* Compact header */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-background">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-semibold truncate">
            <Package className="h-5 w-5 shrink-0 text-primary" />
            <span id={`${id}-interface-name`} className="truncate">{interfaceData.name}</span>
            <span className="text-xs text-muted-foreground shrink-0">{t('interface.view.fieldCount', { count: interfaceData.columns.length })}</span>
          </div>
          <DescriptionEditor key={`${identity}:description`} draftKey={`${expectedProjectSession}:devcel:text-draft:interface-description:${interfaceUuid}`}
            value={interfaceData.description ?? ''} revision={interfaceData.current_version.id} label={t('interface.description')} disabled={busy || !!editorTarget}
            onRead={async () => {
              const latest = await invoke<InterfaceDetails>('get_interface_details', { interfaceUuid, expectedProjectSession });
              return { value: latest.description ?? '', revision: latest.current_version.id };
            }} onSave={async (value, revision) => {
              const result = await updateInterface(interfaceUuid, [{ type: 'ChangeDescription', newDescription: value }], expectedProjectSession, undefined, 'Update interface description', revision);
              if (result !== 'ok') throw result;
              await loadInterfaceData();
            }} />
        </div>
        <div className="flex gap-1 shrink-0">
          <Button onClick={handleAddColumn} size="sm" className="h-8 px-3 bg-primary hover:bg-primary/90" disabled={busy || !!editorTarget}>
            <Plus className="h-3.5 w-3.5 mr-1" />{t('interface.view.addField')}
          </Button>
          <Button onClick={loadInterfaceData} aria-label={t('interface.refresh')} size="sm" variant="outline" className="h-7 px-2" disabled={busy}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {error !== null && <p role="alert" className="px-4 py-2 text-xs text-red-700 bg-red-50">{localizeError(error)}</p>}
      {/* Field list with column labels */}
      <div className="flex-1 overflow-auto">
        {interfaceData.columns.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">{t('interface.view.empty')}</div>
        ) : (
          <div className="interface-field-list w-full min-w-[600px] text-sm">
            <div className="interface-field-row sticky top-0 bg-muted/60 backdrop-blur text-left text-xs text-muted-foreground" aria-hidden="true">
              <span />
              <div className="interface-field-values">
                <span className="px-2 py-1.5 font-medium">{t('column.displayName')}</span>
                <span className="px-2 py-1.5 font-medium">{t('column.fieldName')}</span>
                <span className="px-2 py-1.5 font-medium">{t('interface.view.type')}</span>
                <span className="px-2 py-1.5 font-medium">{t('interface.view.default')}</span>
                <span className="px-2 py-1.5 font-medium">{t('interface.description')}</span>
              </div>
              <span />
            </div>
            <ul role="list" aria-labelledby={`${id}-interface-name`}>
              {interfaceData.columns.map((column, index) => (
                <li
                  key={column.uuid}
                  aria-labelledby={`${id}-field-${index}`}
                  onDoubleClick={() => setEditorTarget(current => current || { mode: 'interface', target_uuid: interfaceUuid, column_uuid: column.uuid })}
                  draggable={!editorTarget}
                  onDragStart={(e) => {
                    dragIndexRef.current = index;
                    setDragIndex(index);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(index));
                  }}
                  onDragEnd={() => { dragIndexRef.current = null; setDragIndex(null); setOverIndex(null); }}
                  onDragOver={(e) => {
                    if (dragIndexRef.current === null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (overIndex !== index) setOverIndex(index);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragIndexRef.current;
                    dragIndexRef.current = null; setDragIndex(null); setOverIndex(null);
                    if (from !== null && from !== index) commitReorder(from, index);
                  }}
                  className={
                    "interface-field-row border-b border-border/60 hover:bg-muted/40 cursor-grab active:cursor-grabbing select-none " +
                    (overIndex === index && dragIndex !== null && dragIndex !== index ? "border-t-2 border-t-primary " : "") +
                    (dragIndex === index ? "opacity-50 " : "")
                  }
                >
                  <div className="px-1 py-1 text-muted-foreground" aria-hidden="true"><GripVertical className="h-4 w-4" /></div>
                  <dl className="interface-field-values">
                    <div><dt className="sr-only">{t('column.displayName')}</dt><dd id={`${id}-field-${index}`} className="px-2 py-1 font-medium truncate" title={column.name}>{column.display_name || column.name}</dd></div>
                    <div><dt className="sr-only">{t('column.fieldName')}</dt><dd className="px-2 py-1 font-mono truncate" title={column.name}>{column.name}</dd></div>
                    <div><dt className="sr-only">{t('interface.view.type')}</dt><dd className="px-2 py-1"><Badge variant="secondary" className="text-[11px] px-1.5 py-0">{columnTypeLabel(column.value_type)}</Badge></dd></div>
                    <div><dt className="sr-only">{t('interface.view.default')}</dt><dd className="px-2 py-1 text-muted-foreground truncate">{column.default_value !== undefined && column.default_value !== '' ? String(column.default_value) : '-'}</dd></div>
                    <div><dt className="sr-only">{t('interface.description')}</dt><dd className="px-2 py-1 text-muted-foreground truncate">{column.description || '-'}</dd></div>
                  </dl>
                  <div className="px-1 py-1" draggable={false} onDragStart={(e) => e.preventDefault()}>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={busy || !!editorTarget} aria-label={t('interface.view.fieldActions', { name: column.display_name || column.name })}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditorTarget(current => current || { mode: 'interface', target_uuid: interfaceUuid, column_uuid: column.uuid })}>
                          <Pencil className="h-4 w-4 mr-2" />{t('interface.view.settings')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => {
                          const ticket = lifetime.current;
                          setTimeout(() => { if (isCurrent(ticket)) setColumnToDelete(column.name); }, 0);
                        }}>
                          <Trash2 className="h-4 w-4 mr-2" />{t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Deletion confirmation */}
      <AlertDialog open={columnToDelete !== null} onOpenChange={(open) => { if (!open) setColumnToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('interface.view.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('interface.view.deleteConfirm', { name: columnToDelete ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoveColumn}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    {editorTarget && <div className="column-editor-host"><ColumnEditor target={editorTarget} expectedProjectSession={expectedProjectSession}
      key={`${expectedProjectSession}:${JSON.stringify(editorTarget)}`} onClose={() => setEditorTarget(null)} onSaved={loadInterfaceData}
      onDelete={editorTarget.column_uuid ? async () => {
        const column = interfaceData.columns.find(c => c.uuid === editorTarget.column_uuid);
        if (!column) throw localizedError(message('interface.view.fieldNotFound'));
        return applyChanges([{ type: 'RemoveColumn', columnName: column.name }], `Remove field "${column.name}"`);
      } : undefined}
    /></div>}
    </div>
  );
};
