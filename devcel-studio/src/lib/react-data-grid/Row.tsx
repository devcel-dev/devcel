/**
 * Row.tsx
 * 
 * Component displaying an individual data grid row
 * Provides the following features:
 * - Render each cell in the row
 * - Manage cell selection state
 * - Handle cells in edit mode
 * - Provide row selection context
 * - Support merged cells (colSpan)
 */

import { memo, useMemo, useRef, useLayoutEffect, type ReactElement, type MouseEvent } from 'react';
import clsx from 'clsx';

import { RowSelectionContext, useLatestFunc, type RowSelectionContextValue } from './hooks';
import { createCellEvent, getColSpan, getRowStyle } from './utils';
import { defaultRenderCell, renderPureTextCell, shallowEqualCellProps } from './Cell';
import PhysicalRowBody from './PhysicalRowBody';
import type { CalculatedColumn, CellRendererProps, RenderRowProps } from './types';
import { useDefaultRenderers } from './DataGridDefaultRenderersContext';
import { rowClassname, rowSelectedClassname, rowWithSelectedCellClassname } from './style/row';

/**
 * Data grid row component
 * 
 * Render all cells in the row and provide these features:
 * - Manage cell selection and editing state
 * - Handle mouse and keyboard events
 * - Provide context for row selection state
 * - Support dynamic cell merging (colSpan)
 * - Apply custom classes and styles
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 * 
 * @param className - Additional CSS class name
 * @param rowIdx - Row index (0-based)
 * @param gridRowStart - CSS grid starting position
 * @param selectedCellIdx - Selected column index, or -1 for the entire row
 * @param isRowSelectionDisabled - Whether row selection is disabled
 * @param isRowSelected - Whether the row is selected
 * @param draggedOverCellIdx - Index of the cell hovered during dragging
 * @param lastFrozenColumnIndex - Index of the last frozen column
 * @param row - Row data
 * @param viewportColumns - Array of displayed columns
 * @param selectedCellEditor - Editor component for the cell being edited
 * @param onCellMouseDown - Cell mouse down handler
 * @param onCellClick - Cell click handler
 * @param onCellDoubleClick - Cell double-click handler
 * @param onCellContextMenu - Cell context menu handler
 * @param rowClass - Function applying a custom class to the row
 * @param onRowChange - Row data change handler
 * @param selectCell - Cell selection function
 * @param style - Additional inline styles
 */
