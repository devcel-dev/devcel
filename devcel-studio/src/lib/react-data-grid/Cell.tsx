import { memo, type MouseEvent } from 'react';
import { css } from '@linaria/core';

import { useRovingTabIndex } from './hooks';
import { createCellEvent, getCellClassname, getCellStyle, isCellEditableUtil } from './utils';
import type { CellMouseEventHandler, CellRendererProps } from './types';
import { TooltipWrapper } from './TooltipWrapper';
import { omit } from './utils/omit';

/**
 * Cell styles during drag-over
 * Define the background color when the pointer is over a cell during dragging
 */
const cellDraggedOver = css`
  @layer rdg.Cell {
    background-color: var(--rdg-row-selected-background-color);
  }
`;

// Drag-over class name combined with the CSS module class
const cellDraggedOverClassname = `rdg-cell-dragged-over ${cellDraggedOver}`;

/**
 * Component representing an individual data grid cell
 * Manage cell display, event handling, and editability
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 */
// Shared host semantics for generic cells and explicitly pure text cells.
function getCellHostProps<R, SR>({ column, colSpan, row, rowIdx, className, style,
  isCellSelected, isRowSelected, isDraggedOver, isHovered = false, isInRange = false,
  getCellBackgroundColor, transientLock = false }: CellRendererProps<R, SR>) {
  // Get the cell class from the column definition
  const { cellClass } = column;
  
  // Calculate the final class name
  // Combine drag-over state, column-specific classes, and additional classes
  className = getCellClassname(
    column,
    {
      [cellDraggedOverClassname]: isDraggedOver
    },
    typeof cellClass === 'function' ? cellClass(row) : cellClass,
    className
  );
  
  // Determine whether the cell is editable
  const isEditable = !transientLock && isCellEditableUtil(column, row);

  // Apply custom styles and the style resolver
  let cellStyle = {
    ...getCellStyle(column, colSpan),  // Column styles (width, position, etc.)
    ...style                           // Additional inline styles
  };
  
  // Get the background color from the callback
  if (getCellBackgroundColor) {
    const backgroundColor = getCellBackgroundColor(
      row,
      column,
      {
        isSelected: isRowSelected || isCellSelected,  // Row selection takes precedence
        isHovered: isHovered,
        rowIdx,
        isEvenRow: rowIdx % 2 === 0
      }
    );
    
    if (backgroundColor) {
      cellStyle.backgroundColor = backgroundColor;
    }
  }
  
  // Apply custom styles except the background color
  if (column.customStyles) {
    const { color, fontSize, fontWeight, textAlign } = column.customStyles;
    cellStyle = {
      ...cellStyle,
      ...(color && { color: color }),
      ...(fontSize && { fontSize: `${fontSize}px` }),
      ...(fontWeight && { fontWeight: fontWeight }),
      ...(textAlign && { textAlign: textAlign })
    };
  }
  
  // Run the style resolver except for the background color
  if (column.styleResolver) {
    const cellValue = (row as any)[column.key];
    const resolvedStyles = column.styleResolver(cellValue, row);
    if (resolvedStyles) {
      const otherResolvedStyles = omit(resolvedStyles, ['backgroundColor']);
      cellStyle = { ...cellStyle, ...otherResolvedStyles };
    }
  }

  // Range selection is an outline, preserving the Rust conditional background.
  if (isInRange || isCellSelected) {
    cellStyle = { ...cellStyle, outline: '1px solid var(--rdg-selection-color)', outlineOffset: '-1px' };
  }

  // Description supplements the value readout without adding a content wrapper.
  const description = column.cellDescription?.(row);

  return { isEditable, hostProps: {
    role: 'gridcell', title: description?.title, 'aria-description': description?.description,
    'aria-invalid': description?.invalid, 'data-row-index': rowIdx,
    'data-column-index': column.idx, 'aria-colindex': column.idx + 1,
    'aria-colspan': colSpan, 'aria-selected': isCellSelected || isInRange,
    'aria-readonly': !isEditable || undefined, className, style: cellStyle
  } };
}

