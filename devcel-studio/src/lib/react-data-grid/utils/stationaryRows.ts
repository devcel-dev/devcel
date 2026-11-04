/** Physical display coordinates for stationary rows; no DOM reads or viewport expansion. */
export interface StationaryRowsWindow {
  start: number;
  end: number;
  originLogical: number;
  groupY: number;
  groupHeight: number;
}
export function getStationaryRowsWindow(
  start: number, end: number, count: number,
  getRowTop: (index: number) => number, getRowHeight: (index: number) => number,
  headerHeight: number, scrollTop: number, scale: number
): StationaryRowsWindow | undefined {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= count
    || ![headerHeight, scrollTop, scale].every(Number.isFinite) || headerHeight < 0 || scale <= 0) return;
  const originLogical = getRowTop(start);
  const bottom = getRowTop(end) + getRowHeight(end);
  const groupY = (headerHeight + originLogical - scrollTop) * scale;
  const groupHeight = (bottom - originLogical) * scale;
  if (![originLogical, bottom, groupY, groupHeight].every(Number.isFinite) || groupHeight < 0) return;
  return { start, end, originLogical, groupY, groupHeight };
}

/** Only the existing additional selected row is parked; normal coverage stays unchanged. */
export function getStationaryRowTop(
  rowIdx: number, logicalTop: number, logicalHeight: number, scale: number,
  headerHeight: number, scrollTop: number, ownerClientHeight: number,
  window: StationaryRowsWindow | undefined, isAdditionalPin: boolean
): number {
  const groupY = window?.groupY ?? 0;
  // The normal local top depends only on the anchor, never on scroll-offset rounding.
  const modelTop = window ? (logicalTop - window.originLogical) * scale
    : (headerHeight + logicalTop - scrollTop) * scale;
  const height = logicalHeight * scale;
  if (!isAdditionalPin || !window || ![groupY, ownerClientHeight, height].every(Number.isFinite)
    || ownerClientHeight <= 0 || height < 0) return modelTop;
  if (rowIdx < window.start) return -height - groupY;
  if (rowIdx > window.end) return ownerClientHeight - groupY;
  return modelTop;
}
