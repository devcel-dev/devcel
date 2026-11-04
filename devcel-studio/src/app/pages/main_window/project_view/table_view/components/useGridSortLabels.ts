import { useEffect, useMemo, useState } from 'react';
import type { TableData } from '@/app/types/tableTypes';
import { getTableCatalog } from '@/app/commands/tableCommands';
import { getReferenceOptions } from './referenceOptions';
import type { SortLevel } from './gridFilterSort';

type Labels = ReadonlyMap<string, ReadonlyMap<string, string>>;
const emptyLabels: Labels = new Map();
/** Resolve only reference columns actually used by the view's sort. No writes,
 * formula evaluation, or replacement of the authoritative row values occurs. */
export function useGridSortLabels(table: TableData, session: string, sorts: SortLevel[], refreshVersion: number) {
  const referenceIds = sorts.filter(sort => sort.dataType === 'Reference' || sort.dataType === 'TableRef')
    .map(sort => sort.columnUuid).sort().join('/');
  // Snapshot replacement, sort targets and explicit refreshes all invalidate labels.
  // Retain only scope metadata in settled results, not the previous table snapshot.
  const request = useMemo(() => ({ tableUuid: table.uuid, session, referenceIds, refreshVersion }),
    [table, session, referenceIds, refreshVersion]);
  const displayScope = JSON.stringify([session, table.uuid, referenceIds,
    table.schema.columns.filter(column => referenceIds.split('/').includes(column.uuid))
      .map(column => [column.uuid, column.data_type, column.reference_config])]);
  const [result, setResult] = useState<{ request: typeof request; displayScope: string; labels: Labels } | null>(null);
  useEffect(() => {
    if (!referenceIds) { setResult(null); return; }
    let active = true;
    const ids = new Set(referenceIds.split('/'));
    const columns = table.schema.columns.filter(column => ids.has(column.uuid));
    let catalog: ReturnType<typeof getTableCatalog> | undefined;
    void Promise.all(columns.map(async column => {
      try {
        if (column.data_type === 'TableRef') {
          catalog ??= getTableCatalog(session);
          return [column.uuid, new Map((await catalog).map(item => [item.uuid, item.display_name || item.path]))] as const;
        }
        const options = await getReferenceOptions({ tableUuid: table.uuid, columnUuid: column.uuid,
          expectedProjectSession: session, targetTableUuid: column.reference_config?.target_table_uuid,
          displayColumnUuid: column.reference_config?.display_column_uuid }, table, refreshVersion);
        return [column.uuid, new Map(options.options.map(option => [option.uuid, option.display_value]))] as const;
      } catch (error) {
        // Match reference cells' unresolved fallback; never use another session's names.
        console.error('Failed to resolve reference sort labels', error);
        return [column.uuid, new Map<string, string>()] as const;
      }
    })).then(entries => { if (active) setResult({ request, displayScope, labels: new Map(entries) }); });
    return () => { active = false; };
  }, [request, table, session, referenceIds, refreshVersion, displayScope]);
  // Keep the settled order while the same reference targets are revalidated.
  // Different tables, sessions, or column targets must never borrow labels.
  return referenceIds && result?.displayScope === displayScope ? result.labels : emptyLabels;
}
