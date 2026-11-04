/**
 * useViewportColumns.ts
 * 
 * Custom hook calculating the columns visible in the viewport
 * Determine the column range, accounting for virtualization and colSpan
 */

import { useMemo } from 'react';

import { getColSpan } from '../utils';
import type { CalculatedColumn, Maybe } from '../types';

/**
 * Arguments for the useViewportColumns hook
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 */
interface ViewportColumnsArgs<R, SR> {
  columns: readonly CalculatedColumn<R, SR>[];         // Array of all columns
  colSpanColumns: readonly CalculatedColumn<R, SR>[];  // Array of columns with colSpan
  rows: readonly R[];                                  // Current row data
  topSummaryRows: Maybe<readonly SR[]>;               // Top summary rows
  bottomSummaryRows: Maybe<readonly SR[]>;            // Bottom summary rows
  colOverscanStartIdx: number;                        // Overscan start column index
  colOverscanEndIdx: number;                          // Overscan end column index
  lastFrozenColumnIndex: number;                      // Index of the last frozen column
  rowOverscanStartIdx: number;                        // Overscan start row index
  rowOverscanEndIdx: number;                          // Overscan end row index
}

/**
 * Custom hook calculating the columns visible in the viewport
 * 
 * Determine which virtualized columns are actually displayed.
 * When cells span columns, the originating column must also be rendered,
 * so adjust the starting index accordingly.
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 */
export function useViewportColumns<R, SR>({
  columns,
  colSpanColumns,
  rows,
  topSummaryRows,
  bottomSummaryRows,
  colOverscanStartIdx,
  colOverscanEndIdx,
  lastFrozenColumnIndex,
  rowOverscanStartIdx,
  rowOverscanEndIdx
}: ViewportColumnsArgs<R, SR>) {
  /**
   * Calculate the actual starting column index
   * 
   * For a cell spanning columns in the viewport, its originating column
   * must also be rendered, so adjust the starting index
   */
  const startIdx = useMemo(() => {
    // No adjustment is needed when starting from the first column
    if (colOverscanStartIdx === 0) return 0;

    let startIdx = colOverscanStartIdx;

    /**
     * Helper function updating the starting index
     * 
     * @param colIdx - Index of the column to check
     * @param colSpan - The column's colSpan value
     * @returns True if the starting index was updated
     */
    const updateStartIdx = (colIdx: number, colSpan: number | undefined) => {
      // If colSpan exists and overlaps the viewport
      if (colSpan !== undefined && colIdx + colSpan > colOverscanStartIdx) {
        // eslint-disable-next-line react-compiler/react-compiler
        startIdx = colIdx;  // Start rendering from the originating column
        return true;
      }
      return false;
    };

    // Check all columns with colSpan
    for (const column of colSpanColumns) {
      const colIdx = column.idx;
      
      // Stop upon reaching the already adjusted range
      if (colIdx >= startIdx) break;
      
      // Check colSpan in the header row
      if (updateStartIdx(colIdx, getColSpan(column, lastFrozenColumnIndex, { type: 'HEADER' }))) {
        break;
      }

      // Check colSpan in each row within the viewport
      for (let rowIdx = rowOverscanStartIdx; rowIdx <= rowOverscanEndIdx; rowIdx++) {
        const row = rows[rowIdx];
        if (
          updateStartIdx(colIdx, getColSpan(column, lastFrozenColumnIndex, { type: 'ROW', row }))
        ) {
          break;
        }
      }

      // Check colSpan in the top summary rows
      if (topSummaryRows != null) {
        for (const row of topSummaryRows) {
          if (
            updateStartIdx(
              colIdx,
              getColSpan(column, lastFrozenColumnIndex, { type: 'SUMMARY', row })
            )
          ) {
            break;
          }
        }
      }

      // Check colSpan in the bottom summary rows
      if (bottomSummaryRows != null) {
        for (const row of bottomSummaryRows) {
          if (
            updateStartIdx(
              colIdx,
              getColSpan(column, lastFrozenColumnIndex, { type: 'SUMMARY', row })
            )
          ) {
            break;
          }
        }
      }
    }

    return startIdx;
  }, [
    rowOverscanStartIdx,
    rowOverscanEndIdx,
    rows,
    topSummaryRows,
    bottomSummaryRows,
    colOverscanStartIdx,
    lastFrozenColumnIndex,
    colSpanColumns
  ]);

  /**
   * Build the final array of viewport columns
   * 
   * Collect columns from the adjusted starting index to the ending index.
   * Always include frozen columns.
   */
  return useMemo((): readonly CalculatedColumn<R, SR>[] => {
    const viewportColumns: CalculatedColumn<R, SR>[] = [];
    
    // Collect columns from the starting index to the ending index
    for (let colIdx = 0; colIdx <= colOverscanEndIdx; colIdx++) {
      const column = columns[colIdx];

      // Skip columns before the starting index unless they are frozen
      if (colIdx < startIdx && !column.frozen) continue;
      
      viewportColumns.push(column);
    }

    return viewportColumns;
  }, [startIdx, colOverscanEndIdx, columns]);
}
