/**
 * useRovingTabIndex.ts
 * 
 * Custom hook implementing the roving tabindex pattern
 * Manage keyboard navigation and accessibility within the grid
 */

import { useState } from 'react';

/**
 * Custom hook implementing the roving tabindex pattern
 * 
 * Roving tabindex is an accessibility pattern for composite widgets,
 * such as grids, that enables arrow-key navigation
 * while maintaining a single tab stop.
 * 
 * This hook ensures that only the selected cell has tabIndex=0,
 * while all other cells have tabIndex=-1.
 * 
 * References:
 * - https://www.w3.org/TR/wai-aria-practices-1.1/#kbd_roving_tabindex
 * - https://www.w3.org/TR/wai-aria-practices-1.1/#gridNav_focus
 * 
 * @param isSelected - Whether this cell or element is selected
 * @returns Keyboard navigation properties
 * - tabIndex: The cell's tabIndex value
 * - childTabIndex: The tabIndex value of child elements, such as editors
 * - onFocus: Focus event handler
 */
export function useRovingTabIndex(isSelected: boolean) {
  // Whether a child element (cell content) has focus
  const [isChildFocused, setIsChildFocused] = useState(false);

  // Clear the child's focus state when the cell is deselected
  if (isChildFocused && !isSelected) {
    setIsChildFocused(false);
  }

  /**
   * Focus event handler
   * When the cell receives focus, move focus to its content
   * (an element with tabindex="0") if possible
   */
  function onFocus(event: React.FocusEvent<HTMLDivElement>) {
    // Find an element with tabindex="0" inside the cell
    const elementToFocus = event.currentTarget.querySelector<Element & HTMLOrSVGElement>(
      '[tabindex="0"]'
    );

    // Focus the cell's content instead of the cell itself when available
    if (elementToFocus !== null) {
      // Use preventScroll: true to prevent automatic scrolling on focus
      elementToFocus.focus({ preventScroll: true });
      setIsChildFocused(true);
    }
  }

  // Whether the cell is focusable
  // True only when selected and no child element has focus
  const isFocusable = isSelected && !isChildFocused;

  return {
    tabIndex: isFocusable ? 0 : -1,              // The cell's tabIndex
    childTabIndex: isSelected ? 0 : -1,          // The child's tabIndex (0 only when selected)
    onFocus: isSelected ? onFocus : undefined    // Provide the focus handler only when selected
  };
}
