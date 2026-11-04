import { memo, useState } from 'react';
import { css } from '@linaria/core';
import clsx from 'clsx';

import { getColSpan, getRowStyle } from './utils';
import PhysicalRowBody from './PhysicalRowBody';
import type { CalculatedColumn, Direction, Maybe, PhysicalBodyWindow, Position, ResizedWidth } from './types';
import type { DataGridProps } from './DataGrid';
import HeaderCell from './HeaderCell';
import { cell, cellFrozen } from './style/cell';
import { rowSelectedClassname } from './style/row';

/**
 * Type definition for properties shared with DataGrid
 * Include sorting and column reordering properties
 */
type SharedDataGridProps<R, SR, K extends React.Key> = Pick<
  DataGridProps<R, SR, K>,
  'sortColumns' | 'onSortColumnsChange' | 'onColumnsReorder'
>;

/**
 * HeaderRow component property interface
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 * @template K - React Key type
 * 
 * @property rowIdx - Header row index (0-based)
 * @property columns - Array of calculated column definitions
 * @property onColumnResize - Callback invoked when a column is resized
 * @property onColumnResizeEnd - Callback invoked when column resizing ends
 * @property selectCell - Function selecting a cell
 * @property lastFrozenColumnIndex - Index identifying the last frozen column boundary
 * @property selectedCellIdx - Selected cell's column index, or undefined if none
 * @property direction - Text direction (ltr: left to right, rtl: right to left)
 * @property headerRowClass - Additional CSS class for the header row
 */
export interface HeaderRowProps<R, SR, K extends React.Key> extends SharedDataGridProps<R, SR, K> {
  rowIdx: number;
  physicalRowHeight?: number;
  physicalBodyWindow?: PhysicalBodyWindow;
  physicalBodyFallback?: string;
  columns: readonly CalculatedColumn<R, SR>[];
  allColumns: readonly CalculatedColumn<R, SR>[];
  onColumnResize: (column: CalculatedColumn<R, SR>, width: ResizedWidth) => void;
  onColumnResizeEnd: () => void;
  selectCell: (position: Position) => void;
  lastFrozenColumnIndex: number;
  selectedCellIdx: number | undefined;
  direction: Direction;
  headerRowClass: Maybe<string>;
}

/**
 * CSS styles for the header row
 * - display: contents participates in grid layout without generating its own box
 * - Header cells have a z-index placing them above regular cells
 * - Frozen column headers have an even higher z-index
 */
const headerRow = css`
  @layer rdg.HeaderRow {
    display: contents;
    background-color: var(--rdg-header-background-color);
    font-weight: bold;

    & > .${cell} {
      /* Use a value greater than 1 to appear above regular cells and the focus sink */
      z-index: 2;
      position: sticky;
    }

    & > .${cellFrozen} {
      /* Frozen column headers appear above regular header cells */
      z-index: 3;
    }
  }
`;

// Export the header row CSS class name for other components
export const headerRowClassname = `rdg-header-row ${headerRow}`;

/**
 * Component displaying the data grid header row
 * 
 * This component provides the following features:
 * - Column headers
 * - Column sorting
 * - Column resizing
 * - Column reordering through drag and drop
 * - Keyboard navigation
 * - Accessibility support through ARIA roles
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 * @template K - React Key type
 */
function HeaderRow<R, SR, K extends React.Key>({
  headerRowClass,
  physicalRowHeight,
  physicalBodyWindow,
  physicalBodyFallback,
  rowIdx,
  columns,
  allColumns,
  onColumnResize,
  onColumnResizeEnd,
  onColumnsReorder,
  sortColumns,
  onSortColumnsChange,
  lastFrozenColumnIndex,
  selectedCellIdx,
  selectCell,
  direction
}: HeaderRowProps<R, SR, K>) {
  // State tracking the key of the column being dragged
  // Used to visually indicate drop targets during column reordering
  const [draggedColumnKey, setDraggedColumnKey] = useState<string>();
  

  // Build the array of header cells
  const cells: React.ReactNode[] = [];
  const frozenCells: React.ReactNode[] = [];
  const bodyCells: React.ReactNode[] = [];
  
  // Create a HeaderCell component for each column
  // Skip the appropriate indices when colSpan is set
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index];
    
    // Get the column's colSpan for merged cells
    // getColSpan returns a valid span accounting for frozen column boundaries
    const colSpan = getColSpan(column, lastFrozenColumnIndex, { type: 'HEADER' });
    
    // Advance the index by colSpan when set
    // This skips columns covered by merged cells
    if (colSpan !== undefined) {
      index += colSpan - 1;
    }

    // Add the HeaderCell component to the array
    const targetCells = physicalRowHeight === undefined ? cells : column.frozen ? frozenCells : bodyCells;
    targetCells.push(
      <HeaderCell<R, SR>
        key={column.key}
        column={column}
        // Viewport columns retain global idx values and may have gaps.
        // Resize handles must resolve neighbors from the complete column list.
        columns={allColumns}
        colSpan={colSpan}
        rowIdx={rowIdx}
        isCellSelected={selectedCellIdx === column.idx}
        onColumnResize={onColumnResize}
        onColumnResizeEnd={onColumnResizeEnd}
        onColumnsReorder={onColumnsReorder}
        onSortColumnsChange={onSortColumnsChange}
        sortColumns={sortColumns}
        selectCell={selectCell}
        direction={direction}
        draggedColumnKey={draggedColumnKey}
        setDraggedColumnKey={setDraggedColumnKey}
      />
    );
  }

  return (
    <div
      // WAI-ARIA role: Identify this element as a row
      role="row"
      // aria-rowindex: Row index (1-based)
      // Used by screen readers to identify the current row position
      aria-rowindex={rowIdx}
      style={physicalRowHeight === undefined ? undefined : {
        ...getRowStyle(rowIdx), '--rdg-physical-row-height': `${physicalRowHeight}px`
      } as React.CSSProperties}
      className={clsx(
        headerRowClassname,
        physicalRowHeight !== undefined && 'rdg-physical-semantic-header',
        {
          // selectedCellIdx of -1 means the entire row is selected
          // Apply row selection styles in that case
          [rowSelectedClassname]: selectedCellIdx === -1
        },
        // Add a custom class name if provided
        headerRowClass
      )}
    >
      {physicalRowHeight === undefined ? cells : <>
        <div className="rdg-physical-row-pane rdg-physical-row-frozen" data-row-pane="frozen">
          <div className="rdg-physical-row-logical-grid">{frozenCells}</div>
        </div>
        <PhysicalRowBody physicalBodyWindow={physicalBodyWindow} physicalBodyFallback={physicalBodyFallback}>
          <div className="rdg-physical-row-logical-grid">{bodyCells}</div>
        </PhysicalRowBody>
      </>}
    </div>
  );
}

// Export the memoized component
// For better performance, render again only when properties change
export default memo(HeaderRow) as <R, SR, K extends React.Key>(
  props: HeaderRowProps<R, SR, K>
) => React.JSX.Element;