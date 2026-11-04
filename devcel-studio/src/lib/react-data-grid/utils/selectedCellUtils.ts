/**
 * @file Utility functions for the selected cell
 * 
 * This file provides essential features for cell selection
 * and navigation within the data grid:
 * - Determine whether a cell is editable
 * - Calculate the next cell position for keyboard navigation
 * - Account for colspan (merged cells) during navigation
 * - Determine when focus can leave the grid
 */

import type {
  CalculatedColumn,
  CalculatedColumnParent,
  CellNavigationMode,
  Maybe,
  Position
} from '../types';
import { getColSpan } from './colSpanUtils';

/**
 * Options for determining whether the selected cell is editable
 */
interface IsSelectedCellEditableOpts<R, SR> {
  selectedPosition: Position;
  columns: readonly CalculatedColumn<R, SR>[];
  rows: readonly R[];
}

/**
 * Determine whether the selected cell is editable
 * 
 * @param opts - Options including the selected position, columns, and row data
 * @returns True if the cell is editable
 */
export function isSelectedCellEditable<R, SR>({
  selectedPosition,
  columns,
  rows
}: IsSelectedCellEditableOpts<R, SR>): boolean {
  const column = columns[selectedPosition.idx];
  const row = rows[selectedPosition.rowIdx];
  return isCellEditableUtil(column, row);
}

/**
 * Utility determining whether a cell is editable
 * 
 * @param column - Target column
 * @param row - Target row data
 * @returns True if the cell is editable
 * 
 * @note
 * - Not editable if renderEditCell is undefined
 * - Not editable if editable is false
 * - If editable is a function, use its return value
 * 
 * @see https://github.com/vercel/next.js/issues/56480
 * Separated into its own function to work around a Next.js issue
 */
export function isCellEditableUtil<R, SR>(column: CalculatedColumn<R, SR>, row: R): boolean {
  return (
    column.renderEditCell != null &&
    (typeof column.editable === 'function' ? column.editable(row) : column.editable) !== false
  );
}

/**
 * Options for getting the next selected cell position
 */
interface GetNextSelectedCellPositionOpts<R, SR> {
  /** Whether movement is upward */
  moveUp: boolean;
  /** Whether movement is forward (right or down) */
  moveNext: boolean;
  /** Cell navigation mode (whether row changes are allowed) */
  cellNavigationMode: CellNavigationMode;
  /** Array of all columns */
  columns: readonly CalculatedColumn<R, SR>[];
  /** Array of columns with colspan */
  colSpanColumns: readonly CalculatedColumn<R, SR>[];
  /** Array of data rows */
  rows: readonly R[];
  /** Optional array of top summary rows */
  topSummaryRows: Maybe<readonly SR[]>;
  /** Optional array of bottom summary rows */
  bottomSummaryRows: Maybe<readonly SR[]>;
  /** Minimum row index */
  minRowIdx: number;
  /** Main header row index */
  mainHeaderRowIdx: number;
  /** Maximum row index */
  maxRowIdx: number;
  /** Current position */
  currentPosition: Position;
  /** Candidate next position */
  nextPosition: Position;
  /** Index of the last frozen column */
  lastFrozenColumnIndex: number;
  /** Function determining whether a cell is within bounds */
  isCellWithinBounds: (position: Position) => boolean;
}

/**
 * Get the selected cell's colspan (number of spanned columns)
 * 
 * @param params - Parameters including row data, row index, and column information
 * @returns The colspan value, or undefined
 * 
 * @note
 * Calculate the appropriate colspan for the row type (header, data, or summary).
 * - Header row: Header-specific colspan calculation
 * - Top summary row: colspan based on summary row data
 * - Data row: colspan based on regular row data
 * - Bottom summary row: colspan based on summary row data
 */
