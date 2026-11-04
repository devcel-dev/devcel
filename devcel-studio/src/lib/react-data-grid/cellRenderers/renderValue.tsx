/**
 * Default value renderer
 * 
 * This file provides the default renderer for displaying values
 * in regular data grid cells.
 * 
 * Main features:
 * - Get the value matching the column key from row data
 * - Handle errors by returning null when the value cannot be retrieved
 * - Return the value as a React.ReactNode
 * 
 * This is the simplest renderer, used for regular cells
 * that need no special formatting or interactions.
 */

import type { RenderCellProps } from '../types';

/**
 * Function rendering a cell value
 * 
 * @param props - Cell rendering properties
 *                props.row - Row data object
 *                props.column - Column definition (including its key property)
 * 
 * @returns The displayed value (React.ReactNode) or null
 * 
 * Implementation details:
 * - Get the value from row data using the column key
 * - Cast with keyof for type safety
 * - Catch errors with try-catch and safely return null
 * 
 * Error handling:
 * - When the property does not exist
 * - When an access error occurs
 * - When another unexpected error occurs
 * 
 * Return null in all these cases to prevent
 * the grid from crashing.
 */
export function renderValue<R, SR>(props: RenderCellProps<R, SR>) {
  try {
    // Get the value matching the column key from the row data
    // Casting to React.ReactNode allows values of various types,
    // including strings, numbers, and ReactElement, to be displayed
    return props.row[props.column.key as keyof R] as React.ReactNode;
  } catch {
    // Safely return null when an error occurs
    // This prevents inconsistent data structures
    // from crashing the entire application
    return null;
  }
}
