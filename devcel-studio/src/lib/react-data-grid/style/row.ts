/**
 * row.ts - Grid row style definitions
 * 
 * This file defines styles for react-data-grid data and summary rows.
 * Use the Linaria CSS-in-JS library to generate static CSS classes at compile time.
 */

import { css } from '@linaria/core';

/**
 * Base row styles
 * 
 * With display: contents, the row element itself does not affect layout,
 * and its child cells behave as direct children of the grid container.
 * This makes full use of CSS Grid features.
 */
export const row = css`
  @layer rdg.Row {
    /* 
     * With display: contents, this element generates no box,
     * and its children are placed directly in the parent's grid container
     */
    display: contents;
    
    /* Set the default background color */
    background-color: var(--rdg-background-color);

    /* Change the background color on hover */
    &:hover {
      background-color: var(--rdg-row-hover-background-color);
    }

    /* Selected row styles */
    &[aria-selected='true'] {
      background-color: var(--rdg-row-selected-background-color);

      /* Hover styles for selected rows */
      &:hover {
        background-color: var(--rdg-row-selected-hover-background-color);
      }
    }
  }
`;

/** Row class name */
export const rowClassname = `rdg-row ${row}`;

/**
 * Focus styles for selected rows
 * 
 * Visually highlight rows selected through keyboard navigation.
 * Use the FocusSink layer for precedence over other styles.
 */
export const rowSelected = css`
  @layer rdg.FocusSink {
    /* Display an outline around the selected row */
    outline: 2px solid var(--rdg-selection-color);
    /* Inset the outline to avoid overlapping neighboring rows */
    outline-offset: -2px;
  }
`;

/** Selected row class name without CSS */
export const rowSelectedClassname = 'rdg-row-selected';

/**
 * Selected row styles when frozen cells are present
 * 
 * With frozen columns, the full-row outline is hidden behind frozen cells,
 * so use a pseudo-element to display a selection indicator at the left edge.
 */
export const rowSelectedWithFrozenCell = css`
  @layer rdg.FocusSink {
    /* Create the selection indicator with a pseudo-element */
    &::before {
      content: '';
      display: inline-block;
      /* Cover the full row height */
      block-size: 100%;
      /* Use fixed positioning within the scroll area */
      position: sticky;
      /* Logical property: Position at the start edge (left in LTR, right in RTL) */
      inset-inline-start: 0;
      /* Display a border in the selection color */
      border-inline-start: 2px solid var(--rdg-selection-color);
    }
  }
`;

/** Top summary row class name */
export const topSummaryRowClassname = 'rdg-top-summary-row';

/** Bottom summary row class name */
export const bottomSummaryRowClassname = 'rdg-bottom-summary-row';

/**
 * Styles for the row containing the currently selected cell
 * Apply a background color to the row's first cell, usually the row indicator
 */
export const rowWithSelectedCell = css`
  @layer rdg.Row {
    /* Apply the background color to the first cell */
    & > .rdg-cell:first-child {
      background-color: var(--rdg-row-selected-background-color) !important;
    }
  }
`;

/** Class name for the row containing the currently selected cell */
export const rowWithSelectedCellClassname = `rdg-row-with-selected-cell ${rowWithSelectedCell}`;
