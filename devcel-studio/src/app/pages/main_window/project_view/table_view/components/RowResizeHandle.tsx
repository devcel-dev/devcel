import React, { useEffect, useRef } from 'react';

interface RowResizeHandleProps {
  rowId: string;
  previousRowId?: string;
  onRowResize: (rowId: string, height: number) => void;
  onRowResizeEnd?: () => void;
}

export const RowResizeHandle: React.FC<RowResizeHandleProps> = ({
  rowId,
  previousRowId,
  onRowResize,
  onRowResizeEnd
}) => {
  interface ResizeState {
    pointerId: number;
    rowId: string;
    startY: number;
    startHeight: number;
    scale: number;
    lastHeight: number;
    pendingHeight: number;
    frameId?: number;
  }

  const resizeRef = useRef<ResizeState | undefined>(undefined);
  const callbacksRef = useRef({ onRowResize, onRowResizeEnd });
  callbacksRef.current = { onRowResize, onRowResizeEnd };

  useEffect(() => () => {
    const resize = resizeRef.current;
    if (!resize) return;
    if (resize.frameId !== undefined) cancelAnimationFrame(resize.frameId);
    resizeRef.current = undefined;
    callbacksRef.current.onRowResizeEnd?.();
  }, []);

  function flushPendingResize(resize: ResizeState) {
    if (resize.frameId !== undefined) cancelAnimationFrame(resize.frameId);
    resize.frameId = undefined;
    if (resize.pendingHeight === resize.lastHeight) return;
    resize.lastHeight = resize.pendingHeight;
    callbacksRef.current.onRowResize(resize.rowId, resize.pendingHeight);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>, targetRowId: string) {
    if (resizeRef.current || (event.pointerType === 'mouse' && event.buttons !== 1)) return;

    event.preventDefault();
    event.stopPropagation();

    const { currentTarget, pointerId } = event;
    const grid = currentTarget.closest('.rdg');
    const targetCell = grid?.querySelector<HTMLElement>(
      `.rdg-advanced-row[data-row-id="${CSS.escape(targetRowId)}"]`
    )?.closest<HTMLElement>('.rdg-cell');
    if (!targetCell || targetCell.offsetHeight === 0) return;

    // The top handle measures the previous row itself; the inner wrapper excludes the row border.
    const startHeight = targetCell.offsetHeight;
    const scale = targetCell.getBoundingClientRect().height / startHeight;
    if (!(scale > 0) || !Number.isFinite(scale)) return;

    currentTarget.setPointerCapture(pointerId);
    resizeRef.current = {
      pointerId,
      rowId: targetRowId,
      startY: event.clientY,
      startHeight,
      scale,
      lastHeight: startHeight,
      pendingHeight: startHeight
    };
  }

  function updatePendingHeight(event: React.PointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();

    const delta = (event.clientY - resize.startY) / resize.scale;
    // Round movement to 5px increments so a click alone does not alter the initial height.
    resize.pendingHeight = Math.max(20, resize.startHeight + Math.round(delta / 5) * 5);
    return resize;
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.buttons !== 1) {
      handleLostPointerCapture(event);
      return;
    }
    const resize = updatePendingHeight(event);
    if (!resize || resize.frameId !== undefined) return;
    // Update pendingHeight while waiting for RAF too, preserving the last movement.
    resize.frameId = requestAnimationFrame(() => {
      if (resizeRef.current === resize) flushPendingResize(resize);
    });
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    updatePendingHeight(event);
    handleLostPointerCapture(event);
  }

  function handleLostPointerCapture(event: React.PointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.stopPropagation();
    flushPendingResize(resize);
    resizeRef.current = undefined;
    callbacksRef.current.onRowResizeEnd?.();
  }

  function handleDoubleClick(event: React.MouseEvent<HTMLDivElement>, targetRowId: string) {
    event.preventDefault();
    event.stopPropagation();
    // Keep the existing double-click behavior of resetting to 30px.
    onRowResize(targetRowId, 30);
    onRowResizeEnd?.();
  }

  const resizeEvents = {
    onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => event.stopPropagation(),
    onClick: (event: React.MouseEvent<HTMLDivElement>) => event.stopPropagation(),
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handleLostPointerCapture,
    onLostPointerCapture: handleLostPointerCapture
  };

  return (
    <>
      {/* Top resize handle (changes the previous row's height), left side */}
      {previousRowId && (
        <>
          <div
            className="rdg-row-resize-handle rdg-row-resize-handle-top"
            style={{
              position: 'absolute',
              top: '-6px',
              left: '0',
              width: 'calc(50% - 12px)', // Reserve the centered insertion button
              height: '12px',
              cursor: 'row-resize',
              zIndex: 1000,
              backgroundColor: 'transparent',
              // backgroundColor: 'rgba(0, 0, 255, 0.2)',
            }}
            {...resizeEvents}
            onPointerDown={(e) => handlePointerDown(e, previousRowId)}
            onDoubleClick={(e) => handleDoubleClick(e, previousRowId)}
          />
          {/* Top resize handle (changes the previous row's height), right side */}
          <div
            className="rdg-row-resize-handle rdg-row-resize-handle-top"
            style={{
              position: 'absolute',
              top: '-6px',
              right: '0',
              width: 'calc(50% - 12px)', // Reserve the centered insertion button
              height: '12px',
              cursor: 'row-resize',
              zIndex: 1000,
              backgroundColor: 'transparent',
              // backgroundColor: 'rgba(0, 0, 255, 0.2)',
            }}
            {...resizeEvents}
            onPointerDown={(e) => handlePointerDown(e, previousRowId)}
            onDoubleClick={(e) => handleDoubleClick(e, previousRowId)}
          />
        </>
      )}

      {/* Bottom resize handle (changes the current row's height), left side */}
      <div
        className="rdg-row-resize-handle rdg-row-resize-handle-bottom"
        style={{
          position: 'absolute',
          bottom: '-6px',
          left: '0',
          width: 'calc(50% - 12px)', // Reserve the centered insertion button
          height: '12px',
          cursor: 'row-resize',
          zIndex: 1000,
          backgroundColor: 'transparent',
          // backgroundColor: 'rgba(255, 0, 0, 0.2)',
        }}
        {...resizeEvents}
        onPointerDown={(e) => handlePointerDown(e, rowId)}
        onDoubleClick={(e) => handleDoubleClick(e, rowId)}
      />

      {/* Bottom resize handle (changes the current row's height), right side */}
      <div
        className="rdg-row-resize-handle rdg-row-resize-handle-bottom"
        style={{
          position: 'absolute',
          bottom: '-6px',
          right: '0',
          width: 'calc(50% - 12px)', // Reserve the centered insertion button
          height: '12px',
          cursor: 'row-resize',
          zIndex: 1000,
          backgroundColor: 'transparent',
          // backgroundColor: 'rgba(255, 0, 0, 0.2)',
        }}
        {...resizeEvents}
        onPointerDown={(e) => handlePointerDown(e, rowId)}
        onDoubleClick={(e) => handleDoubleClick(e, rowId)}
      />

      {/* Visual indicator when hovering over the bottom handle */}
      <div
        className="rdg-row-resize-handle-indicator-bottom"
        style={{
          position: 'absolute',
          bottom: '-1.5px',
          left: 0,
          right: 0,
          height: '3px',
          backgroundColor: 'transparent',
          pointerEvents: 'none',
          transition: 'background-color 0.1s',
        }}
      />

      {/* Visual indicator when hovering over the top handle */}
      <div
        className="rdg-row-resize-handle-indicator-top"
        style={{
          position: 'absolute',
          top: '-1.5px',
          left: 0,
          right: 0,
          height: '3px',
          backgroundColor: 'transparent',
          pointerEvents: 'none',
          transition: 'background-color 0.1s',
        }}
      />
    </>
  );
};
