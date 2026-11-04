import type { CSSProperties } from 'react';
import type { CalculatedColumn, PhysicalBodyWindow } from '../types';

/** A paint-box budget, not extra column overscan. Large tracks use the full-width paint box. */
export const PHYSICAL_BODY_BUFFER_PX = 160;

export function createPhysicalBodyWindow(
  columns: readonly { readonly key: string }[],
  metrics: { get: (column: { readonly key: string }) => { readonly left: number; readonly width: number } | undefined },
  templateColumns: readonly string[],
  startIdx: number,
  endIdx: number,
  viewportWidth: number,
  scale: number
): PhysicalBodyWindow | undefined {
  if (startIdx < 0 || startIdx > endIdx || endIdx >= columns.length ||
    !(viewportWidth > 0) || !(scale > 0) || !Number.isFinite(scale)) return undefined;
  const first = metrics.get(columns[startIdx]);
  const last = metrics.get(columns[endIdx]);
  if (!first || !last) return undefined;
  const logicalOffset = first.left;
  const logicalWidth = last.left + last.width - logicalOffset;
  const physicalWidth = logicalWidth * scale;
  const physicalOffset = logicalOffset * scale;
  if (![logicalOffset, logicalWidth, physicalWidth, physicalOffset].every(Number.isFinite) ||
    logicalOffset < 0 || logicalWidth <= 0 ||
    physicalWidth > viewportWidth * scale + 2 * PHYSICAL_BODY_BUFFER_PX + 1e-6) return undefined;
  const tracks = templateColumns.slice(startIdx, endIdx + 1);
  if (tracks.length !== endIdx - startIdx + 1 ||
    tracks.some(track => !/^(?:\d+\.?\d*|\.\d+)px$/.test(track))) return undefined;
  return { startIdx, endIdx, logicalOffset, logicalWidth, physicalOffset, physicalWidth,
    templateColumns: tracks.join(' ') };
}

/** Never enlarge a window to include a far selected cell or a span-origin gap. */
export function resolvePhysicalBodyWindow<R, SR>(
  window: PhysicalBodyWindow | undefined,
  rowColumns: readonly CalculatedColumn<R, SR>[]
): PhysicalBodyWindow | undefined {
  return window && rowColumns.every(column => column.frozen ||
    (column.idx >= window.startIdx && column.idx <= window.endIdx)) ? window : undefined;
}

export function getPhysicalBodyWindowStyle(window: PhysicalBodyWindow | undefined): CSSProperties | undefined {
  return window === undefined ? undefined : {
    '--rdg-body-physical-width': `${window.physicalWidth}px`,
    '--rdg-body-physical-offset': `${window.physicalOffset}px`,
    '--rdg-body-logical-width': `${window.logicalWidth}px`,
    '--rdg-body-columns': window.templateColumns,
    '--rdg-window-start': String(window.startIdx)
  } as CSSProperties;
}
