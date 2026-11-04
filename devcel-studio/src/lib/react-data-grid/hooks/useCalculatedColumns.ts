/**
 * useCalculatedColumns.ts
 * 
 * Custom hook calculating and processing data grid columns
 * Provides the following features:
 * - Process column hierarchies and groups
 * - Calculate column widths and layout
 * - Handle frozen columns
 * - Calculate visible column ranges for virtualization
 * - Apply default column options
 */

import { useMemo, useRef } from 'react';
import { sameArray, useStableValue } from './useStableValue';

import { clampColumnWidth, max, min } from '../utils';
import type { CalculatedColumn, CalculatedColumnParent, ColumnOrColumnGroup, Omit } from '../types';
import { renderValue } from '../cellRenderers';
import { SELECT_COLUMN_KEY, ROW_INDICATOR_COLUMN_KEY } from '../Columns';
import type { DataGridProps } from '../DataGrid';
import renderHeaderCell from '../renderHeaderCell';
import { defaultRenderRowIndicator } from '../RowIndicator';
import textEditor from '../editors/textEditor';
import validatedTextEditor from '../editors/validatedTextEditor';

/**
 * Type helper making readonly properties mutable
 * Used when internal processing needs temporary value changes
 */
type Mutable<T> = {
  -readonly [P in keyof T]: T[P] extends ReadonlyArray<infer V> ? Mutable<V>[] : T[P];
};

/**
 * Type definition for a column with a parent
 * Used to support column grouping and hierarchies
 */
interface WithParent<R, SR> {
  readonly parent: MutableCalculatedColumnParent<R, SR> | undefined;
}

// Mutable calculated parent column type for internal processing
type MutableCalculatedColumnParent<R, SR> = Omit<Mutable<CalculatedColumnParent<R, SR>>, 'parent'> &
  WithParent<R, SR>;
// Mutable calculated column type for internal processing
type MutableCalculatedColumn<R, SR> = Omit<Mutable<CalculatedColumn<R, SR>>, 'parent'> &
  WithParent<R, SR>;

/**
 * Column metrics
 * Store each column's width and left position
 */
interface ColumnMetric {
  width: number;    // Column width in pixels
  left: number;     // Column left position in pixels
}

// Default column width
const DEFAULT_COLUMN_WIDTH = 'auto';
const DEFAULT_COLUMN_MIN_WIDTH = 50;

/**
 * Arguments for the useCalculatedColumns hook
 */
interface CalculatedColumnsArgs<R, SR> {
  rawColumns: readonly ColumnOrColumnGroup<R, SR>[];                        // Raw column definitions, including hierarchy
  defaultColumnOptions: DataGridProps<R, SR>['defaultColumnOptions'];      // Default column options
  rowIndicator: DataGridProps<R, SR>['rowIndicator'];                      // Row indicator settings
  getColumnWidth: (column: CalculatedColumn<R, SR>) => string | number;    // Column width getter
  dataTypeStyles?: DataGridProps<R, SR>['dataTypeStyles'];                 // Styles by data type
}

