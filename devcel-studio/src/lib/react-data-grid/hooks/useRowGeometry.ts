import { useMemo } from 'react';
import type { Key } from 'react';
import { sameArray, useStableValue } from './useStableValue';

export interface RowGeometry {
  readonly count: number;
  readonly heights: number | readonly number[];
  readonly identities: readonly Key[] | undefined;
}

/** Evaluate arbitrary rowHeight callbacks against every new row input, then
 * retain the geometry only when its actual dimensions and row order agree. */
export function useRowGeometry<R>(rows: readonly R[], rowHeight: number | ((row: R) => number), rowKeyGetter?: (row: R) => Key): RowGeometry {
  const measured = useMemo(() => ({
    count: rows.length,
    heights: typeof rowHeight === 'number' ? rowHeight : rows.map(rowHeight),
    identities: rowKeyGetter ? rows.map(rowKeyGetter) : undefined,
  }), [rows, rowHeight, rowKeyGetter]);
  return useStableValue(measured, (previous, next) => previous.count === next.count
    && (typeof previous.heights === 'number' && typeof next.heights === 'number'
      ? Object.is(previous.heights, next.heights)
      : typeof previous.heights !== 'number' && typeof next.heights !== 'number'
        && sameArray(previous.heights, next.heights))
    && (previous.identities === next.identities || previous.identities !== undefined
      && next.identities !== undefined && sameArray(previous.identities, next.identities)));
}
