import { useI18n, formatNumber } from '@/app/i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AddRowIcon, AddColumnIcon, TableSettingsIcon } from './TableActionIcons';
import './DataGridToolbar.css';
import { VersionViewControls } from './VersionControls';
import { TableSearchBar } from './TableSearchBar';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu';

export interface TableSettingsActivation {
  activate: () => void;
  cancel: () => void;
}

/** Keep one initially enabled pointer gesture clickable while its blur commit runs. */
function TableSettingsButton({ disabled, onOpen, prepare, children }: {
  disabled: boolean;
  onOpen: () => void;
  prepare?: () => TableSettingsActivation | undefined;
  children: React.ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const gesture = useRef<{ pointerId: number; action: TableSettingsActivation; cancelled: boolean } | null>(null);
  const [holdingActivation, setHoldingActivation] = useState(false);
  const cancel = useCallback(() => {
    if (gesture.current) {
      gesture.current.action.cancel();
      // Retain the canceled pointer until its release/click, so Escape cannot
      // fall through to an ordinary open if the write has just settled.
      gesture.current.cancelled = true;
    }
    setHoldingActivation(false);
  }, []);
  useEffect(() => {
    const release = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      // A matching release inside the button is followed by its ordinary click.
      // Do not disable the button between that release and click.
      if (event.type === 'pointercancel' || !(event.target instanceof Node) || !button.current?.contains(event.target)) { cancel(); gesture.current = null; }
    };
    const nextPointer = () => { if (gesture.current) { cancel(); gesture.current = null; } };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('pointerdown', nextPointer, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('pointerdown', nextPointer, true);
      window.removeEventListener('blur', cancel);
      gesture.current?.action.cancel();
    };
  }, [cancel]);
  return <button ref={button} type="button" disabled={disabled && !holdingActivation}
    onPointerDown={event => {
      if (disabled || event.button !== 0) return;
      const action = prepare?.();
      if (action) { gesture.current = { pointerId: event.pointerId, action, cancelled: false }; setHoldingActivation(true); }
    }}
    onKeyDown={event => {
      if (event.key === 'Escape') { cancel(); event.preventDefault(); }
      else if ((event.key === 'Enter' || event.key === ' ') && gesture.current) cancel();
    }}
    onClick={event => {
      const current = gesture.current;
      if (event.detail === 0) {
        // Keyboard/assistive activation is separate from a held pointer. It
        // never consumes that pointer's commit exception or queues behind it.
        if (current) cancel();
        if (!disabled) onOpen();
        return;
      }
      gesture.current = null; setHoldingActivation(false);
      if (current) { if (!current.cancelled) current.action.activate(); }
      else if (!disabled) onOpen();
    }}
    className="inline-flex h-[38px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:opacity-50">
    {children}
  </button>;
}

interface DataGridToolbarProps {
  onOpenTableSettings?: () => void;
  prepareTableSettingsActivation?: () => TableSettingsActivation | undefined;
  addRowsAllowed: boolean;
  addColumnsAllowed: boolean;
  versionEditMode?: boolean;
  onVersionEditModeChange?: (enabled: boolean) => void;
  versionPreview?: boolean;
  onVersionPreviewChange?: (enabled: boolean) => void;
  releaseVersion?: number;
  onReleaseVersionChange?: (version: number) => void;
  versionControlsDisabled?: boolean;
  transposed?: boolean;
  onTransposeChange?: (transposed: boolean) => void;
  // Search props
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onSearch: (query: string) => void;
  onClear: () => void;
  isSearching: boolean;
  filteredRowCount: number;
  
  // Undo/Redo props
  canUndo?: boolean;
  canRedo?: boolean;
  undo: () => void;
  redo: () => void;
  
  // Add row/column props
  addRow: () => void;
  addRows: () => void;
  addColumn: () => void;
  isUpdating: boolean;
  
  // Status props
  isSaving: boolean;
  pendingChangesCount: number;
  
  // Data info
  rowCount: number;
  columnCount: number;
  
  // Zoom props
  zoomLevel?: number;
  setZoomLevel?: (level: number) => void;
  
}

