/**
 * core.ts - Core react-data-grid style definitions
 * 
 * This file defines root grid styles, theme settings,
 * and global style variables. Use Linaria CSS-in-JS
 * to generate static CSS at compile time.
 */

import { css } from '@linaria/core';

import { cell } from './cell';
import { bottomSummaryRowClassname, row, topSummaryRowClassname } from './row';

/** Grid colors follow the application theme, including explicit theme selection. */
const appTheme = `
  --rdg-selection-color: hsl(var(--ring));
  --rdg-color: hsl(var(--foreground));
  --rdg-border-color: hsl(var(--border));
  --rdg-summary-border-color: hsl(var(--input));
  --rdg-background-color: hsl(var(--background));
  --rdg-header-background-color: hsl(var(--muted));
  --rdg-header-draggable-background-color: hsl(var(--secondary));
  --rdg-row-hover-background-color: hsl(var(--muted));
  --rdg-row-selected-background-color: hsl(var(--accent));
  --rdg-row-selected-hover-background-color: hsl(var(--secondary));
  --rdg-checkbox-focus-color: hsl(var(--ring));
`;

/**
 * Root grid container style definitions
 * 
 * Use CSS layers to manage style precedence
 * and control the grid layout and theme.
 */
const root = css`
  /* Default box model settings */
  @layer rdg.Defaults {
    /* Make all elements and pseudo-elements inherit box-sizing */
    *,
    *::before,
    *::after {
      box-sizing: inherit;
    }
  }

  /* Root layer styles */
  @layer rdg.Root {
    /* Inherit the application's theme */
    ${appTheme}
    
    /* Global style variables */
    --rdg-font-size: 14px; /* Base font size */
    --rdg-cell-frozen-box-shadow: 2px 0 5px -2px rgba(136, 136, 136, 0.3); /* Frozen cell shadow */

    /* Right-to-left (RTL) language support */
    &:dir(rtl) {
      /* Reverse the shadow direction */
      --rdg-cell-frozen-box-shadow: -2px 0 5px -2px rgba(136, 136, 136, 0.3);
    }

    /* Use grid layout */
    display: grid;

    /* Color scheme support following OS settings */
    color-scheme: inherit;
    /* Accent color: Switch automatically with the theme using light-dark() */
    accent-color: hsl(var(--primary));

    /**
     * Stacking context configuration
     * Reference: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Positioning/Understanding_z_index/The_stacking_context
     * 
     * Create a stacking context so internal elements do not render above external elements.
     * Do not use size containment: It breaks properties such as "width: min-content"
     * and may cause infinite resizing in Chromium browsers.
     */
    contain: content; /* Layout and paint containment */
    content-visibility: auto; /* Defer rendering content outside the viewport */
    
    /* Default grid size and styles */
    block-size: 350px; /* Default height */
    border: 1px solid var(--rdg-border-color);
    box-sizing: border-box;
    overflow: auto; /* Enable scrolling */
    background-color: var(--rdg-background-color);
    color: var(--rdg-color);
    font-size: var(--rdg-font-size);

    /* Required to fix scrollbars in Firefox */
    /* Create an empty pseudo-element covering the entire grid */
    &::before {
      content: '';
      grid-column: 1/-1; /* Span all columns */
      grid-row: 1/-1; /* Span all rows */
    }

    /* Styles for the last top summary row */
    /* :nth-last-child(1 of .class) selects the last element with a particular class */
    > :nth-last-child(1 of .${topSummaryRowClassname}) {
      > .${cell} {
        /* Add a thick bottom border to separate the summary section */
        border-block-end: 2px solid var(--rdg-summary-border-color);
      }
    }

    /* Styles for the first bottom summary row */
    > :nth-child(1 of .${bottomSummaryRowClassname}) {
      > .${cell} {
        /* Add a thick top border to separate the summary section */
        border-block-start: 2px solid var(--rdg-summary-border-color);
      }
    }
    
  }
`;

/** Root grid container class name */
export const rootClassname = `rdg ${root}`;

/**
 * Styles during viewport dragging
 * 
 * Styles applied while dragging within the grid
 */
const viewportDragging = css`
  @layer rdg.Root {
    /* Disable text selection for smooth dragging */
    user-select: none;

    /* Use the move cursor for all rows */
    & .${row} {
      cursor: move;
    }
  }
`;

/** Class name during viewport dragging */
export const viewportDraggingClassname = `rdg-viewport-dragging ${viewportDragging}`;

/**
 * Focus sink element styles
 * 
 * Invisible element for keyboard navigation and focus management.
 * Control focus throughout the grid to support keyboard operation.
 */
export const focusSinkClassname = css`
  @layer rdg.FocusSink {
    /* Span all grid columns */
    grid-column: 1/-1;
    
    /* Ignore pointer events (pass through) */
    pointer-events: none;
    
    /* Place above regular frozen cells (z-index: 1) */
    z-index: 1;
  }
`;

/**
 * Focus sink styles for header and summary rows
 * 
 * Use a higher z-index for the focus sink placed
 * above header and summary rows.
 */
export const focusSinkHeaderAndSummaryClassname = css`
  @layer rdg.FocusSink {
    /* Place above header and summary rows, normally at z-index: 3 */
    z-index: 3;
  }
`;
