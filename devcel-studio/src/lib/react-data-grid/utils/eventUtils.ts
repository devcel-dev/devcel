/**
 * eventUtils.ts
 * 
 * Utility functions for event handling
 * Provide grid-specific event extensions
 */

import type { CellEvent } from '../types';

/**
 * Create a custom event object for a cell
 * 
 * Extend standard React events to control grid-specific default behavior.
 * This allows custom cell handlers to override
 * the grid's default actions, such as cell selection
 * and starting editing.
 * 
 * @template E - Event type extending React.SyntheticEvent
 * @param event - Original React event
 * @returns An event object extended for the grid
 * 
 * @example
 * // Use inside a custom cell click handler
 * function handleCellClick(args: CellClickArgs, event: CellEvent) {
 *   if (shouldPreventDefault) {
 *     // Prevent the grid's default action, such as cell selection
 *     event.preventGridDefault();
 *   }
 * }
 * 
 * // Check inside the grid
 * if (!event.isGridDefaultPrevented()) {
 *   // Perform the default action
 *   selectCell(position);
 * }
 */
export function createCellEvent<E extends React.SyntheticEvent<HTMLDivElement>>(
  event: E
): CellEvent<E> {
  // Flag tracking whether the grid's default action was prevented
  let defaultPrevented = false;
  
  // Extend the original event with new methods
  const cellEvent = {
    ...event,
    // React tracks cancellation on the original synthetic event, not this wrapper.
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
    /**
     * Prevent the grid's default action
     * Unlike event.preventDefault(), this prevents only grid-specific
     * actions such as cell selection and starting editing
     */
    preventGridDefault() {
      defaultPrevented = true;
    },
    /**
     * Check whether the grid's default action was prevented
     * @returns True if the default action was prevented
     */
    isGridDefaultPrevented() {
      return defaultPrevented;
    }
  };

  // Preserve the original event's prototype chain
  // This lets cellEvent inherit all methods and properties of the original event
  Object.setPrototypeOf(cellEvent, Object.getPrototypeOf(event));

  return cellEvent;
}