function Row<R, SR>({
  className,
  sharedTooltip,
  transientLock,
  isCurrentRowSelected,
  isHovered,
  rangeStartIdx,
  rangeEndIdx,
  getCellBackgroundColor,
  onRowHover,
  rowIdx,
  gridRowStart,
  physicalRowTop,
  physicalRowHeight,
  physicalBodyWindow,
  physicalBodyFallback,
  selectedCellIdx,
  isRowSelectionDisabled,
  isRowSelected,
  draggedOverCellIdx,
  lastFrozenColumnIndex,
  row,
  viewportColumns,
  selectedCellEditor,
  onCellMouseDown,
  onCellClick,
  onCellDoubleClick,
  onCellContextMenu,
  onRowContextMenu,
  rowClass,
  onRowChange,
  selectCell,
  style,
  onMouseEnter,
  onMouseLeave,
  ...props
}: RenderRowProps<R, SR>) {
  // Get the default cell renderer
  // This renderer draws regular cells outside edit mode
  const renderCell = useDefaultRenderers<R, SR>()!.renderCell!;

  // Wrapper for the row data change handler
  // Add column information and the row index before notifying the parent
  const handleRowChange = useLatestFunc((column: CalculatedColumn<R, SR>, newRow: R) => {
    onRowChange(column, rowIdx, newRow);
  });
  
  // Keep row-bound handlers inside Row so parent renders do not change their references.
  const handleMouseEnter = useLatestFunc(() => { onRowHover?.(rowIdx); onMouseEnter?.(); });
  const handleMouseLeave = useLatestFunc(() => { onRowHover?.(undefined); onMouseLeave?.(); });

  // One event function per Row, attached to each numeric host (not row bubbling).
  // currentTarget remains the actual gridcell for callbacks and shared tooltip.
  const handleTextMouse = useLatestFunc((event: MouseEvent<HTMLDivElement>) => {
    const column = viewportColumns.find(column => column.idx === Number(event.currentTarget.dataset.columnIndex));
    if (!column?.renderTextCell) return;
    const select = (enableEditor?: boolean, isShiftPressed?: boolean) =>
      selectCell({ rowIdx, idx: column.idx }, { enableEditor: enableEditor && !transientLock, isShiftPressed });
    const handler = event.type === 'mousedown' ? onCellMouseDown : event.type === 'click' ? onCellClick
      : event.type === 'dblclick' ? onCellDoubleClick : onCellContextMenu;
    let handled = false;
    if (handler) {
      const cellEvent = createCellEvent(event);
      handler({ rowIdx, row, column, selectCell: select }, cellEvent);
      handled = cellEvent.isGridDefaultPrevented();
    }
    if (event.type === 'mousedown' && !handled) select(false, event.shiftKey);
    if (event.type === 'dblclick' && !handled) select(true);
    if (event.type === 'click') sharedTooltip?.onClick(event);
  });
  const textHandlers = useMemo(() => ({ onMouseDown: handleTextMouse, onClick: handleTextMouse,
    onDoubleClick: handleTextMouse, onContextMenu: handleTextMouse }), [handleTextMouse]);
  type TextEntry = { props: CellRendererProps<R, SR>; element: ReactElement };
  const committedTextCache = useRef(new Map<string, TextEntry>());
  // Render-local candidate: interrupted renders cannot publish speculative values.
  // Only visible pure columns enter this map, pruning removed/editor columns.
  const nextTextCache = new Map<string, TextEntry>();
  useLayoutEffect(() => { committedTextCache.current = nextTextCache; });

  // Build the row CSS class name
  // - Base row class
  // - Even/odd row indicator for striping
  // - Class for an entirely selected row
  // - Class for the row containing the selected cell
  // - Result of the custom row class function
  className = clsx(
    rowClassname,
    `rdg-row-${rowIdx % 2 === 0 ? 'even' : 'odd'}`,
    {
      // selectedCellIdx of -1 means the entire row is selected
      [rowSelectedClassname]: selectedCellIdx === -1,
      // If the currently selected cell is in this row
      [rowWithSelectedCellClassname]: isCurrentRowSelected
    },
    physicalRowHeight !== undefined && 'rdg-physical-semantic-row',
    rowClass?.(row, rowIdx),
    className
  );

  // Build the array of cell components
  const cells: React.ReactNode[] = [];
  const frozenCells: React.ReactNode[] = [];
  const bodyCells: React.ReactNode[] = [];

  // Render a cell for each column
  // Skip the appropriate indices when colSpan is set
  for (let index = 0; index < viewportColumns.length; index++) {
    const column = viewportColumns[index];
    const { idx } = column;
    
    // Get this column's colSpan for merged cells
    // getColSpan returns a valid span accounting for frozen column boundaries
    const colSpan = getColSpan(column, lastFrozenColumnIndex, { type: 'ROW', row });
    
    // Advance the index by colSpan when set
    // This skips columns covered by merged cells
    if (colSpan !== undefined) {
      index += colSpan - 1;
    }

    const targetCells = physicalRowHeight === undefined ? cells : column.frozen ? frozenCells : bodyCells;

    // Whether this cell is selected
    const isCellSelected = selectedCellIdx === idx;

    // Display the editor if this is the selected cell and an editor exists
    // Otherwise render a regular cell
    if (isCellSelected && selectedCellEditor) {
      // Edit-mode cell: Add the editor component directly
      targetCells.push(selectedCellEditor);
    } else {
      // Regular-mode cell: Render with renderCell
      const cellProps: CellRendererProps<R, SR> = {
          column,
          colSpan,
          row,
          rowIdx,
          // Structural pane ownership, independent of viewport readiness/window fallback.
          tooltipUsesCellHost: physicalRowHeight !== undefined && !column.frozen,
          sharedTooltip,
          transientLock,
          isDraggedOver: draggedOverCellIdx === idx,
          isCellSelected,
          isHovered,
          isInRange: rangeStartIdx !== undefined && rangeEndIdx !== undefined
            && idx >= rangeStartIdx && idx <= rangeEndIdx,
          getCellBackgroundColor,
          isRowSelected,
          onCellMouseDown,
          onCellClick,
          onCellDoubleClick,
          onCellContextMenu,
          onRowChange: handleRowChange,
          selectCell
        };
      if (renderCell === defaultRenderCell && column.renderTextCell && sharedTooltip && colSpan === undefined) {
        const previous = committedTextCache.current.get(column.key);
        const entry = previous && shallowEqualCellProps(previous.props, cellProps) ? previous
          : { props: cellProps, element: renderPureTextCell(column.key, cellProps, textHandlers) };
        nextTextCache.set(column.key, entry);
        targetCells.push(entry.element);
      } else {
        targetCells.push(renderCell(column.key, cellProps));
      }
    }
  }

  // Create the row selection context value
  // Child components, such as cells, use this context to access row selection state
  const selectionValue = useMemo(
    (): RowSelectionContextValue => ({ isRowSelected, isRowSelectionDisabled }),
    [isRowSelectionDisabled, isRowSelected]
  );

  // Row-level context menu handler
  const handleRowContextMenu = useLatestFunc((event: React.MouseEvent<HTMLDivElement>) => {
    // Display the row-level context menu only if
    // the cell-level context menu was not handled
    if (onRowContextMenu && !event.defaultPrevented) {
      onRowContextMenu(row, event);
    }
  });

  return (
    // Wrap children in the row selection context provider
    <RowSelectionContext value={selectionValue}>
      <div
        role="row"
        data-row-index={rowIdx}
        data-physical-row-top={physicalRowTop}
        data-physical-row-height={physicalRowHeight}
        className={className}
        style={{
          // CSS grid row position styles
          ...getRowStyle(gridRowStart),
          ...(physicalRowHeight === undefined ? {} : { top: physicalRowTop,
            '--rdg-physical-row-height': `${physicalRowHeight}px` }),
          // Additional custom styles
          ...style
        }}
        onContextMenu={handleRowContextMenu}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        {physicalRowHeight === undefined ? cells : <>
          <div className="rdg-physical-row-pane rdg-physical-row-frozen" data-row-pane="frozen">
            <div className="rdg-physical-row-logical-grid">{frozenCells}</div>
          </div>
          <PhysicalRowBody physicalBodyWindow={physicalBodyWindow} physicalBodyFallback={physicalBodyFallback}
            isEditing={Boolean(selectedCellEditor)}>
            <div className="rdg-physical-row-logical-grid">{bodyCells}</div>
          </PhysicalRowBody>
        </>}
      </div>
    </RowSelectionContext>
  );
}

// Memoized component
// Render again only when properties change
const RowComponent = memo(Row) as <R, SR>(props: RenderRowProps<R, SR>) => React.JSX.Element;

export default RowComponent;

/**
 * Default row renderer function
 * Standard row rendering implementation used by DataGrid
 * 
 * @param key - React key for list rendering
 * @param props - Row rendering properties
 * @returns The rendered row component
 */
export function defaultRenderRow<R, SR>(key: React.Key, props: RenderRowProps<R, SR>) {
  return <RowComponent key={key} {...props} />;
}
