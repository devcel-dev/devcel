/**
 * Checkbox renderer
 * 
 * This file renders the checkboxes used by the data grid's
 * row selection feature.
 * 
 * Main features:
 * - UI for selecting and deselecting rows
 * - Range selection with Shift+click
 * - Indeterminate (partially selected) state display
 * - Accessibility support (focus indicators and ARIA attributes)
 */

import { css } from '@linaria/core';

import type { RenderCheckboxProps } from '../types';

/**
 * Checkbox style definitions
 * 
 * Use CSS layers to manage style precedence.
 * 
 * Style features:
 * - Fixed size of 20x20px
 * - Centered with margin: auto
 * - Visual feedback on focus
 * - Cursor changes when enabled
 */
const checkbox = css`
  @layer rdg.CheckboxInput {
    display: block;
    margin: auto;
    inline-size: 20px;
    block-size: 20px;

    &:focus-visible {
      outline: 2px solid var(--rdg-checkbox-focus-color);
      outline-offset: -3px;
    }

    &:enabled {
      cursor: pointer;
    }
  }
`;

// Build the checkbox class name
const checkboxClassname = `rdg-checkbox-input ${checkbox}`;

/**
 * Function rendering a checkbox
 * 
 * @param onChange - Callback when the checked state changes
 *                   First argument: New checked state (boolean)
 *                   Second argument: Whether Shift was pressed (boolean)
 * @param indeterminate - Whether the state is indeterminate (partially selected)
 * @param props - Other HTML input attributes
 * 
 * @returns A checkbox React element
 * 
 * Implementation details:
 * - Set the DOM element's indeterminate state directly through a ref callback
 * - Detect Shift to support range selection
 * - Forward additional props (disabled, tabIndex, etc.) with the spread operator
 */
export function renderCheckbox({ onChange, indeterminate, ...props }: RenderCheckboxProps) {
  /**
   * Checkbox change event handler
   * 
   * Read the Shift key state from the native event
   * and notify the parent component. This enables
   * advanced selection operations such as range selection.
   */
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange(e.target.checked, (e.nativeEvent as MouseEvent).shiftKey);
  }

  return (
    <input
      ref={(el) => {
        // The indeterminate state can only be set through the DOM API,
        // so set it directly using the ref callback
        if (el) {
          el.indeterminate = indeterminate === true;
        }
      }}
      type="checkbox"
      className={checkboxClassname}
      onChange={handleChange}
      {...props}
    />
  );
}
