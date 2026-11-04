/**
 * useViewportRows.ts
 * 
 * Custom hook calculating rows visible in the viewport
 * Support virtualization with fixed or variable row heights
 */

import { useMemo } from 'react';

import { floor, max, min } from '../utils';
import type { RowGeometry } from './useRowGeometry';
import { useRowGeometry } from './useRowGeometry';

/**
 * Arguments for the useViewportRows hook
 * 
 * @template R - Row data type
 */
interface ViewportRowsArgs<R> {
  rows: readonly R[];                             // All row data
  rowHeight: number | ((row: R) => number);       // Row height, either fixed or a function
  clientHeight: number;                           // Viewport height
  scrollTop: number;                              // Vertical scroll position
  geometry?: RowGeometry;
  enableVirtualization: boolean;                  // Whether virtualization is enabled
}

/**
 * Custom hook calculating rows visible in the viewport
 * 
 * This hook provides the following features:
 * - Calculate virtualized row ranges
 * - Manage row positions and heights
 * - Generate CSS grid templates
 * - Find row indices from scroll positions
 * 
 * @template R - Row data type
 */
export function useViewportRows<R>({
  rows,
  rowHeight,
  clientHeight,
  scrollTop,
  enableVirtualization,
  geometry: providedGeometry
}: ViewportRowsArgs<R>) {
  const fallbackGeometry = useRowGeometry(providedGeometry ? [] : rows, providedGeometry ? 0 : rowHeight);
  const geometry = providedGeometry ?? fallbackGeometry;
  const heights = geometry.heights;
  const rowCount = geometry.count;
  /**
   * Calculate row heights and positions
   * Support both fixed and variable heights
   */
  const { totalRowHeight, gridTemplateRows, getRowTop, getRowHeight, findRowIdx } = useMemo(() => {
    // For fixed heights: Simple calculations
    if (typeof heights === 'number') {
      return {
        totalRowHeight: heights * rowCount,                              // Total height
        gridTemplateRows: ` repeat(${rowCount}, ${heights}px)`,       // CSS grid template
        getRowTop: (rowIdx: number) => rowIdx * heights,                   // Row top position
        getRowHeight: () => heights,                                       // Row height
        findRowIdx: (offset: number) => floor(offset / heights)           // Find the row index from the scroll position
      };
    }

    // For variable heights: Precalculate each row's height
    let totalRowHeight = 0;
    let gridTemplateRows = ' ';
    
    // Precalculate all row heights; this may cause performance problems.
    // An approach like react-window may also be worth considering
    // https://github.com/bvaughn/react-window/blob/b0a470cc264e9100afcaa1b78ed59d88f7914ad4/src/VariableSizeList.js#L68
    const rowPositions = heights.map((currentRowHeight) => {
      const position = { top: totalRowHeight, height: currentRowHeight };
      gridTemplateRows += `${currentRowHeight}px `;
      totalRowHeight += currentRowHeight;
      return position;
    });

    /**
     * Clamp a row index to its valid range
     * @param rowIdx - Row index to validate
     * @returns A row index within the valid range
     */
    const validateRowIdx = (rowIdx: number) => {
      return max(0, min(rowCount - 1, rowIdx));
    };

    return {
      totalRowHeight,
      gridTemplateRows,
      getRowTop: (rowIdx: number) => rowPositions[validateRowIdx(rowIdx)]?.top ?? 0,
      getRowHeight: (rowIdx: number) => rowPositions[validateRowIdx(rowIdx)]?.height ?? 0,
      
      /**
       * Find the row index from a scroll offset
       * Search efficiently with binary search
       * 
       * @param offset - Scroll offset
       * @returns Index of the corresponding row
       */
      findRowIdx(offset: number) {
        // Do not stall rendering searches if unresolved dimensions produce NaN.
        if (!Number.isFinite(offset)) return 0;

        let start = 0;
        let end = rowPositions.length - 1;
        
        // Find the row efficiently using binary search
        while (start <= end) {
          const middle = start + floor((end - start) / 2);
          const currentOffset = rowPositions[middle].top;

          if (currentOffset === offset) return middle;

          if (currentOffset < offset) {
            start = middle + 1;
          } else {
            // Always shrink the search range even if a row position is invalid.
            end = middle - 1;
          }

          // Stop when the offset lies between two row boundaries
          if (start > end) return end;
        }
        return 0;
      }
    };
  }, [heights, rowCount]);

  // Calculate the row range displayed in the viewport
  let rowOverscanStartIdx = 0;
  let rowOverscanEndIdx = rows.length - 1;

  if (enableVirtualization) {
    // Number of overscan buffer rows
    // Include extra rows above and below the visible range to prevent scrolling flicker
    const overscanThreshold = 4;
    
    // Find the first and last currently visible rows
    const rowVisibleStartIdx = findRowIdx(scrollTop);
    const rowVisibleEndIdx = findRowIdx(scrollTop + clientHeight);
    
    // Calculate the range including overscan
    rowOverscanStartIdx = max(0, rowVisibleStartIdx - overscanThreshold);
    rowOverscanEndIdx = min(rows.length - 1, rowVisibleEndIdx + overscanThreshold);
  }

  return {
    rowOverscanStartIdx,      // First row index to render
    rowOverscanEndIdx,        // Last row index to render
    totalRowHeight,           // Total height of all rows
    gridTemplateRows,         // CSS grid-template-rows value
    getRowTop,                // Function getting a row's top position
    getRowHeight,             // Function getting a row's height
    findRowIdx                // Function finding a row from the scroll position
  };
}
