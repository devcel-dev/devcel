/**
 * domUtils.ts
 * 
 * Utility functions for DOM operations
 * Provide event handling and scrolling operations
 */

import type { Direction, Maybe } from '../types';

/**
 * Stop event propagation
 * 
 * Used to prevent events from bubbling to parent elements.
 * Primarily used for click and keyboard events
 * when parent handlers should not run.
 * 
 * @param event - React event to stop
 * 
 * @example
 * // Prevent clicks on the resize handle from triggering
 * // the parent cell's sorting action
 * <div onClick={stopPropagation}>
 *   Resize handle
 * </div>
 */
export function stopPropagation(event: React.SyntheticEvent) {
  event.stopPropagation();
}

/** Home navigation must use the grid origin, not sticky header/frozen cell boxes. */
export function scrollToGridStart(
  grid: HTMLElement,
  externalScroller: Maybe<HTMLElement>,
  direction: Direction,
  blockStart: boolean
) {
  if (!externalScroller || externalScroller === grid) {
    grid.scrollLeft = 0;
    if (blockStart) grid.scrollTop = 0;
    return;
  }

  // Rectangles include the grid's transform, while scroll offsets use physical
  // pixels. This preserves zoom and either LTR or negative RTL outer scrolling.
  const gridRect = grid.getBoundingClientRect();
  const viewportRect = externalScroller.getBoundingClientRect();
  const viewportLeft = viewportRect.left + externalScroller.clientLeft;
  externalScroller.scrollLeft += direction === 'rtl'
    ? gridRect.right - viewportLeft - externalScroller.clientWidth
    : gridRect.left - viewportLeft;
  if (blockStart) {
    externalScroller.scrollTop += gridRect.top - viewportRect.top - externalScroller.clientTop;
  }
}

/** Ask only the active editor to verify that its displayed draft is committable. */
export function canCommitEditor(editor: HTMLElement | null | undefined): boolean {
  const input = editor?.querySelector('[data-rdg-raw-text-editor="true"]');
  if (input && !input.dispatchEvent(new Event('rdg-editor-commit-check', { cancelable: true }))) return false;
  return editor?.querySelector('[data-rdg-editor-blocked="true"]') == null;
}
