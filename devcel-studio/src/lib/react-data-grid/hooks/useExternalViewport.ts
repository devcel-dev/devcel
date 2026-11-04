import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/** The outer physical viewport, expressed in unscaled logical grid coordinates. */
export function useExternalViewport(
  gridRef: RefObject<HTMLDivElement | null>,
  externalScrollRef: RefObject<HTMLElement | null> | undefined,
  externalZoom: number,
  direction: 'ltr' | 'rtl',
  geometryKey?: object,
  beforeMeasure?: () => boolean,
  contentOriginRef?: RefObject<HTMLElement | null>
) {
  const [viewport, setViewport] = useState<{
    scrollTop: number; clientHeight: number; scrollLeft: number; clientWidth: number;
    ownerClientWidth: number; ownerClientHeight: number; geometryKey?: object;
    zoom: number; direction: 'ltr' | 'rtl';
    owner: HTMLElement; root: HTMLElement;
  } | null>(null);
  const geometryKeyRef = useRef(geometryKey);
  geometryKeyRef.current = geometryKey;
  const beforeMeasureRef = useRef(beforeMeasure);
  useLayoutEffect(() => { beforeMeasureRef.current = beforeMeasure; });
  const measureRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { measureRef.current?.(); }, [geometryKey, externalZoom, direction, contentOriginRef]);
  const updateViewportRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => updateViewportRef.current?.(), []);

  // Parent refs attach after child layout effects. Connect after the whole commit.
  useEffect(() => {
    const grid = gridRef.current;
    const scroller = externalScrollRef?.current;
    if (!grid || !scroller) { setViewport(null); return; }
    const zoom = Number.isFinite(externalZoom) && externalZoom > 0 ? externalZoom : 1;
    let active = true;
    let measuredGeometryKey: object | undefined;
    let gridOrigin = 0, gridOriginLeft = 0, gridWidth = 0, viewportHeight = 0, viewportWidth = 0;

    function updateViewport() {
      const top = (scroller!.scrollTop - gridOrigin) / zoom;
      const scrollTop = Math.max(0, top);
      const clientHeight = Math.max(0, top + viewportHeight - scrollTop);
      const physicalLeft = (scroller!.scrollLeft - gridOriginLeft) / zoom;
      const left = direction === 'rtl' ? gridWidth - physicalLeft - viewportWidth : physicalLeft;
      const scrollLeft = Math.max(0, left);
      const clientWidth = Math.max(0, left + viewportWidth - scrollLeft);
      setViewport(previous => previous?.scrollTop === scrollTop && previous.clientHeight === clientHeight
        && previous.scrollLeft === scrollLeft && previous.clientWidth === clientWidth
        && previous.geometryKey === measuredGeometryKey && previous.zoom === zoom
        && previous.direction === direction
        && previous.owner === scroller && previous.root === grid
        && previous.ownerClientWidth === viewportWidth * zoom && previous.ownerClientHeight === viewportHeight * zoom
        ? previous : { scrollTop, clientHeight, scrollLeft, clientWidth, geometryKey: measuredGeometryKey,
          zoom, direction, owner: scroller!, root: grid!,
          ownerClientWidth: viewportWidth * zoom, ownerClientHeight: viewportHeight * zoom });
    }
    function measure() {
      // Detached/old keyed observers cannot write the persistent parent's extent.
      if (!active || gridRef.current !== grid || externalScrollRef?.current !== scroller
        || !grid!.isConnected || !scroller!.isConnected) return;
      if (beforeMeasureRef.current?.() === false) { setViewport(null); return; }
      const origin = contentOriginRef ? contentOriginRef.current : grid!;
      if (!origin || contentOriginRef && (!origin.isConnected || !origin.contains(grid!))) { setViewport(null); return; }
      const gridRect = origin.getBoundingClientRect();
      const scrollerRect = scroller!.getBoundingClientRect();
      gridOrigin = scroller!.scrollTop + gridRect.top - scrollerRect.top - scroller!.clientTop + origin.clientTop;
      gridOriginLeft = scroller!.scrollLeft + gridRect.left - scrollerRect.left - scroller!.clientLeft + origin.clientLeft;
      gridWidth = origin.clientWidth / zoom;
      viewportHeight = scroller!.clientHeight / zoom;
      viewportWidth = scroller!.clientWidth / zoom;
      measuredGeometryKey = geometryKeyRef.current;
      updateViewport();
    }
    // Scroll reads only offsets. No rect reads, extent writes or delayed correction.
    function handleScroll() { flushSync(updateViewport); }
    updateViewportRef.current = updateViewport;
    measureRef.current = measure;
    measure();
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(scroller); observer?.observe(grid);
    if (contentOriginRef?.current) observer?.observe(contentOriginRef.current);
    return () => {
      active = false;
      updateViewportRef.current = null; measureRef.current = null;
      scroller.removeEventListener('scroll', handleScroll); observer?.disconnect();
    };
  }, [gridRef, externalScrollRef, externalZoom, direction, contentOriginRef]);
  return externalScrollRef && viewport ? { ...viewport, refresh,
    ready: viewport.geometryKey === geometryKey && viewport.zoom === externalZoom
      && viewport.direction === direction
      && viewport.owner === externalScrollRef.current && viewport.root === gridRef.current
  } : null;
}
