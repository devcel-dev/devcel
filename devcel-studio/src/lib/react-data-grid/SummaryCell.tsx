import { memo } from 'react';
import { css } from '@linaria/core';

import { useRovingTabIndex } from './hooks';
import { getCellClassname, getCellStyle } from './utils';
import type { CellRendererProps } from './types';

/**
 * CSS class definition for summary cells
 * Use CSS logical properties for top and bottom positioning
 */
export const summaryCellClassname = css`
  @layer rdg.SummaryCell {
    /* Logical top position (from a CSS variable) */
    inset-block-start: var(--rdg-summary-row-top);
    /* Logical bottom position (from a CSS variable) */
    inset-block-end: var(--rdg-summary-row-bottom);
  }
`;

/**
 * Type selecting the required properties from CellRendererProps
 * Define properties shared by summary cells
 */
type SharedCellRendererProps<R, SR> = Pick<
  CellRendererProps<R, SR>,
  'rowIdx' | 'column' | 'colSpan' | 'isCellSelected' | 'selectCell'
>;

/**
 * Summary cell props
 * Interface for displaying individual cells in a summary row
 */
interface SummaryCellProps<R, SR> extends SharedCellRendererProps<R, SR> {
  /** Summary row data */
  row: SR;
}

/**
 * Summary cell component
 * Display individual cells in a summary row and manage interactions
 * 
 * @description
 * This component provides the following features:
 * - Summary data display (aggregates, totals, etc.)
 * - Cell selection
 * - Keyboard navigation
 * - Custom rendering functions
 * - Dynamic style classes
 * 
 * Unlike regular data cells, summary cells are specialized
 * for displaying aggregate information.
 */
function SummaryCell<R, SR>({
  column,
  colSpan,
  row,
  rowIdx,
  isCellSelected,
  selectCell
}: SummaryCellProps<R, SR>) {
  // Manage tab indices for keyboard navigation
  const { tabIndex, childTabIndex, onFocus } = useRovingTabIndex(isCellSelected);
  
  // Get the custom summary cell class from the column definition
  const { summaryCellClass } = column;
  
  // Build the class name (base class + custom class)
  // If summaryCellClass is a function, generate it dynamically using the row data
  const className = getCellClassname(
    column,
    summaryCellClassname,
    typeof summaryCellClass === 'function' ? summaryCellClass(row) : summaryCellClass
  );

  /**
   * Mouse down event handler
   * Select the cell when clicked
   */
  function onMouseDown() {
    selectCell({ rowIdx, idx: column.idx });
  }

  return (
    <div
      role="gridcell"
      // Accessibility: Column index (1-based)
      aria-colindex={column.idx + 1}
      // Accessibility: Cell spanning multiple columns
      aria-colspan={colSpan}
      // Accessibility: Selection state
      aria-selected={isCellSelected}
      tabIndex={tabIndex}
      className={className}
      // Cell styles (width and colSpan support)
      style={getCellStyle(column, colSpan)}
      onMouseDown={onMouseDown}
      onFocus={onFocus}
    >
      {/* Call the custom summary cell renderer */}
      {column.renderSummaryCell?.({ column, row, tabIndex: childTabIndex })}
    </div>
  );
}

// Export a memoized component for better performance
export default memo(SummaryCell) as <R, SR>(props: SummaryCellProps<R, SR>) => React.JSX.Element;
