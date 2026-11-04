import { useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { CalculatedColumn, Column, RenderEditCellProps } from '@/lib/react-data-grid';
import textEditor from '@/lib/react-data-grid/editors/textEditor';
import { renderValue } from '@/lib/react-data-grid/cellRenderers';
import renderHeaderCell from '@/lib/react-data-grid/renderHeaderCell';
import type { GridRow } from './DataGridView';
import type { TableData } from '@/app/types/tableTypes';
import { recordDisplayLabel } from '@/app/utils/recordDisplayLabel';
import { formatNumber } from '@/app/i18n';
import { initialHeaderWidth } from './initialHeaderWidth';

/** The production width resolver consumes the supplied record, never the row list. */
export function createTransposedWidthResolver(widths: Readonly<Record<string, number>>, table: TableData) {
  return (recordUuid: string, row: GridRow) => widths[recordUuid] ?? initialHeaderWidth(
    `${formatNumber(row.rowIndex + 1)}: ${row.tableRecord ? recordDisplayLabel(row.tableRecord, table, row.rowIndex) : row.rowLabel}`, 190);
}

export interface GridViewCell {
  row: GridRow;
  column: Column<GridRow>;
}

/** Resolve UUID identities without copying the table's cell matrix into the view. */
export function resolveGridViewCell(
  displayRow: GridRow,
  displayKey: string,
  transposed: boolean,
  sourceRowsById: ReadonlyMap<string, GridRow>,
  sourceColumnsById: ReadonlyMap<string, Column<GridRow>>,
): GridViewCell | undefined {
  const sourceRow = transposed ? sourceRowsById.get(displayKey) : displayRow;
  const column = sourceColumnsById.get(transposed ? displayRow.rowId : displayKey);
  if (!sourceRow || !column) return undefined;
  // Only an active editor adds a record-keyed draft to a projected row. Preserve
  // the raw input/presentation metadata used by the existing editors.
  const row = transposed && Object.prototype.hasOwnProperty.call(displayRow, displayKey)
    ? { ...sourceRow, [column.key]: displayRow[displayKey] }
    : sourceRow;
  return { row, column };
}

/** O(schema columns) view metadata. Cell values remain in the canonical rows. */
export function createTransposedRows(sourceColumns: readonly Column<GridRow>[]): GridRow[] {
  return sourceColumns.map((column, rowIndex) => ({
    rowId: column.key,
    rowLabel: typeof column.name === 'string' ? column.name : column.key,
    rowIndex,
  }));
}

export interface TransposedColumnsOptions {
  sourceRows: readonly GridRow[];
  sourceColumns: readonly Column<GridRow>[];
  getWidth: (recordUuid: string, record: GridRow) => number;
  renderHeader: (record: GridRow, recordIndex: number) => ReactNode;
  onHeaderDoubleClick?: (record: GridRow, event: MouseEvent<HTMLDivElement>) => void;
  onHeaderContextMenu?: (record: GridRow, event: MouseEvent<HTMLDivElement>) => void;
}

/** Keep cell identity semantic, while editor navigation/layout stays physical. */
function adaptColumn(source: Column<GridRow>, display: CalculatedColumn<GridRow>): CalculatedColumn<GridRow> {
  return {
    ...source,
    idx: display.idx,
    parent: display.parent,
    level: display.level,
    width: display.width,
    minWidth: display.minWidth,
    maxWidth: display.maxWidth,
    frozen: display.frozen,
    resizable: display.resizable,
    sortable: display.sortable,
    draggable: false,
    renderCell: source.renderCell ?? renderValue,
    renderHeaderCell: source.renderHeaderCell ?? renderHeaderCell,
    renderEditCell: source.renderEditCell ?? textEditor,
  };
}

/**
 * A projected column contains multiple data types. The outer EditCell must not
 * commit a Curve dialog on outside click, so apply that option per source cell.
 * React capture also covers portalled Reference/TableRef controls, just as it
 * does in the grid's normal EditCell; interacting with a popup isn't an exit.
 */
function TransposedEditor(props: RenderEditCellProps<GridRow>) {
  const pendingEvent = useRef<globalThis.MouseEvent | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const onClose = useRef(props.onClose);
  useLayoutEffect(() => { onClose.current = props.onClose; });

  const cancelOutsideCommit = () => {
    pendingEvent.current = undefined;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
  };
  const commitOnOutsideClick = props.column.editorOptions?.commitOnOutsideClick ?? true;
  useLayoutEffect(() => {
    if (!commitOnOutsideClick) return;
    const commit = () => {
      if (pendingEvent.current === undefined) return;
      cancelOutsideCommit();
      // The outer EditCell still owns raw-input validation and the latest draft.
      onClose.current(true, false);
    };
    const capture = (event: globalThis.MouseEvent) => {
      cancelOutsideCommit();
      pendingEvent.current = event;
      frame.current = requestAnimationFrame(commit);
    };
    const bubble = (event: globalThis.MouseEvent) => {
      if (pendingEvent.current === event) commit();
    };
    window.addEventListener('mousedown', capture, true);
    window.addEventListener('mousedown', bubble);
    return () => {
      window.removeEventListener('mousedown', capture, true);
      window.removeEventListener('mousedown', bubble);
      cancelOutsideCommit();
    };
  }, [commitOnOutsideClick]);

  return (
    <div style={{ width: '100%', height: '100%' }} onMouseDownCapture={cancelOutsideCommit}>
      {props.column.renderEditCell?.(props)}
      {props.column.editorOptions?.displayCellContent && props.column.renderCell({
        ...props,
        isCellEditable: true,
        tabIndex: -1,
      })}
    </div>
  );
}

/** O(records + schema columns) metadata; each visible cell resolves on demand. */
export function createTransposedColumns({
  sourceRows,
  sourceColumns,
  getWidth,
  renderHeader,
  onHeaderDoubleClick,
  onHeaderContextMenu,
}: TransposedColumnsOptions): Column<GridRow>[] {
  const sourceRowsById = new Map(sourceRows.map(row => [row.rowId, row]));
  const sourceColumnsById = new Map(sourceColumns.map(column => [column.key, column]));
  return sourceRows.map((record, recordIndex) => {
    const resolve = (row: GridRow) => resolveGridViewCell(row, record.rowId, true, sourceRowsById, sourceColumnsById);
    const projectChange = (displayRow: GridRow, canonicalRow: GridRow, sourceKey: string): GridRow => ({
      ...displayRow,
      [record.rowId]: canonicalRow[sourceKey],
    });
    return {
      key: record.rowId,
      name: record.rowLabel,
      width: getWidth(record.rowId, record),
      resizable: true,
      draggable: false,
      sortable: false,
      headerCellClass: 'rdg-cell-has-inline-buttons',
      renderHeaderCell: () => renderHeader(record, recordIndex),
      onHeaderDoubleClick: event => onHeaderDoubleClick?.(record, event),
      onHeaderContextMenu: event => onHeaderContextMenu?.(record, event),
      editable: displayRow => {
        const cell = resolve(displayRow);
        if (!cell || cell.column.dataType === 'Boolean') return false;
        const editable = cell.column.editable;
        return (typeof editable === 'function' ? editable(cell.row) : editable) !== false;
      },
      renderCell: props => {
        const cell = resolve(props.row);
        if (!cell) return null;
        const column = adaptColumn(cell.column, props.column);
        return column.renderCell({
          ...props,
          row: cell.row,
          column,
          onRowChange: row => props.onRowChange(projectChange(props.row, row, cell.column.key)),
        });
      },
      renderEditCell: props => {
        const cell = resolve(props.row);
        if (!cell) return null;
        return <TransposedEditor
          {...props}
          row={cell.row}
          column={adaptColumn(cell.column, props.column)}
          onRowChange={(row, commit) => props.onRowChange(projectChange(props.row, row, cell.column.key), commit)}
        />;
      },
      editorOptions: { commitOnOutsideClick: false },
      cellClass: displayRow => {
        const cell = resolve(displayRow);
        if (!cell) return undefined;
        const cellClass = cell.column.cellClass;
        return typeof cellClass === 'function' ? cellClass(cell.row) : cellClass;
      },
      cellDescription: displayRow => {
        const cell = resolve(displayRow);
        return cell?.column.cellDescription?.(cell.row) ?? {};
      },
      getNavigationValue: displayRow => { const cell=resolve(displayRow); return cell ? cell.row[cell.column.key] : undefined; },
      styleResolver: (_value, unknownRow) => {
        const cell = resolve(unknownRow as GridRow);
        if (!cell) return undefined;
        // Cell applies static customStyles before styleResolver. A transposed
        // record column has no single type/style, so perform both steps here.
        const styles = cell.column.customStyles;
        return {
          ...(styles?.color && { color: styles.color }),
          ...(styles?.fontSize && { fontSize: `${styles.fontSize}px` }),
          ...(styles?.fontWeight && { fontWeight: styles.fontWeight as CSSProperties['fontWeight'] }),
          ...(styles?.textAlign && { textAlign: styles.textAlign }),
          ...cell.column.styleResolver?.(cell.row[cell.column.key], cell.row),
        };
      },
      tooltip: displayRow => {
        const cell = resolve(displayRow);
        if (!cell) return '';
        const tooltip = cell.column.tooltip;
        return (typeof tooltip === 'function' ? tooltip(cell.row) : tooltip) ?? '';
      },
      memoText: displayRow => {
        const cell = resolve(displayRow);
        if (!cell) return '';
        const memoText = cell.column.memoText;
        return (typeof memoText === 'function' ? memoText(cell.row) : memoText) ?? '';
      },
      tooltipPlacement: 'top',
    };
  });
}
