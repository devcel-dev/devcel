import { useI18n, message, resolveMessage, type LocalizedMessage } from '@/app/i18n';
import { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getTableCatalog } from '@/app/commands/tableCommands';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FileSelectTreeView, FileItem } from '@/app/components/common/FileSelectTreeView';
import { ChevronDown, Table2 } from 'lucide-react';
import type { Column } from '@/app/types/tableTypes';
import type { RenderCellProps, RenderEditCellProps } from '@/lib/react-data-grid';
import type { GridRow } from './DataGridView';

/** Return value of get_tables_for_interface */
interface TableForInterface {
  uuid: string;
  path: string;
  display_name: string;
}

/** Tree items: Build the tree from path and use metadata.uuid as the actual value */
interface TableTreeItem extends FileItem {
  metadata: { uuid: string };
}

async function loadTableOptions(interfaceUuid: string, expectedProjectSession: string): Promise<TableTreeItem[]> {
  const rows = await invoke<TableForInterface[]>('get_tables_for_interface', { interfaceUuid, expectedProjectSession });
  return rows.map((r) => ({
    name: r.display_name || r.path,
    path: r.path,
    metadata: { uuid: r.uuid },
  }));
}

/** Table UUID to display name, resolved across all project tables */
async function resolveTableName(uuid: string, expectedProjectSession: string): Promise<string | null> {
  try {
    const list = await getTableCatalog(expectedProjectSession);
    const t = list.find((x) => x.uuid === uuid);
    return t ? t.display_name : null;
  } catch {
    return null;
  }
}

// Read-only display showing the referenced table name
export function TableRefCellRenderer(
  props: RenderCellProps<GridRow> & {
    columnData: Column;
    tableUuid: string;
    expectedProjectSession: string;
    onOpenTable?: (tableUuid: string) => void;
    selectCell?: (position: { rowIdx: number; idx: number }, options?: { enableEditor?: boolean }) => void;
  }
) {
  const { t } = useI18n();
  const value = props.row[props.column.key];
  const [name, setName] = useState<string | LocalizedMessage>('');
  const [loading, setLoading] = useState<boolean>(!!value);

  useEffect(() => {
    let active = true;
    if (value) {
      setLoading(true);
      resolveTableName(value, props.expectedProjectSession).then((n) => {
        if (!active) return;
        setName(n ?? message('reference.tableMissing'));
        setLoading(false);
      });
    } else {
      setName('');
      setLoading(false);
    }
    return () => { active = false; };
  }, [value, props.expectedProjectSession]);

  const isEmpty = !value;
  const isClickable = !isEmpty && !loading && !!props.onOpenTable;

  return (
    <div
      className="h-full flex items-center justify-between px-2"
    >
      <span
        className={`truncate flex items-center gap-1 ${isClickable ? 'cursor-pointer hover:underline' : ''}`}
        style={isClickable && !props.column.customStyles?.backgroundColor && !props.row.cellPresentations?.[props.column.key]?.style.background_color && !props.row.cellPresentations?.[props.column.key]?.style.text_color ? { color: 'hsl(var(--primary-ink))' } : undefined}
        onClick={(e) => {
          if (isClickable && value) {
            e.stopPropagation();
            e.preventDefault();
            props.onOpenTable!(value);
          }
        }}
        title={isClickable ? t('reference.openTable') : undefined}
      >
        {!isEmpty && <Table2 className="h-3.5 w-3.5 shrink-0 opacity-70" />}
        {loading ? t('common.loading') : resolveMessage(name)}
      </span>
      <ChevronDown
        className="h-4 w-4 opacity-50 flex-shrink-0 ml-1 cursor-pointer hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (props.selectCell && props.rowIdx !== undefined) {
            props.selectCell({ rowIdx: props.rowIdx, idx: props.column.idx }, { enableEditor: true });
          }
        }}
      />
    </div>
  );
}

// Editing: Select a table implementing the interface from the file tree
export function TableRefCellEditor(
  props: RenderEditCellProps<GridRow> & { columnData: Column; tableUuid: string; expectedProjectSession: string }
) {
  const { t } = useI18n();
  const initial = (props.row[props.column.key] as string) || '';
  const [open, setOpen] = useState(true);
  const [options, setOptions] = useState<TableTreeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const interfaceUuid = props.columnData.table_ref_config?.interface_uuid;

  useEffect(() => {
    let active = true;
    if (!interfaceUuid) {
      setOptions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    loadTableOptions(interfaceUuid, props.expectedProjectSession).then((o) => {
      if (!active) return;
      setOptions(o);
    }).catch(() => {
      if (!active) return;
      setOptions([]); setFailed(true);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [interfaceUuid, props.expectedProjectSession, retry]);

  const selected = useMemo(
    () => new Set(options.filter((o) => o.metadata.uuid === initial).map((o) => o.path)),
    [options, initial]
  );

  const commit = (uuid: string | null) => {
    const newRow = { ...props.row };
    newRow[props.column.key] = uuid || '';
    props.onRowChange(newRow, true);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) props.onClose(false); // Cancel if closed without selecting
      }}
    >
      <PopoverTrigger asChild>
        <div className="h-full w-full px-2 flex items-center justify-between cursor-pointer">
          <span className="truncate text-muted-foreground">{t('reference.selectTable')}</span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </div>
      </PopoverTrigger>
      <PopoverContent className="p-2 w-[340px]" align="start">
        {!interfaceUuid ? (
          <div className="text-sm text-muted-foreground p-2">
            {t('reference.noInterfaceConfigured')}
          </div>
        ) : loading ? (
          <div className="text-sm text-muted-foreground p-2">{t('common.loading')}</div>
        ) : failed ? (
          <div role="alert" className="p-2 text-sm">
            <p>{t('reference.loadFailed')}</p>
            <button type="button" onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</button>
          </div>
        ) : (
          <>
            <FileSelectTreeView<TableTreeItem>
              items={options}
              selectedItems={selected}
              onToggleItem={(path) => {
                const opt = options.find((o) => o.path === path);
                commit(opt ? opt.metadata.uuid : null);
              }}
              height="240px"
              searchPlaceholder={t('reference.searchTables')}
              emptyMessage={t('reference.noImplementingTables')}
              fileIcon={Table2}
              showClearButton={false}
            />

          </>
        )}
            <div className="pt-2 px-1">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => commit(null)}
              >
                {t('reference.clear')}
              </button>
            </div>
      </PopoverContent>
    </Popover>
  );
}
