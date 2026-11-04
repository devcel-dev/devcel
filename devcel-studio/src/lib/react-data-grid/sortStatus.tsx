import { formatNumber } from '@/app/i18n';
import { css } from '@linaria/core';

import type { RenderSortIconProps, RenderSortPriorityProps, RenderSortStatusProps } from './types';

/**
 * Styles for the sort icon (arrow)
 * Use the current text color and animate direction changes smoothly
 */
const arrow = css`
  @layer rdg.SortIcon {
    fill: currentColor;

    > path {
      /* Apply a 0.1-second transition when the path changes */
      transition: d 0.1s;
    }
  }
`;

// Combine class names
const arrowClassname = `rdg-sort-arrow ${arrow}`;

/**
 * Default sort status renderer
 * Display the sort icon together with its priority
 * 
 * @param sortDirection - Sort direction ('ASC' | 'DESC' | undefined)
 * @param priority - Priority for multi-column sorting (undefined or a number)
 * @returns The sort icon and priority elements
 */
export default function renderSortStatus({ sortDirection, priority }: RenderSortStatusProps) {
  return (
    <>
      {/* Icon indicating the sort direction */}
      {renderSortIcon({ sortDirection })}
      {/* Priority for multi-column sorting */}
      {renderSortPriority({ priority })}
    </>
  );
}

/**
 * Sort icon renderer
 * Display an upward or downward arrow according to the sort direction
 * 
 * @param sortDirection - Sort direction ('ASC' | 'DESC' | undefined)
 * @returns An SVG arrow icon or null
 * 
 * @description
 * - ASC (ascending): Upward arrow (▲)
 * - DESC (descending): Downward arrow (▼)
 * - undefined: Display nothing
 * 
 * The SVG path supports transition animations,
 * morphing smoothly when the direction changes.
 */
export function renderSortIcon({ sortDirection }: RenderSortIconProps) {
  // Display nothing if no sort direction is set
  if (sortDirection === undefined) return null;

  return (
    <svg viewBox="0 0 12 8" width="12" height="8" className={arrowClassname} aria-hidden>
      {/* 
        Path data:
        - ASC (ascending): 'M0 8 6 0 12 8' - Upward triangle
        - DESC (descending): 'M0 0 6 8 12 0' - Downward triangle
      */}
      <path d={sortDirection === 'ASC' ? 'M0 8 6 0 12 8' : 'M0 0 6 8 12 0'} />
    </svg>
  );
}

/**
 * Sort priority renderer
 * Display the priority number when sorting by multiple columns
 * 
 * @param priority - Priority (undefined or a number)
 * @returns The priority number or null
 * 
 * @description
 * When multi-column sorting is enabled, display each column's sort priority
 * as a number (for example, 1, 2, 3...).
 * Single-column sorting passes undefined and displays nothing.
 */
export function renderSortPriority({ priority }: RenderSortPriorityProps) {
  return priority === undefined ? undefined : formatNumber(priority);
}
