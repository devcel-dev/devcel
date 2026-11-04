import { css } from '@linaria/core';

/** A sticky display root with owned, viewport-relative physical body rows. */
export const stationaryRowsClassname = css`
  &.rdg.rdg-physical-rows-viewport.rdg-stationary-rows-viewport {
    display: block;
    position: sticky;
    inset-block-start: 0;
    inset-inline-start: 0;
    inline-size: var(--rdg-stationary-client-width);
    min-inline-size: 0;
    min-block-size: 0;
    overflow: clip !important;
    /* The root and scroll owner's client origins must coincide. */
    border: 0 !important;
    padding: 0 !important;

    & > .rdg-physical-semantic-header > .rdg-physical-row-frozen {
      background-image: linear-gradient(transparent, transparent);
      background-attachment: fixed;
    }

    & > .rdg-stationary-rowgroup[role='rowgroup'] {
      position: absolute;
      inset-inline-start: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }

    /* Both paths are owned; no descendant selector can reach a nested grid. */
    & > .rdg-physical-semantic-header,
    & > .rdg-stationary-rowgroup[role='rowgroup'] > .rdg-physical-semantic-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
      inline-size: var(--rdg-stationary-client-width);
      block-size: calc(var(--rdg-physical-row-height) * var(--rdg-physical-scale));
      min-inline-size: 0;
      min-block-size: 0;
      will-change: auto;

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
        &.rdg-physical-row-editing { z-index: 1; }
        &[data-rdg-bounded-body] {
          inline-size: var(--rdg-body-physical-width);
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
        position: relative;
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
    & > .rdg-physical-semantic-header {
      /* The display root alone owns native stickiness. */
      position: relative !important;
      top: 0 !important;
      inset-block-start: 0 !important;
      z-index: 4;
      border: 0;
    }
    & > .rdg-stationary-rowgroup[role='rowgroup'] > .rdg-physical-semantic-row {
      position: absolute;
      inset-inline-start: 0;
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

    /* Synchronous intrinsic measurement keeps every cell/editor node mounted. */
    &[data-rdg-measuring] {
      display: grid !important;
      overflow: visible !important;
      width: max-content !important;
      height: var(--rdg-physical-logical-height) !important;
      min-width: 0 !important;
      min-height: 0 !important;
      padding: 0 !important;
      grid-template-columns: var(--rdg-measure-columns) !important;
      grid-template-rows: var(--rdg-measure-rows) !important;
      & > .rdg-stationary-rowgroup[role='rowgroup'],
      & > .rdg-stationary-rowgroup[role='rowgroup'] > .rdg-physical-semantic-row,
      & > .rdg-physical-semantic-header,
      & > .rdg-physical-row-utility-grid {
        display: contents !important;
        transform: none !important;
      }
      & > .rdg-physical-semantic-header > .rdg-physical-row-pane,
      & > .rdg-stationary-rowgroup[role='rowgroup'] > .rdg-physical-semantic-row > .rdg-physical-row-pane {
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
          /* Restore global columns; row coordinates inherit from the real row. */
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