/**
 * Custom hook calculating and processing columns
 * 
 * This hook performs the following operations:
 * 1. Convert raw column definitions to calculated columns
 * 2. Process column hierarchies and groups
 * 3. Position frozen columns appropriately
 * 4. Calculate column widths and layout
 * 5. Determine the visible range for virtualization
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 */
export function useCalculatedColumns<R, SR>({
  rawColumns,
  defaultColumnOptions,
  rowIndicator,
  getColumnWidth,
  dataTypeStyles
}: CalculatedColumnsArgs<R, SR>) {
  // Extract default options
  // Use these defaults when individual columns do not specify their own values
  const defaultWidth = defaultColumnOptions?.width ?? DEFAULT_COLUMN_WIDTH;
  const defaultMinWidth = defaultColumnOptions?.minWidth ?? DEFAULT_COLUMN_MIN_WIDTH;
  const defaultMaxWidth = defaultColumnOptions?.maxWidth ?? undefined;
  const defaultRenderCell = defaultColumnOptions?.renderCell ?? renderValue;
  const defaultRenderHeaderCell = defaultColumnOptions?.renderHeaderCell ?? renderHeaderCell;
  const defaultSortable = defaultColumnOptions?.sortable ?? false;
  const defaultResizable = defaultColumnOptions?.resizable ?? false;
  const defaultDraggable = defaultColumnOptions?.draggable ?? false;

  /**
   * Process and structure columns
   * Generate calculated columns from raw definitions and arrange them in the appropriate order
   */
  const { columns: calculatedColumns, lastFrozenColumnIndex, headerRowsCount } = useMemo((): {
    readonly columns: readonly CalculatedColumn<R, SR>[];           // All processed columns
    readonly colSpanColumns: readonly CalculatedColumn<R, SR>[];    // List of columns with colSpan
    readonly lastFrozenColumnIndex: number;                         // Index of the last frozen column
    readonly headerRowsCount: number;                               // Number of header rows (hierarchy depth)
  } => {
    let lastFrozenColumnIndex = -1;  // -1 when no frozen columns exist
    let headerRowsCount = 1;         // At least one header row is required
    const columns: MutableCalculatedColumn<R, SR>[] = [];

    // Add the row indicator column if configured
    if (rowIndicator) {
      const indicatorWidth = rowIndicator.width ?? 50;
      const rowIndicatorColumn: MutableCalculatedColumn<R, SR> = {
        key: ROW_INDICATOR_COLUMN_KEY,
        name: (rowIndicator.headerContent ?? '') as string,
        idx: 0,
        level: 0,
        parent: undefined,
        frozen: true,
        width: indicatorWidth,
        minWidth: indicatorWidth,
        maxWidth: indicatorWidth,
        resizable: false,
        sortable: false,
        draggable: false,
        renderCell: (props) => {
          const renderIndicator = rowIndicator.renderIndicator ?? defaultRenderRowIndicator;
          return renderIndicator({
            rowIdx: props.rowIdx,
            isCellSelected: props.isCellSelected,
            row: props.row,
            rowNumber: props.rowIdx + 1,
            totalRows: 0, // This must be updated later with the actual row count
            tabIndex: props.tabIndex,
            isRowSelected: false, // This must be obtained from selection state
            column: props.column,
            rowIndicatorConfig: rowIndicator
          });
        },
        renderHeaderCell: () => rowIndicator.headerContent ?? null,
        cellClass: rowIndicator.className,
        headerCellClass: rowIndicator.headerClassName
      };
      columns.push(rowIndicatorColumn);
      lastFrozenColumnIndex++;
    }

    // Collect columns recursively, flattening the hierarchy
    collectColumns(rawColumns, 1);

    /**
     * Collect columns recursively and flatten their hierarchy
     * 
     * @param rawColumns - Array of columns to process, including groups
     * @param level - Current hierarchy level, starting at 1
     * @param parent - Parent group, if present
     */
    function collectColumns(
      rawColumns: readonly ColumnOrColumnGroup<R, SR>[],
      level: number,
      parent?: MutableCalculatedColumnParent<R, SR>
    ) {
      for (const rawColumn of rawColumns) {
        // For grouped columns
        if ('children' in rawColumn) {
          // Create parent group information
          const calculatedColumnParent: MutableCalculatedColumnParent<R, SR> = {
            name: rawColumn.name,
            parent,
            idx: -1,        // Set later
            colSpan: 0,     // Increase according to the number of child columns
            level: 0,       // Set later
            headerCellClass: rawColumn.headerCellClass
          };

          // Process child columns recursively, one level deeper
          collectColumns(rawColumn.children, level + 1, calculatedColumnParent);
          continue;
        }

        // For regular columns
        const frozen = rawColumn.frozen ?? false;

        // Determine custom styles based on dataType
        let customStyles = rawColumn.customStyles;
        if (!customStyles && dataTypeStyles && rawColumn.dataType) {
          const dataTypeStyle = dataTypeStyles[rawColumn.dataType];
          if (dataTypeStyle) {
            customStyles = {
              backgroundColor: dataTypeStyle.backgroundColor as string | undefined,
              color: dataTypeStyle.color as string | undefined,
              fontSize: typeof dataTypeStyle.fontSize === 'number' 
                ? dataTypeStyle.fontSize 
                : undefined,
              fontWeight: dataTypeStyle.fontWeight as string | number | undefined,
              textAlign: dataTypeStyle.textAlign as 'left' | 'center' | 'right' | undefined
            };
          }
        }

        // Create a calculated column object
        // Apply defaults and add required properties
        const column: MutableCalculatedColumn<R, SR> = {
          ...rawColumn,
          parent,
          idx: 0,         // Set later after sorting
          level: 0,       // Calculate later from parent information
          frozen,
          width: rawColumn.width ?? defaultWidth,
          minWidth: rawColumn.minWidth ?? defaultMinWidth,
          maxWidth: rawColumn.maxWidth ?? defaultMaxWidth,
          sortable: rawColumn.sortable ?? defaultSortable,
          resizable: rawColumn.resizable ?? defaultResizable,
          draggable: rawColumn.draggable ?? defaultDraggable,
          renderCell: rawColumn.renderCell ?? defaultRenderCell,
          renderHeaderCell: rawColumn.renderHeaderCell ?? defaultRenderHeaderCell,
          customStyles
        };
        
        // Set an appropriate editor for editable columns without renderEditCell
        if (column.editable !== false && !column.renderEditCell) {
          // Use validatedTextEditor if validator is set
          if (column.validator) {
            column.renderEditCell = validatedTextEditor;
          } else {
            column.renderEditCell = textEditor;
          }
        }

        columns.push(column);

        // For frozen columns, update the last frozen column index
        if (frozen) {
          lastFrozenColumnIndex++;
        }

        // Update the header row count to match the deepest hierarchy
        if (level > headerRowsCount) {
          headerRowsCount = level;
        }
      }
    }

    // Sort columns: Row indicator, selection, frozen, then regular columns
    columns.sort(({ key: aKey, frozen: frozenA }, { key: bKey, frozen: frozenB }) => {
      // Place the row indicator column first
      if (aKey === ROW_INDICATOR_COLUMN_KEY) return -1;
      if (bKey === ROW_INDICATOR_COLUMN_KEY) return 1;
      
      // Place the selection checkbox column after the row indicator
      if (aKey === SELECT_COLUMN_KEY) return -1;
      if (bKey === SELECT_COLUMN_KEY) return 1;

      // Place frozen columns after the selection column
      if (frozenA) {
        if (frozenB) return 0;  // Preserve original order when both columns are frozen
        return -1;              // Place frozenA first when only it is frozen
      }
      if (frozenB) return 1;    // Place frozenB last when only it is frozen

      // TODO: Sort to keep columns with the same parent grouped together

      // Preserve the original order for other columns
      return 0;
    });

    // After sorting, set indices and update parent information
    const colSpanColumns: CalculatedColumn<R, SR>[] = [];
    columns.forEach((column, idx) => {
      // Set the column index
      column.idx = idx;
      // Update parent column information, including colSpan and level
      updateColumnParent(column, idx, 0);

      // Track columns with colSpan separately for merged cell handling
      if (column.colSpan != null) {
        colSpanColumns.push(column);
      }
    });

    return {
      columns,
      colSpanColumns,
      lastFrozenColumnIndex,
      headerRowsCount
    };
  }, [
    rawColumns,
    rowIndicator,
    defaultWidth,
    defaultMinWidth,
    defaultMaxWidth,
    defaultRenderCell,
    defaultRenderHeaderCell,
    defaultResizable,
    defaultSortable,
    defaultDraggable,
    dataTypeStyles
  ]);

  const previousColumns = useRef(new Map<string, CalculatedColumn<R, SR>>());
  const columns = useMemo(() => {
    const shared = calculatedColumns.map(column => {
      const previous = previousColumns.current.get(column.key);
      const keys = Object.keys(column) as (keyof CalculatedColumn<R, SR>)[];
      return previous && keys.length === Object.keys(previous).length
        && keys.every(key => Object.is(previous[key], column[key])) ? previous : column;
    });
    previousColumns.current = new Map(shared.map(column => [column.key, column]));
    return shared;
  }, [calculatedColumns]);
  const colSpanColumns = useMemo(() => columns.filter(column => column.colSpan != null), [columns]);

  // Renderers, names, header controls and transient editability are not layout.
  // Keep a key-based metric map so fresh runtime columns never invalidate it.
  const geometryCandidate = useMemo(() => columns.map(column => {
    const requestedWidth = getColumnWidth(column);
    const width = typeof requestedWidth === 'number'
      ? clampColumnWidth(requestedWidth, column) : column.minWidth;
    const parents: number[] = [];
    for (let parent = column.parent; parent; parent = parent.parent) {
      parents.push(parent.idx, parent.colSpan, parent.level);
    }
    return { key: column.key, width, requestedWidth, minWidth: column.minWidth,
      maxWidth: column.maxWidth, frozen: column.frozen, level: column.level,
      colSpan: column.colSpan, parents };
  }), [columns, getColumnWidth]);
  const columnGeometry = useStableValue(geometryCandidate, (previous, next) =>
    previous.length === next.length && previous.every((column, index) => {
      const other = next[index];
      return column.key === other.key && Object.is(column.width, other.width)
        && Object.is(column.requestedWidth, other.requestedWidth)
        && column.minWidth === other.minWidth && column.maxWidth === other.maxWidth
        && column.frozen === other.frozen && column.level === other.level
        && column.colSpan === other.colSpan && sameArray(column.parents, other.parents);
    }));
  const { templateColumns, layoutCssVars, totalFrozenColumnWidth, columnMetrics, totalColumnWidth } = useMemo(() => {
    const metricsByKey = new Map<string, ColumnMetric>();
    const templateColumns: string[] = [];
    const layoutCssVars: Record<string, string> = {};
    let left = 0;
    let totalFrozenColumnWidth = 0;
    columnGeometry.forEach((column, index) => {
      metricsByKey.set(column.key, { width: column.width, left });
      templateColumns.push(`${column.width}px`);
      if (index <= lastFrozenColumnIndex) {
        layoutCssVars[`--rdg-frozen-left-${index}`] = `${left}px`;
        totalFrozenColumnWidth = left + column.width;
      }
      left += column.width;
    });
    // The adapter accepts both old and new runtime column objects by UUID/key.
    const columnMetrics = { get: (column: { readonly key: string }) => metricsByKey.get(column.key) };
    return { templateColumns, layoutCssVars, totalFrozenColumnWidth, columnMetrics, totalColumnWidth: left };
  }, [columnGeometry, lastFrozenColumnIndex]);

  return { columns, colSpanColumns, templateColumns, layoutCssVars, headerRowsCount,
    lastFrozenColumnIndex, totalFrozenColumnWidth, columnMetrics, totalColumnWidth, columnGeometry };
}

