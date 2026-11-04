import { createContext, useContext } from 'react';

import type { Maybe, Renderers } from './types';

/**
 * React context providing the default DataGrid renderers
 * 
 * @description
 * This context provides the default rendering functions used throughout DataGrid
 * to child components. Components do not need to receive each rendering function
 * individually, ensuring consistent rendering.
 * 
 * Available renderers:
 * - renderRow: Row rendering
 * - renderCell: Cell rendering
 * - renderHeaderCell: Header cell rendering
 * - renderSortStatus: Sort status rendering
 * - renderCheckbox: Checkbox rendering
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DataGridDefaultRenderersContext = createContext<Maybe<Renderers<any, any>>>(undefined);

/**
 * Custom hook for accessing the default renderers
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 * @returns The default renderers object, or undefined
 * 
 * @description
 * Use this hook to access the default DataGrid rendering functions
 * from within a component.
 * 
 * Example:
 * ```typescript
 * const defaultRenderers = useDefaultRenderers<RowType, SummaryRowType>();
 * const renderSortStatus = defaultRenderers?.renderSortStatus;
 * ```
 */
export function useDefaultRenderers<R, SR>(): Maybe<Renderers<R, SR>> {
  return useContext(DataGridDefaultRenderersContext);
}
