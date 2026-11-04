/**
 * Group toggle renderer
 * 
 * This file renders the expand/collapse toggle used
 * by the data grid's row grouping feature.
 * 
 * Main features:
 * - UI for expanding and collapsing grouped rows
 * - Keyboard support (Enter key)
 * - Animated arrow icon
 * - Accessibility support (tab navigation and keyboard operation)
 */

import { css } from '@linaria/core';

import type { RenderGroupCellProps } from '../types';

/**
 * Group cell content styles
 * 
 * Remove the outline to disable the default focus style
 * and allow a custom focus indicator.
 */
const groupCellContent = css`
  @layer rdg.GroupCellContent {
    outline: none;
  }
`;

const groupCellContentClassname = `rdg-group-cell-content ${groupCellContent}`;

/**
 * Caret (expand/collapse arrow) styles
 * 
 * SVG icon styling:
 * - A 4px left margin provides spacing from the text
 * - currentColor inherits the parent element's color
 * - A 1.5px stroke width ensures visibility
 * - Path transitions provide smooth animation
 */
const caret = css`
  @layer rdg.GroupCellCaret {
    margin-inline-start: 4px;
    stroke: currentColor;
    stroke-width: 1.5px;
    fill: transparent;
    vertical-align: middle;

    > path {
      transition: d 0.1s;
    }
  }
`;

const caretClassname = `rdg-caret ${caret}`;

/**
 * Exported group toggle renderer
 * 
 * @param props - Group cell properties
 * @returns A ToggleGroup component
 * 
 * This function is exposed as an externally customizable renderer
 * and returns the ToggleGroup component
 * as its default implementation.
 */
export function renderToggleGroup<R, SR>(props: RenderGroupCellProps<R, SR>) {
  return <ToggleGroup {...props} />;
}

/**
 * Toggle group component
 * 
 * @param groupKey - Group key value (displayed text)
 * @param isExpanded - Whether the group is expanded
 * @param tabIndex - Tab order index
 * @param toggleGroup - Function toggling group expansion and collapse
 * 
 * Implementation details:
 * - Toggle expansion and collapse on click
 * - Also support the Enter key for accessibility
 * - Change the SVG path dynamically for animation
 * - Hide the arrow from screen readers with aria-hidden
 */
export function ToggleGroup<R, SR>({
  groupKey,
  isExpanded,
  tabIndex,
  toggleGroup
}: RenderGroupCellProps<R, SR>) {
  /**
   * Keyboard event handler
   * 
   * Toggle group expansion and collapse
   * when Enter is pressed. This allows operation
   * even when a mouse is unavailable.
   */
  function handleKeyDown({ key }: React.KeyboardEvent<HTMLSpanElement>) {
    if (key === 'Enter') {
      toggleGroup();
    }
  }

  /**
   * SVG path definition
   * 
   * Expanded: Downward arrow (∨)
   * Collapsed: Rightward arrow (>)
   * 
   * Path transitions animate smoothly
   * when the state changes.
   */
  const d = isExpanded ? 'M1 1 L 7 7 L 13 1' : 'M1 7 L 7 1 L 13 7';

  return (
    <span className={groupCellContentClassname} tabIndex={tabIndex} onKeyDown={handleKeyDown}>
      {/* Display the group key */}
      {groupKey as string}
      {/* Expand/collapse arrow icon */}
      <svg viewBox="0 0 14 8" width="14" height="8" className={caretClassname} aria-hidden>
        <path d={d} />
      </svg>
    </span>
  );
}
