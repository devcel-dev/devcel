import { DescriptionEditor } from './DescriptionEditor';
import { canRefreshGridError } from '@/app/utils/errorRecovery';
import { useTableHistory } from './useTableHistory';
import { FormulaCompletionProvider } from '@/app/components/formula/FormulaCompletionProvider';
import { registerProjectSaveParticipant } from '@/app/utils/projectSaveParticipants';
import { hasBlockingShortcutSurface, isComposingKey } from '@/app/utils/shortcutGuards';
import { canCommitEditor } from '@/lib/react-data-grid/utils';
import { useSelectAll } from '@/app/utils/useSelectAll';
import { rangeBarStyle } from '@/app/utils/rangeBarStyle';
import { getLocaleDirection } from '@/app/i18n';
import { normalizeTableData } from '@/app/types/tableTypes';
import { HeaderDescription } from '@/lib/react-data-grid/HeaderDescription';
import { GridInsertIcon } from './GridInsertIcon';
import { publishTableDisplayName } from '@/app/commands/tableCommands';
import { recordDisplayLabel, recordReferenceLabel } from '@/app/utils/recordDisplayLabel';
import { filterMetadataRows } from './gridMetadata';
import { settingsDisplayLabel, settingsTooltip } from '@/app/settings/displayLabels';
import { getTableSnapshotInvalidationVersion } from '@/app/services/tableSnapshotInvalidation';
import { ColorCell } from './ColorCell';
import { isColorType } from '@/app/components/color/colorDisplay';
import { showColorPicker } from '@/app/utils/color_picker_window';
import type { AuthoritativeTableSnapshot } from '@/app/services/tableSnapshotCache';
import { captureTableInteractionScope, isTableInteractionScopeCurrent, isTableInteractionAllowed, registerTableNavigationBlocker } from '@/app/services/tableInteractionScope';
import type { ReferenceNavigationRequest } from '../../referenceNavigation';
import { useI18n, message, localizeError, localizedError, formatNumber } from '@/app/i18n';
import { gridErrorNotice, resolveGridError } from './gridErrorNotice';
import { createGridDisplayModel, type GridDisplayModel } from './gridDisplayModel';
import { GridColumnFilterButton, GridSortDialog } from './GridFilterSortControls';
import { filterSortRows, type ColumnFilter, type SortLevel } from './gridFilterSort';
import { useGridSortLabels } from './useGridSortLabels';
import { useGridFilterSortState } from './useGridFilterSortState';
import { createTransposedRows, createTransposedColumns, createTransposedWidthResolver } from './gridTransposeView';
import { RowResizeHandle } from './RowResizeHandle';
import { parseClipboardTsv, serializeClipboardTsv } from './gridClipboard';
import { writeGridClipboard, literalClipboardValue, type ClipboardCell } from './gridClipboardPayload';
import { GridCommandDialog, type GridCommandRequest, type ReplaceCell } from './GridCommandDialog';
import React, { useCallback, useState, useEffect, useLayoutEffect, useRef, useMemo, useContext, createContext, memo } from 'react';
import { DataGrid, RenderCellProps, Column as DataGridColumn, CellRange, RowsChangeData, DataGridHandle, DataGridProps, RowIndicatorConfig, RenderEditCellProps } from '@/lib/react-data-grid';
import { invoke } from '@tauri-apps/api/core';
import { Maximize2 } from 'lucide-react';
import { showStringEditor } from '@/app/utils/string_editor_window';
import { MetadataEditDialog, type MetadataOwner } from './MetadataEditDialog';
import { TableEditSettingsDialog, type EditSettingsOwner } from './TableEditSettingsDialog';
import { DataGridToolbar, type TableSettingsActivation } from './DataGridToolbar';
import { VersionBadge } from './VersionControls';
import { ColumnEditor } from '@/app/components/column-editor/ColumnEditor';
import type { ColumnEditorTarget } from '@/app/components/column-editor/types';
import { initialHeaderWidth } from './initialHeaderWidth';
import { useDataGridColumnWidth } from './useDataGridColumnWidth';
import { useDataGridRowHeight } from './useDataGridRowHeight';
import { DataGridContextMenu } from './DataGridContextMenu';
import { InsertionHeader, createAdvancedHeaderCell, interfaceOriginLabel, createAdvancedRowCell } from './DataGridAdvancedCells';
import { InlineEditDialog } from './DataGridInlineDialogs';
import type { Column, TableRecord, TableData } from '@/app/types/tableTypes';
import { getEffectiveCellValue, hasLocalCellValue } from '@/app/types/tableTypes';
import { ReferenceCellRenderer, ReferenceCellEditor } from './ReferenceCell';
import { TableRefCellRenderer, TableRefCellEditor } from './TableRefCell';
import { CurveCellRenderer, CurveCellEditor } from './CurveCell';
import { SelectCellRenderer, SelectCellEditor } from './SelectCell';
import { InterfaceDialog } from '@/app/components/interface/InterfaceDialog';
import { isDefaultColumnColor, getContrastingTextColor } from './DataGridDynamicStyles';
import { useTablePresentation } from './useTablePresentation';
import { useTableMutation } from './useTableMutation';
import { showBulkRowDialog } from '@/app/utils/bulk_row_dialog';
import { type CellPresentation, type TableMutation, type RecordDraft, type MutationResult } from '@/app/types/tableRules';

// CSS import for react-data-grid
import '@/lib/react-data-grid/style/layers.css';
import './DataGridView.css';

