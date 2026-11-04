import { HeaderDescription } from './HeaderDescription';
/**
 * HeaderCell.tsx
 * 
 * Data grid header cell component
 * Provides the following features:
 * - Column sorting by click or keyboard
 * - Column resizing by dragging or keyboard
 * - Column reordering by drag and drop
 * - Accessibility through ARIA attributes and keyboard navigation
 */

import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { css } from '@linaria/core';

import { useRovingTabIndex } from './hooks';
import { usePhysicalViewport } from './DataGridViewportContext';
import {
  clampColumnWidth,
  getCellClassname,
  getCellStyle,
  getHeaderCellRowSpan,
  getHeaderCellStyle,
  getLeftRightKey,
  isCtrlKeyHeldDown,
  stopPropagation
} from './utils';
import type { CalculatedColumn, SortColumn } from './types';
import type { HeaderRowProps } from './HeaderRow';
import { TooltipWrapper } from './TooltipWrapper';
import { useDataGridState } from './DataGridStateContext';

/**
 * CSS class for sortable header cells
 * Show a pointer cursor on sortable column headers
 */
const cellSortableClassname = css`
  @layer rdg.HeaderCell {
    cursor: pointer;
  }
`;

/**
 * CSS class for resizable header cells
 * Disable default touch behavior on touch devices
 * to enable custom resizing
 */
const cellResizable = css`
  @layer rdg.HeaderCell {
    touch-action: none;
  }
`;

const cellResizableClassname = `rdg-cell-resizable ${cellResizable}`;

/**
 * CSS class for the right column resize handle
 * Positioned at the right edge of the header cell (left edge in RTL)
 * Provides a 20px clickable region extending to both sides
 */
export const resizeHandleClassname = css`
  @layer rdg.HeaderCell {
    cursor: col-resize;
    position: absolute;
    inset-block-start: 0;
    inset-inline-end: -10px; /* Extend 10px to the right, into the neighboring cell */
    inset-block-end: 0;
    inline-size: 20px; /* Extend 10px on each side of the cell border */
    z-index: 4; /* Place above other elements */
  }
`;

/**
 * CSS class for the left column resize handle
 * Positioned at the left edge of the header cell
 */
export const resizeHandleLeftClassname = css`
  @layer rdg.HeaderCell {
    cursor: col-resize;
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: -10px; /* Extend 10px to the left, into the neighboring cell */
    inset-block-end: 0;
    inline-size: 20px; /* Extend 10px on each side of the cell border */
    z-index: 4; /* Place above other elements */
  }
`;

/**
 * Class name identifying a draggable header cell
 */
const cellDraggableClassname = 'rdg-cell-draggable';

/**
 * CSS class for the header cell being dragged
 * Change its background color for visual feedback during dragging
 */
const cellDragging = css`
  @layer rdg.HeaderCell {
    background-color: var(--rdg-header-draggable-background-color);
  }
`;

const cellDraggingClassname = `rdg-cell-dragging ${cellDragging}`;

/**
 * CSS class for the header cell hovered by a dragged column
 * Provide visual feedback indicating a drop target
 */
const cellOver = css`
  @layer rdg.HeaderCell {
    background-color: var(--rdg-header-draggable-background-color);
  }
`;

const cellOverClassname = `rdg-cell-drag-over ${cellOver}`;

/**
 * Type definition for properties shared with the header row
 * Include callbacks for sorting, resizing, and reordering
 */
type SharedHeaderRowProps<R, SR> = Pick<
  HeaderRowProps<R, SR, React.Key>,
  | 'sortColumns'
  | 'onSortColumnsChange'
  | 'selectCell'
  | 'onColumnResize'
  | 'onColumnResizeEnd'
  | 'direction'
  | 'onColumnsReorder'
>;

/**
 * Header cell component property type definition
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 * 
 * @property column - Definition of the displayed column
 * @property colSpan - Number of columns occupied by a merged cell
 * @property rowIdx - Row index within a multi-row header
 * @property isCellSelected - Whether the cell is selected
 * @property draggedColumnKey - Key of the column being dragged
 * @property setDraggedColumnKey - Function setting the dragged column
 */
export interface HeaderCellProps<R, SR> extends SharedHeaderRowProps<R, SR> {
  column: CalculatedColumn<R, SR>;
  columns: readonly CalculatedColumn<R, SR>[]; // Include the array of all columns
  colSpan: number | undefined;
  rowIdx: number;
  isCellSelected: boolean;
  draggedColumnKey: string | undefined;
  setDraggedColumnKey: (draggedColumnKey: string | undefined) => void;
}

