/**
 * @file Utility for rendering cells that measure grid column widths
 * 
 * This file creates invisible measuring cells to control column widths
 * precisely in a CSS Grid layout. These cells contain no actual content
 * and are used only to enforce minimum and maximum column widths.
 */

import { css } from '@linaria/core';

import type { CalculatedColumn } from '../types';

/**
 * CSS class for measuring cells
 * 
 * @note
 * - contain: strict - Enable layout, style, paint, and size containment for performance
 * - grid-row: 1 - Place cells in the grid's first row (the header row)
 * - visibility: hidden - Hide cells without affecting actual content
 * - @layer rdg.MeasuringCell - Use a CSS cascade layer to manage specificity
 */
const measuringCellClassname = css`
  @layer rdg.MeasuringCell {
    contain: strict;
    grid-row: 1;
    visibility: hidden;
  }
`;

/**
 * Render a measuring cell for each column in the viewport
 * 
 * @param viewportColumns - Array of columns displayed in the current viewport
 * @returns An array of measuring cell React elements
 * 
 * @note
 * CSS Grid requires actual grid items to apply
 * minWidth and maxWidth constraints. These invisible cells
 * are used to enforce column width constraints.
 * 
 * Each cell has the following attributes:
 * - key: Unique key for React reconciliation
 * - gridColumnStart: Column position in CSS Grid (1-based index)
 * - minWidth/maxWidth: Column width constraints
 * - data-measuring-cell-key: Data attribute for debugging and testing
 */
export function renderMeasuringCells<R, SR>(viewportColumns: readonly CalculatedColumn<R, SR>[]) {
  return viewportColumns.map(({ key, idx, minWidth, maxWidth }) => (
    <div
      key={key}
      className={measuringCellClassname}
      style={{ gridColumnStart: idx + 1, minWidth, maxWidth }}
      data-measuring-cell-key={key}
    />
  ));
}
