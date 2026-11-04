/**
 * colSpanUtils.ts
 * 
 * Utility functions for column spans (colSpan)
 * Manage cells that span multiple columns
 */

import type { CalculatedColumn, ColSpanArgs } from '../types';

/**
 * Calculate a column's colSpan value
 * 
 * colSpan specifies how many columns a cell spans.
 * Spans crossing the boundary between frozen and regular columns are invalid.
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 * @param column - Column whose colSpan is calculated
 * @param lastFrozenColumnIndex - Index of the last frozen column
 * @param args - Arguments passed to the colSpan function (row data, type, etc.)
 * @returns A valid colSpan value (at least 2), or undefined
 * 
 * @example
 * // Static colSpan
 * column.colSpan = 3;
 * 
 * // Dynamic colSpan based on row data
 * column.colSpan = ({ type, row }) => {
 *   if (type === 'ROW' && row.isMerged) return 3;
 *   return 1;
 * };
 */
export function getColSpan<R, SR>(
  column: CalculatedColumn<R, SR>,
  lastFrozenColumnIndex: number,
  args: ColSpanArgs<R, SR>
): number | undefined {
  // Get colSpan: Call the function, use the static value, or default to 1 if undefined
  const colSpan = typeof column.colSpan === 'function' 
    ? column.colSpan(args) 
    : (column.colSpan ?? 1);
  
  // Check whether colSpan is valid
  if (
    Number.isInteger(colSpan) &&    // Must be an integer
    colSpan! > 1 &&                 // Must be at least 2 (1 means no spanning)
    // Ignore spans crossing the boundary between frozen and regular columns
    // Valid only for non-frozen columns or spans entirely within frozen columns
    (!column.frozen || column.idx + colSpan! - 1 <= lastFrozenColumnIndex)
  ) {
    return colSpan!;
  }
  
  // Return undefined if invalid
  return undefined;
}
