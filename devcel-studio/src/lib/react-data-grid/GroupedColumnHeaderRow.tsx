import { memo } from 'react';

import type { CalculatedColumn, CalculatedColumnParent, Position } from './types';
import GroupedColumnHeaderCell from './GroupedColumnHeaderCell';
import { headerRowClassname } from './HeaderRow';

/**
 * Grouped column header row props
 * Interface for displaying hierarchical column headers
 */
export interface GroupedColumnHeaderRowProps<R, SR> {
  /** Row index for accessibility */
  rowIdx: number;
  /** Current grouping level (hierarchy depth) */
  level: number;
  /** Array of columns to display */
  columns: readonly CalculatedColumn<R, SR>[];
  /** Callback when a cell is selected */
  selectCell: (position: Position) => void;
  /** Column index of the selected cell */
  selectedCellIdx: number | undefined;
}

/**
 * Grouped column header row component
 * Display a header row with a hierarchical column structure
 * 
 * @description
 * This component provides the following features:
 * - Multiple levels of grouped column headers
 * - Correct parent column rendering without duplicates
 * - Cell selection
 * - Parent column visibility based on level
 * 
 * For hierarchical columns, a separate header row is generated
 * for each level, with the appropriate parent columns displayed.
 */
function GroupedColumnHeaderRow<R, SR>({
  rowIdx,
  level,
  columns,
  selectedCellIdx,
  selectCell
}: GroupedColumnHeaderRowProps<R, SR>) {
  // Array of cells to render
  const cells = [];
  // Track already rendered parent columns to prevent duplicates
  const renderedParents = new Set<CalculatedColumnParent<R, SR>>();

  // Process each column and display its parent at the current level
  for (const column of columns) {
    let { parent } = column;

    // Skip columns without a parent
    if (parent === undefined) continue;

    // Find the parent at the current level
    // Walk up from deeper parents to the current level
    while (parent.level > level) {
      if (parent.parent === undefined) break;
      parent = parent.parent;
    }

    // Add parents at the current level that have not been rendered yet
    if (parent.level === level && !renderedParents.has(parent)) {
      renderedParents.add(parent);
      const { idx } = parent;
      cells.push(
        <GroupedColumnHeaderCell<R, SR>
          key={idx}
          column={parent}
          rowIdx={rowIdx}
          isCellSelected={selectedCellIdx === idx}
          selectCell={selectCell}
        />
      );
    }
  }

  return (
    <div
      role="row"
      // aria-rowindex is 1-based, as required by accessibility specifications
      aria-rowindex={rowIdx}
      className={headerRowClassname}
    >
      {cells}
    </div>
  );
}

// Export a memoized component for better performance
export default memo(GroupedColumnHeaderRow) as <R, SR>(
  props: GroupedColumnHeaderRowProps<R, SR>
) => React.JSX.Element;
