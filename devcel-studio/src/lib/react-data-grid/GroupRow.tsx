/**
 * GroupRow.tsx
 * 
 * Component displaying grouped data grid rows
 * Provides the following features:
 * - Collapsible group rows
 * - Group level (hierarchy) display
 * - Group expansion and collapse
 * - Accessibility support through ARIA attributes
 * - Specialized cell rendering within groups
 */

import { memo, useMemo } from 'react';
import { css } from '@linaria/core';
import clsx from 'clsx';

import { RowSelectionContext, type RowSelectionContextValue } from './hooks';
import { getRowStyle } from './utils';
import { omit } from './utils/omit';
import type { BaseRenderRowProps, GroupRow } from './types';
import { SELECT_COLUMN_KEY } from './Columns';
import GroupCell from './GroupCell';
import { cell, cellFrozen } from './style/cell';
import { rowClassname, rowSelectedClassname } from './style/row';

/**
 * CSS styles for group rows
 * - Use the header background color when not selected
 * - Remove borders between cells to display the group row as a whole
 * - Preserve frozen column borders
 */
const groupRow = css`
  @layer rdg.GroupedRow {
    /* Use the header background color for unselected group rows */
    &:not([aria-selected='true']) {
      background-color: var(--rdg-header-background-color);
    }

    /* Remove borders between cells in the group row */
    /* Exclude the last cell and frozen columns */
    > .${cell}:not(:last-child, .${cellFrozen}),
    > :nth-last-child(n + 2 of .${cellFrozen}) {
      border-inline-end: none;
    }
  }
`;

// CSS class name for group rows
const groupRowClassname = `rdg-group-row ${groupRow}`;

/**
 * Group row renderer property definition
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 * 
 * @property row - Group row data, including expansion state and child row count
 * @property groupBy - Array of column keys used for grouping
 * @property toggleGroup - Function toggling group expansion and collapse
 */
interface GroupRowRendererProps<R, SR> extends BaseRenderRowProps<R, SR> {
  row: GroupRow<R>;
  groupBy: readonly string[];
  toggleGroup: (expandedGroupId: unknown) => void;
}

/**
 * Component displaying grouped rows
 * 
 * Unlike regular rows, group rows have the following features:
 * - Hierarchy level display through indentation
 * - Expansion and collapse
 * - Group information, such as child row count
 * - Specialized styling
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 */
function GroupedRow<R, SR>(groupedRowProps: GroupRowRendererProps<R, SR>) {
  // Base row rendering options are component inputs, never DOM attributes.
  const {
    className,
    row,
    rowIdx,
    viewportColumns,
    selectedCellIdx,
    isRowSelected,
    selectCell,
    gridRowStart,
    groupBy,
    toggleGroup,
    ...props
  } = omit(groupedRowProps, ['isRowSelectionDisabled', 'physicalRowTop', 'physicalRowHeight',
    'physicalBodyWindow', 'physicalBodyFallback', 'onCellMouseDown', 'onCellClick',
    'onCellDoubleClick', 'onCellContextMenu']);
  // Calculate the group column index
  // If a selection checkbox column exists, start at level + 1
  const idx = viewportColumns[0].key === SELECT_COLUMN_KEY ? row.level + 1 : row.level;

  /**
   * Handler selecting the entire group row
   * Select the entire group row when it is clicked
   */
  function handleSelectGroup() {
    // idx: -1 indicates that the entire row is selected
    selectCell({ rowIdx, idx: -1 }, { shouldFocusCell: true });
  }

  // Create the row selection context value
  // Selection is always enabled for group rows (isRowSelectionDisabled: false)
  const selectionValue = useMemo(
    (): RowSelectionContextValue => ({ isRowSelectionDisabled: false, isRowSelected }),
    [isRowSelected]
  );

  return (
    <RowSelectionContext value={selectionValue}>
      <div
        role="row"
        data-row-index={rowIdx}
        // ARIA: Tree level (1-based)
        aria-level={row.level + 1}
        // ARIA: Total number of groups at the same level
        aria-setsize={row.setSize}
        // ARIA: Position within the same level (1-based)
        aria-posinset={row.posInSet + 1}
        // ARIA: Group expansion state
        aria-expanded={row.isExpanded}
        className={clsx(
          rowClassname,
          groupRowClassname,
          // Even/odd row styling
          `rdg-row-${rowIdx % 2 === 0 ? 'even' : 'odd'}`,
          // Class for an entirely selected row
          selectedCellIdx === -1 && rowSelectedClassname,
          className
        )}
        onMouseDown={handleSelectGroup}
        style={getRowStyle(gridRowStart)}
        {...props}
      >
        {/* Render GroupCell for each column */}
        {viewportColumns.map((column) => (
          <GroupCell
            key={column.key}
            id={row.id}
            groupKey={row.groupKey}
            childRows={row.childRows}
            isExpanded={row.isExpanded}
            isCellSelected={selectedCellIdx === column.idx}
            column={column}
            row={row}
            groupColumnIndex={idx}
            toggleGroup={toggleGroup}
            // Whether this column is used for grouping
            isGroupByColumn={groupBy.includes(column.key)}
          />
        ))}
      </div>
    </RowSelectionContext>
  );
}

// Memoized component
// Because group rows may render frequently,
// use memo to improve performance
export default memo(GroupedRow) as <R, SR>(
  props: GroupRowRendererProps<R, SR>
) => React.JSX.Element;