export const DataGridToolbar: React.FC<DataGridToolbarProps> = ({
  onOpenTableSettings,
  prepareTableSettingsActivation,
  addRowsAllowed,
  addColumnsAllowed,
  versionEditMode = false,
  onVersionEditModeChange = () => {},
  versionPreview = false,
  onVersionPreviewChange = () => {},
  releaseVersion = 0,
  onReleaseVersionChange = () => {},
  versionControlsDisabled = false,
  transposed = false,
  onTransposeChange,
  searchQuery,
  setSearchQuery,
  onSearch,
  onClear,
  isSearching,
  filteredRowCount,
  canUndo = false,
  canRedo = false,
  undo,
  redo,
  addRow,
  addRows,
  addColumn,
  isUpdating,
  isSaving,
  pendingChangesCount,
  rowCount,
  columnCount,
  zoomLevel = 100,
  setZoomLevel
}) => {
  const { t } = useI18n();
  // Commands retain their data meaning; the symbols follow the visible axes.
  const RowIcon = transposed ? AddColumnIcon : AddRowIcon;
  const ColumnIcon = transposed ? AddRowIcon : AddColumnIcon;
  return (
    <div className="flex w-full min-w-fit items-center gap-2 px-3 py-2 border-b border-border bg-background/80 backdrop-blur-sm">
      {/* Search Bar */}
      <TableSearchBar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onSearch={onSearch}
        onClear={onClear}
      />
      
      {/* Undo/Redo buttons */}
      <div className="flex h-[38px] shrink-0 items-center bg-muted rounded-lg p-0.5">
        <button
          disabled={!canUndo || isUpdating}
          onClick={undo}
          className="group p-2 rounded-md enabled:hover:bg-background enabled:hover:shadow-sm transition-all duration-200 enabled:active:scale-95 disabled:opacity-30 disabled:cursor-default"
          title={t('grid.undoShortcut')}
        >
          <svg className="w-4 h-4 text-muted-foreground group-enabled:group-hover:text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
        </button>
        <div className="w-px h-5 bg-secondary"></div>
        <button
          disabled={!canRedo || isUpdating}
          onClick={redo}
          className="group p-2 rounded-md enabled:hover:bg-background enabled:hover:shadow-sm transition-all duration-200 enabled:active:scale-95 disabled:opacity-30 disabled:cursor-default"
          title={t('grid.redoShortcut')}
        >
          <svg className="w-4 h-4 text-muted-foreground group-enabled:group-hover:text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10h-10a8 8 0 00-8 8v2m18-10l-6 6m6-6l-6-6" />
          </svg>
        </button>
      </div>

      {/* Add Row/Column buttons */}
      <div className="flex shrink-0 items-center gap-2">
        <ContextMenu>
        <ContextMenuTrigger asChild data-context-menu disabled={isUpdating || !addRowsAllowed}>
        <button
          type="button"
          onKeyDown={event => {
            if (isUpdating || !addRowsAllowed || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
          }}
          onClick={addRow}
          disabled={isUpdating || !addRowsAllowed}
          className={`group flex h-[38px] w-[38px] shrink-0 items-center justify-center p-2 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${
            isUpdating 
              ? 'bg-muted text-muted-foreground cursor-not-allowed border border-transparent'
              : `bg-background border border-border text-foreground hover:bg-muted hover:border-border hover:shadow-sm active:scale-95 ${
                  rowCount === 0 ? 'beginner-hint-pulse' : ''
                }`
          }`}
          title={!addRowsAllowed ? t('table.edit.rowsBlocked') : isUpdating ? t('grid.processing') : (rowCount === 0 ? t('grid.addFirstRow') : t('grid.addRow'))}
        >
          <RowIcon className={`w-5 h-5 ${isUpdating ? 'text-muted-foreground' : 'text-muted-foreground group-hover:text-foreground'}`} />
        </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={isUpdating || !addRowsAllowed} onSelect={() => {
            if (!isUpdating && addRowsAllowed) addRows();
          }}>{t('grid.bulk.add')}</ContextMenuItem>
        </ContextMenuContent>
        </ContextMenu>
        <button
          onClick={addColumn}
          disabled={isUpdating || !addColumnsAllowed}
          className={`group flex h-[38px] w-[38px] shrink-0 items-center justify-center p-2 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${
            isUpdating 
              ? 'bg-muted text-muted-foreground cursor-not-allowed border border-transparent'
              : `bg-background border border-border text-foreground hover:bg-muted hover:border-border hover:shadow-sm active:scale-95 ${
                  columnCount === 0 ? 'beginner-hint-pulse' : ''
                }`
          }`}
          title={!addColumnsAllowed ? t('table.edit.columnsBlocked') : isUpdating ? t('grid.processing') : (columnCount === 0 ? t('grid.addFirstColumn') : t('grid.addColumn'))}
        >
          <ColumnIcon className={`w-5 h-5 ${isUpdating ? 'text-muted-foreground' : 'text-muted-foreground group-hover:text-foreground'}`} />
        </button>
      </div>

      {onOpenTableSettings && <TableSettingsButton onOpen={onOpenTableSettings} prepare={prepareTableSettingsActivation}
        disabled={isUpdating || versionControlsDisabled}>
        <TableSettingsIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <span>{t('table.edit.settings')}</span>
      </TableSettingsButton>}
      {/* Status display */}
      <div className="ms-auto flex shrink-0 items-center gap-2">
        {/* Search results */}
        {isSearching && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-accent text-primary rounded-lg">
            <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-primary/30 border-t-primary"></div>
            <span className="text-sm font-medium">{t('grid.searching')}</span>
          </div>
        )}
        {searchQuery.trim() && !isSearching && (
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-1.5 bg-green-50 text-green-600 rounded-lg">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span className="text-sm font-medium">{t('grid.filterSort.resultCount', { count: formatNumber(filteredRowCount), total: formatNumber(rowCount) })}</span>
          </div>
        )}
        
        {/* Reserve save-status geometry so busy transitions cannot move row controls. */}
        <div
          aria-hidden={!isSaving}
          aria-label={t('grid.saving')}
          title={t('grid.saving')}
          className={`grid-save-status flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-1.5 bg-accent text-primary rounded-lg ${isSaving ? 'visible' : 'invisible'}`}
        >
          <div className={`rounded-full h-3.5 w-3.5 border-2 border-primary/30 border-t-primary ${isSaving ? 'animate-spin' : ''}`}></div>
          <span className="grid-save-label text-sm font-medium">{t('grid.saving')}</span>
        </div>
        {pendingChangesCount > 0 && !isSaving && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 text-amber-600 rounded-lg">
            <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse"></div>
            <span className="text-sm font-medium">{t('grid.unsavedCount', { count: pendingChangesCount })}</span>
          </div>
        )}
        {setZoomLevel && <VersionViewControls
          edit={versionEditMode}
          preview={versionPreview}
          releaseVersion={releaseVersion}
          onEditChange={onVersionEditModeChange}
          onPreviewChange={onVersionPreviewChange}
          onReleaseVersionChange={onReleaseVersionChange}
          zoomLevel={zoomLevel}
          setZoomLevel={setZoomLevel}
          disabled={versionControlsDisabled}
          transposed={transposed}
          onTransposeChange={onTransposeChange}
          labels={{
            view: t('menu.view'), viewSettings: t('menu.view'),
            zoom: t('grid.version.zoom'), adjustZoom: t('grid.adjustZoom'),
            versionEdit: t('grid.editVersion'), exitVersionEdit: t('grid.version.exit'),
            preview: t('grid.version.preview'), releaseVersion: t('grid.version.release'),
            invalidVersion: t('grid.version.invalid'), transpose: t('grid.transpose')
          }}
        />}
      </div>
    </div>
  );
};

// CSS for beginner hint animation
const styles = `
.beginner-hint-pulse {
  animation: hint-pulse 2s ease-in-out infinite;
}

@keyframes hint-pulse {
  0%, 100% {
    opacity: 1;
    box-shadow: 0 0 0 0 hsl(var(--primary) / 0);
  }
  50% {
    opacity: 0.9;
    box-shadow: 0 0 0 5px hsl(var(--primary) / 0.3);
  }
}
`;

// Inject styles
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = styles;
  document.head.appendChild(styleElement);
}