/**
 * Header cell component
 * 
 * Display a data grid header cell with the following features:
 * - Column sorting by click or keyboard
 * - Column resizing by dragging or keyboard
 * - Column reordering by drag and drop
 * - Keyboard navigation
 * - Accessibility through ARIA attributes
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 */
export default function HeaderCell<R, SR>({
  column,
  columns,
  colSpan,
  rowIdx,
  isCellSelected,
  onColumnResize,
  onColumnResizeEnd,
  onColumnsReorder,
  sortColumns,
  onSortColumnsChange,
  selectCell,
  direction,
  draggedColumnKey,
  setDraggedColumnKey
}: HeaderCellProps<R, SR>) {
  // Track drag-over state for visual feedback as a drop target
  const [isOver, setIsOver] = useState(false);

  // Whether this column is currently being dragged
  const isDragging = draggedColumnKey === column.key;

  // Calculate rowSpan for multi-row headers
  const rowSpan = getHeaderCellRowSpan(column, rowIdx);

  // Roving tabindex hook
  // Manage tab navigation using the keyboard
  const { tabIndex, childTabIndex, onFocus } = useRovingTabIndex(isCellSelected);
  const headerRef = useRef<HTMLDivElement>(null);

  // Get DataGrid state to determine whether this column is selected
  const dataGridState = useDataGridState<R, SR>();
  const isColumnSelected = dataGridState?.selectedPosition?.idx === column.idx;

  // Get sorting information for this column
  const sortIndex = sortColumns?.findIndex((sort) => sort.columnKey === column.key);
  const sortColumn =
    sortIndex !== undefined && sortIndex > -1 ? sortColumns![sortIndex] : undefined;
  const sortDirection = sortColumn?.direction;

  // Priority for multi-column sorting (1-based)
  const priority = sortColumn !== undefined && sortColumns!.length > 1 ? sortIndex! + 1 : undefined;

  // Sort direction for ARIA, set only for single-column sorting
  const ariaSort =
    sortDirection && !priority ? (sortDirection === 'ASC' ? 'ascending' : 'descending') : undefined;

  // Get column feature flags
  const { sortable, resizable, draggable } = column;

  // Build the header cell CSS class name
  // Apply classes according to column state and features
  const className = getCellClassname(column, column.headerCellClass, {
    [cellSortableClassname]: sortable,      // If sortable
    [cellResizableClassname]: resizable,    // If resizable
    [cellDraggableClassname]: draggable,    // If draggable
    [cellDraggingClassname]: isDragging,    // If currently being dragged
    [cellOverClassname]: isOver             // If hovered as a drop target
  });

  /**
   * Function performing sorting
   * 
   * Sorting behavior:
   * 1. Unsorted column: Sort ascending, or descending if descending is preferred
   * 2. Sorted ascending: Switch to descending
   * 3. Sorted descending: Remove sorting
   * 
   * Ctrl-click enables multi-column sorting
   * 
   * @param ctrlClick - Whether Ctrl, or Cmd on Mac, is pressed
   */
  function onSort(ctrlClick: boolean) {
    if (onSortColumnsChange == null) return;
    const { sortDescendingFirst } = column;
    if (sortColumn === undefined) {
      // If not currently sorted, add a new sort
      const nextSort: SortColumn = {
        columnKey: column.key,
        direction: sortDescendingFirst ? 'DESC' : 'ASC'
      };
      // Append to existing sorts on Ctrl-click; otherwise use a single sort
      onSortColumnsChange(sortColumns && ctrlClick ? [...sortColumns, nextSort] : [nextSort]);
    } else {
      // If already sorted, switch direction or remove sorting
      let nextSortColumn: SortColumn | undefined;
      if (
        (sortDescendingFirst === true && sortDirection === 'DESC') ||
        (sortDescendingFirst !== true && sortDirection === 'ASC')
      ) {
        // Reverse the sort direction
        nextSortColumn = {
          columnKey: column.key,
          direction: sortDirection === 'ASC' ? 'DESC' : 'ASC'
        };
      }
      // Remove sorting if nextSortColumn is undefined

      if (ctrlClick) {
        // Multi-column sorting: Update the existing sort array
        const nextSortColumns = [...sortColumns!];
        if (nextSortColumn) {
          // Change the sort direction
          nextSortColumns[sortIndex!] = nextSortColumn;
        } else {
          // Remove this sort
          nextSortColumns.splice(sortIndex!, 1);
        }
        onSortColumnsChange(nextSortColumns);
      } else {
        // Single-column sorting: Sort only by this column
        onSortColumnsChange(nextSortColumn ? [nextSortColumn] : []);
      }
    }
  }

  /**
   * Mouse down event handler
   * Select the header cell when clicked
   */
  function onMouseDown() {
    selectCell({ idx: column.idx, rowIdx });
  }

  /**
   * Click event handler
   * Sort on click if the column is sortable
   * Also run the custom handler if defined
   * 
   * @param event - Mouse event used to check Ctrl/Cmd state
   */
  function onClick(event: React.MouseEvent<HTMLSpanElement>) {
    // Run the custom click handler if provided
    column.onHeaderClick?.(event as React.MouseEvent<HTMLDivElement>);

    if (sortable) {
      onSort(event.ctrlKey || event.metaKey);
    }
  }

  /**
   * Key down event handler
   * Support sorting and resizing with the keyboard
   * 
   * Supported actions:
   * - Space/Enter: Sort sortable columns
   * - Ctrl+Left/Right: Adjust width of resizable columns
   *   - Left arrow: Shrink by 10px
   *   - Right arrow: Expand by 10px
   * 
   * @param event - Keyboard event
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLSpanElement>) {
    const { key } = event;
    if (sortable && (key === ' ' || key === 'Enter')) {
      // Prevent scrolling with the Space key
      event.preventDefault();
      onSort(event.ctrlKey || event.metaKey);
    } else if (
      resizable &&
      isCtrlKeyHeldDown(event) &&
      (key === 'ArrowLeft' || key === 'ArrowRight')
    ) {
      // Prevent navigation within the grid
      event.preventDefault();
      event.stopPropagation();
      // Persist logical pixels, matching pointer resize and auto-fit at any zoom.
      const width = event.currentTarget.offsetWidth;
      const { leftKey } = getLeftRightKey(direction);
      // Account for direction because left and right are reversed in RTL
      const offset = key === leftKey ? -10 : 10;
      const newWidth = clampColumnWidth(width + offset, column);
      if (newWidth !== width) {
        onColumnResize(column, newWidth);
        onColumnResizeEnd();
      }
    }
  }

  /**
   * Drag start event handler
   * Start dragging to reorder columns
   * 
   * @param event - Drag event
   */
  function onDragStart(event: React.DragEvent<HTMLDivElement>) {
    // Some environments, such as WebView2, require dataTransfer data
    // for dragging and dragover/drop events to work. Always set it first.
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', column.key);
    // Update draggedColumnKey immediately so other cells receive drop handlers
    // (onDragOver/onDrop) in time; otherwise drops are missed and columns do not reorder.
    // Use the browser's default drag image, a snapshot of the dragged element.
    // Do not add drag-image elements inside the grid; preserve actual cell placement.
    flushSync(() => {
      setDraggedColumnKey(column.key);
    });
    // Set the drop effect to "move"
    event.dataTransfer.dropEffect = 'move';
  }

  /**
   * Drag end event handler
   * Clear the drag state
   */
  function onDragEnd() {
    setDraggedColumnKey(undefined);
  }

  /**
   * Drag over event handler
   * Allow dropping
   * 
   * @param event - Drag event
   */
  function onDragOver(event: React.DragEvent<HTMLDivElement>) {
    // Prevent the default action to allow dropping
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  /**
   * Drop event handler
   * Reorder columns
   * 
   * @param event - Drag event
   */
  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    setIsOver(false);
    // Prevent possible browser redirection
    event.preventDefault();
    // Move the dragged column to this position
    onColumnsReorder?.(draggedColumnKey!, column.key);
  }

  /**
   * Drag enter event handler
   * Handle the dragged element entering this cell
   * 
   * @param event - Drag event
   */
  function onDragEnter(event: React.DragEvent<HTMLDivElement>) {
    // Only handle appropriate events, excluding movement between children
    if (isEventPertinent(event)) {
      setIsOver(true);
    }
  }

  /**
   * Drag leave event handler
   * Handle the dragged element leaving this cell
   * 
   * @param event - Drag event
   */
  function onDragLeave(event: React.DragEvent<HTMLDivElement>) {
    // Only handle appropriate events, excluding movement between children
    if (isEventPertinent(event)) {
      setIsOver(false);
    }
  }

  // Conditionally set drag-and-drop properties
  let dragTargetProps: React.ComponentProps<'div'> | undefined;
  let dropTargetProps: React.ComponentProps<'div'> | undefined;

  if (draggable) {
    // If this column is draggable, set drag source properties
    dragTargetProps = {
      draggable: true,
      onDragStart,
      onDragEnd
    };

    // If another column is being dragged and this column can accept a drop
    if (draggedColumnKey !== undefined && draggedColumnKey !== column.key) {
      dropTargetProps = {
        onDragOver,
        onDragEnter,
        onDragLeave,
        onDrop
      };
    }
  }

  // Calculate header cell styles
  // Combine header-specific styles, such as position and height,
  // with general cell styles, such as width and borders
  const style: React.CSSProperties = {
    ...getHeaderCellStyle(column, rowIdx, rowSpan),
    ...getCellStyle(column, colSpan),
    // Change the background for the selected column
    ...(isColumnSelected ? { backgroundColor: 'var(--rdg-row-selected-background-color)' } : {}),
    // Use an outline to provide visual feedback for the dragged column
    // The drag image uses the browser's element snapshot, so no separate ghost element is rendered
    ...(isDragging ? { outline: '2px solid var(--rdg-selection-color)', outlineOffset: '-2px', opacity: 0.6 } : {})
  };

  // Generate header content with the column definition's renderHeaderCell function
  // Pass sorting state and tab index
  const content = column.renderHeaderCell({
    column,
    sortDirection,
    priority,
    tabIndex: childTabIndex
  });

  // Get tooltip for header (static only, not function)
  const headerTooltip = typeof column.tooltip === 'string' ? column.tooltip : undefined;
  const headerMemoText = typeof column.memoText === 'string' ? column.memoText : undefined;

  const headerElement = (
    <div
      ref={headerRef}
      role="columnheader"
      aria-colindex={column.idx + 1}  // ARIA indices start at 1
      aria-colspan={colSpan}
      aria-rowspan={rowSpan}
      aria-selected={isCellSelected}
      aria-sort={ariaSort}             // Sort state for screen readers
      tabIndex={tabIndex}
      className={className}
      style={style}
      onMouseDown={onMouseDown}
      onFocus={onFocus}
      onClick={onClick}
      onDoubleClick={column.onHeaderDoubleClick ?? undefined}
      onContextMenu={column.onHeaderContextMenu ?? undefined}
      onKeyDown={onKeyDown}
      {...dragTargetProps}             // Drag source properties
      {...dropTargetProps}             // Drop target properties
    >
      {content}

      {/* If resizable, show the left resize handle except on the first column */}
      {resizable && column.idx > 0 && (
        <ResizeHandle
          direction={direction}
          column={columns[column.idx - 1]} // Resize the previous column
          onColumnResize={onColumnResize}
          onColumnResizeEnd={onColumnResizeEnd}
          position="left"
        />
      )}

      {/* If resizable, show the right resize handle */}
      {resizable && (
        <ResizeHandle
          direction={direction}
          column={column}
          onColumnResize={onColumnResize}
          onColumnResizeEnd={onColumnResizeEnd}
          position="right"
        />
      )}
    </div>
  );

  return (
    <>
      {/* Description is explicitly header-owned; body memo callbacks are independent. */}
      <HeaderDescription text={column.headerMemoText} selected={isCellSelected} anchorRef={headerRef} />
      {(headerTooltip || headerMemoText) ? (
        <TooltipWrapper
          asChild
          tooltip={headerTooltip}
          memoText={headerMemoText}
          placement={column.tooltipPlacement || 'top'}
        >
          {headerElement}
        </TooltipWrapper>
      ) : (
        headerElement
      )}
    </>
  );
}

