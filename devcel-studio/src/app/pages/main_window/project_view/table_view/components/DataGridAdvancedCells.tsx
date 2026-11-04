import { GridInsertIcon } from './GridInsertIcon';
import { settingsDisplayLabel, settingsTooltip } from '@/app/settings/displayLabels';
import { t, formatNumber } from '@/app/i18n';
import React, { useLayoutEffect, useRef, useState } from 'react';

export function InsertionHeader(props: React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const header = ref.current?.closest<HTMLElement>('[role=columnheader]');
    if (!header) return;
    const update = (width: number) => setNarrow(width <= 70);
    update(header.offsetWidth);
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) update(entry.borderBoxSize?.[0]?.inlineSize ?? header.offsetWidth);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return <div {...props} ref={ref} data-narrow-insertion={narrow || undefined} />;
}

import { RowResizeHandle } from './RowResizeHandle';

// Do not treat insert-button presses as parent cell selection, editing, or dragging.
// Also prevent the default pointerdown action so draggable column headers do not receive it.
const stopInsertInteraction = (event: React.SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};
const insertButtonEvents = {
  onPointerDown: stopInsertInteraction,
  onMouseDown: stopInsertInteraction,
  onDoubleClick: stopInsertInteraction,
  onDragStart: stopInsertInteraction,
  onContextMenu: stopInsertInteraction,
  onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
  onFocus: (event: React.FocusEvent) => event.stopPropagation()
};

// Capture at the wrapper even when disabled, preventing text selection or parent-row editing on a second press.
// Do not capture clicks or keyboard actions, preserving the button's first native activation.
const stopRowInsertCapture = (event: React.SyntheticEvent<HTMLDivElement>) => {
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  if (button && event.currentTarget.contains(button)) stopInsertInteraction(event);
};
const rowInsertCaptureEvents = {
  onPointerDownCapture: stopRowInsertCapture,
  onMouseDownCapture: stopRowInsertCapture,
  onDoubleClickCapture: stopRowInsertCapture
};

interface Column {
  uuid: string;
  display_name: string;
  data_name: string;
  data_type: string;
  style?: {
    color?: string;
    font_size?: number;
    width?: number;
  };
  tooltip?: string;
  memo_text?: string;
  default_value?: string;
  interface_origin?: string;
  interface_origin_name_fallback?: string;
  reference_config?: any;
}

export interface AdvancedHeaderCellProps {
  versionBadge?: React.ReactNode;
  filterButton?: React.ReactNode;
  column: Column;
  columnIndex: number;
  tableUuid: string;
  onInsertLeft: (columnIndex: number) => void;
  onInsertRight: (columnIndex: number) => void;
  onEdit: () => void;
  isUpdating: boolean;
  insertAllowed?: boolean;
  interfaceMap?: Record<string, string>; // Interface UUID -> Name mapping (for display)
}

/** Compact provenance, shared by normal and transposed field headers. */
export function interfaceOriginLabel(column: Pick<Column, 'interface_origin' | 'interface_origin_name_fallback'>, interfaceMap: Record<string, string>): string {
  if (!column.interface_origin) return '';
  return interfaceMap[column.interface_origin]
    || (column.interface_origin_name_fallback
      ? t('grid.deletedInterface', { name: column.interface_origin_name_fallback })
      : t('grid.unknownInterface', { id: column.interface_origin.substring(0, 8) }));
}

export const createAdvancedHeaderCell = ({
  column,
  columnIndex,
  tableUuid: _tableUuid,
  onInsertLeft,
  onInsertRight,
  onEdit,
  isUpdating,
  insertAllowed = true,
  versionBadge,
  filterButton,
  interfaceMap = {}
}: AdvancedHeaderCellProps) => {
  return (
    <InsertionHeader
      className={`rdg-advanced-column flex items-center justify-center h-full relative group cursor-grab ${versionBadge ? 'rdg-header-with-version' : ''}`}
      data-insert-allowed={insertAllowed}
      // Disable header text selection. Otherwise the header name is captured
      // as a text drag first, preventing column drag reordering from starting.
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
    >
      {/* Keep origin separate from the display label; hover reveals the data identifier. */}
      <button type="button" className="rdg-header-labels" title={settingsTooltip(column.uuid, column.tooltip || '') || `${settingsDisplayLabel(column.uuid, column.display_name || column.data_name)} (${column.data_name})`}
        disabled={isUpdating}
        onClick={event => { event.stopPropagation(); if (event.detail === 0) onEdit(); }}
        onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); if (!isUpdating) onEdit(); }}
        onKeyDown={event => event.stopPropagation()}>
        {column.interface_origin && <span className="rdg-interface-origin-label" title={interfaceOriginLabel(column, interfaceMap)}>
          {interfaceOriginLabel(column, interfaceMap)}
        </span>}
        <span className="rdg-field-display-label">{settingsDisplayLabel(column.uuid, column.display_name || column.data_name)}</span>
      </button>
      {filterButton && <div className="rdg-column-filter-slot">{filterButton}</div>}
      {versionBadge && <div className="rdg-column-version-badge">{versionBadge}</div>}

      {insertAllowed && (['left', 'right'] as const).map(position => <div
        key={position} className={`rdg-column-insert-control rdg-column-insert-${position === 'left' ? 'start' : 'end'}`}>
        <button type="button" {...insertButtonEvents} className="rdg-boundary-button"
          title={t(insertAllowed ? (position === 'left' ? 'grid.addColumnLeft' : 'grid.addColumnRight') : 'table.edit.structureBlocked')}
          disabled={isUpdating || !insertAllowed}
          onClick={event => { event.stopPropagation(); if (event.detail < 2) (position === 'left' ? onInsertLeft : onInsertRight)(columnIndex); }}><GridInsertIcon /></button>
      </div>)}
    </InsertionHeader>
  );
};

