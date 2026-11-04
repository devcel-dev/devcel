import type { Column } from '@/app/types/tableTypes';
import type { GridRow } from './DataGridView';
/** #tag restricts search to row tags; ordinary search includes tags and displayed values. */
export function filterMetadataRows(rows: GridRow[], columns: Column[], search: string): GridRow[] {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return rows;
  const tagsOnly = query.startsWith('#');
  const tagQuery = tagsOnly ? query.slice(1) : query;
  return rows.filter(row => row.tableRecord?.tags.some(tag => tag.toLocaleLowerCase().includes(tagQuery))
    || !tagsOnly && (row.rowLabel.toLocaleLowerCase().includes(query)
      || columns.some(column => String(row[column.uuid] ?? '').toLocaleLowerCase().includes(query))));
}

/** Blank text is meaningful for these types; numeric/boolean/color use their typed input editor. */
export function supportsExplicitEmptyType(dataType: string | null | undefined): boolean {
  return typeof dataType === 'string' && ['String', 'Select', 'Reference', 'TableRef', 'DateTime'].includes(dataType);
}
