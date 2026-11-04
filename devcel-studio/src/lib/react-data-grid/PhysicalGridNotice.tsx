import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { usePhysicalViewport } from './DataGridViewportContext';
import { isPhysicalNoticeVisible, isValidPhysicalNoticeRect } from './utils/isPhysicalNoticeVisible';
import { getOwnedPhysicalCell } from './utils/physicalRowOwnership';

interface PhysicalGridNoticeProps {
  anchorRef: RefObject<HTMLElement | null>;
  id: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  as?: 'div' | 'span';
  align?: 'left' | 'right';
  offset?: number;
}

/** Only active errors measure their anchor; ordinary grid scrolling does no work here. */
export function PhysicalGridNotice({ anchorRef, id, children, className, style,
  as: Tag = 'div', align = 'left', offset = 0 }: PhysicalGridNoticeProps) {
  const gridViewport = usePhysicalViewport();
  const viewport = gridViewport?.layout === 'grid' ? undefined : gridViewport;
  const [position, setPosition] = useState<{
    anchor: HTMLElement; version: object; style: CSSProperties;
  } | null>(null);
  const ownerRef = viewport?.ownerRef;
  const scale = viewport?.scale;
  const direction = viewport?.direction;
  const ready = viewport?.layoutReady;
  const version = viewport?.layoutVersion;

  useLayoutEffect(() => {
    if (!ownerRef || !ready || !version || !scale || !Number.isFinite(scale) || scale <= 0) {
      setPosition(null);
      return;
    }
    const view = ownerRef.current?.ownerDocument.defaultView;
    if (!view) return;
    let frame = 0;
    const update = () => {
      const anchor = anchorRef.current;
      const owner = ownerRef.current;
      const root = anchor?.closest<HTMLElement>('.rdg-physical-rows-viewport');
      const isStationary = root?.classList.contains('rdg-stationary-rows-viewport') ?? false;
      const owned = isStationary && root && anchor ? getOwnedPhysicalCell(root, anchor) : undefined;
      const row = isStationary ? owned?.row
        : anchor?.closest<HTMLElement>('.rdg-physical-semantic-row, .rdg-physical-semantic-header');
      const pane = isStationary ? owned?.pane
        : anchor?.closest<HTMLElement>('.rdg-physical-row-frozen, .rdg-physical-row-body');
      const logical = isStationary ? owned?.logical
        : anchor?.closest<HTMLElement>('.rdg-physical-row-logical-grid');
      const hide = () => setPosition(previous => previous === null ? previous : null);
      if (!anchor?.isConnected || !owner?.isConnected || !root || !owner.contains(root)
        || !owner.contains(anchor) || anchor.closest('.rdg') !== root || !row
        || (isStationary ? !owned : row.parentElement !== root) || !pane || pane.parentElement !== row
        || !logical || logical.parentElement !== pane) { hide(); return; }
      const panes = Array.from(row.children);
      const frozenPanes = panes.filter(child => child.classList.contains('rdg-physical-row-frozen'));
      const bodyPanes = panes.filter(child => child.classList.contains('rdg-physical-row-body'));
      const headers = Array.from(root.children).filter(child => child.classList.contains('rdg-physical-semantic-header'));
      if (panes.length !== 2 || frozenPanes.length !== 1 || bodyPanes.length !== 1
        || frozenPanes[0] === bodyPanes[0] || ![frozenPanes[0], bodyPanes[0]].includes(pane)
        || headers.length !== 1 || headers[0].classList.contains('rdg-physical-semantic-row')
        || row.classList.contains('rdg-physical-semantic-header') && row !== headers[0]) {
        hide(); return;
      }
      const rect = anchor.getBoundingClientRect();
      const ownerRect = owner.getBoundingClientRect();
      if (!isValidPhysicalNoticeRect(ownerRect) || ownerRect.width <= 0 || ownerRect.height <= 0
        || ![owner.clientLeft, owner.clientTop, owner.clientWidth,
        owner.clientHeight].every(Number.isFinite) || owner.clientLeft < 0 || owner.clientTop < 0) { hide(); return; }
      const left = ownerRect.left + owner.clientLeft;
      const top = ownerRect.top + owner.clientTop;
      if (!isPhysicalNoticeVisible({ anchor: rect,
        viewport: { left, top, right: left + owner.clientWidth, bottom: top + owner.clientHeight,
          width: owner.clientWidth, height: owner.clientHeight },
        header: headers[0].getBoundingClientRect(), frozen: frozenPanes[0].getBoundingClientRect(),
        isHeader: row === headers[0], isFrozen: pane === frozenPanes[0], direction: direction! })) { hide(); return; }
      const inherited = view.getComputedStyle(anchor);
      const nextStyle: CSSProperties = {
        position: 'fixed', left: align === 'right' ? rect.right : rect.left, top: rect.bottom + offset * scale,
        width: 'max-content', zIndex: 1000, pointerEvents: 'none',
        transform: `scale(${scale})${align === 'right' ? ' translateX(-100%)' : ''}`, transformOrigin: 'top left',
        fontFamily: inherited.fontFamily, fontSize: inherited.fontSize, fontWeight: inherited.fontWeight,
        fontStyle: inherited.fontStyle, lineHeight: inherited.lineHeight,
        letterSpacing: inherited.letterSpacing, textAlign: inherited.textAlign as CSSProperties['textAlign']
      };
      setPosition(previous => previous?.anchor === anchor && previous.version === version
        && Object.keys(nextStyle).every(key => previous.style[key as keyof CSSProperties] === nextStyle[key as keyof CSSProperties])
        ? previous : { anchor, version, style: nextStyle });
    };
    const track = () => { update(); frame = view.requestAnimationFrame(track); };
    track();
    return () => view.cancelAnimationFrame(frame);
  }, [anchorRef, ownerRef, ready, version, scale, direction, align, offset]);

  if (!viewport) return <Tag id={id} role="alert" className={className} style={style}>{children}</Tag>;
  // A layout transaction hides the old portal in this render, before measuring again.
  if (!ready || !position || position.version !== version || position.anchor !== anchorRef.current
    || !position.anchor.isConnected) return null;
  return createPortal(<div dir={direction} style={position.style}>
    <Tag id={id} role="alert" className={className} style={{ ...style, display: 'block', position: 'relative',
      top: 'auto', right: 'auto', bottom: 'auto', left: 'auto', margin: 0 }}>{children}</Tag>
  </div>, position.anchor.ownerDocument.body);
}
