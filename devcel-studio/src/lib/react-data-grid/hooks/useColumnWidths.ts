/**
 * useColumnWidths.ts
 * 
 * Custom hook managing column widths and dynamic resizing
 * Provides the following features:
 * - Measure and update column widths
 * - Handle user column resizing
 * - Support automatic sizing with 'auto' and 'max-content'
 * - Recalculate column widths when the grid width changes
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import type { CalculatedColumn, ColumnWidths, ResizedWidth } from '../types';
import type { DataGridProps } from '../DataGrid';

/** Plan measuring only logical widths, separately from numeric rendering tracks. */
export interface ColumnMeasurementPlan {
  readonly keys: readonly string[];
  readonly templateColumns: readonly string[];
  readonly numericResize?: boolean;
}

export interface ColumnMeasurementAdapter {
  measureLogicalColumns(plan: ColumnMeasurementPlan): ReadonlyMap<string, number> | undefined;
}

/**
 * Custom hook managing column widths
 * 
 * Manage column measurement, resizing, and automatic sizing.
 * Support dynamic widths such as 'auto' and 'max-content',
 * measuring and applying widths from actual DOM elements.
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 * 
 * @param columns - Array of all columns
 * @param viewportColumns - Array of currently displayed columns
 * @param templateColumns - Column widths for the CSS grid template
 * @param gridRef - Reference to the grid DOM element
 * @param gridWidth - Current grid width
 * @param columnWidths - Current map of measured or resized column widths
 * @param onColumnWidthsChange - Callback when column widths change
 * @param onColumnResize - External callback when a column is resized
 * @param setColumnResizing - Function setting resizing state
 */
