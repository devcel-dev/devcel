import { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore, type Key, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useI18n } from '@/app/i18n';
import type { CalculatedColumn } from './types';
import { createGridSharedTooltipController, type GridSharedTooltipController } from './gridSharedTooltipController';

export type { GridSharedTooltipController } from './gridSharedTooltipController';

interface GridTooltipSource<R, SR> {
  rootRef: RefObject<HTMLDivElement | null>;
  rows: readonly R[];
  columns: readonly CalculatedColumn<R, SR>[];
  selectedPosition?: { rowIdx: number; idx: number };
  rowKeyGetter?: ((row: R) => Key) | null;
}

/** No tooltip context, state, callback ref or cloned element is created for a cell. */
export function useGridSharedTooltip<R, SR>(source: GridTooltipSource<R, SR>) {
  const id = useId();
  const committedSource = useRef(source);
  const controllerRef = useRef<GridSharedTooltipController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createGridSharedTooltipController({
      id: `rdg-tooltip-${id}`,
      getRoot: () => committedSource.current.rootRef.current,
      resolveCell(host) {
        const { rows, columns, rowKeyGetter } = committedSource.current;
        const rowIdx = Number(host.dataset.rowIndex);
        const columnIdx = Number(host.dataset.columnIndex);
        if (!Number.isInteger(rowIdx) || !Number.isInteger(columnIdx) || rowIdx < 0 || columnIdx < 0
          || host.dataset.rowIndex === undefined || host.dataset.columnIndex === undefined) return;
        const row = rows[rowIdx];
        const column = columns[columnIdx];
        if (row === undefined || !column || column.idx !== columnIdx) return;
        return {
          rowKey: rowKeyGetter ? rowKeyGetter(row) : row,
          columnKey: column.key,
          tooltip: typeof column.tooltip === 'function' ? column.tooltip(row) : column.tooltip,
          memoText: typeof column.memoText === 'function' ? column.memoText(row) : column.memoText,
          placement: column.tooltipPlacement
        };
      }
    });
  }
  const controller = controllerRef.current;
  useLayoutEffect(() => {
    // Resolve only committed data; speculative React renders must not change target identity.
    committedSource.current = source;
    if (source.selectedPosition) {
      const row = source.rows[source.selectedPosition.rowIdx];
      const column = source.columns[source.selectedPosition.idx];
      controller.onSelection(row !== undefined && column ? { rowKey: source.rowKeyGetter ? source.rowKeyGetter(row) : row, columnKey: column.key } : undefined);
    }
    controller.reconcile();
  });
  useEffect(() => {
    const doc = source.rootRef.current?.ownerDocument;
    const win = doc?.defaultView;
    if (!doc || !win) return;
    const resize = () => { if (controller.getSnapshot()?.mode !== 'memo') controller.dismiss(); };
    doc.addEventListener('scroll', controller.onScroll, true);
    doc.addEventListener('keydown', controller.onEscape, true);
    win.addEventListener('resize', resize);
    win.addEventListener('blur', resize);
    return () => {
      doc.removeEventListener('scroll', controller.onScroll, true);
      doc.removeEventListener('keydown', controller.onEscape, true);
      win.removeEventListener('resize', resize);
      win.removeEventListener('blur', resize);
      controller.dismiss();
    };
  }, [controller, source.rootRef]);
  return controller;
}

const emptySnapshot = () => null;

/** Only this small component re-renders when a tooltip opens or closes. */
export function GridSharedTooltipPortal({ controller }: { controller: GridSharedTooltipController }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, emptySnapshot);
  const { t } = useI18n();
  if (!view) return null;
  const memo = view.mode === 'memo';
  const { placement } = view;
  return createPortal(
    <div
      id={memo ? `${controller.id}-surface` : controller.id}
      role={memo ? 'dialog' : 'tooltip'}
      aria-label={memo ? view.text : undefined}
      data-grid-tooltip-id={controller.id}
      style={memo ? {
        position: 'fixed', top: view.top, left: view.left, transform: 'translate(-50%, -100%)',
        backgroundColor: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))', padding: '12px 16px', borderRadius: '8px',
        fontSize: '14px', lineHeight: 1.5, boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        border: '1px solid hsl(var(--border))', zIndex: 40, maxWidth: '400px', maxHeight: '300px', overflow: 'hidden'
      } : {
        position: 'fixed', top: placement === 'bottom' ? view.top : view.top - 28, left: view.left,
        transform: placement === 'left' || placement === 'right' ? 'translateY(-50%)' : 'translateX(-50%)',
        backgroundColor: 'rgba(0, 0, 0, 0.8)', color: 'white', padding: '4px 8px', borderRadius: '4px',
        fontSize: '12px', whiteSpace: 'nowrap', zIndex: 40, pointerEvents: 'none', maxWidth: '300px',
        overflow: 'hidden', textOverflow: 'ellipsis'
      }}
      onClick={event => event.stopPropagation()}
      onMouseLeave={memo ? controller.onPortalLeave : undefined}
      onBlur={memo ? controller.onPortalBlur : undefined}
    >
      <div id={memo ? controller.id : undefined} data-grid-memo-content={memo ? '' : undefined} style={memo ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingRight: '28px', maxHeight: '274px', overflowY: 'auto' } : undefined}>{view.text}</div>
      {memo && <button
        type="button"
        aria-label={t('common.close')}
        className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        style={{ position: 'absolute', top: '8px', right: '8px', width: '24px', height: '24px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'hsl(var(--popover))', border: 'none',
          cursor: 'pointer', color: 'hsl(var(--popover-foreground))', padding: 0 }}
        onClick={event => { event.stopPropagation(); controller.closeMemo(); }}
      ><X size={16} aria-hidden="true" focusable="false" /></button>}
    </div>,
    view.host.ownerDocument.body
  );
}