function getSelectedCellColSpan<R, SR>({
  rows,
  topSummaryRows,
  bottomSummaryRows,
  rowIdx,
  mainHeaderRowIdx,
  lastFrozenColumnIndex,
  column
}: Pick<
  GetNextSelectedCellPositionOpts<R, SR>,
  'rows' | 'topSummaryRows' | 'bottomSummaryRows' | 'lastFrozenColumnIndex' | 'mainHeaderRowIdx'
> & {
  rowIdx: number;
  column: CalculatedColumn<R, SR>;
}) {
  const topSummaryRowsCount = topSummaryRows?.length ?? 0;
  
  // For a header row
  if (rowIdx === mainHeaderRowIdx) {
    return getColSpan(column, lastFrozenColumnIndex, { type: 'HEADER' });
  }

  // For a top summary row
  if (
    topSummaryRows &&
    rowIdx > mainHeaderRowIdx &&
    rowIdx <= topSummaryRowsCount + mainHeaderRowIdx
  ) {
    return getColSpan(column, lastFrozenColumnIndex, {
      type: 'SUMMARY',
      row: topSummaryRows[rowIdx + topSummaryRowsCount]
    });
  }

  // For a regular data row
  if (rowIdx >= 0 && rowIdx < rows.length) {
    const row = rows[rowIdx];
    return getColSpan(column, lastFrozenColumnIndex, { type: 'ROW', row });
  }

  // For a bottom summary row
  if (bottomSummaryRows) {
    return getColSpan(column, lastFrozenColumnIndex, {
      type: 'SUMMARY',
      row: bottomSummaryRows[rowIdx - rows.length]
    });
  }

  return undefined;
}

/**
 * Calculate the next selected cell position for keyboard navigation
 * 
 * @param opts - Navigation options
 * @returns The next selected position
 * 
 * @note
 * This function performs complex position calculations for keyboard navigation:
 * - Movement accounting for colspan (merged cells)
 * - Movement accounting for the header group hierarchy
 * - Wrapping at row boundaries in CHANGE_ROW mode
 * - Grid boundary checks
 */
