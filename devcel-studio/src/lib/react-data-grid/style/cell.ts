/**
 * cell.ts - Grid cell style definitions
 * 
 * This file defines all styles for individual react-data-grid cells.
 * Use the Linaria CSS-in-JS library to generate static CSS classes at compile time.
 */

import { css } from '@linaria/core';

/**
 * Base cell styles
 * 
 * @layer rdg.Cell - Use a CSS layer to manage style precedence
 * 
 * Notes:
 * - max-content cannot be combined with size containment
 * - Dynamically switching containment styles causes expensive layout recalculations
 * - Chromium bug: At odd zoom levels or subpixel positions,
 *   layout/paint/style containment may make cell borders disappear
 *   https://issues.chromium.org/issues/40840864
 */
export const cell = css`
  @layer rdg.Cell {
    /* Required for absolute positioning */
    position: relative;
    
    /* Padding using logical properties */
    padding-block: 0; /* Top and bottom padding */
    padding-inline: 0; /* Left and right padding according to writing direction */
    
    /* Borders using logical properties for RTL support */
    border-inline-end: 1px solid var(--rdg-border-color); /* Border at the inline end */
    border-block-end: 1px solid var(--rdg-border-color); /* Bottom border */
    
    /* Grid row starting position, set dynamically */
    grid-row-start: var(--rdg-grid-row-start);
    
    /* Vertically center content */
    align-content: center;
    
    /* Inherit the parent element's background color */
    background-color: inherit;

    /* Text overflow handling */
    white-space: nowrap; /* Prevent text wrapping */
    overflow: clip; /* Clip overflowing content */
    text-overflow: ellipsis; /* Display an ellipsis for overflowing text */
    
    /* Override overflow for cells containing inline buttons */
    &.rdg-cell-has-inline-buttons {
      overflow: visible;
    }
    
    /* Disable the default outline */
    outline: none;

    /* Selected cell styles */
    &[aria-selected='true'] {
      outline: 2px solid var(--rdg-selection-color);
      outline-offset: -2px; /* Position the outline inside the cell */
    }
  }
`;

/** Cell class name using a BEM-like naming convention */
export const cellClassname = `rdg-cell ${cell}`;

/**
 * Frozen cell styles
 * 
 * Styles for cells fixed in place while scrolling
 */
export const cellFrozen = css`
  @layer rdg.Cell {
    /* Keep the position fixed while scrolling */
    position: sticky;
    
    /* z-index placing frozen cells above regular cells */
    z-index: 1;

    /* Add a box shadow to the last frozen cell */
    /* :nth-last-child(1 of &) is modern CSS syntax selecting the last element with the same class */
    &:nth-last-child(1 of &) {
      box-shadow: var(--rdg-cell-frozen-box-shadow);
    }
  }
`;

/** Frozen cell class name */
export const cellFrozenClassname = `rdg-cell-frozen ${cellFrozen}`;

/**
 * Cell drag handle styles
 * 
 * Handle at the cell's bottom-right corner for extending the selection range
 */
const cellDragHandle = css`
  @layer rdg.DragHandle {
    /* Define the drag handle size with a CSS variable */
    --rdg-drag-handle-size: 8px;
    
    /* Stacking order: Place below regular cell content */
    z-index: 0;
    
    /* Use the move cursor */
    cursor: move;
    
    /* Sizing with logical properties */
    inline-size: var(--rdg-drag-handle-size); /* Width */
    block-size: var(--rdg-drag-handle-size); /* Height */
    
    /* Use the selection color as the background */
    background-color: var(--rdg-selection-color);
    
    /* Position at the cell's bottom-right corner */
    place-self: end;

    /* Hover styles */
    &:hover {
      /* Increase the handle size */
      --rdg-drag-handle-size: 16px;
      
      /* Add a border and fill the interior with the background color */
      border: 2px solid var(--rdg-selection-color);
      background-color: var(--rdg-background-color);
    }
  }
`;

/**
 * Additional drag handle styles for frozen cells
 * 
 * Keep frozen cell drag handles fixed in position too
 */
export const cellDragHandleFrozenClassname = css`
  @layer rdg.DragHandle {
    /* Use the same z-index as frozen cells */
    z-index: 1;
    /* Keep the position fixed while scrolling */
    position: sticky;
  }
`;

/** Drag handle class name */
export const cellDragHandleClassname = `rdg-cell-drag-handle ${cellDragHandle}`;
