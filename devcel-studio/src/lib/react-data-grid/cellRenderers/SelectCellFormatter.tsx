/**
 * Selection cell formatter
 * 
 * This file provides a specialized formatter for the data grid's
 * selection column (checkbox column).
 * 
 * Main features:
 * - Display selection column cells as checkboxes
 * - Use the default checkbox renderer
 * - Forward accessibility attributes correctly
 * - Map the value state (true/false) to the checked attribute
 * 
 * Unlike regular cell renderers, this component is used
 * in a specialized column that manages selection state.
 */

import type { RenderCheckboxProps } from '../types';
import { useDefaultRenderers } from '../DataGridDefaultRenderersContext';

/**
 * Shared input property type definition
 * 
 * Select the required properties from RenderCheckboxProps
 * to define properties shared by SelectCellFormatter.
 * 
 * Included properties:
 * - disabled: Checkbox disabled state
 * - tabIndex: Tab order
 * - aria-label: Accessibility label
 * - aria-labelledby: Reference to the label element's ID
 * - indeterminate: Indeterminate state
 * - onChange: Change event handler
 */
type SharedInputProps = Pick<
  RenderCheckboxProps,
  'disabled' | 'tabIndex' | 'aria-label' | 'aria-labelledby' | 'indeterminate' | 'onChange'
>;

/**
 * SelectCellFormatter property type definition
 * 
 * Extend SharedInputProps with the value attribute.
 * value is a boolean representing the selection state.
 */
interface SelectCellFormatterProps extends SharedInputProps {
  value: boolean;
}

/**
 * Component formatting a selection cell
 * 
 * @param value - Checkbox selection state
 * @param tabIndex - Tab order index
 * @param indeterminate - Indeterminate (partially selected) state
 * @param disabled - Disabled state
 * @param onChange - Callback when the state changes
 * @param aria-label - Accessibility label
 * @param aria-labelledby - Label element ID
 * 
 * @returns A checkbox React element
 * 
 * Implementation details:
 * - Get the default checkbox renderer from context
 * - Map value to the checked property
 * - Forward all accessibility attributes correctly
 * - Use a non-null assertion (!) because the renderer is guaranteed to exist
 * 
 * This component is used in each selection column cell
 * to visually represent the row's selection state.
 */
export function SelectCellFormatter({
  value,
  tabIndex,
  indeterminate,
  disabled,
  onChange,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy
}: SelectCellFormatterProps) {
  // Get the checkbox renderer from the default renderers context
  // This renderer provides a consistent checkbox appearance
  // and behavior throughout the grid
  const renderCheckbox = useDefaultRenderers()!.renderCheckbox!;

  // Call the checkbox renderer with the required properties
  // Note that value is mapped to the checked property
  return renderCheckbox({
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    tabIndex,
    indeterminate,
    disabled,
    checked: value,  // Map value to checked
    onChange
  });
}
