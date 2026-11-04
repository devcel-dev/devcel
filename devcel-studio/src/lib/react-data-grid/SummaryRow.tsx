import { memo } from 'react';
import { css } from '@linaria/core';
import clsx from 'clsx';

import { getColSpan, getRowStyle } from './utils';
import type { RenderRowProps } from './types';
import { cell, cellFrozen } from './style/cell';
import {
  bottomSummaryRowClassname,
  rowClassname,
  rowSelectedClassname,
  topSummaryRowClassname
} from './style/row';
import SummaryCell from './SummaryCell';

/**
 * Type selecting the required properties from RenderRowProps
 * Define properties shared by summary rows
 */
type SharedRenderRowProps<R, SR> = Pick<
  RenderRowProps<R, SR>,
  'viewportColumns' | 'rowIdx' | 'gridRowStart' | 'selectCell'
>;

/**
 * Summary row props
 * Interface for aggregate rows displayed at the top or bottom of the data grid
 */
interface SummaryRowProps<R, SR> extends SharedRenderRowProps<R, SR> {
  /** Row index for accessibility */
  'aria-rowindex': number;
  /** Summary row data */
  row: SR;
  /** Position from the top in pixels */
  top: number | undefined;
  /** Position from the bottom in pixels */
  bottom: number | undefined;
  /** Index of the last frozen column */
  lastFrozenColumnIndex: number;
  /** Column index of the selected cell */
  selectedCellIdx: number | undefined;
  /** Whether this is a top summary row */
  isTop: boolean;
}

/**
 * Base styles for summary rows
 * Use sticky positioning to keep cells visible while scrolling
 */
const summaryRow = css`
  @layer rdg.SummaryRow {
    > .${cell} {
      position: sticky;
    }
  }
`;

/**
 * Additional styles for top summary rows
 * Set z-index to appear above other elements
 */
const topSummaryRow = css`
  @layer rdg.SummaryRow {
    > .${cell} {
      z-index: 2;
    }

    > .${cellFrozen} {
      z-index: 3;
    }
  }
`;

// Combine summary row class names
const summaryRowClassname = `rdg-summary-row ${summaryRow}`;

/**
 * Summary row component
 * Row displaying aggregate information for the data grid
 * 
 * @description
 * This component provides the following features:
 * - Aggregate rows fixed at the top or bottom
 * - Column colSpan support
 * - Cell selection
 * - Fixed positioning during scrolling
 * 
 * Unlike regular data rows, summary rows
 * remain at a fixed screen position while scrolling.
 */
function SummaryRow<R, SR>({
  rowIdx,
  gridRowStart,
  row,
  viewportColumns,
  top,
  bottom,
  lastFrozenColumnIndex,
  selectedCellIdx,
  isTop,
  selectCell,
  'aria-rowindex': ariaRowIndex
}: SummaryRowProps<R, SR>) {
  // Build the array of cell components
  const cells = [];
  for (let index = 0; index < viewportColumns.length; index++) {
    const column = viewportColumns[index];
    // Get the column span for cells spanning multiple columns
    const colSpan = getColSpan(column, lastFrozenColumnIndex, { type: 'SUMMARY', row });
    if (colSpan !== undefined) {
      // Skip indices covered by colSpan
      index += colSpan - 1;
    }

    // Check whether the current cell is selected
    const isCellSelected = selectedCellIdx === column.idx;

    cells.push(
      <SummaryCell<R, SR>
        key={column.key}
        column={column}
        colSpan={colSpan}
        row={row}
        rowIdx={rowIdx}
        isCellSelected={isCellSelected}
        selectCell={selectCell}
      />
    );
  }

  return (
    <div
      role="row"
      data-row-index={rowIdx}
      aria-rowindex={ariaRowIndex}
      className={clsx(
        rowClassname,
        // Even/odd row styling
        `rdg-row-${rowIdx % 2 === 0 ? 'even' : 'odd'}`,
        summaryRowClassname,
        {
          // If the entire row is selected (selectedCellIdx === -1)
          [rowSelectedClassname]: selectedCellIdx === -1,
          // For a top summary row
          [`${topSummaryRowClassname} ${topSummaryRow}`]: isTop,
          // For a bottom summary row
          [bottomSummaryRowClassname]: !isTop
        }
      )}
      style={
        {
          ...getRowStyle(gridRowStart),
          // Set positions as CSS variables for sticky positioning
          '--rdg-summary-row-top': top !== undefined ? `${top}px` : undefined,
          '--rdg-summary-row-bottom': bottom !== undefined ? `${bottom}px` : undefined
        } as unknown as React.CSSProperties
      }
    >
      {cells}
    </div>
  );
}

// Export a memoized component for better performance
export default memo(SummaryRow) as <R, SR>(props: SummaryRowProps<R, SR>) => React.JSX.Element;