/**
 * Resize handle component property type definition
 */
type ResizeHandleProps<R, SR> = Pick<
  HeaderCellProps<R, SR>,
  'direction' | 'column' | 'onColumnResize' | 'onColumnResizeEnd'
> & {
  position?: 'left' | 'right'; // Specify the left or right side
};

/**
 * Column resize handle component
 * 
 * Placed at the edge of a header cell to support column resizing by dragging.
 * Use the Pointer Capture API so resizing continues
 * even when the pointer leaves the handle.
 * 
 * Features:
 * - Resize columns by dragging
 * - Double-click to auto-size the column (max-content)
 * - Support right-to-left (RTL) layouts
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 */
function ResizeHandle<R, SR>({
  direction,
  column,
  onColumnResize,
  onColumnResizeEnd,
  position = 'right'
}: ResizeHandleProps<R, SR>) {
  const physicalViewport = usePhysicalViewport();
  const resizeRef = useRef<{
    pointerId: number;
    column: CalculatedColumn<R, SR>;
    startX: number;
    startWidth: number;
    scroller: HTMLElement | null;
    startScrollLeft: number;
    scale: number;
    lastWidth: number;
    onEnd: () => void;
  } | undefined>(undefined);

  useEffect(() => () => {
    const resize = resizeRef.current;
    resizeRef.current = undefined;
    // Virtualization or a removed column can detach the captured handle before
    // pointerup. Complete its last visible width once, just like cancellation.
    resize?.onEnd();
  }, [column.key]);

  const isRtl = direction === 'rtl';

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (resizeRef.current || (event.pointerType === 'mouse' && event.buttons !== 1)) return;

    event.preventDefault();
    event.stopPropagation();

    const { currentTarget, pointerId } = event;
    const headerCell = currentTarget.parentElement;
    const grid = headerCell?.closest('.rdg');
    if (!headerCell || !grid || headerCell.offsetWidth === 0) return;

    // The left handle also uses the width of the previous column being resized, not its own cell.
    // Measure from the current grid because column.width may be a saved initial value.
    const measuringCell = grid.querySelector<HTMLElement>(
      `[data-measuring-cell-key="${CSS.escape(column.key)}"]`
    );
    const startWidth = measuringCell?.offsetWidth ?? Number.parseFloat(
      (physicalViewport && physicalViewport.layout !== 'grid' ? (grid as HTMLElement).style.getPropertyValue('--rdg-physical-columns')
        : getComputedStyle(grid).gridTemplateColumns).split(/\s+/)[column.idx]
    );
    const scale = physicalViewport && physicalViewport.layout !== 'grid' ? physicalViewport.scale
      : headerCell.getBoundingClientRect().width / headerCell.offsetWidth;
    const scroller = physicalViewport && !column.frozen ? physicalViewport.ownerRef.current : null;
    if (!(startWidth > 0) || !(scale > 0) || !Number.isFinite(scale)) return;

    currentTarget.setPointerCapture(pointerId);
    resizeRef.current = {
      pointerId,
      column,
      startX: event.clientX,
      startWidth,
      scroller,
      startScrollLeft: scroller?.scrollLeft ?? 0,
      scale,
      lastWidth: startWidth,
      onEnd: onColumnResizeEnd
    };
  }

  function updateWidth(event: React.PointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;

    event.preventDefault();
    event.stopPropagation();
    // Use only initial width and movement distance to avoid accumulation if rendering moves the cell.
    const currentScrollLeft = resize.scroller?.scrollLeft ?? resize.startScrollLeft;
    const delta = (event.clientX - resize.startX + currentScrollLeft - resize.startScrollLeft) / resize.scale;
    const newWidth = clampColumnWidth(
      resize.startWidth + (isRtl ? -delta : delta),
      resize.column
    );
    if (newWidth !== resize.lastWidth) {
      resize.lastWidth = newWidth;
      try {
        onColumnResize(resize.column, newWidth);
      } finally {
        // Own synchronous range clamp must not feed the next same-position event.
        // Update this captured transaction only, even if callback unmounts it.
        if (resize.scroller) resize.startScrollLeft += resize.scroller.scrollLeft - currentScrollLeft;
      }
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.buttons !== 1) {
      onLostPointerCapture(event);
      return;
    }
    updateWidth(event);
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    // Apply the release position even if the last move event was skipped.
    updateWidth(event);
    onLostPointerCapture(event);
  }

  function onLostPointerCapture(event: React.PointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizeRef.current = undefined;
    event.stopPropagation();
    resize.onEnd();
  }

  function onDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    onColumnResize(column, 'max-content');
    // Auto-fit is synchronous in useColumnWidths and has no drag-end event.
    onColumnResizeEnd();
  }

  const className = position === 'left' ? resizeHandleLeftClassname : resizeHandleClassname;

  return (
    <div
      className={`${className} rdg-cell-resizer rdg-cell-resizer-${position}`}
      onClick={stopPropagation}              // Stop click propagation to avoid triggering sorting
      onMouseDown={stopPropagation}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onLostPointerCapture}
      // Also finish if pointerup is missed, such as after Alt+Tab.
      onLostPointerCapture={onLostPointerCapture}
      onDoubleClick={onDoubleClick}
    />
  );
}

/**
 * Function determining whether a drag event should be handled
 * 
 * Exclude unnecessary events such as:
 * - Drag events from the container to an inner element
 * - Drag events from an inner element to the container
 * 
 * This handles events only when an actual element boundary is crossed
 * 
 * @param event - Drag event
 * @returns Whether the event should be handled
 */
function isEventPertinent(event: React.DragEvent) {
  const relatedTarget = event.relatedTarget as HTMLElement | null;

  // True only if relatedTarget is not a child of the current element
  return !event.currentTarget.contains(relatedTarget);
}
