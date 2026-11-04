import { css } from '@linaria/core';

/** Physical native scroll/sticky boxes; original logical font sizes scale inside. */
export const physicalRowsClassname = css`
  &.rdg.rdg-physical-rows-viewport {
    display: block;
    overflow: visible !important;
    min-inline-size: 0;
    min-block-size: 0;

    & > .rdg-physical-semantic-row,
    & > .rdg-physical-semantic-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
      inline-size: var(--rdg-physical-cell-width);
      block-size: calc(var(--rdg-physical-row-height) * var(--rdg-physical-scale));
      min-inline-size: 0;
      min-block-size: 0;
      will-change: auto;
    }
    & > .rdg-physical-semantic-row {
      position: absolute;
      inset-inline-start: 0;
    }
    & > .rdg-physical-semantic-header {
      position: sticky;
      inset-block-start: 0;
      z-index: 4;
      border: 0;
    }
    /* Do not apply an outer grid's physical rules to grids rendered inside a cell. */
    & > :is(.rdg-physical-semantic-row, .rdg-physical-semantic-header) {
      & > .rdg-physical-row-pane {
        grid-area: 1 / 1;
        position: relative;
        justify-self: start;
        inline-size: 100%;
        block-size: 100%;
        min-inline-size: 0;
        min-block-size: 0;
        background-color: inherit;

        & > .rdg-physical-row-logical-grid {
          --rdg-grid-row-start: 1;
          display: grid;
          position: absolute;
          inset-inline-start: 0;
          inset-block-start: 0;
          inline-size: var(--rdg-physical-logical-width);
          block-size: var(--rdg-physical-row-height);
          grid-template-columns: var(--rdg-physical-columns);
          grid-template-rows: var(--rdg-physical-row-height);
          transform: scale(var(--rdg-physical-scale));
          transform-origin: var(--rdg-physical-transform-origin);
          background-color: inherit;

          & > .rdg-cell,
          & > .rdg-cell-tooltip-wrapper > .rdg-cell {
            position: relative !important;
            top: auto !important;
            right: auto !important;
            bottom: auto !important;
            left: auto !important;
            inset-block-start: auto !important;
            inset-inline-start: auto !important;
            inset-inline-end: auto !important;
            transform: none !important;
          }
        }
      }
      & > .rdg-physical-row-body {
        --rdg-window-start: 0;
        --rdg-body-physical-width: 100%;
        --rdg-body-physical-offset: 0px;
        --rdg-body-logical-width: var(--rdg-physical-logical-width);
        --rdg-body-columns: var(--rdg-physical-columns);
        z-index: 0;
        inset-inline-start: 0;
        &.rdg-physical-row-editing { z-index: 1; }
        /* Fallback uses the full global box even inside another bounded grid. */
        &[data-rdg-bounded-body] {
          inline-size: var(--rdg-body-physical-width);
          inset-inline-start: var(--rdg-body-physical-offset);
          & > .rdg-physical-row-logical-grid {
            inline-size: var(--rdg-body-logical-width);
            grid-template-columns: var(--rdg-body-columns);
            & > .rdg-cell,
            & > .rdg-cell-tooltip-wrapper > .rdg-cell {
              grid-column-start: calc(var(--rdg-global-column-start) - var(--rdg-window-start)) !important;
              grid-column-end: calc(var(--rdg-global-column-end) - var(--rdg-window-start)) !important;
            }
          }
        }
      }
      & > .rdg-physical-row-frozen {
        position: sticky;
        inset-inline-start: 0;
        inline-size: calc(var(--rdg-physical-frozen-width) * var(--rdg-physical-scale));
        z-index: 2;
        & > .rdg-physical-row-logical-grid {
          inline-size: var(--rdg-physical-frozen-width);
          grid-template-columns: var(--rdg-physical-prefix-columns);
        }
      }
      &.rdg-row-with-selected-cell > .rdg-physical-row-frozen > .rdg-physical-row-logical-grid {
        & > .rdg-cell:first-child,
        & > .rdg-cell-tooltip-wrapper:first-child > .rdg-cell {
          background-color: var(--rdg-row-selected-background-color) !important;
        }
      }
    }
    & > .rdg-physical-row-utility-grid {
      display: grid;
      position: absolute;
      inset-inline-start: 0;
      inset-block-start: 0;
      pointer-events: none;
    }
    & > .rdg-physical-empty {
      position: absolute;
      inset-inline-start: 0;
    }
    /* One synchronous intrinsic-width transaction, without DOM reparenting. */
    &[data-rdg-measuring] {
      display: grid !important;
      width: max-content !important;
      height: var(--rdg-physical-logical-height) !important;
      min-width: 0 !important;
      min-height: 0 !important;
      padding: 0 !important;
      grid-template-columns: var(--rdg-measure-columns) !important;
      grid-template-rows: var(--rdg-measure-rows) !important;
      & > .rdg-physical-semantic-row,
      & > .rdg-physical-semantic-header,
      & > .rdg-physical-row-utility-grid {
        display: contents !important;
        transform: none !important;
      }
      & > :is(.rdg-physical-semantic-row, .rdg-physical-semantic-header) > .rdg-physical-row-pane {
        --rdg-window-start: 0 !important;
        --rdg-grid-row-start: inherit;
        display: contents !important;
        transform: none !important;
        & > .rdg-physical-row-logical-grid {
          --rdg-grid-row-start: inherit;
          display: contents !important;
          transform: none !important;
        }
        &[data-rdg-bounded-body] > .rdg-physical-row-logical-grid {
          /* Fallback/custom renderers keep their original global inline placement. */
          /* Restore explicit global integers for bounded Cell, HeaderCell and EditCell. */
          & > .rdg-cell,
          & > .rdg-cell-tooltip-wrapper > .rdg-cell {
            grid-column-start: var(--rdg-global-column-start) !important;
            grid-column-end: var(--rdg-global-column-end) !important;
          }
        }
      }
    }
  }
`;