export function useColumnWidths<R, SR>(
  columns: readonly CalculatedColumn<R, SR>[],
  viewportColumns: readonly CalculatedColumn<R, SR>[],
  templateColumns: readonly string[],
  gridRef: React.RefObject<HTMLDivElement | null>,
  gridWidth: number,
  columnWidths: ColumnWidths,
  onColumnWidthsChange: (columnWidths: ColumnWidths) => void,
  onColumnResize: DataGridProps<R, SR>['onColumnResize'],
  setColumnResizing: (isColumnResizing: boolean) => void,
  measurementAdapter?: ColumnMeasurementAdapter
) {
  // Store information about the column being auto-sized
  const [columnToAutoResize, setColumnToAutoResize] = useState<{
    readonly key: string;
    readonly width: ResizedWidth;
    readonly requestId?: number;
  } | null>(null);
  
  // Retain physical-layout results per request to avoid measuring again after flushSync.
  const nextRequestId = useRef(0);
  const resizeResult = useRef<{
    readonly requestId: number;
    readonly key: string;
    readonly width: number | undefined;
  } | null>(null);
  const committedColumns = useRef(columns);
  const [measurementRevision, setMeasurementRevision] = useState(0);

  // Set of columns requiring measurement during resizing
  const [columnsToMeasureOnResize, setColumnsToMeasureOnResize] =
    useState<ReadonlySet<string> | null>(null);
  
  // Store the previous grid width to detect changes
  const [prevGridWidth, setPreviousGridWidth] = useState(gridWidth);
  
  // Columns can flex when all columns are displayed
  const columnsCanFlex: boolean = columns.length === viewportColumns.length;
  
  // Whether to ignore previously measured widths after a grid width change
  const ignorePreviouslyMeasuredColumnsOnGridWidthChange =
    // If columns can flex...
    columnsCanFlex &&
    // And the grid was resized, allow the columns to flex again
    gridWidth !== prevGridWidth;
  
  // Create a new template column array
  const newTemplateColumns = [...templateColumns];
  // Keys of columns requiring measurement
  const columnsToMeasure: string[] = [];

  // Set the appropriate width for each displayed column
  for (const { key, idx, width } of viewportColumns) {
    const columnWidth = columnWidths.get(key);
    
    // For the column being auto-sized
    if (key === columnToAutoResize?.key) {
      newTemplateColumns[idx] =
        columnToAutoResize.width === 'max-content'
          ? columnToAutoResize.width  // Use 'max-content' unchanged
          : `${columnToAutoResize.width}px`;  // Convert numeric widths to pixels
      columnsToMeasure.push(key);
    } 
    // For dynamic widths, such as 'auto', requiring measurement
    else if (
      typeof width === 'string' &&
      // Do not remeasure columns resized by the user
      columnWidth?.type !== 'resized' &&
      (ignorePreviouslyMeasuredColumnsOnGridWidthChange ||
        columnsToMeasureOnResize?.has(key) === true ||
        columnWidth === undefined)
    ) {
      newTemplateColumns[idx] = width;
      columnsToMeasure.push(key);
    }
  }

  // Resolve offscreen auto-size requests using current keys across all columns too.
  const requestedColumn = measurementAdapter && columnToAutoResize !== null
    ? columns.find(({ key }) => key === columnToAutoResize.key)
    : undefined;
  if (requestedColumn !== undefined && !columnsToMeasure.includes(requestedColumn.key)) {
    newTemplateColumns[requestedColumn.idx] = columnToAutoResize!.width === 'max-content'
      ? 'max-content'
      : `${columnToAutoResize!.width}px`;
    columnsToMeasure.push(requestedColumn.key);
  }

  const measurementPlan: ColumnMeasurementPlan = {
    keys: columnsToMeasure,
    templateColumns: newTemplateColumns,
    numericResize: measurementAdapter !== undefined &&
      requestedColumn !== undefined &&
      typeof columnToAutoResize?.width === 'number' &&
      columnsToMeasure.length === 1 &&
      newTemplateColumns.every((track, idx) => idx === requestedColumn.idx ||
        (/^(?:\d+\.?\d*|\.\d+)px$/.test(track) && Number.isFinite(Number.parseFloat(track))))
  };

  // For physical rows, keep auto/max-content only in the measurement plan, not the rendering grid.
  const gridTemplateColumns = (measurementAdapter ? templateColumns : newTemplateColumns).join(' ');

  // Measure and update widths in a layout effect
  // Use useLayoutEffect to update widths before painting
  useLayoutEffect(updateMeasuredAndResizedWidths);

  /**
   * Update measured and resized column widths
   * 
   * This function performs the following operations:
   * 1. Read actual widths from the DOM for columns requiring measurement
   * 2. Update the auto-sized column's width
   * 3. Notify the parent if anything changed
   */
  function updateMeasuredAndResizedWidths() {
    committedColumns.current = columns;
    if (measurementAdapter !== undefined) {
      updatePhysicalWidths(measurementAdapter);
      return;
    }
    // Record the current grid width
    setPreviousGridWidth(gridWidth);
    
    // Return early if no columns require measurement
    if (columnsToMeasure.length === 0) return;

    const newColumnWidths = new Map(columnWidths);
    let hasChanges = false;

    // Measure each column's width
    for (const key of columnsToMeasure) {
      const measuredWidth = measureColumnWidth(gridRef, key);
      // Check whether the width changed
      hasChanges ||= measuredWidth !== columnWidths.get(key)?.width;
      
      if (measuredWidth === undefined) {
        // Delete if measurement failed, falling back to the default width
        newColumnWidths.delete(key);
      } else {
        // Record the measured width with type: 'measured'
        newColumnWidths.set(key, { type: 'measured', width: measuredWidth });
      }
    }

    // If a column is being auto-sized
    if (columnToAutoResize !== null) {
      const resizingKey = columnToAutoResize.key;
      const oldWidth = columnWidths.get(resizingKey)?.width;
      const newWidth = measureColumnWidth(gridRef, resizingKey);
      
      if (newWidth !== undefined && oldWidth !== newWidth) {
        hasChanges = true;
        // Record it as a resized column with type: 'resized'
        newColumnWidths.set(resizingKey, {
          type: 'resized',
          width: newWidth
        });
      }
      // Clear auto-sizing state
      setColumnToAutoResize(null);
    }

    // Notify the parent if anything changed
    if (hasChanges) {
      onColumnWidthsChange(newColumnWidths);
    }
  }

  function updatePhysicalWidths(adapter: ColumnMeasurementAdapter) {
    setPreviousGridWidth(gridWidth);
    const request = columnToAutoResize;
    if (request !== null) {
      resizeResult.current = {
        requestId: request.requestId!,
        key: request.key,
        width: undefined
      };
      setColumnToAutoResize(null);
      setColumnsToMeasureOnResize(null);
    }
    if (measurementPlan.keys.length === 0) return;

    // The adapter measures this plan synchronously once and returns without changing rendering tracks.
    const measuredWidths = adapter.measureLogicalColumns(measurementPlan);
    if (measuredWidths === undefined) return;

    const newColumnWidths = new Map(columnWidths);
    let hasChanges = false;
    for (const key of measurementPlan.keys) {
      const measuredWidth = measuredWidths.get(key);
      hasChanges ||= measuredWidth !== columnWidths.get(key)?.width;
      if (measuredWidth === undefined) {
        newColumnWidths.delete(key);
      } else {
        newColumnWidths.set(key, { type: 'measured', width: measuredWidth });
      }
    }

    if (request !== null && requestedColumn !== undefined) {
      const width = measuredWidths.get(request.key);
      resizeResult.current = { requestId: request.requestId!, key: request.key, width };
      // Match the generic path by not changing only the type to resized when the width is unchanged.
      if (width !== undefined && columnWidths.get(request.key)?.width !== width) {
        hasChanges = true;
        newColumnWidths.set(request.key, { type: 'resized', width });
      }
    }
    if (hasChanges) onColumnWidthsChange(newColumnWidths);
    if (hasChanges || request !== null) {
      setMeasurementRevision((revision) => revision + 1);
    }
  }

  function handlePhysicalColumnResize(column: CalculatedColumn<R, SR>, nextWidth: ResizedWidth) {
    const currentColumn = committedColumns.current.find(({ key }) => key === column.key);
    if (currentColumn === undefined || (typeof nextWidth === 'number' && !Number.isFinite(nextWidth))) {
      return;
    }
    const resizingKey = currentColumn.key;
    const requestId = ++nextRequestId.current;

    // Numeric widths also pass through request, render, and layout effect to preserve controlled/uncontrolled switching.
    flushSync(() => {
      if (columnsCanFlex) {
        const columnsToRemeasure = new Set<string>();
        for (const { key, width } of viewportColumns) {
          if (resizingKey !== key && typeof width === 'string' &&
            columnWidths.get(key)?.type !== 'resized') {
            columnsToRemeasure.add(key);
          }
        }
        setColumnsToMeasureOnResize(columnsToRemeasure);
      }
      setColumnToAutoResize({ key: resizingKey, width: nextWidth, requestId });
      setColumnResizing(typeof nextWidth === 'number');
    });
    setColumnsToMeasureOnResize(null);

    // Match keys and request IDs rather than array identity, avoiding notifications to replaced or deleted columns.
    const result = resizeResult.current;
    const resizedColumn = committedColumns.current.find(({ key }) => key === resizingKey);
    if (result === null || result.requestId !== requestId || result.key !== resizingKey ||
      result.width === undefined || resizedColumn === undefined) return;
    const newWidth = typeof nextWidth === 'number' ? nextWidth : result.width;
    if (newWidth !== columnWidths.get(resizingKey)?.width) {
      onColumnResize?.(resizedColumn, newWidth);
    }
  }

  /**
   * Handle column resizing
   * 
   * Called when the user resizes a column.
   * Update the resized column and other columns that can flex.
   * 
   * @param column - Column being resized
   * @param nextWidth - New width, either a number or 'max-content'
   */
  function handleColumnResize(column: CalculatedColumn<R, SR>, nextWidth: ResizedWidth) {
    if (measurementAdapter !== undefined) {
      handlePhysicalColumnResize(column, nextWidth);
      return;
    }
    const { key: resizingKey } = column;

    // Update state synchronously with flushSync to run layout effects immediately
    flushSync(() => {
      if (columnsCanFlex) {
        // Remeasure all flexible columns not resized by the user
        const columnsToRemeasure = new Set<string>();
        for (const { key, width } of viewportColumns) {
          if (
            resizingKey !== key &&                        // Columns other than the one being resized
            typeof width === 'string' &&                  // With dynamic widths
            columnWidths.get(key)?.type !== 'resized'   // That have not been resized by the user
          ) {
            columnsToRemeasure.add(key);
          }
        }

        setColumnsToMeasureOnResize(columnsToRemeasure);
      }

      // Set the column as the auto-size target
      setColumnToAutoResize({
        key: resizingKey,
        width: nextWidth
      });

      // Update resizing state; true only for numeric widths
      setColumnResizing(typeof nextWidth === 'number');
    });

    // Clear the list of columns to remeasure
    setColumnsToMeasureOnResize(null);

    // Call the external resize handler
    if (onColumnResize) {
      const previousWidth = columnWidths.get(resizingKey)?.width;
      const newWidth =
        typeof nextWidth === 'number' ? nextWidth : measureColumnWidth(gridRef, resizingKey);
      
      // Invoke the callback only if the width actually changed
      if (newWidth !== undefined && newWidth !== previousWidth) {
        onColumnResize(column, newWidth);
      }
    }
  }

  return {
    gridTemplateColumns,     // CSS grid-template-columns value
    handleColumnResize,      // Column resize handler
    measurementPending: measurementAdapter !== undefined && columnsToMeasure.length > 0,
    measurementRevision,
    measuringColumnKeys: columnsToMeasure as readonly string[]
  } as const;
}

/**
 * Measure a column's actual width from the DOM
 * 
 * Find the element with the data-measuring-cell-key attribute
 * and get its actual rendered width.
 * 
 * @param gridRef - Reference to the grid DOM element
 * @param key - Key of the column to measure
 * @returns Measured width in pixels, or undefined if the element is absent
 */
function measureColumnWidth(gridRef: React.RefObject<HTMLDivElement | null>, key: string) {
  // Build the CSS selector, safely escaping the key
  const selector = `[data-measuring-cell-key="${CSS.escape(key)}"]`;
  // Find the measuring cell element
  const measuringCell = gridRef.current?.querySelector<HTMLElement>(selector);
  // Store width before CSS scaling so remeasurement while zoomed does not shrink or enlarge it
  return measuringCell?.offsetWidth;
}