export function getNextSelectedCellPosition<R, SR>({
  moveUp,
  moveNext,
  cellNavigationMode,
  columns,
  colSpanColumns,
  rows,
  topSummaryRows,
  bottomSummaryRows,
  minRowIdx,
  mainHeaderRowIdx,
  maxRowIdx,
  currentPosition: { idx: currentIdx, rowIdx: currentRowIdx },
  nextPosition,
  lastFrozenColumnIndex,
  isCellWithinBounds
}: GetNextSelectedCellPositionOpts<R, SR>): Position {
  let { idx: nextIdx, rowIdx: nextRowIdx } = nextPosition;
  const columnsCount = columns.length;

  /**
   * Set the next column index, accounting for colspan
   * 
   * @param moveNext - Whether movement is forward
   */
  const setColSpan = (moveNext: boolean) => {
    // If a cell within a colspan range is selected, move to the previous
    // or next cell according to the navigation direction
    for (const column of colSpanColumns) {
      const colIdx = column.idx;
      if (colIdx > nextIdx) break;
      const colSpan = getSelectedCellColSpan({
        rows,
        topSummaryRows,
        bottomSummaryRows,
        rowIdx: nextRowIdx,
        mainHeaderRowIdx,
        lastFrozenColumnIndex,
        column
      });

      // If the current position is within a colspan range
      if (colSpan && nextIdx > colIdx && nextIdx < colSpan + colIdx) {
        // Move to the end of colspan when moveNext is true; otherwise move to its start
        nextIdx = colIdx + (moveNext ? colSpan : 0);
        break;
      }
    }
  };

  /**
   * Get the parent column's row index
   * 
   * @param parent - Parent column information
   * @returns The parent column's row index
   */
  const getParentRowIdx = (parent: CalculatedColumnParent<R, SR>) => {
    return parent.level + mainHeaderRowIdx;
  };

  /**
   * Set the header group's colspan and rowspan
   * 
   * @note
   * Handle complex navigation for hierarchical headers
   */
  const setHeaderGroupColAndRowSpan = () => {
    if (moveNext) {
      // Find the parent at the same row level
      const nextColumn = columns[nextIdx];
      let parent = nextColumn.parent;
      while (parent !== undefined) {
        const parentRowIdx = getParentRowIdx(parent);
        if (nextRowIdx === parentRowIdx) {
          // Move to the next column beyond the parent's colspan
          nextIdx = parent.idx + parent.colSpan;
          break;
        }
        parent = parent.parent;
      }
    } else if (moveUp) {
      // Find the first reachable parent
      const nextColumn = columns[nextIdx];
      let parent = nextColumn.parent;
      let found = false;
      while (parent !== undefined) {
        const parentRowIdx = getParentRowIdx(parent);
        if (nextRowIdx >= parentRowIdx) {
          // Move to the parent column's position
          nextIdx = parent.idx;
          nextRowIdx = parentRowIdx;
          found = true;
          break;
        }
        parent = parent.parent;
      }

      // Keep the current position if no parent matches the new row position
      if (!found) {
        nextIdx = currentIdx;
        nextRowIdx = currentRowIdx;
      }
    }
  };

  // Handle positions within bounds
  if (isCellWithinBounds(nextPosition)) {
    setColSpan(moveNext);

    // For movement within the header area
    if (nextRowIdx < mainHeaderRowIdx) {
      setHeaderGroupColAndRowSpan();
    }
  }

  // Handle row-changing navigation mode
  if (cellNavigationMode === 'CHANGE_ROW') {
    const isAfterLastColumn = nextIdx === columnsCount;
    const isBeforeFirstColumn = nextIdx === -1;

    if (isAfterLastColumn) {
      // If moving past the last column
      const isLastRow = nextRowIdx === maxRowIdx;
      if (!isLastRow) {
        // Move to the first column of the next row
        nextIdx = 0;
        nextRowIdx += 1;
      }
    } else if (isBeforeFirstColumn) {
      // If moving before the first column
      const isFirstRow = nextRowIdx === minRowIdx;
      if (!isFirstRow) {
        // Move to the last column of the previous row
        nextRowIdx -= 1;
        nextIdx = columnsCount - 1;
      }
      setColSpan(false);
    }
  }

  // Additional checks within the header area
  if (nextRowIdx < mainHeaderRowIdx && nextIdx > -1 && nextIdx < columnsCount) {
    // Find the last reachable parent for the new rowIdx
    // This is needed when navigating to a column
    // without a parent matching the new rowIdx
    const nextColumn = columns[nextIdx];
    let parent = nextColumn.parent;
    const nextParentRowIdx = nextRowIdx;
    nextRowIdx = mainHeaderRowIdx;
    while (parent !== undefined) {
      const parentRowIdx = getParentRowIdx(parent);
      if (parentRowIdx >= nextParentRowIdx) {
        nextRowIdx = parentRowIdx;
        nextIdx = parent.idx;
      }
      parent = parent.parent;
    }
  }

  return { idx: nextIdx, rowIdx: nextRowIdx };
}

/**
 * Options for determining whether focus can leave the grid
 */
interface CanExitGridOpts {
  /** Maximum column index */
  maxColIdx: number;
  /** Minimum row index */
  minRowIdx: number;
  /** Maximum row index */
  maxRowIdx: number;
  /** Current selected position */
  selectedPosition: Position;
  /** Whether Shift is pressed */
  shiftKey: boolean;
}

/**
 * Determine whether focus can leave the grid
 * 
 * @param opts - Grid boundaries and current position
 * @returns True if focus can leave the grid
 * 
 * @note
 * Conditions for leaving the grid through Tab navigation:
 * - With Shift pressed: At the first cell (top left)
 * - Without Shift pressed: At the last cell (bottom right)
 * 
 * This allows Tab navigation to other UI elements
 * outside the grid.
 */
export function canExitGrid({
  maxColIdx,
  minRowIdx,
  maxRowIdx,
  selectedPosition: { rowIdx, idx },
  shiftKey
}: CanExitGridOpts): boolean {
  // Leave the grid when at its first or last cell
  const atLastCellInRow = idx === maxColIdx;
  const atFirstCellInRow = idx === 0;
  const atLastRow = rowIdx === maxRowIdx;
  const atFirstRow = rowIdx === minRowIdx;

  // Shift+Tab leaves from the first cell; Tab leaves from the last cell
  return shiftKey ? atFirstCellInRow && atFirstRow : atLastCellInRow && atLastRow;
}
