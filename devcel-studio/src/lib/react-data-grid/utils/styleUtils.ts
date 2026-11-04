/**
 * @file Utility functions for data grid style calculations
 * 
 * This file provides calculations and class name generation
 * for styling with CSS Grid and CSS variables:
 * - Set grid row positions
 * - Calculate header cell styles accounting for rowspan
 * - Calculate data cell styles accounting for colspan and frozen columns
 * - Generate cell class names
 */

import type { CSSProperties } from 'react';
import clsx from 'clsx';

import type { CalculatedColumn, CalculatedColumnOrColumnGroup } from '../types';
import { cellClassname, cellFrozenClassname } from '../style/cell';

/**
 * Get row styles for CSS Grid placement
 * 
 * @param rowIdx - Row index
 * @returns A style object containing CSS variables
 * 
 * @note
 * Set the '--rdg-grid-row-start' CSS variable
 * to control the row's starting position in CSS Grid.
 */
export function getRowStyle(rowIdx: number): CSSProperties {
  return { '--rdg-grid-row-start': rowIdx } as unknown as CSSProperties;
}

/**
 * Calculate header cell styles
 * 
 * @param column - Column or column group
 * @param rowIdx - Row index
 * @param rowSpan - Number of rows occupied by the cell
 * @returns CSS properties for the header cell
 * 
 * @note
 * Handle complex layouts with hierarchical headers:
 * - insetBlockStart: Top position for sticky positioning
 * - gridRowStart/End: Row range in CSS Grid
 * - paddingBlockStart: Top padding according to rowspan
 * 
 * Use different calculations for top-level columns without parents
 * and columns with parents.
 */
export function getHeaderCellStyle<R, SR>(
  column: CalculatedColumnOrColumnGroup<R, SR>,
  rowIdx: number,
  rowSpan: number
): React.CSSProperties {
  const gridRowEnd = rowIdx + 1;
  // Calculate padding for cells spanning multiple rows
  const paddingBlockStart = `calc(${rowSpan - 1} * var(--rdg-header-row-height))`;

  if (column.parent === undefined) {
    // For top-level columns without a parent
    return {
      insetBlockStart: 0,
      gridRowStart: 1,
      gridRowEnd,
      paddingBlockStart
    };
  }

  // For child columns
  return {
    // Calculate the top position for sticky positioning
    insetBlockStart: `calc(${rowIdx - rowSpan} * var(--rdg-header-row-height))`,
    gridRowStart: gridRowEnd - rowSpan,
    gridRowEnd,
    paddingBlockStart
  };
}

/**
 * Calculate data cell styles
 * 
 * @param column - Column information
 * @param colSpan - Number of columns occupied by the cell; defaults to 1
 * @returns CSS properties for the cell
 * 
 * @note
 * - gridColumnStart/End: Set the column range in CSS Grid
 * - insetInlineStart: Left position for frozen columns, using CSS variables
 * 
 * Indices are 1-based to match CSS Grid specifications
 */
export function getCellStyle<R, SR>(
  column: CalculatedColumn<R, SR>,
  colSpan = 1
): React.CSSProperties & Record<'--rdg-global-column-start' | '--rdg-global-column-end', string> {
  const index = column.idx + 1; // CSS Grid uses 1-based indices
  return {
    gridColumnStart: index,
    gridColumnEnd: index + colSpan,
    // Stable in bounded, fallback and non-physical paths; only owned physical CSS uses them.
    '--rdg-global-column-start': String(index),
    '--rdg-global-column-end': String(index + colSpan),
    // For frozen columns, control positioning with CSS variables
    insetInlineStart: column.frozen ? `var(--rdg-frozen-left-${column.idx})` : undefined
  };
}

/**
 * Generate cell class names
 * 
 * @param column - Column information
 * @param extraClasses - Additional class names passed to clsx
 * @returns The combined class name string
 * 
 * @note
 * - Apply the base cell class
 * - Add the frozen class if the column is frozen
 * - Flexibly combine additional classes
 */
export function getCellClassname<R, SR>(
  column: CalculatedColumn<R, SR>,
  ...extraClasses: Parameters<typeof clsx>
): string {
  return clsx(
    cellClassname,
    {
      [cellFrozenClassname]: column.frozen
    },
    ...extraClasses
  );
}