export function useColumnViewport<R, SR>({ columns, columnMetrics, lastFrozenColumnIndex,
  totalFrozenColumnWidth, scrollLeft, viewportWidth, enableVirtualization }: {
  columns: readonly CalculatedColumn<R, SR>[];
  columnMetrics: { get: (column: { readonly key: string }) => ColumnMetric | undefined };
  lastFrozenColumnIndex: number;
  totalFrozenColumnWidth: number;
  scrollLeft: number;
  viewportWidth: number;
  enableVirtualization: boolean;
}) {
  /**
   * Calculate the visible column range for virtualization
   * Determine the index range of columns visible in the viewport
   */
  const [colOverscanStartIdx, colOverscanEndIdx] = useMemo((): [number, number] => {
    // Display all columns when virtualization is disabled
    if (!enableVirtualization) {
      return [0, columns.length - 1];
    }
    
    // Calculate viewport boundaries for non-frozen columns
    // Offset by frozen column width because frozen columns are always visible
    const viewportLeft = scrollLeft + totalFrozenColumnWidth;
    const viewportRight = scrollLeft + viewportWidth;
    
    // Get the first and last non-frozen column indices
    const lastColIdx = columns.length - 1;
    const firstUnfrozenColumnIdx = min(lastFrozenColumnIndex + 1, lastColIdx);

    // Do not render non-frozen columns if frozen columns cover the entire viewport
    if (viewportLeft >= viewportRight) {
      return [firstUnfrozenColumnIdx, firstUnfrozenColumnIdx];
    }

    // Find the first visible non-frozen column
    let colVisibleStartIdx = firstUnfrozenColumnIdx;
    while (colVisibleStartIdx < lastColIdx) {
      const { left, width } = columnMetrics.get(columns[colVisibleStartIdx])!;
      // If a column's right edge passes the viewport's left edge,
      // it is the first column at least partially visible
      if (left + width > viewportLeft) {
        break;
      }
      colVisibleStartIdx++;
    }

    // Find the last visible non-frozen column
    let colVisibleEndIdx = colVisibleStartIdx;
    while (colVisibleEndIdx < lastColIdx) {
      const { left, width } = columnMetrics.get(columns[colVisibleEndIdx])!;
      // If a column's right edge reaches or passes the viewport's right edge,
      // it is the last column at least partially visible
      // The previous column's right edge does not pass the viewport
      if (left + width >= viewportRight) {
        break;
      }
      colVisibleEndIdx++;
    }

    // Calculate the range including overscan buffers
    // Include one extra column on each side to prevent flicker while scrolling
    const colOverscanStartIdx = max(firstUnfrozenColumnIdx, colVisibleStartIdx - 1);
    const colOverscanEndIdx = min(lastColIdx, colVisibleEndIdx + 1);

    return [colOverscanStartIdx, colOverscanEndIdx];
  }, [
    columnMetrics,
    columns,
    lastFrozenColumnIndex,
    scrollLeft,
    totalFrozenColumnWidth,
    viewportWidth,
    enableVirtualization
  ]);

  return { colOverscanStartIdx, colOverscanEndIdx };
}

/**
 * Update column parent information recursively
 * 
 * In a column group hierarchy, update parent indices, levels, and colSpan
 * using child column information. Start at the lowest-level columns
 * and propagate processing recursively to their ancestors.
 * 
 * @param column - Column or parent column to update
 * @param index - Column index
 * @param level - Column hierarchy level, with 0 at the lowest level
 */
function updateColumnParent<R, SR>(
  column: MutableCalculatedColumn<R, SR> | MutableCalculatedColumnParent<R, SR>,
  index: number,
  level: number
) {
  // Update when a shallower level is found
  // Keep the shallowest level because multiple children call this function
  if (level < column.level) {
    column.level = level;
  }

  // Process recursively if a parent exists
  if (column.parent !== undefined) {
    const { parent } = column;
    
    // Set the parent index if unset
    // The first child column's index becomes the parent's index
    if (parent.idx === -1) {
      parent.idx = index;
    }
    
    // Increase the parent's colSpan to include this column
    parent.colSpan += 1;
    
    // Update the parent recursively, moving one level up
    updateColumnParent(parent, index, level - 1);
  }
}
