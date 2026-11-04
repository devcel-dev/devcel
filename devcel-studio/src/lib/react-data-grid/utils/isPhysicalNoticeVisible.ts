export interface PhysicalNoticeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function isValidPhysicalNoticeRect(rect: PhysicalNoticeRect): boolean {
  return [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite)
    && rect.right >= rect.left && rect.bottom >= rect.top && rect.width >= 0 && rect.height >= 0
    && Math.abs(rect.right - rect.left - rect.width) < 0.001
    && Math.abs(rect.bottom - rect.top - rect.height) < 0.001;
}

/** All bounds are physical client pixels, including the actual sticky boxes. */
export function isPhysicalNoticeVisible({ anchor, viewport, header, frozen, isHeader, isFrozen, direction }: {
  anchor: PhysicalNoticeRect;
  viewport: PhysicalNoticeRect;
  header: PhysicalNoticeRect | null;
  frozen: PhysicalNoticeRect | null;
  isHeader: boolean;
  isFrozen: boolean;
  direction: 'ltr' | 'rtl';
}): boolean {
  if (!isValidPhysicalNoticeRect(anchor) || !isValidPhysicalNoticeRect(viewport)
    || anchor.width <= 0 || anchor.height <= 0 || viewport.width <= 0 || viewport.height <= 0
    || (header && (!isValidPhysicalNoticeRect(header) || header.width <= 0 || header.height <= 0))
    || (frozen && (!isValidPhysicalNoticeRect(frozen) || frozen.height <= 0))) return false;
  if (!isHeader && (!header || header.width <= 0 || header.height <= 0)) return false;
  if (!isFrozen && (!frozen || frozen.height <= 0)) return false;
  const top = isHeader ? viewport.top : Math.max(viewport.top, header!.bottom);
  const left = !isFrozen && direction === 'ltr' ? Math.max(viewport.left, frozen!.right) : viewport.left;
  const right = !isFrozen && direction === 'rtl' ? Math.min(viewport.right, frozen!.left) : viewport.right;
  return Math.max(anchor.left, left) < Math.min(anchor.right, right)
    && Math.max(anchor.top, top) < Math.min(anchor.bottom, viewport.bottom);
}
