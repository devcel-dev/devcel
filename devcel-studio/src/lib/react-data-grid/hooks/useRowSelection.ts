/**
 * useRowSelection.ts
 * 
 * Contexts and custom hooks for row selection
 * Provide checkbox selection state management and change notifications
 */

import { createContext, useContext } from 'react';

import type { SelectHeaderRowEvent, SelectRowEvent } from '../types';

/**
 * Row selection context value type definition
 * Manage each row's selection state and selectability
 */
export interface RowSelectionContextValue {
  readonly isRowSelected: boolean;           // Whether the row is selected
  readonly isRowSelectionDisabled: boolean;  // Whether row selection is disabled
}

// Context providing row selection state
export const RowSelectionContext = createContext<RowSelectionContextValue | undefined>(undefined);

// Context providing the row selection change handler
export const RowSelectionChangeContext = createContext<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((selectRowEvent: SelectRowEvent<any>) => void) | undefined
>(undefined);

/**
 * Custom hook for row selection
 * 
 * Use this hook from individual cells, particularly selection checkboxes,
 * to read and change row selection state.
 * Must be used inside renderCell.
 * 
 * @returns Row selection state and handlers
 * - isRowSelectionDisabled: Whether row selection is disabled
 * - isRowSelected: Whether the row is selected
 * - onRowSelectionChange: Handler for changing selection state
 * 
 * @throws If used outside the useRowSelection context
 */
export function useRowSelection() {
  const rowSelectionContext = useContext(RowSelectionContext);
  const rowSelectionChangeContext = useContext(RowSelectionChangeContext);

  // Throw an error if no context is provided
  if (rowSelectionContext === undefined || rowSelectionChangeContext === undefined) {
    throw new Error('useRowSelection must be used within renderCell');
  }

  return {
    isRowSelectionDisabled: rowSelectionContext.isRowSelectionDisabled,
    isRowSelected: rowSelectionContext.isRowSelected,
    onRowSelectionChange: rowSelectionChangeContext
  };
}

/**
 * Header row selection context value type definition
 * Manage the select-all checkbox state
 */
export interface HeaderRowSelectionContextValue {
  readonly isRowSelected: boolean;     // Whether all rows are selected
  readonly isIndeterminate: boolean;   // Whether only some rows are selected (indeterminate state)
}

// Context providing header row selection state
export const HeaderRowSelectionContext = createContext<HeaderRowSelectionContextValue | undefined>(
  undefined
);

// Context providing the header row selection change handler
export const HeaderRowSelectionChangeContext = createContext<
  ((selectRowEvent: SelectHeaderRowEvent) => void) | undefined
>(undefined);

/**
 * Custom hook for header row selection
 * 
 * Use this hook from the header's select-all checkbox
 * to read overall selection state and select or deselect all rows.
 * Must be used inside renderHeaderCell.
 * 
 * @returns Header row selection state and handlers
 * - isIndeterminate: Whether only some rows are selected
 * - isRowSelected: Whether all rows are selected
 * - onRowSelectionChange: Handler for selecting or deselecting all rows
 * 
 * @throws If used outside the useHeaderRowSelection context
 */
export function useHeaderRowSelection() {
  const headerRowSelectionContext = useContext(HeaderRowSelectionContext);
  const headerRowSelectionChangeContext = useContext(HeaderRowSelectionChangeContext);

  // Throw an error if no context is provided
  if (headerRowSelectionContext === undefined || headerRowSelectionChangeContext === undefined) {
    throw new Error('useHeaderRowSelection must be used within renderHeaderCell');
  }

  return {
    isIndeterminate: headerRowSelectionContext.isIndeterminate,
    isRowSelected: headerRowSelectionContext.isRowSelected,
    onRowSelectionChange: headerRowSelectionChangeContext
  };
}
