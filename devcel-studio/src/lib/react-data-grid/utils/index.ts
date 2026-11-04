/**
 * utils/index.ts
 * 
 * Entry point for utility functions
 * Export shared functions used throughout the data grid
 */

import type { CalculatedColumn, CalculatedColumnOrColumnGroup, Maybe } from '../types';

// Re-export each utility module
export * from './colSpanUtils';
export * from './domUtils';
export * from './eventUtils';
export * from './keyboardUtils';
export * from './renderMeasuringCells';
export * from './selectedCellUtils';
export * from './styleUtils';

// Export common Math functions for concise access
export const { min, max, floor, sign, abs } = Math;

/**
 * Assertion function validating the rowKeyGetter function
 * 
 * When row selection is used, ensure that the function
 * for retrieving each row's unique key is configured correctly.
 * 
 * @template R - Row data type
 * @template K - Key type extending React.Key
 * @param keyGetter - Key getter function to validate
 * @throws If rowKeyGetter is not a function
 */
export function assertIsValidKeyGetter<R, K extends React.Key>(
  keyGetter: Maybe<(row: NoInfer<R>) => K>
): asserts keyGetter is (row: R) => K {
  if (typeof keyGetter !== 'function') {
    throw new Error('Please specify the rowKeyGetter prop to use selection');
  }
}

/**
 * Constrain column width between its minimum and maximum
 * 
 * Apply the configured minimum and maximum widths when resizing columns.
 * Ignore maxWidth if it is smaller than minWidth.
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 * @param width - Width before clamping
 * @param column - Column definition, including minWidth and maxWidth
 * @returns The clamped width
 */
export function clampColumnWidth<R, SR>(
  width: number,
  { minWidth, maxWidth }: CalculatedColumn<R, SR>
): number {
  // Apply the minimum width
  width = max(width, minWidth);

  // Apply the maximum width only if maxWidth is at least minWidth
  if (typeof maxWidth === 'number' && maxWidth >= minWidth) {
    return min(width, maxWidth);
  }

  return width;
}

/**
 * Calculate the rowSpan of a header cell
 * 
 * For hierarchical headers (grouped columns),
 * calculate how many rows each header cell occupies.
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 * @param column - Column or grouped column
 * @param rowIdx - Current header row index
 * @returns The rowSpan value (number of rows occupied)
 */
export function getHeaderCellRowSpan<R, SR>(
  column: CalculatedColumnOrColumnGroup<R, SR>,
  rowIdx: number
) {
  // Without a parent, cover all rows through the current row index
  // With a parent, use the difference between the column's and parent's levels
  return column.parent === undefined ? rowIdx : column.level - column.parent.level;
}
