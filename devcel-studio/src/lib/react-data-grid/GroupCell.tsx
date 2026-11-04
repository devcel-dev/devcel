import { memo } from 'react';

import { useRovingTabIndex } from './hooks';
import { getCellClassname, getCellStyle } from './utils';
import type { CalculatedColumn, GroupRow } from './types';

/**
 * Group cell props
 * Interface for displaying cells in grouped data grid rows
 */
interface GroupCellProps<R, SR> {
  /** Unique group identifier */
  id: string;
  /** Group key value */
  groupKey: unknown;
  /** Array of child rows in the group */
  childRows: readonly R[];
  /** Function toggling group expansion and collapse */
  toggleGroup: (expandedGroupId: unknown) => void;
  /** Whether the group is expanded */
  isExpanded: boolean;
  /** Column definition for this cell */
  column: CalculatedColumn<R, SR>;
  /** Group row data */
  row: GroupRow<R>;
  /** Whether the cell is selected */
  isCellSelected: boolean;
  /** Grouping column index */
  groupColumnIndex: number;
  /** Whether this column is used for grouping */
  isGroupByColumn: boolean;
}

/**
 * Group cell component
 * Display cells in grouped rows and support expanding and collapsing groups
 * 
 * @description
 * This component provides the following features:
 * - Grouped row display
 * - Click to expand or collapse a group
 * - Keyboard navigation
 * - Custom rendering functions
 * 
 * The cell is clickable only when the grouping level matches,
 * and the appropriate cursor style is applied.
 */
function GroupCell<R, SR>({
  id,
  groupKey,
  childRows,
  isExpanded,
  isCellSelected,
  column,
  row,
  groupColumnIndex,
  isGroupByColumn,
  toggleGroup: toggleGroupWrapper
}: GroupCellProps<R, SR>) {
  // Manage tab indices for keyboard navigation
  const { tabIndex, childTabIndex, onFocus } = useRovingTabIndex(isCellSelected);

  /**
   * Toggle group expansion and collapse
   * Wrap the parent component's toggleGroup function
   */
  function toggleGroup() {
    toggleGroupWrapper(id);
  }

  // Check whether the grouping level matches the current column
  // Make the cell clickable only when they match
  const isLevelMatching = isGroupByColumn && groupColumnIndex === column.idx;

  return (
    <div
      role="gridcell"
      aria-colindex={column.idx + 1}
      aria-selected={isCellSelected}
      tabIndex={tabIndex}
      key={column.key}
      className={getCellClassname(column)}
      style={{
        ...getCellStyle(column),
        // Use a pointer cursor when levels match; otherwise use the default
        cursor: isLevelMatching ? 'pointer' : 'default'
      }}
      onMouseDown={(event) => {
        // Prevent stealing focus from focusSink
        // This preserves keyboard navigation
        event.preventDefault();
      }}
      // Set a click handler only when levels match
      onClick={isLevelMatching ? toggleGroup : undefined}
      onFocus={onFocus}
    >
      {/* Custom group cell rendering */}
      {(!isGroupByColumn || isLevelMatching) &&
        column.renderGroupCell?.({
          groupKey,
          childRows,
          column,
          row,
          isExpanded,
          tabIndex: childTabIndex,
          toggleGroup
        })}
    </div>
  );
}

// Export a memoized component for better performance
export default memo(GroupCell) as <R, SR>(props: GroupCellProps<R, SR>) => React.JSX.Element;