// Helper function to darken a hex color
function darkenColor(hex: string, percent: number): string {
  // Remove # if present
  hex = hex.replace('#', '');

  // Convert to RGB
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  // Darken each component
  const newR = Math.max(0, Math.floor(r * (1 - percent)));
  const newG = Math.max(0, Math.floor(g * (1 - percent)));
  const newB = Math.max(0, Math.floor(b * (1 - percent)));

  // Convert back to hex
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(newR)}${toHex(newG)}${toHex(newB)}`;
}

// Helper function to blend two colors
function blendColors(color1: string, color2: string, weight: number): string {
  // Remove # if present
  color1 = color1.replace('#', '');
  color2 = color2.replace('#', '');

  // Convert to RGB
  const r1 = parseInt(color1.substring(0, 2), 16);
  const g1 = parseInt(color1.substring(2, 4), 16);
  const b1 = parseInt(color1.substring(4, 6), 16);

  const r2 = parseInt(color2.substring(0, 2), 16);
  const g2 = parseInt(color2.substring(2, 4), 16);
  const b2 = parseInt(color2.substring(4, 6), 16);

  // Blend
  const r = Math.round(r1 * (1 - weight) + r2 * weight);
  const g = Math.round(g1 * (1 - weight) + g2 * weight);
  const b = Math.round(b1 * (1 - weight) + b2 * weight);

  // Convert back to hex
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Types are imported from @/app/types/tableTypes

interface SettingsActivationScope { projectSessionId: string; tableUuid: string }
interface SettingsInlineCommit {
  result?: Promise<boolean>;
  owner: EditSettingsOwner | null;
}
interface SettingsIntent {
  scope: SettingsActivationScope;
  interactionOwner: number;
  cancelled: boolean;
  commit: SettingsInlineCommit | null;
}

interface DataGridViewProps {
  projectSessionId: string;
  tableData: TableData;
  preparedSnapshot?: AuthoritativeTableSnapshot;
  onAuthoritativeSnapshot?: (snapshot: AuthoritativeTableSnapshot) => void;
  interactionLocked?: boolean;
  tableName: string;
  versionEditMode?: boolean;
  onVersionEditModeChange?: (enabled: boolean) => void;
  versionPreview?: boolean;
  onVersionPreviewChange?: (enabled: boolean) => void;
  releaseVersion?: number;
  onReleaseVersionChange?: (version: number) => void;
  onDataChange?: (data: TableData) => void;
  onOpenReference?: (targetTableUuid: string, recordUuid: string) => void;
  referenceNavigation?: ReferenceNavigationRequest;
  onReferenceNavigationHandled?: (request: ReferenceNavigationRequest) => void;
}

// Define the row type for the grid
export interface GridRow {
  rowId: string;
  rowLabel: string;
  rowIndex: number;
  tableRecord?: TableRecord;
  columnDefs?: Column[];
  cellPresentations?: Record<string, CellPresentation>;
  [key: string]: any;
}


const GridTransientLockContext = createContext(false);
type HeaderRenderer = (column: Column, columnIndex: number) => React.ReactNode;
const GridHeaderRuntimeContext = createContext<HeaderRenderer | null>(null);
const GridIndicatorRuntimeContext = createContext<RowIndicatorConfig<GridRow>['renderIndicator']>(undefined);
const GridReferenceRuntimeContext = createContext<{ tableData: TableData; refreshVersion: number } | null>(null);

function RuntimeHeader({ column, columnIndex }: { column: Column; columnIndex: number }) {
  return useContext(GridHeaderRuntimeContext)!(column, columnIndex);
}
function RuntimeIndicator(props: Parameters<NonNullable<RowIndicatorConfig<GridRow>['renderIndicator']>>[0]) {
  return useContext(GridIndicatorRuntimeContext)!(props);
}
function RuntimeReferenceCell(props: React.ComponentProps<typeof ReferenceCellRenderer>) {
  const runtime = useContext(GridReferenceRuntimeContext)!;
  return <ReferenceCellRenderer {...props} tableData={runtime.tableData} refreshVersion={runtime.refreshVersion} />;
}
function RuntimeReferenceEditor(props: RenderEditCellProps<GridRow> & { columnData: Column; tableUuid: string; expectedProjectSession: string }) {
  const runtime = useContext(GridReferenceRuntimeContext)!;
  return <ReferenceCellEditor {...props} tableData={runtime.tableData} refreshVersion={runtime.refreshVersion} />;
}

/** Event identity stays stable; render data is never read from this ref. */
function useCommittedEvent<T extends (...args: any[]) => any>(handler: T): T {
  const current = useRef(handler);
  useLayoutEffect(() => { current.current = handler; });
  return useCallback(((...args: Parameters<T>) => current.current(...args)) as T, []);
}

// Custom cell renderer for boolean values with click-to-toggle functionality
const BooleanCellRenderer = memo(({ row, column, tabIndex, onRowChange, readOnly }: RenderCellProps<GridRow> & { readOnly: boolean }) => {
  const disabled = useContext(GridTransientLockContext);
  const value = row[column.key];
  const checked = value === 'true' || value === true;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    onRowChange({ ...row, [column.key]: (!checked).toString() });
  };

  return (
    <div className="flex items-center justify-center h-full">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled || readOnly}
        onChange={handleChange}
        tabIndex={tabIndex}
        className="rdg-checkbox cursor-pointer"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
});


// Values, defaults, formulas and conditional styles all come from the same Rust snapshot.
/** Presentation only: stored inputs, row data, and clipboard values stay canonical. */
function localizedNumericDisplay(value: string, dataType: string): string {
  if (/^[IU](8|16|32|64)$/.test(dataType) && /^[+-]?\d+$/.test(value)) {
    // Rust's 64-bit integers exceed Number's exact range. Never round through Number.
    try { return formatNumber(BigInt(value)); } catch { return value; }
  }
  if ((dataType === 'F32' || dataType === 'F64') && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      const magnitude = Math.abs(number);
      return formatNumber(number, {
        maximumSignificantDigits: 21,
        notation: magnitude !== 0 && (magnitude >= 1e21 || magnitude < 1e-6) ? 'scientific' : 'standard',
      });
    }
  }
  return value;
}

// Define base colors by data type; data_type is canonicalized by the core
const dataTypeColors: Record<string, string> = {
  // Numeric types - light blue
  'U8': '#e3f2fd',
  'I8': '#e3f2fd',
  'U16': '#e3f2fd',
  'I16': '#e3f2fd',
  'U32': '#e3f2fd',
  'I32': '#e3f2fd',
  'U64': '#e3f2fd',
  'I64': '#e3f2fd',
  'F32': '#e3f2fd',
  'F64': '#e3f2fd',
  // String type - white
  'String': '#ffffff',
  // Boolean type - light yellow
  'Boolean': '#fffde7',
  // Reference type - light green
  'Reference': '#e8f5e8',
  // Select type - light purple
  'Select': '#f3e5f5',
  // DateTime type - light orange
  'DateTime': '#fff3e0',
  // Color type - light gray
  'Color32': '#fafafa',
  'ColorFloat': '#fafafa',
  // Curve type - light gray
  'Curve': '#f5f5f5'
};

// Helper function to get data type class name
const getDataTypeClassName = (dataType: string): string => {
  switch (dataType) {
    case 'Boolean':
      return 'rdg-cell-type-boolean';
    case 'U8':
    case 'I8':
    case 'U16':
    case 'I16':
    case 'U32':
    case 'I32':
    case 'U64':
    case 'I64':
    case 'F32':
    case 'F64':
      return 'rdg-cell-type-number';
    case 'Reference':
      return 'rdg-cell-type-reference';
    case 'Curve':
      return 'rdg-cell-type-curve';
    case 'String':
    default:
      return 'rdg-cell-type-string';
  }
};

const getGridCellBackgroundColor: NonNullable<DataGridProps<GridRow>['getCellBackgroundColor']> = (row, column, state) => {
  const cell = row.cellPresentations?.[column.key];
  const barBackground = rangeBarStyle(cell?.range_bar, getLocaleDirection())?.backgroundColor;
  if (barBackground) return barBackground;
  const conditional = cell?.style.background_color;
  if (conditional) return conditional;

  // Built-in type tints follow the selected theme. Explicit column and cell
  // colors remain data-owned and retain their existing rendering semantics.
  const customBackground = column.customStyles?.backgroundColor;
  if (!customBackground || customBackground === 'transparent') {
    const tint = dataTypeColors[column.dataType || ''];
    const surface = !tint || column.dataType === 'String'
      ? 'hsl(var(--background))'
      : `color-mix(in srgb, hsl(var(--background)) 75%, ${tint})`;
    if (state.isSelected) {
      return `color-mix(in srgb, ${surface} 65%, hsl(var(--${state.isHovered ? 'secondary' : 'accent'})))`;
    }
    if (state.isHovered || !state.isEvenRow) {
      return `color-mix(in srgb, ${surface} ${state.isHovered ? '70%' : '85%'}, hsl(var(--muted)))`;
    }
    return surface;
  }

  // Determine the base color from the data type or custom color
  let baseColor = dataTypeColors[column.dataType || ''] || '#ffffff';

  // Override the data type color if a custom column color exists
  if (column.customStyles?.backgroundColor &&
      column.customStyles.backgroundColor !== 'transparent') {
    baseColor = column.customStyles.backgroundColor;
  }

  // Apply alternating row colors first, slightly darkening odd rows
  if (!state.isEvenRow) {
    if (baseColor === '#ffffff') {
      baseColor = '#f9f9f9';
    } else if (baseColor === '#e3f2fd') {
      baseColor = '#d7ecfd';
    } else if (baseColor === '#fffde7') {
      baseColor = '#fffbd0';
    } else if (baseColor === '#e8f5e8') {
      baseColor = '#e0f2e0';
    } else if (baseColor === '#f5f5f5') {
      baseColor = '#eeeeee';
    } else {
      // Darken custom colors by 5%
      baseColor = darkenColor(baseColor, 0.05);
    }
  }

  // Priority 1: Selection state, blended with the base color
  if (state.isSelected) {
    // Blend 20% selection color with 80% base color
    const selectionColor = state.isHovered ? '#D9E2E5' : '#EEF1F3';
    return blendColors(baseColor, selectionColor, 0.2);
  }

  // Priority 2: Hover state when not selected
  if (state.isHovered) {
    // Slightly darken the base color on hover
    return darkenColor(baseColor, 0.08);
  }

  // Return the unchanged base color
  return baseColor;
};
const gridRowKeyGetter = (row: GridRow) => row.rowId;

const StringExpandButton = ({ row, definition, onExpand, readOnly }: {
  readOnly: boolean;
  row: GridRow; definition: Column; onExpand: (row: GridRow, column: Column) => void;
}) => {
  const disabled = useContext(GridTransientLockContext);
  const { t } = useI18n();
  return <button type="button" className="rdg-string-expand" tabIndex={-1} disabled={disabled || readOnly}
    aria-label={t('grid.stringExpand')} title={t(readOnly ? 'table.edit.cellsBlocked' : 'grid.stringExpandHint')}
    onMouseDown={event => event.preventDefault()}
    onClick={event => { event.preventDefault(); event.stopPropagation(); if (!disabled) onExpand(row, definition); }}>
    <Maximize2 size={13} />
  </button>;
};

// Plain display content belongs directly to the gridcell host. Keeping this a
// pure renderer avoids a component and a layout wrapper for every visible cell.
function renderFormulaContent(value: unknown, cell: CellPresentation | undefined,
  definition: Column, numeric: boolean, expandButton?: React.ReactNode) {
  const canonicalDisplay = cell?.display_value ?? String(value || (numeric ? '0' : ''));
  const display = numeric && !cell?.formula_error
    ? localizedNumericDisplay(canonicalDisplay, definition.data_type) : canonicalDisplay;
  if (definition.data_type !== 'String') return display;
  const firstBreak = display.search(/[\r\n]/);
  const preview = firstBreak < 0 ? display : `↵ ${display.slice(0, firstBreak)}`;
  return expandButton ? <><span className="rdg-string-selected-text">{preview}</span>{expandButton}</> : preview;
}

// Right-side table padding in unscaled pixels, keeping the last column away from the edge.
const TRAILING_MARGIN = 40;
// During column resizing, start auto-scrolling when the pointer comes within this distance of the right edge, in unscaled pixels.
const AUTO_SCROLL_EDGE = 48;
// Maximum auto-scroll distance per frame, in pixels.
const AUTO_SCROLL_MAX_SPEED = 24;

// Default column widths by data type; data_type is canonicalized by the core
const getDefaultColumnWidth = (dataType: string): number => {
  switch (dataType) {
    case 'Boolean':
      return 60;
    case 'U8':
    case 'I8':
    case 'U16':
    case 'I16':
    case 'U32':
    case 'I32':
    case 'U64':
    case 'I64':
    case 'F32':
    case 'F64':
      return 90;
    case 'Color32':
    case 'ColorFloat':
      return 190;
    case 'DateTime':
      return 160;
    case 'String':
      return 180;
    case 'Reference':
    case 'Select':
    case 'Curve':
    default:
      return 120;
  }
};

const DataGridView: React.FC<DataGridViewProps> = ({
  projectSessionId,
  tableData: incomingTableData,
  preparedSnapshot,
  onAuthoritativeSnapshot,
  interactionLocked = false,
  tableName,
  versionEditMode = false,
  onVersionEditModeChange = () => {},
  versionPreview = false,
  onVersionPreviewChange = () => {},
  releaseVersion = 0,
  onReleaseVersionChange = () => {},
  onDataChange,
  onOpenReference,
  referenceNavigation,
  onReferenceNavigationHandled
}) => {
  const { locale, t } = useI18n();
  // The translator reads ambient state and keeps its function identity. This
  // snapshot makes locale changes invalidate memoized labels and renderers.
  const translation = useMemo(() => ({ locale, t }), [locale, t]);
  const [tableData, setTableData] = useState(incomingTableData);
  useEffect(() => { setTableData(incomingTableData); }, [incomingTableData]);
  const [referenceRefreshVersion, setReferenceRefreshVersion] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  // This view can be reused when tab order changes without a React remount.
  useLayoutEffect(() => { setSearchQuery(''); }, [projectSessionId, incomingTableData.uuid]);
  const [contextMenu, setContextMenu] = useState<{
    type: 'row' | 'column';
    x: number;
    y: number;
    rowIndex?: number;
    recordUuid?: string;
    columnIndex?: number;
  } | null>(null);
  const repeatOperation = useRef<{ kind: 'fill'; direction: 'down' | 'right' } | { kind: 'clear' } | { kind: 'input'; value: string } | null>(null);
  useLayoutEffect(() => { repeatOperation.current = null; }, [projectSessionId, incomingTableData.uuid]);
  const [structuralHint, setStructuralHint] = useState(false);
  const [gridCommand, setGridCommand] = useState<GridCommandRequest | null>(null);
  useLayoutEffect(() => { setGridCommand(null); }, [projectSessionId, incomingTableData.uuid]);
  const [bulkEditorPending, setBulkEditorPending] = useState<object | null>(null);
  useLayoutEffect(() => { setBulkEditorPending(null); }, [projectSessionId, incomingTableData.uuid]);
  const [selectionRange, setSelectionRange] = useState<CellRange | null>(null);
  const selectedCellIdentity = useRef<{ recordUuid: string; columnUuid: string } | null>(null);
  useLayoutEffect(() => { selectedCellIdentity.current = null; }, [projectSessionId, incomingTableData.uuid]);
  useLayoutEffect(() => { setSelectionRange(null); }, [projectSessionId, tableData.uuid]);
  const [transposed, setTransposed] = useState(incomingTableData.metadata.initial_transposed);
  const [metadataEdit, setMetadataEdit] = useState<MetadataOwner | null>(null);
  const [cellMenu, setCellMenu] = useState<{ row: GridRow; key: string; x: number; y: number } | null>(null);
  useLayoutEffect(() => { setMetadataEdit(null); setCellMenu(null); }, [projectSessionId, incomingTableData.uuid]);
  const [editSettings, setEditSettings] = useState<EditSettingsOwner | null>(null);
  const settingsActivationScope = useMemo(() => ({ projectSessionId, tableUuid: incomingTableData.uuid }),
    [projectSessionId, incomingTableData.uuid]);
  const liveSettingsScope = useRef<SettingsActivationScope | null>(null);
  const preparedSettingsIntent = useRef<SettingsIntent | null>(null);
  const settingsInlineCommit = useRef<SettingsInlineCommit | null>(null);
  const activatedSettingsIntent = useRef<SettingsIntent | null>(null);
  const [settledSettingsIntent, setSettledSettingsIntent] = useState<SettingsIntent | null>(null);
  useLayoutEffect(() => {
    liveSettingsScope.current = settingsActivationScope;
    return () => {
      liveSettingsScope.current = null;
      if (preparedSettingsIntent.current) preparedSettingsIntent.current.cancelled = true;
      preparedSettingsIntent.current = null;
      if (activatedSettingsIntent.current) activatedSettingsIntent.current.cancelled = true;
      activatedSettingsIntent.current = null;
      settingsInlineCommit.current = null;
    };
  }, [settingsActivationScope]);
  // Once its click is delivered, any later input supersedes the pending open.
  // Keep cancellation live across the originating commit and its refresh.
  useEffect(() => {
    const cancelPendingSettings = () => {
      const intent = activatedSettingsIntent.current;
      if (!intent) return;
      intent.cancelled = true;
      activatedSettingsIntent.current = null;
      setSettledSettingsIntent(previous => previous === intent ? null : previous);
    };
    window.addEventListener('pointerdown', cancelPendingSettings, true);
    window.addEventListener('keydown', cancelPendingSettings, true);
    window.addEventListener('blur', cancelPendingSettings);
    return () => {
      window.removeEventListener('pointerdown', cancelPendingSettings, true);
      window.removeEventListener('keydown', cancelPendingSettings, true);
      window.removeEventListener('blur', cancelPendingSettings);
    };
  }, []);
  const settingsIntentIsCurrent = useCallback((intent: SettingsIntent) => !intent.cancelled
    && liveSettingsScope.current === intent.scope
    && isTableInteractionScopeCurrent(intent.scope.projectSessionId, intent.scope.tableUuid, intent.interactionOwner), []);
  const [transposedWidths, setTransposedWidths] = useState<Record<string, number>>({});
  const [transposedHeights, setTransposedHeights] = useState<Record<string, number>>({});
  const transposeScope = useRef({ projectSessionId, tableUuid: incomingTableData.uuid });
  useLayoutEffect(() => {
    if (transposeScope.current.projectSessionId === projectSessionId
      && transposeScope.current.tableUuid === incomingTableData.uuid) return;
    transposeScope.current = { projectSessionId, tableUuid: incomingTableData.uuid };
    setTransposed(incomingTableData.metadata.initial_transposed);
    setEditSettings(null); setTransposedWidths({}); setTransposedHeights({});
  }, [projectSessionId, incomingTableData.uuid, incomingTableData.metadata.initial_transposed]);
  // A saved orientation on the same table is just as authoritative as its first load.
  useLayoutEffect(() => { setTransposed(tableData.metadata.initial_transposed); },
    [projectSessionId, tableData.uuid, tableData.metadata.initial_transposed]);
  const [zoomLevel, setZoomLevel] = useState(100); // Add zoom level state
  const [isUpdating, setIsUpdating] = useState(false);
  const [isResizing, setIsResizing] = useState(false); // Add updating state
  // const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [inlineEditDialog, setInlineEditDialog] = useState<{
    isOpen: boolean;
    type: 'row' | 'column';
    position: { x: number; y: number };
    rowIndex?: number;
    recordUuid?: string;
    columnIndex?: number;
    initialValue: string;
  } | null>(null);
  const [columnEditor, setColumnEditor] = useState<{ target: ColumnEditorTarget; tab?: string } | null>(null);
  const [showInterfaceDialog, setShowInterfaceDialog] = useState(false);
  const [showSortDialog, setShowSortDialog] = useState(false);
  useLayoutEffect(() => { setShowSortDialog(false); }, [projectSessionId, incomingTableData.uuid]);
  const [interfaceMap, setInterfaceMap] = useState<Record<string, string>>({}); // UUID -> Name mapping
  const workspaceRef = useRef<HTMLDivElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null); // Add container ref for zoom
  // Survives keyed DataGrid replacement; resolved child metrics update it before reads.
  const physicalExtentRef = useRef<HTMLDivElement>(null);
  const dataGridRef = useRef<DataGridHandle>(null); // ref for DataGrid component

  useSelectAll(workspaceRef, () => {
    if (isTableInteractionAllowed(projectSessionId, tableData.uuid)) dataGridRef.current?.selectAll();
  }, () => {
    if (!isTableInteractionAllowed(projectSessionId, tableData.uuid)
      || gridContainerRef.current?.querySelector('.rdg-editor-container')) return;
    const input = workspaceRef.current?.querySelector<HTMLInputElement>('[data-table-search]');
    input?.focus(); input?.select();
  });

  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const [operationError, setOperationError] = useState<unknown>(null);
  const lastDeliveredSnapshot = useRef(preparedSnapshot);
  const presentationState = useTablePresentation(tableData, projectSessionId, snapshot => {
    const previous = lastDeliveredSnapshot.current;
    if (previous?.table.display_name !== snapshot.table.display_name) {
      publishTableDisplayName(snapshot.table.uuid, snapshot.table.display_name, projectSessionId);
    }
    lastDeliveredSnapshot.current = snapshot;
    setTableData(snapshot.table);
    setEditSettings(owner => owner?.table.uuid === snapshot.table.uuid
      ? { table: snapshot.table, revision: snapshot.presentation.revision } : owner);
    if (previous?.table !== snapshot.table || previous.presentation !== snapshot.presentation
      || previous.snapshotToken !== snapshot.snapshotToken) {
      setReferenceRefreshVersion(version => version + 1);
    }
    try { onAuthoritativeSnapshot?.(snapshot); onDataChange?.(snapshot.table); }
    catch (e) { setOperationError(gridErrorNotice(message('grid.notifyFailed'), e)); }
  }, preparedSnapshot);
  const { getCurrent: getCurrentPresentation, refresh: refreshPresentation, setPaused: setPresentationPaused,
    isRefreshPending: isPresentationRefreshPending, error: presentationError, cancelled: presentationCancelled } = presentationState;
  const acceptMutation = (result: MutationResult, invalidationVersion: number) => {
    result = { ...result, table: normalizeTableData(result.table) };
    presentationState.accept(result.presentation, result.table, invalidationVersion);
    if (tableData.display_name !== result.table.display_name) {
      publishTableDisplayName(result.table.uuid, result.table.display_name, projectSessionId);
    }
    setTableData(result.table);
    setEditSettings(owner => owner?.table.uuid === result.table.uuid
      ? { table: result.table, revision: result.presentation.revision } : owner);
    setOperationError(null);
    setReferenceRefreshVersion(version => version + 1);
    const committedSnapshot = { ...result, projectSessionId, tableUuid: result.table.uuid,
      snapshotToken: null, retainedBytes: 0, invalidationVersion };
    lastDeliveredSnapshot.current = committedSnapshot;
    onAuthoritativeSnapshot?.(committedSnapshot);
    onDataChange?.(result.table);
    // Only the inline edit that belongs to a prepared settings gesture may
    // supply its successful, authoritative dialog basis.
    if (settingsInlineCommit.current) settingsInlineCommit.current.owner = {
      table: result.table, revision: result.presentation.revision
    };
  };
  const mutation = useTableMutation(tableData.uuid, projectSessionId, acceptMutation);
  const { run, runExclusive, isBusy: isMutationBusy, clearError: clearMutationError } = mutation;
  const runMutation = useCallback(async (...args: Parameters<typeof run>) => {
    const owner = captureTableInteractionScope(projectSessionId, tableData.uuid);
    const committed = await run(...args);
    if (committed && isTableInteractionScopeCurrent(projectSessionId, tableData.uuid, owner)) repeatOperation.current = null;
    return committed;
  }, [run, projectSessionId, tableData.uuid]);
  const runExclusiveMutation = useCallback(async (...args: Parameters<typeof runExclusive>) => {
    const owner = captureTableInteractionScope(projectSessionId, tableData.uuid);
    const committed = await runExclusive(...args);
    if (committed && isTableInteractionScopeCurrent(projectSessionId, tableData.uuid, owner)) repeatOperation.current = null;
    return committed;
  }, [runExclusive, projectSessionId, tableData.uuid]);
  const isSaving = mutation.busy;
  const pendingChanges = mutation.busy ? 1 : 0;
  const previousBusy = useRef(false);
  useEffect(() => {
    if (mutation.busy || interactionLocked) setPresentationPaused(true);
    else if (previousBusy.current) {
      const deferred = setPresentationPaused(false);
      if (deferred || !getCurrentPresentation()) void refreshPresentation({ background: true });
    }
    previousBusy.current = mutation.busy || interactionLocked;
  }, [mutation.busy, interactionLocked, setPresentationPaused, getCurrentPresentation, refreshPresentation]);
  const snapshotReady = presentationState.ready;
  const previewActive = versionEditMode && versionPreview;
  const headerHeight = versionEditMode ? 60 : 35;
  const [atScrollTop, setAtScrollTop] = useState(true);


  const blankMutation = useCallback(async (): Promise<TableMutation> => {
    // A write must use the revision of the snapshot the user actually saw.
    // Never fetch a newer revision here and attach it to older displayed values.
    const presentation = getCurrentPresentation();
    if (!presentation || !isTableInteractionAllowed(projectSessionId, tableData.uuid)) throw localizedError(message('grid.waitForPresentation'));
    return { table_uuid: tableData.uuid, expected_revision: presentation.revision,
      cells: [], versions: [], column_versions: [], create_records: [], delete_record_uuids: [] };
  }, [projectSessionId, tableData.uuid, getCurrentPresentation]);

  const openStringEditor = useCallback((row: GridRow, column: Column) => {
    const presentation = getCurrentPresentation();
    if (!presentation || mutation.busy || column.data_type !== 'String') return;
    // Plain cells are intentionally omitted from the sparse rule presentation.
    // Resolve their stored raw input from the SAME displayed table/revision.
    const definition = tableData.schema.columns.find(candidate => candidate.uuid === column.uuid);
    const record = tableData.records.find(candidate => candidate.uuid === row.rowId);
    if (!definition || definition.data_type !== 'String' || !record) return;
    if (!tableData.metadata.edit_permissions.edit_cells || definition.read_only) {
      setOperationError(message('table.edit.cellsBlocked')); return;
    }
    const cell = presentation.cells[row.rowId]?.[definition.uuid];
    const value = cell?.raw_value ?? getEffectiveCellValue(record, definition);
    clearMutationError();
    setOperationError(null);
    void showStringEditor({ tableUuid: tableData.uuid, projectSessionId, target: { recordUuid: row.rowId, columnUuid: column.uuid,
      label: `${recordDisplayLabel(record, tableData)} / ${settingsDisplayLabel(definition.uuid, definition.display_name || definition.data_name)}`, value,
      revision: presentation.revision } }).catch(setOperationError);
  }, [getCurrentPresentation, mutation.busy, clearMutationError, tableData, projectSessionId]);

  const openColorEditor = useCallback((row: GridRow, column: Column) => {
    const presentation = getCurrentPresentation();
    if (!presentation || isMutationBusy() || !isColorType(column.data_type)) return;
    const definition = tableData.schema.columns.find(candidate => candidate.uuid === column.uuid);
    const record = tableData.records.find(candidate => candidate.uuid === row.rowId);
    if (!definition || !isColorType(definition.data_type) || !record) return;
    const cell = presentation.cells[row.rowId]?.[definition.uuid];
    const raw = cell?.raw_value ?? getEffectiveCellValue(record, definition);
    const formula = (raw || definition.default_value).trimStart().startsWith('=');
    const readonly = formula || previewActive || interactionLocked || definition.read_only || !tableData.metadata.edit_permissions.edit_cells;
    const value = cell?.display_value ?? String(row[definition.uuid] ?? '');
    const type = definition.data_type;
    const label = `${recordDisplayLabel(record, tableData)} / ${settingsDisplayLabel(definition.uuid, definition.display_name || definition.data_name)}`;
    // Freeze the displayed revision BEFORE opening; never rebase a picker result to a newer snapshot.
    const expectedRevision = presentation.revision;
    setOperationError(null);
    void runMutation(async signal => {
      const selected = await showColorPicker({ type, value, label, readonly, formula, columnSwatches: definition.color_swatches ?? [],
        columnContext: { tableUuid: tableData.uuid, columnUuid: definition.uuid } }, signal);
      if (selected === null || readonly || selected === value) return null;
      return { table_uuid: tableData.uuid, expected_revision: expectedRevision,
        cells: [{ record_uuid: record.uuid, column_uuid: definition.uuid, value: selected }],
        versions: [], column_versions: [], create_records: [], delete_record_uuids: [] };
    });
  }, [getCurrentPresentation, runMutation, isMutationBusy, tableData, previewActive, interactionLocked]);

  const commitVersion = useCallback((kind: 'row' | 'column', uuid: string, value: number) => runMutation(async () => {
    const request = await blankMutation();
    if (kind === 'row') request.versions.push({ record_uuid: uuid, min_version: String(value) });
    else request.column_versions = [{ column_uuid: uuid, min_version: String(value) }];
    return request;
  }), [runMutation, blankMutation]);

  // Share complete display semantics only. Mutation/presentation basis identity
  // continues to use the unmodified authoritative tableData object.
  const previousDisplay = useRef<GridDisplayModel | undefined>(undefined);
  const displayModel = useMemo(() => createGridDisplayModel(previousDisplay.current,
    tableData, presentationState.presentation, projectSessionId),
    [tableData, presentationState.presentation, projectSessionId]);
  previousDisplay.current = displayModel;
  const rows = displayModel.rows;
  const displayColumns = displayModel.columns;

  const { filters, sorts, update: updateFilterSort } = useGridFilterSortState(projectSessionId, tableData.uuid, displayColumns);

  // Filtering is derived from the same snapshot synchronously. A delayed filter
  // must not leave old row values editable under a newer revision.
  const filteredRows = useMemo(() => filterMetadataRows(rows, displayColumns, searchQuery), [rows, searchQuery, displayColumns]);
  const sortLabels = useGridSortLabels(tableData, projectSessionId, sorts, referenceRefreshVersion);
  const visibleRows = useMemo(() => filterSortRows(filteredRows, displayColumns, filters, sorts, sortLabels),
    [filteredRows, displayColumns, filters, sorts, sortLabels]);
  const filterSortDisabled = isUpdating || mutation.busy || !snapshotReady || interactionLocked;
  const changeColumnFilter = useCallback((columnUuid: string, filter: ColumnFilter | undefined) => {
    if (filterSortDisabled || gridContainerRef.current?.querySelector('.rdg-editor-container, [data-version-badge] input')) return;
    updateFilterSort({ filters: [...filters.filter(item => item.columnUuid !== columnUuid), ...(filter ? [filter] : [])], sorts });
  }, [filterSortDisabled, filters, sorts, updateFilterSort]);
  const changeSorts = useCallback((next: SortLevel[]) => {
    if (filterSortDisabled || gridContainerRef.current?.querySelector('.rdg-editor-container, [data-version-badge] input')) return;
    updateFilterSort({ filters, sorts: next });
  }, [filterSortDisabled, filters, updateFilterSort]);
  const renderFilterButton = useCallback((column: Column) => <GridColumnFilterButton key={`${column.uuid}/${column.data_type}`}
    column={column} rows={rows} filter={filters.find(item => item.columnUuid === column.uuid)} sorts={sorts}
    expectedProjectSession={projectSessionId} tableData={tableData} refreshVersion={referenceRefreshVersion}
    onFilterChange={filter => changeColumnFilter(column.uuid, filter)} onSortChange={changeSorts}
    onOpenSort={() => setShowSortDialog(true)} disabled={filterSortDisabled} />,
    [rows, filters, sorts, projectSessionId, tableData, referenceRefreshVersion, changeColumnFilter, changeSorts, filterSortDisabled]);
  const isSearching = false;
  const handleSearch = useCallback((query: string) => setSearchQuery(query), []);

  // Column width management
  const { getColumnWidth, queueColumnWidth, flushColumnWidths } = useDataGridColumnWidth(tableData.uuid, projectSessionId);

  // Row height management
  const { getRowHeight, setRowHeight } = useDataGridRowHeight(tableData.uuid);

  // Interface name map for column header indicators
  useEffect(() => {
    let active = true;
    setInterfaceMap({});
    const loadInterfaceMappings = async () => {
      try {
        const interfacesJson = await invoke<string>('get_interfaces', { expectedProjectSession: projectSessionId });
        const interfaces = JSON.parse(interfacesJson) as Array<{
          uuid: string;
          name: string;
          description?: string;
        }>;

        const map: Record<string, string> = {};
        interfaces.forEach(iface => {
          map[iface.uuid] = iface.name;
        });

        if (active) setInterfaceMap(map);
      } catch (error) {
        console.error('Failed to load interface mappings:', error);
      }
    };

    void loadInterfaceMappings();
    return () => { active = false; };
  }, [projectSessionId]);

  // Handler to select cell and enable editor
  const handleSelectCellForEdit = useCallback((rowIdx: number, columnIdx: number) => {
    if (dataGridRef.current && !mutation.busy) {
      dataGridRef.current.selectCell({ rowIdx, idx: columnIdx }, { enableEditor: true });
    }
  }, [mutation.busy]);

  const gridRowHeight = useCallback((row: GridRow) => transposed
    ? transposedHeights[row.rowId] ?? (versionEditMode ? 54 : 35) : getRowHeight(row.rowId),
    [transposed, transposedHeights, versionEditMode, getRowHeight]);

  // Auto-scroll during column resizing.
  //
  // Keep the captured physical handle moving at the native owner's right edge.
  // HeaderCell accounts for intentional owner scroll and rebases its own range
  // clamp. Capture-phase termination runs even when the handle stops bubbling.
  const autoScrollRef = useRef<{
    raf: number | null;
    clientX: number;
    clientY: number;
    pointerId: number;
    pointerType: string;
    handle: Element | null;
    speed: number;
  }>({ raf: null, clientX: 0, clientY: 0, pointerId: 0, pointerType: 'mouse', handle: null, speed: 0 });

  const stopAutoScroll = useCallback(() => {
    const s = autoScrollRef.current;
    if (s.raf !== null) {
      cancelAnimationFrame(s.raf);
      s.raf = null;
    }
    s.handle = null;
    s.speed = 0;
  }, []);

  useEffect(() => {
    window.addEventListener('pointerup', stopAutoScroll, true);
    window.addEventListener('pointercancel', stopAutoScroll, true);
    window.addEventListener('lostpointercapture', stopAutoScroll, true);
    window.addEventListener('blur', stopAutoScroll);
    return () => {
      window.removeEventListener('pointerup', stopAutoScroll, true);
      window.removeEventListener('pointercancel', stopAutoScroll, true);
      window.removeEventListener('lostpointercapture', stopAutoScroll, true);
      window.removeEventListener('blur', stopAutoScroll);
      stopAutoScroll();
    };
  }, [stopAutoScroll]);

  const handleContainerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const container = gridContainerRef.current;
    if (!container) return;
    const handle = (e.target as Element | null)?.closest?.('.rdg-cell-resizer') ?? null;
    const s = autoScrollRef.current;
    // Only apply while dragging a resize handle; otherwise stop auto-scrolling.
    if (!handle || (e.pointerType === 'mouse' && e.buttons !== 1)) {
      stopAutoScroll();
      return;
    }
    s.handle = handle;
    s.clientX = e.clientX;
    s.clientY = e.clientY;
    s.pointerId = e.pointerId;
    s.pointerType = e.pointerType;

    const rect = container.getBoundingClientRect();
    const over = e.clientX - (rect.right - AUTO_SCROLL_EDGE);
    if (over > 0) {
      s.speed = Math.min(AUTO_SCROLL_MAX_SPEED, Math.ceil(over / 2));
      if (s.raf === null) {
        const tick = () => {
          const st = autoScrollRef.current;
          if (!st.handle?.isConnected || st.speed === 0
            || !(st.handle instanceof HTMLElement) || !st.handle.hasPointerCapture(st.pointerId)) {
            st.raf = null;
            return;
          }
          const before = container.scrollLeft;
          container.scrollLeft += st.speed;
          const moved = container.scrollLeft - before;
          if (moved <= 0) {
            // Cannot scroll further because the content fits the viewport
            // or the column reached maxWidth. Wait for the next actual pointer movement.
            st.raf = null;
            return;
          }
          // Same physical pointer; HeaderCell includes this intentional scroll delta.
          st.handle.dispatchEvent(
            new PointerEvent('pointermove', {
              pointerId: st.pointerId, pointerType: st.pointerType, buttons: 1,
              clientX: st.clientX,
              clientY: st.clientY,
              bubbles: true,
              cancelable: true
            })
          );
          st.raf = requestAnimationFrame(tick);
        };
        s.raf = requestAnimationFrame(tick);
      }
    } else {
      s.speed = 0;
      if (s.raf !== null) {
        cancelAnimationFrame(s.raf);
        s.raf = null;
      }
    }
  }, [stopAutoScroll]);



  // No longer need dynamic style injection - using column customStyles instead

  const completedReferenceNavigation = useRef<ReferenceNavigationRequest | null>(null);
  const [highlightedRecord, setHighlightedRecord] = useState<string | null>(null);
  const gridRowClass = useCallback((row: GridRow) => row.rowId === highlightedRecord ? 'rdg-row-highlight' : undefined, [highlightedRecord]);
  useEffect(() => {
    if (!highlightedRecord) return;
    const timer = setTimeout(() => setHighlightedRecord(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightedRecord, referenceNavigation]);

  // Wait for the actual target snapshot and the unfiltered grid to commit.
  // An arbitrary delay can lose slow loads; source-row indexes are never valid
  // against a filtered destination. The request is consumed exactly once.
  useEffect(() => {
    const request = referenceNavigation;
    if (!request || request === completedReferenceNavigation.current
      || request.projectSessionId !== projectSessionId
      || request.tableUuid !== tableData.uuid
      || request.tableUuid !== incomingTableData.uuid
      || !snapshotReady) return;
    if (searchQuery || filters.length) {
      setSearchQuery('');
      if (filters.length) updateFilterSort({ filters: [], sorts });
      return;
    }
    const targetRowIndex = request.recordUuid
      ? visibleRows.findIndex(row => row.rowId === request.recordUuid)
      : -1;
    if (targetRowIndex >= 0 && !dataGridRef.current) return;
    completedReferenceNavigation.current = request;
    setOperationError(null);
    setHighlightedRecord(null);
    if (request.recordUuid && targetRowIndex < 0) {
      setOperationError(gridErrorNotice(message('reference.missing'), request.recordUuid));
    } else if (targetRowIndex >= 0) {
      const position = transposed ? { rowIdx: 0, idx: targetRowIndex + 1 } : { rowIdx: targetRowIndex, idx: 0 };
      dataGridRef.current!.scrollToCell({ ...position, scrollPosition: 'top-left' });
      if (!transposed || displayColumns.length > 0) dataGridRef.current!.selectCell(position);
      setHighlightedRecord(request.recordUuid);
    }
    onReferenceNavigationHandled?.(request);
  }, [referenceNavigation, projectSessionId, tableData.uuid, incomingTableData.uuid,
    snapshotReady, searchQuery, filters, sorts, updateFilterSort, visibleRows, transposed, displayColumns.length, onReferenceNavigationHandled]);

  const selectCellForEdit = useCommittedEvent(handleSelectCellForEdit);
  const expandStringCell = useCommittedEvent(openStringEditor);
  const expandColorCell = useCommittedEvent(openColorEditor);
  const openReference = useCommittedEvent((targetTableUuid: string, recordUuid: string) => onOpenReference?.(targetTableUuid, recordUuid));
  const tableUuid = tableData.uuid;
  const hasReferenceNavigation = Boolean(onOpenReference);

  const previousColumns = useRef(new Map<string, { inputs: readonly unknown[]; column: DataGridColumn<GridRow> }>());
  // Convert columns to DataGrid format without a one-frame schema/revision mismatch.
  const columns = useMemo(() => {
    const gridColumns: DataGridColumn<GridRow>[] = [];
    const nextColumns = new Map<string, { inputs: readonly unknown[]; column: DataGridColumn<GridRow> }>();

    // Add data columns
    // Display columns in schema order. The table retains column order,
    // allowing interface-derived and custom columns to be freely mixed and reordered
    displayColumns.forEach((column, columnIndex) => {
      // Use the core's data_type identifiers unchanged.
      const dataType = column.data_type;
      // Default white means no specified color; other values are the user's actual selected background.
      const hasCustomColor = !isDefaultColumnColor(column.style?.color);
      const customColor = hasCustomColor ? column.style!.color : undefined;

      const defaultWidth = column.style?.width || initialHeaderWidth(settingsDisplayLabel(column.uuid, column.display_name || column.data_name), getDefaultColumnWidth(dataType));
      const width = getColumnWidth(column.uuid, defaultWidth);
      const inputs = [column, columnIndex, width, projectSessionId, tableUuid, translation,
        previewActive, releaseVersion, tableData.metadata.edit_permissions.edit_cells, selectCellForEdit, expandStringCell, expandColorCell, openReference, hasReferenceNavigation];
      const previous = previousColumns.current.get(column.uuid);
      if (previous && previous.inputs.length === inputs.length
        && inputs.every((value, index) => Object.is(value, previous.inputs[index]))) {
        nextColumns.set(column.uuid, previous);
        gridColumns.push(previous.column);
        return;
      }



      const dataTypeClass = getDataTypeClassName(dataType);
      const numeric = dataTypeClass === 'rdg-cell-type-number';
      const plainDisplay = !['Boolean', 'Reference', 'TableRef', 'Curve'].includes(dataType) && !isColorType(dataType);
      let renderCell: DataGridColumn<GridRow>['renderCell'];
      let editable = true;
      let headerCellClass: DataGridColumn<GridRow>['headerCellClass'];

      // Set up renderers based on data type
      if (dataType === 'Boolean') {
        renderCell = props => <BooleanCellRenderer {...props} readOnly={column.read_only || !tableData.metadata.edit_permissions.edit_cells} />;
        editable = false; // Disable default editing mode
      } else if (dataType === 'Reference') {
        renderCell = (props) => <RuntimeReferenceCell
          expectedProjectSession={projectSessionId}
          {...props}
          columnData={column}
          tableUuid={tableUuid}
          onReferenceClick={hasReferenceNavigation ? openReference : undefined}
          selectCell={(position) => selectCellForEdit(position.rowIdx, position.idx)}
        />;
        editable = true; // Enable editing with custom editor
      } else if (dataType === 'TableRef') {
        renderCell = (props) => <TableRefCellRenderer
          expectedProjectSession={projectSessionId}
          {...props}
          columnData={column}
          tableUuid={tableUuid}
          onOpenTable={(targetTableUuid) => openReference(targetTableUuid, '')}
          selectCell={(position) => selectCellForEdit(position.rowIdx, position.idx)}
        />;
        editable = true;
      } else if (dataType === 'Select') {
        renderCell = props => <SelectCellRenderer {...props} columnData={column}
          readOnly={column.read_only || !tableData.metadata.edit_permissions.edit_cells}
          onEdit={selectCellForEdit} />;
      } else if (isColorType(dataType)) {
        renderCell = props => <ColorCell row={props.row} column={column} onOpen={expandColorCell} readOnly={column.read_only || !tableData.metadata.edit_permissions.edit_cells} />;
      } else if (dataType === 'Curve') {
        renderCell = (props) => <CurveCellRenderer
          {...props}
          columnData={column}
          selectCell={(position) => selectCellForEdit(position.rowIdx, position.idx)}
        />;
        editable = true;
      } else {
        renderCell = props => renderFormulaContent(props.row[column.uuid],
          props.row.cellPresentations?.[column.uuid], column, numeric,
          dataType === 'String' && props.tabIndex === 0
            ? <StringExpandButton row={props.row} definition={column} onExpand={expandStringCell} readOnly={column.read_only || !tableData.metadata.edit_permissions.edit_cells} /> : undefined);
      }

      // Header styles depend on interface origin and whether a custom color is set
      if (column.interface_origin) {
        headerCellClass = hasCustomColor
          ? 'rdg-header-interface-origin rdg-header-custom-color rdg-cell-has-inline-buttons'
          : 'rdg-header-interface-origin rdg-cell-has-inline-buttons';
      } else if (hasCustomColor) {
        headerCellClass = 'rdg-header-custom-color rdg-cell-has-inline-buttons';
      } else {
        headerCellClass = 'rdg-cell-has-inline-buttons';
      }


      // Bounded per-column cache survives scrolls with the stable column object.
      const contrastColors = new Map<string, string>();
      const conditionalForeground = (background: string) => {
        let color = contrastColors.get(background);
        if (!color) {
          color = getContrastingTextColor(background);
          if (contrastColors.size >= 64) contrastColors.clear();
          contrastColors.set(background, color);
        }
        return color;
      };

      const colDef: DataGridColumn<GridRow> = {
        key: column.uuid,
        name: settingsDisplayLabel(column.uuid, column.display_name || column.data_name),
        width: width,
        resizable: true,
        // Allow freely reordering columns by dragging headers
        // Order mixing interface-derived and custom columns is preserved
        draggable: true,
        editable: editable && !column.read_only && tableData.metadata.edit_permissions.edit_cells,
        renderCell,
        renderTextCell: numeric ? row => renderFormulaContent(row[column.uuid],
          row.cellPresentations?.[column.uuid], column, true) as string : undefined,
        cellDescription: row => {
          const cell = row.cellPresentations?.[column.uuid];
          const inheritance = row.tableRecord?.parent_uuid && !hasLocalCellValue(row.tableRecord, column) ? translation.t('metadata.inherit') : undefined;
          const protection = column.read_only || !tableData.metadata.edit_permissions.edit_cells ? translation.t('table.edit.cellsBlocked') : undefined;
          if (!inheritance && !protection && !cell?.hint && !cell?.formula_error && !cell?.issues.length) return undefined;
          const description = [inheritance, protection, cell?.hint, cell?.formula_error ? localizeError(cell.formula_error) : undefined,
            ...(cell?.issues.map(issue => localizeError(issue)) || [])].filter(Boolean).join('\n');
          return { title: description || undefined, description: description || undefined,
            invalid: cell?.issues.length ? true : undefined };
        },
        renderEditCell: dataType === 'Reference'
          ? (props) => <RuntimeReferenceEditor {...props} columnData={column} tableUuid={tableUuid} expectedProjectSession={projectSessionId} />
          : dataType === 'TableRef'
          ? (props) => <TableRefCellEditor {...props} columnData={column} tableUuid={tableUuid} expectedProjectSession={projectSessionId} />
          : dataType === 'Select'
          ? (props) => <SelectCellEditor {...props} columnData={column} />
          : dataType === 'Curve'
          ? (props) => <CurveCellEditor {...props} columnData={column} />
          : undefined,
        editorOptions: dataType === 'Curve' ? { commitOnOutsideClick: false } : undefined,
        headerCellClass: headerCellClass + (previewActive && (column.min_version) > releaseVersion ? ' rdg-version-excluded' : ''),
        dataType: dataType,
        // Add tooltip and memo text support
        headerMemoText: column.memo_text,
        memoText: (row: GridRow) => row.tableRecord?.memo_texts?.[column.uuid] ?? '',
        tooltipPlacement: 'top',
        // Only for columns with a user-selected color, set the unchanged background
        // and a readable text color calculated from luminance.
        customStyles: customColor ? {
          backgroundColor: customColor,
          color: getContrastingTextColor(customColor)
        } : undefined,
        styleResolver: (_value, unknownRow) => {
          const row = unknownRow as GridRow;
          const cell = row.cellPresentations?.[column.uuid];
          // Match the former inner renderer's color precedence on the host.
          // Explicit foreground wins; a conditional background gets a readable
          // foreground in either theme. Formula errors retain their red signal.
          const color = cell?.style.text_color
            || (plainDisplay && cell?.formula_error ? '#b91c1c' : undefined)
            || (cell?.style.background_color ? conditionalForeground(cell.style.background_color) : undefined)
            || (plainDisplay && !(row.tableRecord && getEffectiveCellValue(row.tableRecord, column)) ? '#737373' : undefined);
          if (!(column.style?.font_size && column.style.font_size !== 12)
            && !color && !cell?.range_bar && cell?.style.bold === undefined && !cell?.issues.length) return undefined;
          return {
            ...(column.style?.font_size && column.style.font_size !== 12 ? { fontSize: `${column.style.font_size}px` } : {}),
            ...(color ? { color } : {}),
            ...rangeBarStyle(cell?.range_bar, getLocaleDirection(), cell?.style.text_color),
            ...(cell?.style.bold !== undefined ? { fontWeight: cell.style.bold ? 700 : 400 } : {}),
            ...(cell?.issues.length ? { boxShadow: `inset 0 -2px ${cell.issues.some(issue => issue.mode === 'reject') ? '#dc2626' : '#d97706'}` } : {}),
          };
        },
        // Use the new header event handlers
        onHeaderContextMenu: (e) => {
          e.preventDefault();
          setColumnEditor(current => current || { target: { mode: 'table', target_uuid: tableUuid, column_uuid: column.uuid }, tab: 'display' });
        },
        onHeaderDoubleClick: () => {
          setColumnEditor(current => current || { target: { mode: 'table', target_uuid: tableUuid, column_uuid: column.uuid } });
        },
        renderHeaderCell: () => <RuntimeHeader column={column} columnIndex={columnIndex} />,
        cellClass: (row) => {
          // Only return data type class
          const excluded = previewActive && ((row.tableRecord !== undefined && row.tableRecord.min_version > releaseVersion) || (column.min_version) > releaseVersion);
          return dataTypeClass + (row.tableRecord?.memo_texts?.[column.uuid] ? ' rdg-cell-has-memo' : '') + (row.tableRecord?.parent_uuid && !hasLocalCellValue(row.tableRecord, column) ? ' rdg-cell-inherited' : '') + (plainDisplay ? ' rdg-cell-plain-display' : '') + (excluded ? ' rdg-version-excluded' : '');
        }
      };

      nextColumns.set(column.uuid, { inputs, column: colDef });
      gridColumns.push(colDef);
    });

    previousColumns.current = nextColumns;
    return gridColumns;
  }, [projectSessionId, translation, displayColumns, tableUuid, previewActive, releaseVersion,
    getColumnWidth, selectCellForEdit, expandStringCell, expandColorCell, openReference, hasReferenceNavigation, tableData.metadata.edit_permissions.edit_cells]);

  const submitChanges = useCallback(async (changes: Array<{ rowId: string; key: string; value: string }>) => {
    const owner = captureTableInteractionScope(projectSessionId, tableData.uuid);
    const committed = await runMutation(async () => {
    if (!changes.length) return null;
    const request = await blankMutation();
    for (const change of changes) {
      if (change.key === 'version') request.versions.push({ record_uuid: change.rowId, min_version: change.value });
      else request.cells.push({ record_uuid: change.rowId, column_uuid: change.key, value: change.value });
    }
    return request;
  });
    if (committed && changes.length === 1 && isTableInteractionScopeCurrent(projectSessionId, tableData.uuid, owner)) {
      repeatOperation.current = { kind: 'input', value: changes[0].value };
    }
    return committed;
  }, [runMutation, blankMutation, projectSessionId, tableData.uuid]);

  const flushInlineForSave = useCommittedEvent(async () => {
    if (!isTableInteractionAllowed(projectSessionId, tableData.uuid)) return true;
    if (isMutationBusy() || !snapshotReady) return false;
    const pending = {}; setBulkEditorPending(pending);
    try {
      return await dataGridRef.current?.flushEditor(async (draft, key) => {
        const row = draft as GridRow;
        return submitChanges([{ rowId: transposed ? key : row.rowId,
          key: transposed ? row.rowId : key, value: String(row[key] ?? '') }]);
      }) ?? true;
    } finally { setBulkEditorPending(current => current === pending ? null : current); }
  });
  useEffect(() => registerProjectSaveParticipant(projectSessionId, flushInlineForSave),
    [projectSessionId, flushInlineForSave]);

  const handleRowsChange = useCallback((newRows: GridRow[], data: RowsChangeData<GridRow>) => {
    if (!data.column) return;
    const key = data.column.key;
    const changes = data.indexes.map(index => newRows[index]).filter(Boolean).map(row => ({
      rowId: transposed ? key : row.rowId, key: transposed ? row.rowId : key, value: String(row[key] ?? '') }));
    const intent = preparedSettingsIntent.current;
    if (!intent || !settingsIntentIsCurrent(intent) || intent.commit) { void submitChanges(changes); return; }
    const commit: SettingsInlineCommit = { owner: null };
    intent.commit = commit;
    settingsInlineCommit.current = commit;
    commit.result = submitChanges(changes);
    void commit.result.finally(() => { if (settingsInlineCommit.current === commit) settingsInlineCommit.current = null; });
  }, [submitChanges, transposed, settingsIntentIsCurrent]);

  const openTableSettings = () => {
    if (descriptionEditing) return;
    const presentation = getCurrentPresentation();
    if (!presentation || isMutationBusy() || columnEditor || interactionLocked
      || gridContainerRef.current?.querySelector('.rdg-editor-container')) return;
    clearMutationError();
    setEditSettings({ table: tableData, revision: presentation.revision });
  };
  const openTableSettingsLatest = useRef(openTableSettings);
  useLayoutEffect(() => { openTableSettingsLatest.current = openTableSettings; });
  const prepareTableSettingsActivation = (): TableSettingsActivation | undefined => {
    if (isMutationBusy() || columnEditor || interactionLocked || !getCurrentPresentation()
      || !gridContainerRef.current?.querySelector('.rdg-editor-container')) return;
    const interactionOwner = captureTableInteractionScope(projectSessionId, tableUuid);
    if (interactionOwner === null) return;
    const intent: SettingsIntent = { scope: settingsActivationScope, interactionOwner, cancelled: false, commit: null };
    preparedSettingsIntent.current = intent;
    return {
      cancel() {
        intent.cancelled = true;
        if (preparedSettingsIntent.current === intent) preparedSettingsIntent.current = null;
      },
      activate() {
        if (preparedSettingsIntent.current === intent) preparedSettingsIntent.current = null;
        if (!settingsIntentIsCurrent(intent)) return;
        const commit = intent.commit;
        if (!commit) { openTableSettingsLatest.current(); return; } // Unchanged drafts need no write.
        activatedSettingsIntent.current = intent;
        void commit.result?.then(success => {
          if (success && commit.owner && settingsIntentIsCurrent(intent)) setSettledSettingsIntent(intent);
          else if (activatedSettingsIntent.current === intent) activatedSettingsIntent.current = null;
        });
      }
    };
  };
  useEffect(() => {
    if (!settledSettingsIntent || mutation.busy) return;
    const intent = settledSettingsIntent;
    const finish = () => {
      setSettledSettingsIntent(null);
      if (activatedSettingsIntent.current === intent) activatedSettingsIntent.current = null;
    };
    const owner = intent.commit?.owner;
    if (!settingsIntentIsCurrent(intent) || !owner || mutation.error || columnEditor || interactionLocked
      || presentationError || presentationCancelled
      || gridContainerRef.current?.querySelector('.rdg-editor-container')) { finish(); return; }
    const presentation = getCurrentPresentation();
    if (!snapshotReady || !presentation) {
      // A native invalidation can start refresh before React renders refreshing.
      // Only a real in-flight/deferred read may retain this successful intent.
      if (!isPresentationRefreshPending()) finish();
      return;
    }
    const delivered = lastDeliveredSnapshot.current;
    const refreshedBasis = delivered?.projectSessionId === intent.scope.projectSessionId
      && delivered.tableUuid === intent.scope.tableUuid && delivered.table === tableData
      && delivered.presentation === presentation;
    finish();
    // A refreshed immutable table is valid only with its exact authoritative
    // presentation and the originating successful commit's unchanged revision.
    if (presentation.revision !== owner.revision || (tableData !== owner.table && !refreshedBasis)) return;
    clearMutationError();
    setEditSettings({ table: tableData, revision: presentation.revision });
  }, [settledSettingsIntent, mutation.busy, mutation.error, columnEditor, interactionLocked, snapshotReady,
    presentationError, presentationCancelled, isPresentationRefreshPending,
    tableData, getCurrentPresentation, settingsIntentIsCurrent, clearMutationError]);

  // Rust reads table contents and presentation under one lock.
  const refreshData = useCallback(async () => { await refreshPresentation(); }, [refreshPresentation]);

  const { canUndo, canRedo } = useTableHistory(tableData.uuid, projectSessionId, presentationState.presentation,
    snapshotReady && !mutation.busy && !isUpdating && !interactionLocked);

  const changeHistory = useCallback((command: 'undo_command' | 'redo_command') => runExclusiveMutation(async signal => {
    const result = await invoke<string>(command, { tableUuid: tableData.uuid, expectedProjectSession: projectSessionId });
    if (signal.aborted || result === 'empty') return;
    if (result !== 'ok') throw new Error(result);
    // Native history atomically persists all participating tables before its ACK.
    // A second project save only delays refresh behind unrelated work and can
    // report a save failure after this history operation already succeeded.
    await refreshData();
  }), [projectSessionId, runExclusiveMutation, tableData.uuid, refreshData]);
  const undo = useCommittedEvent(() => canUndo && getCurrentPresentation() ? changeHistory('undo_command') : Promise.resolve(false));
  const redo = useCommittedEvent(() => canRedo && getCurrentPresentation() ? changeHistory('redo_command') : Promise.resolve(false));
  useEffect(() => {
    const onUndo = () => { void undo(); }; const onRedo = () => { void redo(); };
    window.addEventListener('devcel-undo', onUndo); window.addEventListener('devcel-redo', onRedo);
    return () => { window.removeEventListener('devcel-undo', onUndo); window.removeEventListener('devcel-redo', onRedo); };
  }, [undo, redo]);

  // A projected row can carry an active record-keyed edit draft. Replacing the
  // source snapshot must replace projected rows too, even with unchanged schema,
  // so stale drafts cannot survive filtering, sorting or new record values.
  const transposeBasis = useMemo(() => ({ rows: visibleRows, columns }), [visibleRows, columns]);
  const sourceRowsById = useMemo(() => new Map(visibleRows.map(row => [row.rowId, row])), [visibleRows]);
  const sourceColumnsById = useMemo(() => new Map(columns.map(column => [column.key, column])), [columns]);
  const transposedRows = useMemo(() => transposed ? createTransposedRows(transposeBasis.columns) : [], [transposed, transposeBasis]);
  const viewRows = transposed ? transposedRows : visibleRows;
  const viewColumnKeys = useMemo(() => transposed ? visibleRows.map(row => row.rowId) : columns.map(column => column.key),
    [transposed, visibleRows, columns]);
  const resolveViewCell = useCallback((row: GridRow, key: string) => {
    const sourceRow = transposed ? sourceRowsById.get(key) : row;
    const sourceKey = transposed ? row.rowId : key;
    return sourceRow && sourceColumnsById.has(sourceKey) ? { row: sourceRow, key: sourceKey } : undefined;
  }, [transposed, sourceRowsById, sourceColumnsById]);

  const selectedCells = useCallback(() => {
    const selected: Array<{ row: GridRow; key: string; viewRowId: string }> = [];
    if (!selectionRange) return selected;
    const { start, end } = selectionRange;
    for (let r = Math.min(start.rowIdx, end.rowIdx); r <= Math.max(start.rowIdx, end.rowIdx); r++) {
      const viewRow = viewRows[r];
      if (!viewRow) continue;
      for (let c = Math.min(start.idx, end.idx); c <= Math.max(start.idx, end.idx); c++) {
        const key = viewColumnKeys[c];
        const cell = key === undefined ? undefined : resolveViewCell(viewRow, key);
        if (cell) selected.push({ ...cell, viewRowId: viewRow.rowId });
      }
    }
    return selected;
  }, [selectionRange, viewRows, viewColumnKeys, resolveViewCell]);

  const copyCells = useCallback(async (cells: Array<{ row: GridRow; key: string; viewRowId: string }>, rawInputs: boolean) => {
    const textRows: string[][] = [];
    const metadata: ClipboardCell[][] = [];
    let previousRow: string | null = null;
    for (const { row, key, viewRowId } of cells) {
      if (viewRowId !== previousRow) { textRows.push([]); metadata.push([]); previousRow = viewRowId; }
      let value = String(row[key] ?? '');
      if (rawInputs && key !== 'version') {
        const definition = row.columnDefs?.find(column => column.uuid === key);
        // Empty raw input inherits the default; never materialize a computed value.
        value = row.cellPresentations?.[key]?.raw_value
          ?? (definition && row.tableRecord ? getEffectiveCellValue(row.tableRecord, definition) : '');
      }
      textRows[textRows.length - 1].push(value);
      const definition = row.columnDefs?.find(column => column.uuid === key);
      const presentation = row.cellPresentations?.[key];
      metadata[metadata.length - 1].push({ raw: value, type: definition?.data_type ?? '',
        value: literalClipboardValue(definition?.data_type ?? '', presentation?.display_value ?? String(row[key] ?? ''), !!presentation?.formula_error) });
    }
    if (textRows.length) {
      const text = serializeClipboardTsv(textRows);
      if (rawInputs) await writeGridClipboard({ text, cells: metadata });
      else await navigator.clipboard.writeText(text);
      return text;
    }
  }, []);

  const handleCopy = useCallback(async () => {
    await copyCells(selectedCells(), true);
  }, [selectedCells, copyCells]);

  const readOnlyColumnIds = useMemo(() => new Set(displayColumns.filter(column => column.read_only).map(column => column.uuid)), [displayColumns]);
  const handlePaste = useCallback(async (clipboardText: string) => {
    // An active cell editor owns paste, including a blocked draft whose blur did
    // not commit. Bulk paste must not bypass that editor via toolbar/capture.
    if (!selectionRange || mutation.busy || gridContainerRef.current?.querySelector('.rdg-editor-container')) return;
    // Capture UUID targets before the mutation gate or any warning dialog yields.
    const targetRows = [...viewRows];
    const targetColumns = [...viewColumnKeys];
    const resolveTarget = resolveViewCell;
    const start = { rowIdx: Math.min(selectionRange.start.rowIdx, selectionRange.end.rowIdx), idx: Math.min(selectionRange.start.idx, selectionRange.end.idx) };
    await runMutation(async () => {
      const request = await blankMutation();
      const text = clipboardText;
      // Preparing the mutation may yield long enough for an editor to open.
      if (!text || gridContainerRef.current?.querySelector('.rdg-editor-container')) return null;
      const pastedRows = parseClipboardTsv(text);
      if (!pastedRows) throw localizedError(message('grid.invalidClipboardText'));
      pastedRows.forEach((values, i) => {
        const row = targetRows[start.rowIdx + i];
        if (!row) throw localizedError(message('grid.pasteExceedsRows'));
        values.forEach((value, j) => {
          const key = targetColumns[start.idx + j];
          if (!key) throw localizedError(message('grid.pasteExceedsColumns'));
          const target = resolveTarget(row, key);
          if (!target) throw localizedError(message('grid.waitForPresentation'));
          if (!tableData.metadata.edit_permissions.edit_cells || readOnlyColumnIds.has(target.key)) throw localizedError(message('table.edit.cellsBlocked'));
          request.cells.push({ record_uuid: target.row.rowId, column_uuid: target.key, value });
        });
      });
      return request.cells.length || request.versions.length ? request : null;
    });
  }, [selectionRange, mutation.busy, runMutation, viewRows, viewColumnKeys, resolveViewCell, blankMutation, readOnlyColumnIds, tableData.metadata.edit_permissions.edit_cells]);

  const handleClear = useCallback(async (cut: boolean) => {
    const owner = captureTableInteractionScope(projectSessionId, tableData.uuid);
    const cells = selectedCells();
    const committed = await runMutation(async () => {
      if (!cells.length) return null;
      const request = await blankMutation();
      // Bind revision before clipboard I/O. A failed copy never clears cells.
      // Clearing removes the local override; typing/pasting empty stays local.
      if (!tableData.metadata.edit_permissions.edit_cells || cells.some(cell => readOnlyColumnIds.has(cell.key))) {
        throw localizedError(message('table.edit.cellsBlocked'));
      }
      if (cut) await copyCells(cells, true);
      for (const { row, key } of cells) {
        if (key === 'version') request.versions.push({ record_uuid: row.rowId, min_version: '0' });
        else request.cells.push({ record_uuid: row.rowId, column_uuid: key, value: '' });
      }
      return request;
    });
    if (committed && !cut && isTableInteractionScopeCurrent(projectSessionId, tableData.uuid, owner)) repeatOperation.current = { kind: 'clear' };
  }, [selectedCells, runMutation, copyCells, blankMutation, readOnlyColumnIds, tableData.metadata.edit_permissions.edit_cells, projectSessionId, tableData.uuid]);

  const handleFill = useCallback(async (direction: 'down' | 'right') => {
    const owner = captureTableInteractionScope(projectSessionId, tableData.uuid);
    if (!selectionRange || mutation.busy || gridContainerRef.current?.querySelector('.rdg-editor-container')) return;
    const firstRow = Math.min(selectionRange.start.rowIdx, selectionRange.end.rowIdx);
    const lastRow = Math.max(selectionRange.start.rowIdx, selectionRange.end.rowIdx);
    const firstCol = Math.min(selectionRange.start.idx, selectionRange.end.idx);
    const lastCol = Math.max(selectionRange.start.idx, selectionRange.end.idx);
    const writes: Array<{ record_uuid: string; column_uuid: string; value: string }> = [];
    for (let r = firstRow; r <= lastRow; r++) for (let c = firstCol; c <= lastCol; c++) {
      if (direction === 'down' ? r === firstRow : c === firstCol) continue;
      const sourceRow = viewRows[direction === 'down' ? firstRow : r], targetRow = viewRows[r];
      const sourceKey = viewColumnKeys[direction === 'right' ? firstCol : c], targetKey = viewColumnKeys[c];
      if (!sourceRow || !targetRow || sourceKey === undefined || targetKey === undefined) return;
      const source = resolveViewCell(sourceRow, sourceKey), target = resolveViewCell(targetRow, targetKey);
      if (!source || !target) return;
      const definition = source.row.columnDefs?.find(column => column.uuid === source.key);
      const value = source.row.cellPresentations?.[source.key]?.raw_value
        ?? (definition && source.row.tableRecord ? getEffectiveCellValue(source.row.tableRecord, definition) : String(source.row[source.key] ?? ''));
      writes.push({ record_uuid: target.row.rowId, column_uuid: target.key, value });
    }
    const committed = await runMutation(async () => {
      if (!writes.length) return null;
      const request = await blankMutation();
      if (!tableData.metadata.edit_permissions.edit_cells || writes.some(cell => readOnlyColumnIds.has(cell.column_uuid)))
        throw localizedError(message('table.edit.cellsBlocked'));
      for (const cell of writes) {
        if (cell.column_uuid === 'version') request.versions.push({ record_uuid: cell.record_uuid, min_version: cell.value });
        else request.cells.push(cell);
      }
      return request;
    });
    if (committed && isTableInteractionScopeCurrent(projectSessionId, tableData.uuid, owner)) repeatOperation.current = { kind: 'fill', direction };
  }, [selectionRange, mutation.busy, resolveViewCell, viewRows, viewColumnKeys, runMutation, blankMutation, tableData.metadata.edit_permissions.edit_cells, readOnlyColumnIds, projectSessionId, tableData.uuid]);

  const closeCellMenu = useCallback(() => {
    setCellMenu(null);
    requestAnimationFrame(() => {
      if (!hasBlockingShortcutSurface()) gridContainerRef.current?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.focus({ preventScroll: true });
    });
  }, []);

  const handleBulkInput = useCallback(async (value: string) => {
    const owner = captureTableInteractionScope(projectSessionId, tableData.uuid);
    const targets = selectedCells().map(({ row, key }) => ({ record_uuid: row.rowId, column_uuid: key, value }));
    const committed = await runMutation(async () => {
      if (!targets.length) return null;
      if (!tableData.metadata.edit_permissions.edit_cells || targets.some(cell => readOnlyColumnIds.has(cell.column_uuid)))
        throw localizedError(message('table.edit.cellsBlocked'));
      const request = await blankMutation();
      for (const cell of targets) {
        if (cell.column_uuid === 'version') request.versions.push({ record_uuid: cell.record_uuid, min_version: cell.value });
        else request.cells.push(cell);
      }
      return request;
    });
    if (committed && isTableInteractionScopeCurrent(projectSessionId, tableData.uuid, owner)) repeatOperation.current = { kind: 'input', value };
    return committed;
  }, [selectedCells, runMutation, tableData.metadata.edit_permissions.edit_cells, readOnlyColumnIds, blankMutation, projectSessionId, tableData.uuid]);

  const commandView = JSON.stringify([transposed, viewRows.map(row => row.rowId), viewColumnKeys]);
  const currentCommandView = useRef(commandView);
  useLayoutEffect(() => { currentCommandView.current = commandView; }, [commandView]);
  const closeGridCommand = useCallback(() => {
    setGridCommand(null);
    requestAnimationFrame(() => gridContainerRef.current?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.focus({ preventScroll: true }));
  }, []);
  const openGridCommand = useCallback((kind: GridCommandRequest['kind']) => {
    if (isMutationBusy() || !snapshotReady || gridContainerRef.current?.querySelector('.rdg-editor-container')) return;
    const presentation = getCurrentPresentation();
    const owner = captureTableInteractionScope(projectSessionId, tableData.uuid);
    if (!presentation || owner === null || !viewRows.length || !viewColumnKeys.length) return;
    const current = () => isTableInteractionScopeCurrent(projectSessionId, tableData.uuid, owner)
      && currentCommandView.current === commandView && getCurrentPresentation()?.revision === presentation.revision;
    const selected = new Set(selectedCells().map(cell => `${cell.row.rowId}/${cell.key}`));
    const cells: ReplaceCell[] = [];
    const targets = viewRows.map(row => viewColumnKeys.map(key => {
      const target = resolveViewCell(row, key);
      if (!target) return null;
      const definition = target.row.columnDefs?.find(column => column.uuid === target.key);
      const raw = target.row.cellPresentations?.[target.key]?.raw_value
        ?? (definition && target.row.tableRecord ? getEffectiveCellValue(target.row.tableRecord, definition) : String(target.row[target.key] ?? ''));
      cells.push({ recordUuid: target.row.rowId, columnUuid: target.key, raw, selected: selected.has(`${target.row.rowId}/${target.key}`) });
      return { recordUuid: target.row.rowId, columnUuid: target.key, type: definition?.data_type ?? '', readOnly: readOnlyColumnIds.has(target.key) };
    }));
    const start = { row: Math.max(0, Math.min(selectionRange?.start.rowIdx ?? 0, selectionRange?.end.rowIdx ?? 0)),
      column: Math.max(0, Math.min(selectionRange?.start.idx ?? 0, selectionRange?.end.idx ?? 0)) };
    const apply = async (writes: Array<{ recordUuid: string; columnUuid: string; value: string }>) => runMutation(async () => {
      if (!current()) throw localizedError(message('grid.waitForPresentation'));
      if (!tableData.metadata.edit_permissions.edit_cells || writes.some(cell => readOnlyColumnIds.has(cell.columnUuid))) throw localizedError(message('table.edit.cellsBlocked'));
      if (!writes.length) return null;
      const request = await blankMutation();
      if (!current() || request.expected_revision !== presentation.revision) throw localizedError(message('grid.waitForPresentation'));
      for (const cell of writes) {
        if (cell.columnUuid === 'version') request.versions.push({ record_uuid: cell.recordUuid, min_version: cell.value });
        else request.cells.push({ record_uuid: cell.recordUuid, column_uuid: cell.columnUuid, value: cell.value });
      }
      return request;
    });
    setGridCommand({ kind, tableName: tableData.display_name || tableData.metadata.data_name,
      rowCount: viewRows.length, columnCount: viewColumnKeys.length, ...start, transposed, cells,
      goTo: (row, column) => {
        if (!current() || !Number.isInteger(row) || !Number.isInteger(column) || !targets[row]?.[column]) return false;
        dataGridRef.current?.selectCell({ rowIdx: row, idx: column + 1 }, { shouldFocusCell: false });
        dataGridRef.current?.scrollToCell({ rowIdx: row, idx: column + 1 });
        return true;
      },
      replace: (matches, query, replacement) => apply(matches.map(cell => ({ ...cell, value: cell.raw.split(query).join(replacement) }))),
      paste: async (rows, types) => {
        if (!rows.length || !rows[0].length || rows.some(row => row.length !== rows[0].length)) return false;
        const writes: Array<{ recordUuid: string; columnUuid: string; value: string }> = [];
        for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
          const target = targets[start.row + r]?.[start.column + c];
          if (!target || (types && target.type !== types[r]?.[c])) return false;
          writes.push({ ...target, value: rows[r][c] });
        }
        return apply(writes);
      }
    });
  }, [isMutationBusy, snapshotReady, getCurrentPresentation, projectSessionId, tableData, viewRows, viewColumnKeys, commandView, selectedCells, resolveViewCell, readOnlyColumnIds, selectionRange, transposed, runMutation, blankMutation]);

  const handleGridKeyDown = useCallback((e: KeyboardEvent) => {
    if (hasBlockingShortcutSurface() || !isTableInteractionAllowed(projectSessionId, tableData.uuid) || e.defaultPrevented || isComposingKey(e) || e.repeat) return;
    const target = e.target;
    if (!(target instanceof HTMLElement) || !gridContainerRef.current?.contains(target)) return;
    if (target.isContentEditable || target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]')) return;
    const command = !e.shiftKey && (e.ctrlKey || e.metaKey)
      ? (!e.altKey && e.key.toLowerCase() === 'h' ? 'replace' : !e.altKey && e.key.toLowerCase() === 'g' ? 'goto'
        : e.altKey && e.key.toLowerCase() === 'v' ? 'paste' : null)
      : !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'F5' ? 'goto' : null;
    if (command) { e.preventDefault(); openGridCommand(command); return; }
    const filterKey = (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowDown')
      || (!e.altKey && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l');
    if (filterKey) {
      e.preventDefault();
      if (filterSortDisabled || gridContainerRef.current?.querySelector('.rdg-editor-container')) return;
      const columnUuid = selectedCellIdentity.current?.columnUuid;
      const trigger = Array.from(workspaceRef.current?.querySelectorAll<HTMLButtonElement>('[data-filter-column]') ?? [])
        .find(button => button.dataset.filterColumn === columnUuid && !button.disabled);
      trigger?.click();
      return;
    }
    if (e.altKey) return;
    if (e.key === 'F4' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      if (mutation.busy || gridContainerRef.current?.querySelector('.rdg-editor-container')) return;
      const operation = repeatOperation.current;
      if (operation?.kind === 'fill') void handleFill(operation.direction);
      else if (operation?.kind === 'clear') void handleClear(false);
      else if (operation?.kind === 'input') void handleBulkInput(operation.value);
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && (key === 'z' || key === 'y')) { e.preventDefault(); void (key === 'y' || e.shiftKey ? redo() : undo()); }
    else if (ctrl && !e.shiftKey && key === 'c') { e.preventDefault(); void handleCopy().catch(error => setOperationError(gridErrorNotice(message('grid.copyFailed'), error))); }
    // Let Ctrl/Cmd+V dispatch the native paste event. Its clipboardData is available
    // to onPasteCapture without WebKit's asynchronous clipboard-read permission.
    else if (ctrl && !e.shiftKey && key === 'x') { e.preventDefault(); void handleClear(true); }
    else if (ctrl && !e.shiftKey && (key === 'd' || key === 'r')) { e.preventDefault(); void handleFill(key === 'd' ? 'down' : 'right'); }
  }, [projectSessionId, tableData.uuid, undo, redo, handleCopy, handleClear, handleFill, handleBulkInput, mutation.busy, filterSortDisabled, openGridCommand]);
  useEffect(() => {
    document.addEventListener('keydown', handleGridKeyDown);
    return () => { document.removeEventListener('keydown', handleGridKeyDown); };
  }, [handleGridKeyDown]);

  const createRow = useCallback(async (beforeRecordUuid?: string) => {
    await runMutation(async signal => {
      const displayed = await blankMutation();
      const draft = await invoke<RecordDraft>('prepare_record_draft', { tableUuid: tableData.uuid, expectedProjectSession: projectSessionId });
      if (signal.aborted) return null;
      if (draft.revision !== displayed.expected_revision) throw localizedError(message('grid.waitForPresentation'));
      // An ordinary row inherits its column defaults immediately. Any existing
      // default/rule mismatch is shown on the saved cells for inline correction.
      return { table_uuid: draft.table_uuid, expected_revision: draft.revision, cells: [], versions: [], delete_record_uuids: [],
        create_records: [{ record_uuid: draft.record_uuid, values: [], before_record_uuid: beforeRecordUuid || null }] };
    });
  }, [projectSessionId, runMutation, tableData.uuid, blankMutation]);
  const handleAddRow = useCallback(async () => { await createRow(); }, [createRow]);

  const handleAddRows = useCallback(async () => {
    await runMutation(async signal => {
      const request = await blankMutation();
      return showBulkRowDialog(request.table_uuid, request.expected_revision, projectSessionId, signal);
    });
  }, [runMutation, blankMutation, projectSessionId]);

  // Add column functionality
  const handleAddColumn = useCallback(async () => {
    if (!tableData.metadata.edit_permissions.add_columns) { setOperationError(message('table.edit.columnsBlocked')); return; }
    if (!getCurrentPresentation()) return;
    setColumnEditor(current => current || { target: { mode: 'table', target_uuid: tableData.uuid, column_uuid: null } });
  }, [tableData.uuid, tableData.metadata.edit_permissions.add_columns, getCurrentPresentation]);


  // Identify persistence targets by UUID, independent of indicator/version columns or display order.
  const handleColumnResize = useCallback((column: { key: string }, width: number) => {
    if (!isTableInteractionAllowed(projectSessionId, tableData.uuid)) return;
    if (transposed) {
      if (sourceRowsById.has(column.key)) setTransposedWidths(previous => ({ ...previous, [column.key]: width }));
      return;
    }
    if (tableData.schema.columns.some(definition => definition.uuid === column.key)) {
      queueColumnWidth(column.key, width);
    }
  }, [projectSessionId, tableData.uuid, tableData.schema.columns, queueColumnWidth, transposed, sourceRowsById]);

  // Drag-to-reorder columns. sourceKey/targetKey are column.uuid values.
  // Move source to target's position in the target table's schema array.
  // Interface-derived and custom columns can both be reordered freely
  const handleColumnsReorder = useCallback(async (sourceKey: string, targetKey: string) => {
    if (transposed || !getCurrentPresentation() || sourceKey === targetKey) return;
    const schema = tableData.schema.columns;
    const targetIndex = schema.findIndex((c) => c.uuid === targetKey);
    const sourceExists = schema.some((c) => c.uuid === sourceKey);
    // Exclude columns absent from the schema, such as the version column
    if (targetIndex < 0 || !sourceExists) return;

    await runExclusiveMutation(async signal => {
    try {
      setIsUpdating(true);
      if (!getCurrentPresentation() || signal.aborted) return;
      const result = await invoke('move_column', {
        tableUuid: tableData.uuid, expectedProjectSession: projectSessionId,
        columnUuid: sourceKey,
        newIndex: targetIndex,
      });
      if (result === 'ok') {
        await invoke('save_project', { expectedProjectSession: projectSessionId });
        await refreshData();
      } else {
        console.error('Failed to move column:', result);
      }
    } catch (error) {
      console.error('Failed to move column:', error);
    } finally {
      setIsUpdating(false);
    }
    });
  }, [projectSessionId, tableData.schema.columns, tableData.uuid, refreshData, runExclusiveMutation, getCurrentPresentation, transposed]);

  // Context menu handlers
  const handleDeleteRow = useCallback(async (rowIndex: number) => {
    const record = tableData.records[rowIndex];
    if (!record) return;
    await runMutation(async () => ({ ...await blankMutation(), delete_record_uuids: [record.uuid] }));
  }, [tableData.records, runMutation, blankMutation]);

  const handleInsertRow = useCallback(async (position: 'above' | 'below', rowIndex: number) => {
    if (rowIndex < 0) { setOperationError(message('grid.insertTargetDeleted')); return; }
    const index = position === 'above' ? rowIndex : rowIndex + 1;
    await createRow(tableData.records[index]?.uuid);
  }, [createRow, tableData.records]);

  const handleDeleteColumn = useCallback(async (columnUuid: string) => {
    if (!getCurrentPresentation()) return false;
    return runExclusiveMutation(async signal => {
      if (signal.aborted || !getCurrentPresentation()) return;
      const result = await invoke<string>('remove_column', { tableUuid: tableData.uuid, expectedProjectSession: projectSessionId, columnUuid });
      if (result !== 'ok') throw new Error(result);
      await refreshData();
    });
  }, [projectSessionId, tableData.uuid, refreshData, runExclusiveMutation, getCurrentPresentation]);

  const handleInsertColumn = useCallback(async (position: 'left' | 'right', columnIndex: number) => {
    if (!tableData.metadata.edit_permissions.add_columns) { setOperationError(message('table.edit.columnsBlocked')); return; }
    if (!getCurrentPresentation()) return;
    // Calculate the insertion index based on position
    const insertIndex = position === 'left' ? columnIndex : columnIndex + 1;

    setColumnEditor(current => current || { target: { mode: 'table', target_uuid: tableData.uuid, column_uuid: null, insert_index: insertIndex } });
  }, [tableData.uuid, tableData.metadata.edit_permissions.add_columns, getCurrentPresentation]);

  const handleStructuralShortcut = useCallback((event: KeyboardEvent) => {
    if (hasBlockingShortcutSurface() || event.defaultPrevented || isComposingKey(event) || event.repeat || event.altKey
      || !(event.ctrlKey || event.metaKey) || !isTableInteractionAllowed(projectSessionId, tableData.uuid)
      || mutation.busy || !(event.target instanceof HTMLElement)
      || !gridContainerRef.current?.contains(event.target)
      || event.target.closest('input, textarea, select, [contenteditable], [role="dialog"], [role="menu"]')) return;
    const insert = event.key === '+' || (event.key === '=' && event.shiftKey) || event.code === 'NumpadAdd';
    const remove = event.key === '-' || event.code === 'NumpadSubtract';
    if (!insert && !remove) return;
    event.preventDefault();
    if (!selectionRange?.axis) { setStructuralHint(true); return; }
    setStructuralHint(false);
    const cells = selectedCells();
    const recordsAxis = transposed ? selectionRange.axis === 'column' : selectionRange.axis === 'row';
    if (recordsAxis) {
      const ids = [...new Set(cells.map(cell => cell.row.rowId))]; if (!ids.length) return;
      if (insert) {
        if (!tableData.metadata.edit_permissions.add_rows) return;
        void runMutation(async signal => {
          const request = await blankMutation();
          for (let index = 0; index < ids.length; index++) {
            const draft = await invoke<RecordDraft>('prepare_record_draft', { tableUuid: tableData.uuid, expectedProjectSession: projectSessionId });
            if (signal.aborted) return null;
            if (draft.revision !== request.expected_revision) throw localizedError(message('grid.waitForPresentation'));
            request.create_records.push({ record_uuid: draft.record_uuid, values: [], before_record_uuid: ids[0] });
          }
          return request;
        });
      } else if (tableData.metadata.edit_permissions.delete_rows) {
        void runMutation(async () => ({ ...await blankMutation(), delete_record_uuids: ids }));
      }
    } else {
      const ids = [...new Set(cells.map(cell => cell.key))];
      // Multiple columns require one native atomic command, not separate commits.
      if (ids.length !== 1) { setStructuralHint(true); return; }
      const index = tableData.schema.columns.findIndex(column => column.uuid === ids[0]); if (index < 0) return;
      if (insert && tableData.metadata.edit_permissions.add_columns) void handleInsertColumn('left', index);
      else if (remove && tableData.metadata.edit_permissions.delete_columns) void handleDeleteColumn(ids[0]);
    }
  }, [projectSessionId, tableData, mutation.busy, selectionRange, selectedCells, transposed, runMutation, blankMutation, handleInsertColumn, handleDeleteColumn]);
  useEffect(() => {
    document.addEventListener('keydown', handleStructuralShortcut);
    return () => document.removeEventListener('keydown', handleStructuralShortcut);
  }, [handleStructuralShortcut]);

  const renderRuntimeHeader = useCallback<HeaderRenderer>((column, columnIndex) => createAdvancedHeaderCell({
          column,
          columnIndex,
          tableUuid,
          onInsertLeft: idx => { void handleInsertColumn('left', idx); },
          onInsertRight: idx => { void handleInsertColumn('right', idx); },
          onEdit: () => setColumnEditor(current => current || {
            target: { mode: 'table', target_uuid: tableUuid, column_uuid: column.uuid }
          }),
          isUpdating: isUpdating || mutation.busy || !snapshotReady,
          insertAllowed: tableData.metadata.edit_permissions.add_columns,
          interfaceMap,
          filterButton: renderFilterButton(column),
          versionBadge: versionEditMode ? <VersionBadge
            key={`${projectSessionId}/${tableUuid}/${column.uuid}/${column.interface_origin || ''}`}
            contextKey={`${projectSessionId}/${tableUuid}/${column.uuid}/${column.interface_origin || ''}`}
            value={column.min_version}
            label={translation.t('grid.version.columnLabel', { name: settingsDisplayLabel(column.uuid, column.display_name || column.data_name) })}
            messages={{ invalid: translation.t('grid.version.invalid'), saveFailed: translation.t('grid.version.saveFailed') }}
            disabled={isUpdating || mutation.busy || !snapshotReady}
            sourceReason={column.interface_origin ? translation.t('grid.version.inherited') : undefined}
            onRequestSource={column.interface_origin ? () => setColumnEditor(current => current || {
              target: { mode: 'table', target_uuid: tableUuid, column_uuid: column.uuid }, tab: 'origin'
            }) : undefined}
            onCommit={value => commitVersion('column', column.uuid, value)}
          /> : undefined
        }), [tableUuid, projectSessionId, interfaceMap, versionEditMode, translation, isUpdating,
    mutation.busy, snapshotReady, commitVersion, handleInsertColumn, renderFilterButton, tableData.metadata.edit_permissions.add_columns]);

  // Row numbers use indices from the original snapshot, distinct from display or filter indices.
  const renderRuntimeIndicator = useCallback<NonNullable<RowIndicatorConfig<GridRow>['renderIndicator']>>((props) => {
      const actualRowIndex = props.row.rowIndex;
      // Both resize and insertion boundaries follow displayed neighbors.
      // Hidden records must not make the same boundary mean two positions.
      const previousRowId = visibleRows[props.rowIdx - 1]?.rowId;

      return createAdvancedRowCell({
        row: { ...props.row, rowLabel: props.row.tableRecord ? recordDisplayLabel(props.row.tableRecord, tableData, actualRowIndex) : props.row.rowLabel },
        insertAllowed: tableData.metadata.edit_permissions.add_rows,
        editAllowed: tableData.metadata.edit_permissions.edit_cells,
        rowIndex: actualRowIndex,
        previousRowId,
        parentIndicator: props.row.tableRecord?.parent_uuid ? <button type="button" className="shrink-0 px-1 text-primary" title={`${translation.t('metadata.parent')}: ${(() => { const parent = tableData.records.find(row => row.uuid === props.row.tableRecord?.parent_uuid); return parent ? recordReferenceLabel(parent, tableData) : translation.t('metadata.parent'); })()}`} aria-label={translation.t('metadata.parent')} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); const parent = props.row.tableRecord?.parent_uuid; const index = visibleRows.findIndex(row => row.rowId === parent); if (index >= 0) dataGridRef.current?.selectCell({ rowIdx: index, idx: 1 }); else { const presentation = getCurrentPresentation(); if (presentation) setMetadataEdit({ kind: 'parent', recordUuid: props.row.rowId, revision: presentation.revision, table: tableData }); } }}>↥</button> : undefined,
        isLastVisibleRow: props.rowIdx === visibleRows.length - 1,
        isFirstVisibleRow: props.rowIdx === 0,
        onContextMenu: (e, _idx) => {
          setContextMenu({
            type: 'row',
            x: e.clientX,
            y: e.clientY,
            rowIndex: actualRowIndex, recordUuid: props.row.rowId
          });
        },
        onDoubleClick: (e, _idx) => {
          const record = tableData.records[actualRowIndex];
          if (record) {
            const dialogState = {
              isOpen: true,
              type: 'row' as const,
              position: {
                x: e.clientX || 100,
                y: e.clientY || 100
              },
              rowIndex: actualRowIndex,
              recordUuid: record.uuid,
              initialValue: record.label ?? ''
            };
            setInlineEditDialog(dialogState);
          }
        },
        onInsertAbove: async (_idx) => {
          setIsUpdating(true);
          try {
            // This top button is the sole owner of the visible boundary.
            await createRow(props.row.rowId);
          } finally {
            setIsUpdating(false);
          }
        },
        onInsertBelow: async (_idx) => {
          setIsUpdating(true);
          try {
            // Only the last visible row renders a bottom button.
            await createRow();
          } finally {
            setIsUpdating(false);
          }
        },
        isUpdating: isUpdating || mutation.busy || !snapshotReady,
        versionBadge: versionEditMode && props.row.tableRecord ? <VersionBadge
          key={`${projectSessionId}/${tableData.uuid}/${props.row.rowId}`}
          contextKey={`${projectSessionId}/${tableData.uuid}/${props.row.rowId}`}
          value={props.row.tableRecord.min_version}
          label={translation.t('grid.version.rowLabel', { number: formatNumber(actualRowIndex + 1) })}
          messages={{ invalid: translation.t('grid.version.invalid'), saveFailed: translation.t('grid.version.saveFailed') }}
          disabled={isUpdating || mutation.busy || !snapshotReady || !tableData.metadata.edit_permissions.edit_cells}
          disabledReason={!tableData.metadata.edit_permissions.edit_cells ? translation.t('table.edit.structureBlocked') : undefined}
          onCommit={value => commitVersion('row', props.row.rowId, value)}
        /> : undefined,
        onRowResize: (rowId, height) => {
          if (!isResizing) setIsResizing(true);
          setRowHeight(rowId, height);
        },
        onRowResizeEnd: () => {
          setIsResizing(false);
        }
      });
    }, [visibleRows, tableData, createRow, isUpdating, mutation.busy, isResizing, setRowHeight, versionEditMode, projectSessionId, translation, snapshotReady, commitVersion, getCurrentPresentation]);
  const rowIndicator = useMemo<RowIndicatorConfig<GridRow>>(() => ({
    width: versionEditMode ? 180 : 120,
    showNumbers: true, showActions: true, format: 'combined', headerContent: <div className="rdg-corner-inserts">
      {atScrollTop && tableData.metadata.edit_permissions.add_rows && <button type="button" className="rdg-first-row-insert" title={translation.t('grid.addRowAbove')}
        disabled={isUpdating || mutation.busy || !snapshotReady || !tableData.metadata.edit_permissions.add_rows}
        onClick={event => { event.stopPropagation(); void createRow(visibleRows[0]?.rowId); }}><GridInsertIcon /></button>}

    </div>,
    headerClassName: 'rdg-row-indicator-header', getRowLabel: row => row.tableRecord ? recordDisplayLabel(row.tableRecord, tableData, row.rowIndex) : row.rowLabel || '',
    renderIndicator: props => <RuntimeIndicator {...props} />,
    className: 'rdg-cell-frozen rdg-row-index rdg-cell-has-inline-buttons'
  }), [versionEditMode, tableData, atScrollTop, translation, isUpdating, mutation.busy, snapshotReady, createRow, visibleRows]);
  const referenceRuntime = useMemo(() => ({ tableData, refreshVersion: referenceRefreshVersion }),
    [tableData, referenceRefreshVersion]);
  // Orientation is local UI state. Never write table metadata or infer data IDs
  // from a displayed row/column index. An unresolved editor must keep its draft.
  const changeTranspose = useCallback((next: boolean) => {
    if (next === transposed || isUpdating || isMutationBusy() || !snapshotReady || interactionLocked
      || inlineEditDialog || showInterfaceDialog || columnEditor
      || gridContainerRef.current?.querySelector('.rdg-editor-container, [data-version-badge] input')) return;
    stopAutoScroll();
    setContextMenu(null);
    setSelectionRange(null);
    setTransposed(next);
    if (gridContainerRef.current) {
      gridContainerRef.current.scrollLeft = 0;
      gridContainerRef.current.scrollTop = 0;
    }
  }, [transposed, isUpdating, isMutationBusy, snapshotReady, interactionLocked, inlineEditDialog,
    showInterfaceDialog, columnEditor, stopAutoScroll]);

  const renderTransposedHeader = useCallback((row: GridRow) => <InsertionHeader
    className="rdg-transpose-record-header rdg-advanced-column" title={row.tableRecord ? recordDisplayLabel(row.tableRecord, tableData, row.rowIndex) : row.rowLabel}>
    <span className="truncate">{formatNumber(row.rowIndex + 1)}: {row.tableRecord ? recordDisplayLabel(row.tableRecord, tableData, row.rowIndex) : row.rowLabel}</span>
    {row.tableRecord?.parent_uuid && <span className="shrink-0 text-primary" title={`${translation.t('metadata.parent')}: ${(() => { const parent = tableData.records.find(record => record.uuid === row.tableRecord?.parent_uuid); return parent ? recordReferenceLabel(parent, tableData) : translation.t('metadata.parent'); })()}`}>↥</span>}
    {tableData.metadata.edit_permissions.add_rows && (['left', 'right'] as const).map(position => <div key={position}
      className={`rdg-column-insert-control rdg-column-insert-${position === 'left' ? 'start' : 'end'}`}>
      <button type="button" className="rdg-boundary-button"
        title={translation.t(position === 'left' ? 'grid.addRowAbove' : 'grid.addRowBelow')}
        disabled={isUpdating || mutation.busy || !snapshotReady || !tableData.metadata.edit_permissions.add_rows}
        onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}
        onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}
        onClick={event => { event.stopPropagation(); if (event.detail < 2) void createRow(position === 'left' ? row.rowId : visibleRows[visibleRows.findIndex(item => item.rowId === row.rowId) + 1]?.rowId); }}><GridInsertIcon /></button>
    </div>)}
    {versionEditMode && row.tableRecord && <VersionBadge
      contextKey={`${projectSessionId}/${tableUuid}/${row.rowId}`}
      value={row.tableRecord.min_version}
      label={translation.t('grid.version.rowLabel', { number: formatNumber(row.rowIndex + 1) })}
      messages={{ invalid: translation.t('grid.version.invalid'), saveFailed: translation.t('grid.version.saveFailed') }}
      disabled={isUpdating || mutation.busy || !snapshotReady || !tableData.metadata.edit_permissions.edit_cells}
      disabledReason={!tableData.metadata.edit_permissions.edit_cells ? translation.t('table.edit.structureBlocked') : undefined}
      onCommit={value => commitVersion('row', row.rowId, value)} />}
  </InsertionHeader>, [versionEditMode, projectSessionId, tableUuid, translation, isUpdating, mutation.busy, snapshotReady, commitVersion, tableData, createRow, visibleRows]);
  const editTransposedRecordLabel = useCallback((row: GridRow, event: React.MouseEvent<HTMLDivElement>) => {
    if (!tableData.metadata.edit_permissions.edit_cells) { setOperationError(message('table.edit.structureBlocked')); return; }
    if (isMutationBusy() || !snapshotReady) return;
    setInlineEditDialog({ isOpen: true, type: 'row', position: { x: event.clientX || 100, y: event.clientY || 100 },
      rowIndex: row.rowIndex, recordUuid: row.rowId, initialValue: row.tableRecord?.label ?? row.rowLabel ?? '' });
  }, [isMutationBusy, snapshotReady, tableData.metadata.edit_permissions.edit_cells]);
  const openTransposedRecordMenu = useCallback((row: GridRow, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (isMutationBusy() || !snapshotReady) return;
    setContextMenu({ type: 'row', x: event.clientX, y: event.clientY, rowIndex: row.rowIndex, recordUuid: row.rowId });
  }, [isMutationBusy, snapshotReady]);
  const transposedColumns = useMemo(() => transposed ? createTransposedColumns({
    sourceRows: visibleRows, sourceColumns: columns,
    getWidth: createTransposedWidthResolver(transposedWidths, tableData),
    renderHeader: renderTransposedHeader,
    onHeaderDoubleClick: editTransposedRecordLabel,
    onHeaderContextMenu: openTransposedRecordMenu
  }).map(column => column.key === highlightedRecord ? { ...column,
    headerCellClass: 'rdg-transpose-record-highlight',
    cellClass: (row: GridRow) => `${typeof column.cellClass === 'function' ? column.cellClass(row) : column.cellClass || ''} rdg-transpose-record-highlight`
  } : column) : [], [transposed, visibleRows, columns, transposedWidths, renderTransposedHeader, editTransposedRecordLabel,
    openTransposedRecordMenu, highlightedRecord, tableData]);
  const viewColumns = transposed ? transposedColumns : columns;
  const restoreOrientedSelection = useCommittedEvent(() => {
    const identity = selectedCellIdentity.current;
    if (!identity) return;
    const rowIdx = viewRows.findIndex(row => row.rowId === (transposed ? identity.columnUuid : identity.recordUuid));
    const idx = viewColumns.findIndex(column => column.key === (transposed ? identity.recordUuid : identity.columnUuid));
    if (rowIdx < 0 || idx < 0) { selectedCellIdentity.current = null; setSelectionRange(null); return; }
    // Do not steal focus from the settings dialog while its radio applies.
    dataGridRef.current?.selectCell({ rowIdx, idx: idx + 1 }, { shouldFocusCell: false });
    setSelectionRange({ start: { rowIdx, idx }, end: { rowIdx, idx } });
  });
  useLayoutEffect(() => { restoreOrientedSelection(); }, [transposed, restoreOrientedSelection]);

  const transposedIndicator = useMemo<RowIndicatorConfig<GridRow>>(() => ({
    width: Math.max(200, ...displayColumns.map(column => initialHeaderWidth(settingsDisplayLabel(column.uuid, column.display_name || column.data_name), 200, 360))),
    showNumbers: false, showActions: false, headerContent: <div className="rdg-corner-inserts">
      {atScrollTop && tableData.metadata.edit_permissions.add_columns && <button type="button" className="rdg-first-row-insert" title={translation.t('grid.addColumnLeft')}
        disabled={isUpdating || mutation.busy || !snapshotReady || !tableData.metadata.edit_permissions.add_columns}
        onClick={event => { event.stopPropagation(); void handleInsertColumn('left', 0); }}><GridInsertIcon /></button>}

    </div>,
    headerClassName: 'rdg-row-indicator-header', className: 'rdg-cell-frozen rdg-row-index rdg-cell-has-inline-buttons',
    getRowLabel: row => row.rowLabel,
    renderIndicator: ({ row, rowIdx, isCellSelected }) => {
      const definition = displayColumns[row.rowIndex];
      if (!definition) return null;
      const openEditor = (tab?: string) => {
        if (isMutationBusy() || !snapshotReady) return;
        setColumnEditor(current => current || { target: { mode: 'table', target_uuid: tableUuid,
          column_uuid: definition.uuid }, tab });
      };
      return <div className={`rdg-advanced-row rdg-transpose-field-header${previewActive && (definition.min_version) > releaseVersion ? ' rdg-version-excluded' : ''}`}
        data-row-id={row.rowId} onDoubleClick={() => openEditor()}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openEditor('display'); }}>
        {tableData.metadata.edit_permissions.add_columns && [...(rowIdx > 0 ? ['left'] as const : []), ...(rowIdx === transposedRows.length - 1 ? ['right'] as const : [])].map(position => <button
          key={position} type="button" className={`rdg-transpose-column-insert rdg-transpose-column-insert-${position}`}
          title={translation.t(position === 'left' ? 'grid.addColumnLeft' : 'grid.addColumnRight')}
          aria-label={translation.t(position === 'left' ? 'grid.addColumnLeft' : 'grid.addColumnRight')}
          disabled={isUpdating || mutation.busy || !snapshotReady || !tableData.metadata.edit_permissions.add_columns}
          onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
          onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}
          onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); }}
          onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
          onKeyDown={event => event.stopPropagation()} onFocus={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); if (event.detail < 2) void handleInsertColumn(position, rowIdx); }}><GridInsertIcon /></button>)}
        <HeaderDescription text={definition.memo_text} selected={Boolean(isCellSelected)}>
        <button type="button" className="rdg-transpose-field-label" title={settingsTooltip(definition.uuid, definition.tooltip || '') || `${settingsDisplayLabel(definition.uuid, definition.display_name || definition.data_name)} (${definition.data_name})`}
          disabled={isUpdating || mutation.busy || !snapshotReady}
          onClick={event => { event.stopPropagation(); if (event.detail === 0) openEditor(); }}
          onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); openEditor(); }}
          onKeyDown={event => event.stopPropagation()}>
          {definition.interface_origin && <span className="rdg-interface-origin-label" title={interfaceOriginLabel(definition, interfaceMap)}>{interfaceOriginLabel(definition, interfaceMap)}</span>}
          <span className="rdg-field-display-label">{settingsDisplayLabel(definition.uuid, definition.display_name || definition.data_name)}</span>
        </button>
        </HeaderDescription>
        {versionEditMode && <VersionBadge
          contextKey={`${projectSessionId}/${tableUuid}/${definition.uuid}/${definition.interface_origin || ''}`}
          value={definition.min_version}
          label={translation.t('grid.version.columnLabel', { name: settingsDisplayLabel(definition.uuid, definition.display_name || definition.data_name) })}
          messages={{ invalid: translation.t('grid.version.invalid'), saveFailed: translation.t('grid.version.saveFailed') }}
          disabled={isUpdating || mutation.busy || !snapshotReady}
          sourceReason={definition.interface_origin ? translation.t('grid.version.inherited') : undefined}
          onRequestSource={definition.interface_origin ? () => openEditor('origin') : undefined}
          onCommit={value => commitVersion('column', definition.uuid, value)} />}
        {renderFilterButton(definition)}
        <RowResizeHandle rowId={row.rowId} previousRowId={transposedRows[rowIdx - 1]?.rowId}
          onRowResize={(rowId, height) => { setIsResizing(true); setTransposedHeights(previous => ({ ...previous, [rowId]: height })); }}
          onRowResizeEnd={() => setIsResizing(false)} />
      </div>;
    }
  }), [atScrollTop, displayColumns, transposedRows, tableUuid, projectSessionId, versionEditMode, previewActive, releaseVersion,
    isUpdating, mutation.busy, isMutationBusy, snapshotReady, translation, interfaceMap, commitVersion, renderFilterButton, handleInsertColumn, tableData.metadata.edit_permissions.add_columns]);
  const viewCellBackgroundColor = useCallback<NonNullable<DataGridProps<GridRow>['getCellBackgroundColor']>>((row, column, state) => {
    if (!transposed) return getGridCellBackgroundColor(row, column, state);
    const cell = resolveViewCell(row, column.key);
    const sourceColumn = cell && sourceColumnsById.get(cell.key);
    return cell && sourceColumn ? getGridCellBackgroundColor(cell.row, { ...column, ...sourceColumn } as typeof column, state) : undefined;
  }, [transposed, resolveViewCell, sourceColumnsById]);

  // Banners/sidebar can change the owner's available box before ResizeObserver
  // fires. Use displayed semantics, not snapshot references or ready/busy state.
  const viewportPlacementKey = JSON.stringify([versionEditMode, transposed, Boolean(columnEditor), Boolean(filters.length || sorts.length), locale,
    mutation.error || resolveGridError(operationError) || presentationState.error || '',
    presentationState.presentation?.definition_issues.map(localizeError) ?? [],
    presentationState.presentation?.issue_count
      ? translation.t('grid.inputIssueCount', { count: presentationState.presentation.issue_count }) : '']);

  const handleRowContextMenu = useCallback((row: GridRow, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    setContextMenu({ type: 'row', x: event.clientX, y: event.clientY,
      rowIndex: row.rowIndex, recordUuid: row.rowId });
  }, []);

  const navigationState = useRef({ inlineEditDialog, showInterfaceDialog, showSortDialog });
  navigationState.current = { inlineEditDialog, showInterfaceDialog, showSortDialog };
  useEffect(() => registerTableNavigationBlocker(() => !isMutationBusy()
    && !navigationState.current.inlineEditDialog && !navigationState.current.showInterfaceDialog && !navigationState.current.showSortDialog
    && !gridContainerRef.current?.querySelector('.rdg-editor-container')), [isMutationBusy]);

  return (
    <FormulaCompletionProvider session={projectSessionId} tableUuid={tableData.uuid}>
    <div ref={workspaceRef} className={`column-workspace ${columnEditor ? 'is-editing' : ''}`}>
    <div className="column-workspace-main relative h-full flex flex-col">
      {gridCommand && <GridCommandDialog request={gridCommand} onClose={closeGridCommand} />}
      {structuralHint && <div role="status" className="border-b px-3 py-2 text-sm">
        {translation.t('grid.deleteRow')}: <kbd>{transposed ? 'Ctrl+Space' : 'Shift+Space'} → Ctrl+-</kbd>
        {' · '}{translation.t('grid.deleteColumn')} (1): <kbd>{transposed ? 'Shift+Space' : 'Ctrl+Space'} → Ctrl+-</kbd>
        <button type="button" className="ms-3 underline" onClick={() => setStructuralHint(false)}>{translation.t('common.close')}</button>
      </div>}
      <div className="shrink-0 border-b border-border px-4 py-2">
        <DescriptionEditor key={`${projectSessionId}:${tableData.uuid}:description`}
          draftKey={`${projectSessionId}:devcel:text-draft:table-description:${tableData.uuid}`}
          value={tableData.description} revision={presentationState.presentation?.revision ?? ''} label={translation.t('common.description')}
          disabled={!snapshotReady || mutation.busy || previewActive || !!editSettings || !!columnEditor}
          onEditingChange={setDescriptionEditing}
          onRead={async () => {
            const presentation = await refreshPresentation();
            const snapshot = lastDeliveredSnapshot.current;
            if (!presentation || !snapshot || snapshot.presentation.revision !== presentation.revision) throw localizedError(message('grid.waitForPresentation'));
            return { value: snapshot.table.description, revision: presentation.revision };
          }} onSave={async (description, revision) => {
            let failure: unknown;
            const saved = await runExclusiveMutation(async signal => {
              try {
                const presentation = getCurrentPresentation();
                if (signal.aborted || !presentation) throw localizedError(message('grid.waitForPresentation'));
                if (presentation.revision !== revision) throw { kind: 'code', code: 'error.staleData', params: {} };
                const invalidationVersion = getTableSnapshotInvalidationVersion(projectSessionId);
                const result = await invoke<MutationResult>('update_table_edit_settings', { expectedProjectSession: projectSessionId, request: {
                  table_uuid: tableData.uuid, expected_revision: revision, description,
                  display_name: tableData.display_name, initial_transposed: tableData.metadata.initial_transposed,
                  edit_permissions: tableData.metadata.edit_permissions,
                } });
                if (!signal.aborted) {
                  try { acceptMutation(result, invalidationVersion); }
                  catch (error) { setOperationError(gridErrorNotice(message('grid.committedDisplayFailed'), error)); }
                }
              } catch (reason) { failure = reason; throw reason; }
            });
            if (!saved) { clearMutationError(); throw failure ?? localizedError(message('grid.waitForPresentation')); }
          }} />
      </div>
      {/* Keep the full toolbar readable when the editor narrows the grid. */}
      <div className="data-grid-toolbar-viewport shrink-0 min-w-0 overflow-x-auto">
      <DataGridToolbar
        transposed={transposed}
        onTransposeChange={changeTranspose}
        versionEditMode={versionEditMode}
        onVersionEditModeChange={onVersionEditModeChange}
        versionPreview={previewActive}
        onVersionPreviewChange={onVersionPreviewChange}
        releaseVersion={releaseVersion}
        onReleaseVersionChange={onReleaseVersionChange}
        versionControlsDisabled={isUpdating || mutation.busy || !snapshotReady}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onSearch={handleSearch}
        onClear={() => {
          setSearchQuery('');
        }}
        isSearching={isSearching}
        filteredRowCount={visibleRows.length}
        canUndo={canUndo}
        canRedo={canRedo}
        undo={undo}
        redo={redo}
        addRow={handleAddRow}
        addRows={handleAddRows}
        addColumn={handleAddColumn}
        addRowsAllowed={tableData.metadata.edit_permissions.add_rows}
        addColumnsAllowed={tableData.metadata.edit_permissions.add_columns}
        onOpenTableSettings={() => { if (!descriptionEditing) openTableSettings(); }}
        prepareTableSettingsActivation={prepareTableSettingsActivation}
        isUpdating={isUpdating || mutation.busy}
        isSaving={isSaving}
        pendingChangesCount={pendingChanges}
        rowCount={tableData.records.length}
        columnCount={tableData.schema.columns.length}
        zoomLevel={zoomLevel}
        setZoomLevel={setZoomLevel}
      />
      </div>
      {(filters.length > 0 || sorts.length > 0) && <div className="grid-filter-sort-status" role="status">
        <span>{translation.t('grid.filterSort.resultCount', { count: formatNumber(visibleRows.length), total: formatNumber(rows.length) })}</span>
        <button type="button" disabled={filterSortDisabled} onClick={() => {
          if (filterSortDisabled || gridContainerRef.current?.querySelector('.rdg-editor-container, [data-version-badge] input')) return;
          updateFilterSort({ filters: [], sorts: [] });
        }}>{translation.t('grid.filterSort.clearAll')}</button>
      </div>}
      <GridSortDialog open={showSortDialog} onOpenChange={setShowSortDialog} columns={displayColumns} sorts={sorts} onApply={changeSorts} />

      {Boolean(mutation.error || operationError || presentationState.error) && <div role="alert" className="border-b bg-red-50 text-red-900 text-sm p-3 whitespace-pre-wrap">
        {mutation.error || resolveGridError(operationError) || presentationState.error}
        {(mutation.error ? canRefreshGridError(mutation.rawError) : operationError ? canRefreshGridError(operationError) : Boolean(presentationState.error)) &&
          <button className="underline ml-3" onClick={() => { clearMutationError(); setOperationError(null); void refreshData(); }}>{translation.t('grid.reload')}</button>}
      </div>}
      {presentationState.presentation?.definition_issues.map((issue, index) => <p key={index} role="alert" className="text-sm bg-amber-50 text-amber-900 px-3 py-1">{localizeError(issue)}</p>)}
      {!!presentationState.presentation?.issue_count && <p className="text-xs bg-amber-50 text-amber-900 px-3 py-1">{translation.t('grid.inputIssueCount', { count: presentationState.presentation.issue_count })}</p>}
      {/* Transient status must not move a boundary between the two presses of a doubleclick. */}
      <div className="rdg-transient-status-overlay">
        {!snapshotReady && !presentationState.error && !presentationState.backgroundRefreshing && <p role="status" className="text-xs bg-muted px-3 py-1">
          {translation.t(presentationState.cancelled ? 'grid.loading.cancelled' : 'grid.preparingPresentation')}
          {presentationState.refreshing && <button type="button" className="underline ml-3" style={{ pointerEvents: 'auto' }}
            onClick={presentationState.cancel}>{translation.t('common.cancel')}</button>}
          {presentationState.cancelled && <button type="button" className="underline ml-3" style={{ pointerEvents: 'auto' }}
            onClick={() => { void refreshData(); }}>{translation.t('common.retry')}</button>}
        </p>}
        {mutation.busy && <p role="status" className="text-xs bg-blue-50 px-3 py-1">{translation.t('grid.savingWithConfirmation')}</p>}
      </div>

      {/* Data Grid */}
      <div className="flex-1 overflow-hidden">
        {rows.length === 0 && tableData.schema.columns.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
            <div className="text-lg mb-2">{translation.t('grid.emptyTable')}</div>
          </div>
        ) : (
          <div
            ref={gridContainerRef}
            onScroll={event => { setAtScrollTop(event.currentTarget.scrollTop < 1); }}
            dir="ltr"
            className="h-full rdg-scroll-owner"
            onPointerMoveCapture={handleContainerPointerMove}
            onPasteCapture={event => {
              const target = event.target;
              if (target instanceof HTMLElement && target.closest('.rdg-editor-container, input:not([type="checkbox"]), textarea, select, [contenteditable="true"]')) return;
              event.preventDefault(); event.stopPropagation();
              if (gridContainerRef.current?.querySelector('.rdg-editor-container')) return;
              void handlePaste(event.clipboardData.getData('text/plain'));
            }}
            style={{
              overflow: 'auto',
              position: 'relative',
              // Keyboard focus must remain below the transformed sticky header.
              scrollPaddingTop: `${headerHeight * (zoomLevel / 100)}px`
            }}
          >
            <div ref={physicalExtentRef} className="rdg-physical-extent"
              style={{ position: 'relative', overflow: 'clip', minWidth: '100%', minHeight: '100%' }}>
                <GridTransientLockContext.Provider value={mutation.busy || !snapshotReady}>
                <GridHeaderRuntimeContext.Provider value={renderRuntimeHeader}>
                <GridIndicatorRuntimeContext.Provider value={renderRuntimeIndicator}>
                <GridReferenceRuntimeContext.Provider value={referenceRuntime}>
                <DataGrid
                transientLock={mutation.busy || !snapshotReady}
                retainPendingEditor={bulkEditorPending !== null}
                key={`${projectSessionId}:${tableData.uuid}:${transposed}`}
                ref={dataGridRef}
                columns={viewColumns}
                rows={viewRows}
                externalScrollRef={gridContainerRef}
                externalZoom={zoomLevel / 100}
                externalViewportLayout="stationary-rows"
                externalViewportGeometryKey={viewportPlacementKey}
                externalViewportExtentRef={physicalExtentRef}
                externalViewportPadding={{ inlineEnd: TRAILING_MARGIN, blockEnd: 10 }}
                onRowsChange={handleRowsChange}
                  enableRangeSelection
                onSelectedRangeChange={range => {
                  // DataGrid prepends the row indicator; our columns omit it.
                  // Keep range indexes in the same data-column space as single-cell selection.
                  setSelectionRange(range ? {
                    start: { ...range.start, idx: range.start.idx - 1 },
                    end: { ...range.end, idx: range.end.idx - 1 },
                    axis: range.axis
                  } : null);
                }}
                onCellContextMenu={(args, event) => {
                  const cell = resolveViewCell(args.row, args.column.key);
                  if (!cell || mutation.busy || !snapshotReady) return;
                  event.preventDefault(); event.stopPropagation();
                  setContextMenu(null); setCellMenu({ ...cell, x: event.clientX, y: event.clientY });
                }}
                onCellPaste={({ row }, event) => { event.preventDefault(); void handlePaste(event.clipboardData.getData('text/plain')); return row; }}
                onCellDoubleClick={(args, event) => {
                  const cell = resolveViewCell(args.row, args.column.key);
                  const column = cell?.row.columnDefs?.find(column => column.uuid === cell.key);
                  if (cell && column && isColorType(column.data_type)) { event.preventDefault(); event.preventGridDefault(); openColorEditor(cell.row, column); }
                }}
                onCellKeyDown={(args, event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat || event.altKey) return;
                  if (event.key === 'Enter' && !event.shiftKey && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault(); event.preventGridDefault(); event.stopPropagation();
                    const editor = gridContainerRef.current?.querySelector<HTMLElement>('.rdg-editor-container');
                    if (args.mode === 'EDIT' && !canCommitEditor(editor)) return;
                    const source = resolveViewCell(args.row, args.column.key); if (!source) return;
                    const definition = source.row.columnDefs?.find(column => column.uuid === source.key);
                    const value = args.mode === 'EDIT' ? String(args.row[args.column.key] ?? '')
                      : source.row.cellPresentations?.[source.key]?.raw_value
                        ?? (definition && source.row.tableRecord ? getEffectiveCellValue(source.row.tableRecord, definition) : String(source.row[source.key] ?? ''));
                    const pendingEditor = {};
                    if (args.mode === 'EDIT') setBulkEditorPending(pendingEditor);
                    void handleBulkInput(value).then(committed => {
                      if (committed && args.mode === 'EDIT' && editor?.isConnected) args.onClose(false);
                    }).finally(() => setBulkEditorPending(current => current === pendingEditor ? null : current));
                    return;
                  }
                  if (args.mode === 'SELECT' && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.metaKey))) {
                    const source = resolveViewCell(args.row, args.column.key); if (!source) return;
                    event.preventDefault(); event.preventGridDefault();
                    const rect = (event.target as HTMLElement).closest('[role="gridcell"]')?.getBoundingClientRect();
                    if (rect) setCellMenu({ ...source, x: rect.left + 8, y: rect.bottom });
                    return;
                  }
                  if (args.mode === 'SELECT' && event.key === 'Enter' && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && !event.repeat) {
                    const cell = resolveViewCell(args.row, args.column.key);
                    const column = cell?.row.columnDefs?.find(column => column.uuid === cell.key);
                    if (cell && column?.data_type === 'String') { event.preventDefault(); event.preventGridDefault(); openStringEditor(cell.row, column); return; }
                    if (cell && column && isColorType(column.data_type)) { event.preventDefault(); event.preventGridDefault(); openColorEditor(cell.row, column); return; }
                  }
                  if (args.mode !== 'SELECT' || event.nativeEvent.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
                  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.preventGridDefault(); void handleClear(false); }
                }}
                onColumnResize={handleColumnResize}
                onColumnResizeEnd={flushColumnWidths}
                onColumnsReorder={handleColumnsReorder}
                onSelectedCellChange={(args) => {
                  if (args.rowIdx < 0 || !args.row) { setSelectionRange(null); return; }
                  if (args.rowIdx !== undefined && args.column) {
                    const rowIndex = args.rowIdx;
                    const columnIndex = viewColumnKeys.indexOf(args.column.key);

                    const canonical = resolveViewCell(args.row, args.column.key);
                    if (canonical) selectedCellIdentity.current = { recordUuid: canonical.row.rowId, columnUuid: canonical.key };
                    // Update selection range for copy/paste
                    setSelectionRange({
                      start: { rowIdx: rowIndex, idx: columnIndex },
                      end: { rowIdx: rowIndex, idx: columnIndex }
                    });
                  }
                }}
                className="rdg-light"
              rowClass={transposed ? undefined : gridRowClass}
              rowHeight={gridRowHeight}
              headerRowHeight={headerHeight}
              rowKeyGetter={gridRowKeyGetter}
              // Row indicator configuration
              rowIndicator={transposed ? transposedIndicator : rowIndicator}
              // Row-level context menu handler
              onRowContextMenu={transposed ? undefined : handleRowContextMenu}
              // Performance optimizations
              enableVirtualization={true}
              renderers={{
                noRowsFallback: <div className="text-center text-muted-foreground py-8">{translation.t('grid.noData')}</div>
              }}
              // Cell background color callback
              getCellBackgroundColor={viewCellBackgroundColor}
            />
                </GridReferenceRuntimeContext.Provider>
                </GridIndicatorRuntimeContext.Provider>
                </GridHeaderRuntimeContext.Provider>
                </GridTransientLockContext.Provider>
            </div>
          </div>
        )}
      </div>

      {/* Dialogs and menus outside of zoom container */}
      {/* Context Menu - Row only */}
      {contextMenu && contextMenu.type === 'row' && (
        <DataGridContextMenu
          type={contextMenu.type}
          transposed={transposed}
          addAllowed={tableData.metadata.edit_permissions.add_rows}
          deleteAllowed={tableData.metadata.edit_permissions.delete_rows}
          pluginContext={{ tableId: tableData.uuid, table: tableData, rowIndex: contextMenu.rowIndex, record: contextMenu.rowIndex === undefined ? undefined : tableData.records[contextMenu.rowIndex] }}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onEditTags={() => { const presentation = getCurrentPresentation(); if (presentation && contextMenu.recordUuid) setMetadataEdit({ kind: 'tags', recordUuid: contextMenu.recordUuid, revision: presentation.revision, table: tableData }); }}
          onEditParent={() => { const presentation = getCurrentPresentation(); if (presentation && contextMenu.recordUuid) setMetadataEdit({ kind: 'parent', recordUuid: contextMenu.recordUuid, revision: presentation.revision, table: tableData }); }}
          metadataAllowed={tableData.metadata.edit_permissions.edit_cells && !mutation.busy && snapshotReady}
          // Row actions
          onAddRowAbove={contextMenu.rowIndex !== undefined ?
            () => handleInsertRow('above', tableData.records.findIndex(record => record.uuid === contextMenu.recordUuid)) : undefined}
          onAddRowBelow={contextMenu.rowIndex !== undefined ?
            () => handleInsertRow('below', tableData.records.findIndex(record => record.uuid === contextMenu.recordUuid)) : undefined}
          onDeleteRow={contextMenu.rowIndex !== undefined ?
            () => handleDeleteRow(tableData.records.findIndex(record => record.uuid === contextMenu.recordUuid)) : undefined}
        />
      )}

      {cellMenu && <div className="fixed inset-0 z-[70]" onClick={closeCellMenu} onContextMenu={event => { event.preventDefault(); closeCellMenu(); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCellMenu(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
        if (!items.length) return;
        event.preventDefault(); event.stopPropagation();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
        items[next].focus();
      }}>
        <div role="menu" ref={element => element?.focus()} tabIndex={-1} className="absolute min-w-44 rounded-lg border bg-background p-1 shadow-lg" style={{ left: Math.max(8, Math.min(cellMenu.x, window.innerWidth - 220)), top: Math.max(8, Math.min(cellMenu.y, window.innerHeight - 240)) }}>
          <button role="menuitem" className="block w-full rounded px-3 py-2 text-start text-sm hover:bg-muted disabled:opacity-50" disabled={!tableData.metadata.edit_permissions.edit_cells || readOnlyColumnIds.has(cellMenu.key)} onClick={() => { const presentation = getCurrentPresentation(); if (presentation) setMetadataEdit({ kind: 'memo', recordUuid: cellMenu.row.rowId, columnUuid: cellMenu.key, revision: presentation.revision, table: tableData }); }}>{translation.t('metadata.cellMemo')}</button>
          <button role="menuitem" className="block w-full rounded px-3 py-2 text-start text-sm hover:bg-muted" onClick={() => { void copyCells([{ row: cellMenu.row, key: cellMenu.key, viewRowId: cellMenu.row.rowId }], false).catch(error => setOperationError(gridErrorNotice(message('grid.copyFailed'), error))); }}>{translation.t('metadata.copyValues')}</button>
          {<button role="menuitem" className="block w-full rounded px-3 py-2 text-start text-sm hover:bg-muted disabled:opacity-50" disabled={!tableData.metadata.edit_permissions.edit_cells || readOnlyColumnIds.has(cellMenu.key)} onClick={() => { void runExclusiveMutation(async signal => { const presentation = getCurrentPresentation(); if (!presentation) return; const invalidationVersion = getTableSnapshotInvalidationVersion(projectSessionId); const result = await invoke<MutationResult>('update_record_inheritance', { expectedProjectSession: projectSessionId, tableUuid: tableData.uuid, expectedRevision: presentation.revision, recordUuid: cellMenu.row.rowId, request: { clearColumnUuid: cellMenu.key, parentUuid: null } }); if (!signal.aborted) acceptMutation(result, invalidationVersion); }); }}>{translation.t('metadata.empty')}</button>}
        </div>
      </div>}
      {metadataEdit && <MetadataEditDialog expectedProjectSession={projectSessionId} owner={metadataEdit} busy={mutation.busy} error={mutation.error} onClose={() => setMetadataEdit(null)} onSave={async (value, tags) => runExclusiveMutation(async signal => {
        const invalidationVersion = getTableSnapshotInvalidationVersion(projectSessionId);
        const result = metadataEdit.kind === 'parent'
          ? await invoke<MutationResult>('update_record_inheritance', { expectedProjectSession: projectSessionId, tableUuid: metadataEdit.table.uuid, expectedRevision: metadataEdit.revision, recordUuid: metadataEdit.recordUuid, request: { parentUuid: value, clearColumnUuid: null } })
          : await invoke<MutationResult>('update_record_metadata', { expectedProjectSession: projectSessionId, request: { table_uuid: metadataEdit.table.uuid, expected_revision: metadataEdit.revision, record_uuid: metadataEdit.recordUuid, tags: metadataEdit.kind === 'tags' ? tags : null, memo: metadataEdit.kind === 'memo' ? { column_uuid: metadataEdit.columnUuid, text: value } : null } });
        if (!signal.aborted) acceptMutation(result, invalidationVersion);
      })} />}
      {editSettings && <TableEditSettingsDialog onOrientationChange={async initialTransposed => {
        if (!getCurrentPresentation()) return false;
        return runExclusiveMutation(async signal => {
          const presentation = getCurrentPresentation();
          if (signal.aborted || !presentation) throw localizedError(message('grid.waitForPresentation'));
          const invalidationVersion = getTableSnapshotInvalidationVersion(projectSessionId);
          const result = await invoke<MutationResult>('update_table_edit_settings', { expectedProjectSession: projectSessionId, request: {
            table_uuid: tableData.uuid, expected_revision: presentation.revision, initial_transposed: initialTransposed,
            display_name: tableData.display_name, description: tableData.description,
            edit_permissions: tableData.metadata.edit_permissions,
          } });
          if (!signal.aborted) {
            acceptMutation(result, invalidationVersion);
            setTransposed(result.table.metadata.initial_transposed);
          }
        });
      }} open={!showInterfaceDialog} onOpenInterfaces={() => setShowInterfaceDialog(true)} owner={editSettings} busy={mutation.busy} error={mutation.error}
        onClose={() => setEditSettings(null)} onSave={async draft => runExclusiveMutation(async signal => {
          const presentation = getCurrentPresentation();
          if (signal.aborted || !presentation) throw localizedError(message('grid.waitForPresentation'));
          const invalidationVersion = getTableSnapshotInvalidationVersion(projectSessionId);
          const result = await invoke<MutationResult>('update_table_edit_settings', { expectedProjectSession: projectSessionId, request: {
            table_uuid: editSettings.table.uuid, expected_revision: presentation.revision,
            initial_transposed: draft.initial_transposed, edit_permissions: draft.edit_permissions,
            display_name: draft.display_name, description: draft.description,
          } });
          if (!signal.aborted) {
            try { acceptMutation(result, invalidationVersion); }
            catch (error) { setOperationError(gridErrorNotice(message('grid.committedDisplayFailed'), error)); }
          }
        })} />}
      {/* Inline Edit Dialog for Row Labels */}
      {inlineEditDialog && inlineEditDialog.type === 'row' && (
        <InlineEditDialog
            isOpen={inlineEditDialog.isOpen}
            initialValue={inlineEditDialog.initialValue}
            position={inlineEditDialog.position}
            title={translation.t('grid.editRowLabel')}
            placeholder={translation.t('grid.rowLabelPlaceholder')}
            onSave={async (value) => {
              if (!getCurrentPresentation()) throw localizedError(message('grid.waitForPresentation'));
              const record = tableData.records.find(item => item.uuid === inlineEditDialog.recordUuid);
              if (!record) throw new Error(translation.t('grid.rowLabelTargetMissing'));
              // Only a successful write closes the draft. Errors remain in the editor.
              const saved = await runExclusiveMutation(async signal => {
                if (signal.aborted || !getCurrentPresentation()) throw localizedError(message('grid.waitForPresentation'));
                await invoke('set_record_label', {
                  tableUuid: tableData.uuid, expectedProjectSession: projectSessionId,
                  recordUuid: record.uuid, newLabel: value
                });
                await refreshData();
              });
              if (!saved) throw localizedError(message('grid.waitForPresentation'));
              setInlineEditDialog(null);
            }}
          onCancel={() => setInlineEditDialog(null)}
        />
      )}

      {/* Interface Dialog */}
      <InterfaceDialog
        expectedProjectSession={projectSessionId}
        open={showInterfaceDialog}
        onOpenChange={setShowInterfaceDialog}
        tableName={settingsDisplayLabel(tableData.uuid, tableData.display_name) || tableData.metadata.data_name || tableName}
        tableUuid={tableData.uuid}
      />
    </div>
    {columnEditor && <div className="column-editor-host"><ColumnEditor
      expectedProjectSession={projectSessionId}
      key={JSON.stringify(columnEditor.target)} target={columnEditor.target} initialTab={columnEditor.tab}
      onClose={() => setColumnEditor(null)} onSaved={refreshData}
      deleteDisabledReason={!tableData.metadata.edit_permissions.delete_columns ? translation.t('table.edit.structureBlocked') : undefined}
      onDelete={columnEditor.target.column_uuid ? () => handleDeleteColumn(columnEditor.target.column_uuid!) : undefined}
    /></div>}
    </div>
    </FormulaCompletionProvider>
  );
};

export default DataGridView;
