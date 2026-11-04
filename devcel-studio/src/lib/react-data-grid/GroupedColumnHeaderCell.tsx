import clsx from 'clsx';

import { useRovingTabIndex } from './hooks';
import { getHeaderCellRowSpan, getHeaderCellStyle } from './utils';
import type { CalculatedColumnParent } from './types';
import type { GroupedColumnHeaderRowProps } from './GroupedColumnHeaderRow';
import { cellClassname } from './style/cell';

/**
 * Type selecting the required properties from GroupedColumnHeaderRowProps
 * Define properties shared by grouped column header cells
 */
type SharedGroupedColumnHeaderRowProps<R, SR> = Pick<
  GroupedColumnHeaderRowProps<R, SR>,
  'rowIdx' | 'selectCell'
>;

/**
 * Grouped column header cell props
 * Interface for parent column header cells in a column hierarchy
 */
interface GroupedColumnHeaderCellProps<R, SR> extends SharedGroupedColumnHeaderRowProps<R, SR> {
  /** Parent column definition (groups multiple child columns) */
  column: CalculatedColumnParent<R, SR>;
  /** Whether the cell is selected */
  isCellSelected: boolean;
}

/**
 * Grouped column header cell component
 * Display a parent column header cell that groups multiple columns
 * 
 * @description
 * This component provides the following features:
 * - Header cells spanning multiple columns (colSpan support)
 * - Header cells spanning multiple rows (rowSpan support)
 * - Cell selection
 * - Keyboard navigation
 * - Custom style classes
 * 
 * Grouped column headers visually group related columns
 * to clarify the data structure.
 */
export default function GroupedColumnHeaderCell<R, SR>({
  column,
  rowIdx,
  isCellSelected,
  selectCell
}: GroupedColumnHeaderCellProps<R, SR>) {
  // Manage tab indices for keyboard navigation
  const { tabIndex, onFocus } = useRovingTabIndex(isCellSelected);
  
  // Column span (number of columns occupied)
  const { colSpan } = column;
  
  // Calculate the row span based on the hierarchy
  const rowSpan = getHeaderCellRowSpan(column, rowIdx);
  
  // Grid column index (1-based)
  const index = column.idx + 1;

  /**
   * Mouse down event handler
   * Select the cell when clicked
   */
  function onMouseDown() {
    selectCell({ idx: column.idx, rowIdx });
  }

  return (
    <div
      role="columnheader"
      // Accessibility: Column index
      aria-colindex={index}
      // Accessibility: Column span
      aria-colspan={colSpan}
      // Accessibility: Row span
      aria-rowspan={rowSpan}
      // Accessibility: Selection state
      aria-selected={isCellSelected}
      tabIndex={tabIndex}
      // Class name (base class + custom class)
      className={clsx(cellClassname, column.headerCellClass)}
      style={{
        // Header cell styles (height, position, etc.)
        ...getHeaderCellStyle(column, rowIdx, rowSpan),
        // Starting position in the grid layout
        gridColumnStart: index,
        // Ending position in the grid layout, accounting for colSpan
        gridColumnEnd: index + colSpan
      }}
      onFocus={onFocus}
      onMouseDown={onMouseDown}
    >
      {/* Display the grouped column name */}
      {column.name}
    </div>
  );
}
