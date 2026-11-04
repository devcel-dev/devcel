import { createContext, useContext } from 'react';
import type { CalculatedColumn, CellRange, Maybe } from './types';

/**
 * Context for sharing state throughout DataGrid
 */
export interface DataGridState<R, SR> {
  selectedRange?: CellRange | null;
  /** Callback determining the cell background color */
  getCellBackgroundColor?: (
    row: R,
    column: CalculatedColumn<R, SR>,
    state: {
      isSelected: boolean;
      isHovered: boolean;
      rowIdx: number;
      isEvenRow: boolean;
    }
  ) => string | undefined;
  
  /** Striping settings */
  alternatingRowColors?: boolean | { even: string; odd: string };
  
  /** Index of the currently hovered row */
  hoveredRowIdx?: number;
  
  /** Selected cell position */
  selectedPosition?: {
    idx: number;
    rowIdx: number;
  };
}

export const DataGridStateContext = createContext<Maybe<DataGridState<any, any>>>(undefined);

/**
 * Custom hook for accessing DataGrid state
 */
export function useDataGridState<R, SR>(): Maybe<DataGridState<R, SR>> {
  return useContext(DataGridStateContext);
}