// Internal Row-only path: not a generic replacement for Cell custom DOM/event props.
// Opt-in content is text-only in every selection state; sharedTooltip is required.
export function renderPureTextCell<R, SR>(key: React.Key, props: CellRendererProps<R, SR>,
  handlers: Pick<React.HTMLAttributes<HTMLDivElement>, 'onMouseDown' | 'onClick' | 'onDoubleClick' | 'onContextMenu'>) {
  const { hostProps } = getCellHostProps(props);
  return <div key={key} {...hostProps} tabIndex={props.isCellSelected ? 0 : -1} {...handlers}
    onFocus={props.sharedTooltip!.onFocus} onBlur={props.sharedTooltip!.onBlur}
    onMouseEnter={props.sharedTooltip!.onMouseEnter} onMouseLeave={props.sharedTooltip!.onMouseLeave}>
    {props.column.renderTextCell!(props.row)}
  </div>;
}

function Cell<R, SR>(cellProps: CellRendererProps<R, SR>) {
  const {
  tooltipUsesCellHost = false,
  sharedTooltip,
  transientLock = false,
  column,                  // Column definition
  isCellSelected,          // Whether the cell is selected
  row,                     // Row data
  rowIdx,                  // Row index
  onMouseEnter,
  onMouseLeave,
  onFocus: onCellFocus,
  onBlur: onCellBlur,
  onMouseDown,             // Parent mouse down handler
  onCellMouseDown,         // Cell-specific mouse down handler
  onClick,                 // Parent click handler
  onCellClick,             // Cell-specific click handler
  onDoubleClick,           // Parent double-click handler
  onCellDoubleClick,       // Cell-specific double-click handler
  onContextMenu,           // Parent context menu handler
  onCellContextMenu,       // Cell-specific context menu handler
  onRowChange,             // Row data change handler
  selectCell,              // Cell selection function
  ...props                 // Other div element properties
} = omit(cellProps, ['isHovered', 'isInRange', 'getCellBackgroundColor', 'colSpan',
  'isRowSelected', 'isDraggedOver', 'className', 'style']);
  // Keyboard navigation using roving tabindex
  // Only the selected cell has tabIndex=0 and can receive focus through Tab
  const { tabIndex, childTabIndex, onFocus } = useRovingTabIndex(isCellSelected);

  const { hostProps, isEditable } = getCellHostProps(cellProps);

  /**
   * Cell selection wrapper function
   * @param enableEditor - Whether to enable editing
   * @param isShiftPressed - Whether Shift is pressed
   */
  function selectCellWrapper(enableEditor?: boolean, isShiftPressed?: boolean) {
    selectCell({ rowIdx, idx: column.idx }, { enableEditor: enableEditor && !transientLock, isShiftPressed });
  }

  /**
   * Shared mouse event handling
   * Run the custom event handler if defined,
   * and return whether the default action was prevented
   */
  function handleMouseEvent(
    event: React.MouseEvent<HTMLDivElement>,
    eventHandler?: CellMouseEventHandler<R, SR>
  ) {
    let eventHandled = false;
    if (eventHandler) {
      // Create a custom cell event with the preventGridDefault method
      const cellEvent = createCellEvent(event);
      eventHandler({ rowIdx, row, column, selectCell: selectCellWrapper }, cellEvent);
      eventHandled = cellEvent.isGridDefaultPrevented();
    }
    return eventHandled;
  }

  /**
   * Mouse down event handler
   * Select the cell unless the default action is prevented
   */
  function handleMouseDown(event: MouseEvent<HTMLDivElement>) {
    onMouseDown?.(event);
    if (!handleMouseEvent(event, onCellMouseDown)) {
      // Select the cell if the event was not prevented
      selectCellWrapper(false, event.shiftKey);
    }
  }

  /**
   * Click event handler
   * Run the custom handler if provided
   */
  function handleClick(event: MouseEvent<HTMLDivElement>) {
    onClick?.(event);
    handleMouseEvent(event, onCellClick);
    sharedTooltip?.onClick(event);
  }

  /**
   * Double-click event handler
   * Enter edit mode unless the default action is prevented
   */
  function handleDoubleClick(event: MouseEvent<HTMLDivElement>) {
    onDoubleClick?.(event);
    if (!handleMouseEvent(event, onCellDoubleClick)) {
      // Enter edit mode if the event was not prevented
      selectCellWrapper(true);
    }
  }

  /**
   * Context menu event handler
   * Run the custom handler if provided
   */
  function handleContextMenu(event: MouseEvent<HTMLDivElement>) {
    onContextMenu?.(event);
    handleMouseEvent(event, onCellContextMenu);
  }

  /**
   * Wrapper for the row data change handler
   * Add column information and notify the parent component
   */
  function handleRowChange(newRow: R) {
    if (!transientLock) onRowChange(column, newRow);
  }

  
  function handleFocus(event: React.FocusEvent<HTMLDivElement>) {
    (onCellFocus ?? onFocus)?.(event);
    if (!event.isPropagationStopped()) sharedTooltip?.onFocus(event);
  }
  function handleBlur(event: React.FocusEvent<HTMLDivElement>) {
    onCellBlur?.(event);
    if (!event.isPropagationStopped()) sharedTooltip?.onBlur(event);
  }
  function handleMouseEnter(event: React.MouseEvent<HTMLDivElement>) {
    // Existing wrapper entered before its child's enter handler.
    sharedTooltip?.onMouseEnter(event);
    onMouseEnter?.(event);
  }
  function handleMouseLeave(event: React.MouseEvent<HTMLDivElement>) {
    onMouseLeave?.(event);
    if (!event.isPropagationStopped()) sharedTooltip?.onMouseLeave(event);
  }

  // Standalone custom callers without a grid controller keep the generic route.
  // Normal grid cells resolve tooltip metadata only for the active target.
  // Get tooltip text
  const tooltipText = sharedTooltip ? undefined : typeof column.tooltip === 'function'
    ? column.tooltip(row)
    : column.tooltip;
  
  const memoText = sharedTooltip ? undefined : typeof column.memoText === 'function'
    ? column.memoText(row)
    : column.memoText;

  const cellElement = (
    <div
      {...hostProps}
      tabIndex={tabIndex}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onFocus={sharedTooltip ? onCellFocus || onFocus ? handleFocus : sharedTooltip.onFocus : onCellFocus ?? onFocus}
      onBlur={sharedTooltip ? onCellBlur ? handleBlur : sharedTooltip.onBlur : onCellBlur}
      onMouseEnter={sharedTooltip ? onMouseEnter ? handleMouseEnter : sharedTooltip.onMouseEnter : onMouseEnter}
      onMouseLeave={sharedTooltip ? onMouseLeave ? handleMouseLeave : sharedTooltip.onMouseLeave : onMouseLeave}
      {...props}
    >
      {/* Render the cell content using the column definition's renderCell function */}
      {column.renderCell({
        column,
        row,
        rowIdx,
        isCellEditable: isEditable,
        isCellSelected,
        tabIndex: childTabIndex,
        onRowChange: handleRowChange
      })}
    </div>
  );

  // Wrap with tooltip if needed
  if (tooltipText || memoText) {
    return (
      <TooltipWrapper
        asChild={tooltipUsesCellHost}
        className={tooltipUsesCellHost ? undefined : "rdg-cell-tooltip-wrapper"}
        tooltip={tooltipText || undefined}
        memoText={memoText || undefined}
        placement={column.tooltipPlacement || 'top'}
      >
        {cellElement}
      </TooltipWrapper>
    );
  }

  return cellElement;
}

// Memoized Cell component
// Use memo to prevent unnecessary renders
export function shallowEqualCellProps(a: object, b: object): boolean {
  if (Object.is(a, b)) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => Object.prototype.hasOwnProperty.call(b, key)
    && Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

const CellComponent = memo(Cell, shallowEqualCellProps) as <R, SR>(props: CellRendererProps<R, SR>) => React.JSX.Element;

export default CellComponent;

/**
 * Default cell renderer function
 * Standard cell rendering implementation used by DataGrid
 */
export function defaultRenderCell<R, SR>(key: React.Key, props: CellRendererProps<R, SR>) {
  return <CellComponent key={key} {...props} />;
}