export interface AdvancedRowCellProps {
  parentIndicator?: React.ReactNode;
  versionBadge?: React.ReactNode;
  row: any;
  rowIndex: number;
  previousRowId?: string;
  isLastVisibleRow: boolean;
  isFirstVisibleRow?: boolean;
  onContextMenu: (e: React.MouseEvent, rowIndex: number) => void;
  onDoubleClick: (e: React.MouseEvent, rowIndex: number) => void;
  onInsertAbove: (rowIndex: number) => void;
  onInsertBelow: (rowIndex: number) => void;
  isUpdating: boolean;
  insertAllowed?: boolean;
  editAllowed?: boolean;
  onRowResize?: (rowId: string, height: number) => void;
  onRowResizeEnd?: () => void;
}

export const createAdvancedRowCell = ({
  row,
  rowIndex,
  previousRowId,
  isLastVisibleRow,
  isFirstVisibleRow = false,
  onContextMenu,
  onDoubleClick,
  onInsertAbove,
  onInsertBelow,
  isUpdating,
  insertAllowed = true,
  editAllowed = true,
  onRowResize,
  onRowResizeEnd,
  versionBadge, parentIndicator
}: AdvancedRowCellProps) => {
  return (
    <div 
      className="rdg-advanced-row flex items-center justify-between px-2 h-full group relative cursor-pointer select-none"
      data-row-id={row.rowId}
      title={!editAllowed ? t('table.edit.structureBlocked') : undefined}
      style={{ paddingInline: '28px', position: 'relative' }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, rowIndex);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (editAllowed) onDoubleClick(e, rowIndex);
      }}
    >
      {/* The frozen corner owns the first boundary, avoiding header clipping. */}
      {insertAllowed && !isFirstVisibleRow && <div
        className="rdg-row-insert-control rdg-row-insert-top"
        style={{ zIndex: 2000 }}
        {...rowInsertCaptureEvents}
      >
        <button
          type="button"
          {...insertButtonEvents}
          onClick={(e) => {
            e.stopPropagation();
            if (e.detail > 1) return;
            onInsertAbove(rowIndex);
          }}
          className="w-5 h-5 flex items-center justify-center"
          title={t(insertAllowed ? 'grid.addRowAbove' : 'table.edit.structureBlocked')}
          disabled={isUpdating || !insertAllowed}
        >
          <GridInsertIcon />
        </button>
      </div>}
      
      {/* Row number and label */}
      <span className="text-xs text-muted-foreground mr-2">{formatNumber(rowIndex + 1)}</span>
      <span 
        className="font-medium flex-1 text-center truncate"
        title={row.rowLabel}
      >
        {row.rowLabel}
      </span>
      
      {parentIndicator}{versionBadge}

      {/* The next visible row's top button exclusively owns the boundary between rows. */}
      {insertAllowed && isLastVisibleRow && <div
        className="rdg-row-insert-control rdg-row-insert-bottom"
        style={{ zIndex: 2000 }}
        {...rowInsertCaptureEvents}
      >
        <button
          type="button"
          {...insertButtonEvents}
          onClick={(e) => {
            e.stopPropagation();
            if (e.detail > 1) return;
            onInsertBelow(rowIndex);
          }}
          className="w-5 h-5 flex items-center justify-center"
          title={t(insertAllowed ? 'grid.addRowBelow' : 'table.edit.structureBlocked')}
          disabled={isUpdating || !insertAllowed}
        >
          <GridInsertIcon />
        </button>
      </div>}
      
      {/* Row resize handle */}
      {onRowResize && (
        <RowResizeHandle
          rowId={row.rowId}
          previousRowId={previousRowId}
          onRowResize={onRowResize}
          onRowResizeEnd={onRowResizeEnd}
        />
      )}
    </div>
  );
};
