import { hasBlockingShortcutSurface } from '@/app/utils/shortcutGuards';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type { Key, KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import clsx from 'clsx';
import { useExternalViewport } from './hooks/useExternalViewport';
import type { ColumnMeasurementPlan } from './hooks/useColumnWidths';
import { DataGridViewportContext, type PhysicalViewportContextValue } from './DataGridViewportContext';
import { StationaryScrollXContext } from './PhysicalRowBody';
import { GridSharedTooltipPortal, useGridSharedTooltip } from './GridSharedTooltip';
import { physicalRowsClassname } from './style/physicalRows';
import { stationaryRowsClassname } from './style/stationaryRows';
import { getOwnedPhysicalCell } from './utils/physicalRowOwnership';
import { getStationaryRowsWindow, getStationaryRowTop } from './utils/stationaryRows';
import { getNearestScrollOffset } from './utils/getNearestScrollOffset';
import { createPhysicalBodyWindow, resolvePhysicalBodyWindow } from './utils/physicalBodyWindow';

import {
  HeaderRowSelectionChangeContext,
  HeaderRowSelectionContext,
  RowSelectionChangeContext,
  useCalculatedColumns,
  useColumnWidths,
  useGridDimensions,
  useLatestFunc,
  useViewportColumns,
  useViewportRows,
  type HeaderRowSelectionContextValue
} from './hooks';
import { useColumnViewport } from './hooks/useCalculatedColumns';
import { useRowGeometry } from './hooks/useRowGeometry';
import { sameArray, useStableValue } from './hooks/useStableValue';
import {
  abs,
  assertIsValidKeyGetter,
  canExitGrid,
  createCellEvent,
  getCellStyle,
  getColSpan,
  getLeftRightKey,
  getNextSelectedCellPosition,
  isCtrlKeyHeldDown,
  isDefaultCellInput,
  isSelectedCellEditable,
  renderMeasuringCells,
  scrollToGridStart,
  canCommitEditor,
  sign
} from './utils';
import type {
  CalculatedColumn,
  CellClipboardEvent,
  CellCopyArgs,
  CellKeyboardEvent,
  CellKeyDownArgs,
  CellMouseEventHandler,
  CellNavigationMode,
  CellPasteArgs,
  CellRange,
  CellSelectArgs,
  Column,
  ColumnOrColumnGroup,
  ColSpanArgs,
  ColumnWidths,
  Direction,
  FillEvent,
  Maybe,
  Position,
  RangeCopyArgs,
  RangePasteArgs,
  Renderers,
  RowIndicatorConfig,
  RowsChangeData,
  SelectCellOptions,
  SelectHeaderRowEvent,
  SelectRowEvent,
  SortColumn
} from './types';
import { defaultRenderCell } from './Cell';
import { renderCheckbox as defaultRenderCheckbox } from './cellRenderers';
import {
  DataGridDefaultRenderersContext,
  useDefaultRenderers
} from './DataGridDefaultRenderersContext';
import { DataGridStateContext, type DataGridState } from './DataGridStateContext';
import EditCell from './EditCell';
// import textEditor from './editors/textEditor';
// import validatedTextEditor from './editors/validatedTextEditor';
import GroupedColumnHeaderRow from './GroupedColumnHeaderRow';
import HeaderRow from './HeaderRow';
import { defaultRenderRow } from './Row';
import type { PartialPosition } from './ScrollToCell';
import ScrollToCell from './ScrollToCell';
import { default as defaultRenderSortStatus } from './sortStatus';
import { cellDragHandleClassname, cellDragHandleFrozenClassname } from './style/cell';
import {
  focusSinkClassname,
  focusSinkHeaderAndSummaryClassname,
  rootClassname,
  viewportDraggingClassname
} from './style/core';
import { rowSelected, rowSelectedWithFrozenCell } from './style/row';
import SummaryRow from './SummaryRow';

/**
 * Interface representing cell selection state
 * Manage a selected cell in SELECT mode
 */
export interface SelectCellState extends Position {
  /** Mode is always 'SELECT' (selection mode) */
  readonly mode: 'SELECT';
}

/**
 * Interface representing cell editing state
 * Manage a cell being edited in EDIT mode
 */
interface EditCellState<R> extends Position {
  /** Mode is always 'EDIT' (editing mode) */
  readonly mode: 'EDIT';
  /** Row data being edited, including the latest changes */
  readonly row: R;
  /** Original row data at the start of editing, for restoration on cancel */
  readonly originalRow: R;
  /** One identity per edit, retained when its draft row changes. */
  readonly editSession: object;
}

/** Resolve only a moved key; ordinary value snapshots retain their index. */
function resolveSelectionKeyIndex(previous: readonly Key[], next: readonly Key[], index: number): number {
  if (index < 0 || index >= previous.length) return -1;
  const key = previous[index];
  return next[index] === key ? index : next.indexOf(key);
}

/** A rectangle survives only when it still contains exactly the same keys. */
function sameSelectionKeyInterval(previous: readonly Key[], next: readonly Key[],
  previousStart: number, previousEnd: number, nextStart: number, nextEnd: number): boolean {
  const oldMin = Math.min(previousStart, previousEnd), oldMax = Math.max(previousStart, previousEnd);
  const newMin = Math.min(nextStart, nextEnd), newMax = Math.max(nextStart, nextEnd);
  if (oldMin < 0 || newMin < 0 || oldMax >= previous.length || newMax >= next.length
    || oldMax - oldMin !== newMax - newMin) return false;
  if (previous === next && oldMin === newMin && oldMax === newMax) return true;
  const keys = new Set(previous.slice(oldMin, oldMax + 1));
  for (let index = newMin; index <= newMax; index++) {
    if (!keys.delete(next[index])) return false;
  }
  return keys.size === 0;
}

/**
 * Default column option type definition
 * Define settings applied to all columns
 */
export type DefaultColumnOptions<R, SR> = Pick<
  Column<R, SR>,
  | 'renderCell'          // Cell rendering function
  | 'renderHeaderCell'    // Header cell rendering function
  | 'width'               // Column width
  | 'minWidth'            // Minimum column width
  | 'maxWidth'            // Maximum column width
  | 'resizable'           // Whether resizing is enabled
  | 'sortable'            // Whether sorting is enabled
  | 'draggable'           // Whether dragging is enabled
>;

/**
 * Interface for external control of DataGrid
 * Expose component functionality through ref
 */
export interface DataGridHandle {
  selectAll: () => void;
  /** Submit a captured inline draft; close only its own session after success. */
  flushEditor: (submit: (row: unknown, columnKey: string) => Promise<boolean>) => Promise<boolean>;
  /** Reference to the grid DOM element */
  element: HTMLDivElement | null;
  /** Function scrolling to a specified cell */
  scrollToCell: (position: PartialPosition) => void;
  /** Function selecting a specified cell */
  selectCell: (position: Position, options?: SelectCellOptions) => void;
}

/**
 * Shared div properties inherited by DataGrid
 * Select only accessibility and styling attributes
 */
type SharedDivProps = Pick<
  React.ComponentProps<'div'>,
  | 'role'                // WAI-ARIA role
  | 'aria-label'          // Accessible label
  | 'aria-labelledby'     // Reference to the label element's ID
  | 'aria-description'    // Detailed description
  | 'aria-describedby'    // Reference to the description element's ID
  | 'aria-rowcount'       // Total row count, useful for virtual scrolling
  | 'className'           // CSS class name
  | 'style'               // Inline styles
>;

/**
 * DataGrid component property definition
 * @template R - Row data type
 * @template SR - Summary row data type
 * @template K - Row key type
 */
export interface DataGridProps<R, SR = unknown, K extends Key = Key> extends SharedDivProps {
  /** Component reference for external control through DataGridHandle */
  ref?: Maybe<React.Ref<DataGridHandle>>;
  /** Vertical virtualization viewport when scrolling an outer element */
  externalScrollRef?: React.RefObject<HTMLElement | null>;
  /** Scale applied to each row in the external viewport, defaulting to 1 */
  externalZoom?: number;
  /** One external physical owner; content is scaled per row. */
  externalViewportLayout?: 'physical-rows' | 'stationary-rows';
  /** Invalidate position-only layout changes outside the grid's owned tracks. */
  externalViewportGeometryKey?: unknown;
  externalViewportExtentRef?: React.RefObject<HTMLElement | null>;
  externalViewportPadding?: { inlineEnd: number; blockEnd: number };
  
  /**
   * Grid and data properties
   */
  /** 
   * Array of column definitions
   * Define grid structure with an array of Column or ColumnGroup
   */
  columns: readonly ColumnOrColumnGroup<NoInfer<R>, NoInfer<SR>>[];
  
  /** 
   * Array of row data to display
   * Each row is a plain object with properties matching column keys
   */
  rows: readonly R[];
  
  /** 
   * Summary rows fixed at the top of the grid
   * Used for totals and aggregate data
   */
  topSummaryRows?: Maybe<readonly SR[]>;
  
  /** 
   * Summary rows fixed at the bottom of the grid
   * Used for totals and aggregate data
   */
  bottomSummaryRows?: Maybe<readonly SR[]>;
  
  /** 
   * Function returning a unique key for each row
   * Used for performance optimization and row tracking
   */
  rowKeyGetter: (row: NoInfer<R>) => K;
  
  /** 
   * Callback when row data changes
   * Called when rows update through cell editing, fill operations, and similar actions
   */
  /** Temporary write lock; does not alter permanent per-column editor policy. */
  transientLock?: boolean;
  /** Keep the current draft mounted while its owner submits an atomic bulk edit. */
  retainPendingEditor?: boolean;
  onRowsChange?: Maybe<(rows: NoInfer<R>[], data: RowsChangeData<NoInfer<R>, NoInfer<SR>>) => void>;

  /**
   * Sizing properties
   */
  /**
   * Height of each row in pixels
   * Accept a number or a function deriving height from row data
   * @default 35
   */
  rowHeight?: Maybe<number | ((row: NoInfer<R>) => number)>;
  
  /**
   * Header row height in pixels
   * @default 35
   */
  headerRowHeight?: Maybe<number>;
  
  /**
   * Summary row height in pixels
   * @default 35
   */
  summaryRowHeight?: Maybe<number>;
  
  /** 
   * Column width map
   * Map column keys to width information
   */
  columnWidths?: Maybe<ColumnWidths>;
  
  /** 
   * Callback when column widths change
   * Called when the user resizes columns
   */
  onColumnWidthsChange?: Maybe<(columnWidths: ColumnWidths) => void>;

  /**
   * Feature properties
   */
  /** 
   * Set of selected row keys
   * Specify when using row selection
   */
  selectedRows?: Maybe<ReadonlySet<K>>;
  
  /** 
   * Function determining whether selection is disabled for a row
   * Returning true makes the row unselectable
   */
  isRowSelectionDisabled?: Maybe<(row: NoInfer<R>) => boolean>;
  
  /** 
   * Callback when row selection changes
   * Called when the user selects or deselects rows
   */
  onSelectedRowsChange?: Maybe<(selectedRows: Set<NoInfer<K>>) => void>;
  
  /** 
   * Array of sorted columns
   * Array managing sorting state
   */
  sortColumns?: Maybe<readonly SortColumn[]>;
  
  /** 
   * Callback when sorting changes
   * Called when the user sorts by clicking a column header
   */
  onSortColumnsChange?: Maybe<(sortColumns: SortColumn[]) => void>;
  
  /** 
   * Default options applied to all columns
   * Use these values unless overridden by a column definition
   */
  defaultColumnOptions?: Maybe<DefaultColumnOptions<NoInfer<R>, NoInfer<SR>>>;
  
  /** 
   * Callback for drag-fill operations
   * Called when copying cell values by dragging
   */
  onFill?: Maybe<(event: FillEvent<NoInfer<R>>) => NoInfer<R>>;

  /**
   * Event properties
   */
  /** 
   * Callback when the mouse is pressed on a cell
   * Called before dragging or selection starts
   */
  onCellMouseDown?: CellMouseEventHandler<R, SR>;
  
  /** 
   * Callback when a cell is clicked
   * Used to select cells or trigger actions
   */
  onCellClick?: CellMouseEventHandler<R, SR>;
  
  /** 
   * Callback when a cell is double-clicked
   * Used for actions such as entering edit mode
   */
  onCellDoubleClick?: CellMouseEventHandler<R, SR>;
  
  /** 
   * Callback when a cell is right-clicked
   * Used to display context menus
   */
  onCellContextMenu?: CellMouseEventHandler<R, SR>;
  
  /**
   * Callback when a row is right-clicked
   * Used to display row-level context menus
   */
  onRowContextMenu?: Maybe<(row: NoInfer<R>, event: React.MouseEvent<HTMLDivElement>) => void>;
  
  /**
   * Whether to enable range selection
   * @default false
   */
  enableRangeSelection?: Maybe<boolean>;
  
  /**
   * Callback when the selected range changes
   * Active when enableRangeSelection is true
   */
  onSelectedRangeChange?: Maybe<(range: CellRange | null) => void>;
  
  /**
   * Callback when a range is copied
   * Active when enableRangeSelection is true
   */
  onRangeCopy?: Maybe<(args: RangeCopyArgs<NoInfer<R>>) => void>;
  
  /**
   * Callback when a range is pasted
   * Active when enableRangeSelection is true
   */
  onRangePaste?: Maybe<(args: RangePasteArgs<R, SR>) => void>;
  
  
  /**
   * Whether to enable Undo/Redo
   * @default false
   */
  enableUndoRedo?: Maybe<boolean>;
  
  /**
   * Maximum number of Undo steps
   * @default 100
   */
  maxUndoSteps?: Maybe<number>;
  
  /**
   * Callback for Undo operations
   */
  onUndo?: Maybe<(change: RowsChangeData<NoInfer<R>, NoInfer<SR>>) => void>;
  
  /**
   * Callback for Redo operations
   */
  onRedo?: Maybe<(change: RowsChangeData<NoInfer<R>, NoInfer<SR>>) => void>;
  
  /** 
   * Callback when a key is pressed in a cell
   * Used to implement keyboard navigation and shortcuts
   */
  onCellKeyDown?: Maybe<
    (args: CellKeyDownArgs<NoInfer<R>, NoInfer<SR>>, event: CellKeyboardEvent) => void
  >;
  
  /** 
   * Callback when cell content is copied
   * Called when copying to the clipboard
   */
  onCellCopy?: Maybe<
    (args: CellCopyArgs<NoInfer<R>, NoInfer<SR>>, event: CellClipboardEvent) => void
  >;
  
  /** 
   * Callback when content is pasted into a cell
   * Called when pasting from the clipboard; returns new row data
   */
  onCellPaste?: Maybe<
    (args: CellPasteArgs<NoInfer<R>, NoInfer<SR>>, event: CellClipboardEvent) => NoInfer<R>
  >;
  
  /** 
   * Callback when cell selection changes
   * Used for focus movement and selection tracking
   * Key-preserved selections that disappear notify rowIdx: -1, row: undefined and the previous column.
   */
  onSelectedCellChange?: Maybe<(args: CellSelectArgs<NoInfer<R>, NoInfer<SR>>) => void>;
  
  /** 
   * Callback when the grid scrolls
   * Used to synchronize scroll positions and control virtual scrolling
   */
  onScroll?: Maybe<(event: React.UIEvent<HTMLDivElement>) => void>;
  
  /** 
   * Callback when a column is resized
   * Used to track and persist column width changes
   */
  onColumnResize?: Maybe<(column: CalculatedColumn<R, SR>, width: number) => void>;
  /** Work needed only when resizing ends, such as persisting column widths. */
  onColumnResizeEnd?: Maybe<() => void>;
  
  /** 
   * Callback when columns are reordered
   * Called when drag and drop changes column order
   */
  onColumnsReorder?: Maybe<(sourceColumnKey: string, targetColumnKey: string) => void>;
  
  /**
   * Callback when the viewport changes
   * Called when virtual scrolling changes the visible row range
   */
  onViewportChange?: Maybe<(startRowIdx: number, endRowIdx: number, visibleRows: readonly R[]) => void>;

  /**
   * Toggle and mode settings
   */
  /** 
   * Whether to enable virtual scrolling
   * Recommended for better performance with large datasets
   * @default true
   */
  enableVirtualization?: Maybe<boolean>;

  /**
   * Other settings
   */
  /** 
   * Custom renderers for cells, rows, and other components
   * Used to customize default rendering
   */
  renderers?: Maybe<Renderers<NoInfer<R>, NoInfer<SR>>>;
  
  /** 
   * Function applying a custom class name to rows
   * Allow dynamic styling based on row data or indices
   */
  rowClass?: Maybe<(row: NoInfer<R>, rowIdx: number) => Maybe<string>>;
  
  /** 
   * Custom header row class name
   * Used to customize header styles
   */
  headerRowClass?: Maybe<string>;
  
  /**
   * Grid text direction
   * 'ltr': Left to right, as in English and Japanese
   * 'rtl': Right to left, as in Arabic and Hebrew
   * @default 'ltr'
   */
  direction?: Maybe<Direction>;
  
  /**
   * Row indicator settings
   * Settings for displaying row numbers and action buttons
   */
  rowIndicator?: Maybe<RowIndicatorConfig<NoInfer<R>, NoInfer<SR>>>;
  
  /**
   * Alternating even/odd row colors
   * true: Stripe with default colors
   * { even: string; odd: string }: Stripe with custom colors
   * @default false
   */
  alternatingRowColors?: Maybe<boolean | { even: string; odd: string }>;
  
  /**
   * Cell background colors by data type
   * Object mapping data type names to colors
   * Example: { 'number': '#e3f2fd', 'string': '#ffffff', 'boolean': '#fffde7' }
   */
  dataTypeStyles?: Maybe<Record<string, React.CSSProperties>>;
  
  /**
   * Callback determining cell background colors
   * Return a color based on row data, column, and state
   * @param row - Row data
   * @param column - Column information
   * @param state - Cell state, such as selection or hover
   * @returns A background CSS color value, or undefined
   */
  getCellBackgroundColor?: Maybe<(
    row: NoInfer<R>, 
    column: CalculatedColumn<NoInfer<R>, NoInfer<SR>>,
    state: {
      isSelected: boolean;
      isHovered: boolean;
      rowIdx: number;
      isEvenRow: boolean;
    }
  ) => string | undefined>;
  
  /** data-testid attribute for tests */
  'data-testid'?: Maybe<string>;
  
  /** data-cy attribute for Cypress tests */
  'data-cy'?: Maybe<string>;
}

/**
 * Main data grid component
 * Display rows and columns with editing, sorting, selection, and other features
 *
 * @example
 * const columns = [{ key: 'id', name: 'ID' }, { key: 'title', name: 'Title' }];
 * const rows = [{ id: 1, title: 'Example' }];
 * <DataGrid columns={columns} rows={rows} rowKeyGetter={row => row.id} />
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 * @template K - Row key type
 */
export function DataGrid<R, SR = unknown, K extends Key = Key>(props: DataGridProps<R, SR, K>) {
  // Destructure props into individual variables
  const {
    ref,
    externalScrollRef,
    externalZoom = 1,
    externalViewportLayout = 'physical-rows',
    externalViewportGeometryKey,
    externalViewportExtentRef,
    externalViewportPadding,
    // Grid and data properties
    columns: rawColumns,        // Raw column definitions
    rows,                       // Row data
    topSummaryRows,             // Top summary rows
    bottomSummaryRows,          // Bottom summary rows
    rowKeyGetter,               // Row key getter
    onRowsChange,               // Row change callback
    transientLock = false,
    retainPendingEditor = false,
    // Sizing properties
    rowHeight: rawRowHeight,                            // Row height
    headerRowHeight: rawHeaderRowHeight,                // Header row height
    summaryRowHeight: rawSummaryRowHeight,              // Summary row height
    columnWidths: columnWidthsRaw,                      // Column width map
    onColumnWidthsChange: onColumnWidthsChangeRaw,      // Column width change callback
    // Feature properties
    selectedRows,               // Selected rows
    isRowSelectionDisabled,     // Row selection disabled predicate
    onSelectedRowsChange,       // Row selection change callback
    sortColumns,                // Sort column information
    onSortColumnsChange,        // Sort change callback
    defaultColumnOptions,       // Default column options
    // Event properties
    onCellMouseDown,            // Cell mouse down
    onCellClick,                // Cell click
    onCellDoubleClick,          // Cell double-click
    onCellContextMenu,          // Cell right-click
    onRowContextMenu,           // Row right-click
    onCellKeyDown,              // Cell key down
    onSelectedCellChange,       // Cell selection change
    onScroll,                   // Scrolling
    onColumnResize,             // Column resizing
    onColumnResizeEnd,
    onColumnsReorder,           // Column reordering
    onViewportChange,           // Viewport change
    onFill,                     // Drag-fill
    onCellCopy,                 // Cell copy
    onCellPaste,                // Cell paste
    // Range selection properties
    enableRangeSelection,       // Enable range selection
    onSelectedRangeChange,      // Range selection change
    onRangeCopy,                // Range copy
    onRangePaste,               // Range paste
    // Undo/Redo properties
    enableUndoRedo,             // Enable Undo/Redo
    maxUndoSteps: rawMaxUndoSteps, // Maximum Undo steps
    onUndo,                     // Undo operation
    onRedo,                     // Redo operation
    // Toggles and modes
    enableVirtualization: rawEnableVirtualization,      // Enable virtual scrolling
    // Other properties
    renderers,                  // Custom renderers
    className,                  // CSS class name
    style,                      // Inline styles
    rowClass,                   // Row class name function
    headerRowClass,             // Header row class name
    direction: rawDirection,    // Text direction
    rowIndicator,               // Row indicator settings
    alternatingRowColors,       // Alternating row color settings
    dataTypeStyles,             // Styles by data type
    getCellBackgroundColor,     // Cell background color callback
    // ARIA attributes
    role: rawRole,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-description': ariaDescription,
    'aria-describedby': ariaDescribedBy,
    'aria-rowcount': rawAriaRowCount,
    'data-testid': testId,
    'data-cy': dataCy
  } = props;

  /**
   * Set default values
   * Set defaults for values not provided in props
   */
  // Get default renderers from context
  const defaultRenderers = useDefaultRenderers<R, SR>();
  
  // ARIA role attribute, defaulting to 'grid'
  const role = rawRole ?? 'grid';
  
  // Row height, defaulting to 35px
  const rowHeight = rawRowHeight ?? 35;
  
  // Header row height: Use rowHeight if numeric; otherwise 35px
  const headerRowHeight = rawHeaderRowHeight ?? (typeof rowHeight === 'number' ? rowHeight : 35);
  
  // Summary row height: Use rowHeight if numeric; otherwise 35px
  const summaryRowHeight = rawSummaryRowHeight ?? (typeof rowHeight === 'number' ? rowHeight : 35);
  
  // Choose renderers in priority order: Custom, context, then default
  const renderRow = renderers?.renderRow ?? defaultRenderers?.renderRow ?? defaultRenderRow;
  const renderCell = renderers?.renderCell ?? defaultRenderers?.renderCell ?? defaultRenderCell;
  const renderSortStatus =
    renderers?.renderSortStatus ?? defaultRenderers?.renderSortStatus ?? defaultRenderSortStatus;
  const renderCheckbox =
    renderers?.renderCheckbox ?? defaultRenderers?.renderCheckbox ?? defaultRenderCheckbox;
  const noRowsFallback = renderers?.noRowsFallback ?? defaultRenderers?.noRowsFallback;
  
  // Enable virtual scrolling by default
  const enableVirtualization = rawEnableVirtualization ?? true;
  
  // Text direction, defaulting to 'ltr'
  const direction = rawDirection ?? 'ltr';
  
  // Maximum Undo steps, defaulting to 100
  const maxUndoSteps = rawMaxUndoSteps ?? 100;

  /**
   * Internal component state management
   */
  // Vertical scroll position in pixels
  const [endMode, setEndMode] = useState(false);
  const endModeRef = useRef(false);
  function clearEndMode() { endModeRef.current = false; setEndMode(false); }
  const cancelEndOnFocus = useLatestFunc((event: FocusEvent) => {
    if (!(event.target instanceof Node) || !gridRef.current?.contains(event.target)) clearEndMode();
  });
  useEffect(() => {
    const cancel = () => clearEndMode();
    const focus = cancelEndOnFocus;
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('focusin', focus, true);
    window.addEventListener('blur', cancel);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('focusin', focus, true);
      window.removeEventListener('blur', cancel);
    };
  }, [cancelEndOnFocus]);
  useEffect(() => {
    if (!endMode) return;
    const check = () => { if (hasBlockingShortcutSurface()) clearEndMode(); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229
        || !['End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift'].includes(event.key)) clearEndMode();
    };
    document.addEventListener('keydown', key, true);
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['role', 'aria-modal', 'aria-hidden', 'data-state', 'hidden', 'style', 'class'] });
    check();
    return () => { observer.disconnect(); document.removeEventListener('keydown', key, true); };
  }, [endMode]);
  const [scrollTop, setScrollTop] = useState(0);
  
  // Horizontal scroll position in pixels
  const [scrollLeft, setScrollLeft] = useState(0);
  
  // Internally managed column widths used when uncontrolled
  const [columnWidthsInternal, setColumnWidthsInternal] = useState(
    (): ColumnWidths => columnWidthsRaw ?? new Map()
  );
  
  // Whether a column is being resized
  const [isColumnResizing, setColumnResizing] = useState(false);
  
  // Whether dragging is in progress
  const [isDragging, setDragging] = useState(false);
  
  // Index of the row being dragged over
  const [draggedOverRowIdx, setDraggedOverRowIdx] = useState<number | undefined>(undefined);
  
  // Scroll jump information
  const [scrollToPosition, setScrollToPosition] = useState<PartialPosition | null>(null);
  
  // Whether to focus the cell
  const [shouldFocusCell, setShouldFocusCell] = useState(false);
  
  // Index of the previously selected row
  const [previousRowIdx, setPreviousRowIdx] = useState(-1);
  
  // Range selection state management
  let [selectedRange, setSelectedRange] = useState<CellRange | null>(null);
  const rangeDragAnchor = useRef<Position | null>(null);
  useEffect(() => {
    const stop = () => { rangeDragAnchor.current = null; };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    return () => { window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop); };
  }, []);
  
  // Undo/Redo history state management
  const [undoHistory, setUndoHistory] = useState<RowsChangeData<R, SR>[]>([]);
  const [redoHistory, setRedoHistory] = useState<RowsChangeData<R, SR>[]>([]);

  // Determine whether column widths are controlled
  // Controlled when columnWidths and onColumnWidthsChange are both provided and resizing is inactive
  const isColumnWidthsControlled =
    columnWidthsRaw != null && onColumnWidthsChangeRaw != null && !isColumnResizing;
  
  // Use column widths from props when controlled, otherwise from internal state
  const columnWidths = isColumnWidthsControlled ? columnWidthsRaw : columnWidthsInternal;
  
  // Choose the column width change handler
  const onColumnWidthsChange = isColumnWidthsControlled
    ? (columnWidths: ColumnWidths) => {
        // Also synchronize internal state to prevent unnecessary renders
        setColumnWidthsInternal(columnWidths);
        onColumnWidthsChangeRaw(columnWidths);
      }
    : setColumnWidthsInternal;

  // Function getting a column's width
  // Read from the columnWidths map, falling back to the column definition's default width
  const getColumnWidth = useCallback(
    (column: CalculatedColumn<R, SR>) => {
      return columnWidths.get(column.key)?.width ?? column.width;
    },
    [columnWidths]
  );

  // Hook retrieving grid dimensions
  // gridRef: Grid DOM reference; gridWidth/Height: Grid dimensions; horizontalScrollbarHeight: Horizontal scrollbar height
  const isPhysicalRows = externalScrollRef !== undefined;
  // Stationary paint applies only to supported layouts; other external grids use physical rows.
  // Per-column renderers/editors, tooltips and variable row heights are supported.
  const stationaryColumnsSupported = useMemo(() => externalViewportLayout !== 'stationary-rows'
    || rawColumns.every(column => !('children' in column) && column.colSpan === undefined),
    [externalViewportLayout, rawColumns]);
  const isStationaryRows = externalViewportLayout === 'stationary-rows' && isPhysicalRows
    && externalViewportExtentRef !== undefined && enableVirtualization && direction === 'ltr'
    && role === 'grid' && (topSummaryRows?.length ?? 0) === 0 && (bottomSummaryRows?.length ?? 0) === 0
    && renderRow === defaultRenderRow && renderCell === defaultRenderCell && onFill === undefined
    && stationaryColumnsSupported;
  const physicalScale = Number.isFinite(externalZoom) && externalZoom > 0 ? externalZoom : 1;
  const [gridRef, gridWidth, gridHeight, horizontalScrollbarHeight] = useGridDimensions(!isPhysicalRows);
  const physicalUtilityRef = useRef<HTMLDivElement>(null);
  // Hook calculating column information
  // Calculate visible columns, virtual scrolling overscan ranges, CSS variables, and more
  const {
    columns,                    // Calculated column information
    colSpanColumns,             // Columns with colSpan
    lastFrozenColumnIndex,      // Index of the last frozen column
    headerRowsCount,            // Number of header rows, including grouped headers
    templateColumns,            // CSS grid-template-columns value
    layoutCssVars,              // CSS custom properties
    totalFrozenColumnWidth,     // Total frozen column width
    columnMetrics, totalColumnWidth, columnGeometry
  } = useCalculatedColumns({
    rawColumns,
    defaultColumnOptions,
    rowIndicator,
    getColumnWidth,
    dataTypeStyles
  });

  assertIsValidKeyGetter<R, K>(rowKeyGetter);
  const rowGeometry = useRowGeometry(rows, rowHeight, rowKeyGetter);
  // Span callbacks may read arbitrary row data. Preserve that generic contract.
  const spanRows = colSpanColumns.length > 0 ? rows : undefined;
  const spanTopSummaryRows = colSpanColumns.length > 0 ? topSummaryRows : undefined;
  const spanBottomSummaryRows = colSpanColumns.length > 0 ? bottomSummaryRows : undefined;
  // The product stationary path owns its origin/track boxes. Generic physical
  // consumers retain conservative reference invalidation for arbitrary CSS and
  // custom layout. Caller-owned position-only moves have an explicit token.
  const genericGeometryInputs = useMemo(() => isStationaryRows ? undefined
    : { rawColumns, rows, rowIndicator, defaultColumnOptions },
    [isStationaryRows, rawColumns, rows, rowIndicator, defaultColumnOptions]);
  // The snapshot identity invalidates measurements when a track/span, arbitrary
  // consumer CSS, owner/origin, padding, header/summary layout or zoom changes.
  // Retain each input explicitly: value-only stationary rows remain stable,
  // whereas generic consumers and span callbacks may derive geometry from data.
  const physicalGeometryKey = useMemo(() => ({
    columnGeometry, rowGeometry, spanRows, spanTopSummaryRows, spanBottomSummaryRows,
    genericGeometryInputs, externalViewportGeometryKey, style, className,
    headerRowHeight, direction, physicalScale, externalScrollRef, externalViewportExtentRef,
    inlineEndPadding: externalViewportPadding?.inlineEnd, blockEndPadding: externalViewportPadding?.blockEnd,
    headerRowsCount, summaryRowHeight, topSummaryRowsCount: topSummaryRows?.length,
    bottomSummaryRowsCount: bottomSummaryRows?.length, isStationaryRows
  }), [columnGeometry, rowGeometry, spanRows, spanTopSummaryRows, spanBottomSummaryRows,
    genericGeometryInputs, externalViewportGeometryKey, style, className,
    headerRowHeight, direction, physicalScale, externalScrollRef, externalViewportExtentRef,
    externalViewportPadding?.inlineEnd, externalViewportPadding?.blockEnd, headerRowsCount, summaryRowHeight, topSummaryRows?.length, bottomSummaryRows?.length, isStationaryRows]);
  const externalViewport = useExternalViewport(gridRef, externalScrollRef, physicalScale, direction,
    physicalGeometryKey,
    isPhysicalRows && externalViewportExtentRef ? syncPersistentPhysicalExtent : undefined,
    isStationaryRows ? externalViewportExtentRef : undefined);
  
  const { colOverscanStartIdx, colOverscanEndIdx } = useColumnViewport({
    columns, columnMetrics, lastFrozenColumnIndex, totalFrozenColumnWidth,
    scrollLeft: externalViewport?.scrollLeft ?? scrollLeft,
    viewportWidth: externalViewport?.clientWidth ?? (externalScrollRef ? 0 : gridWidth),
    enableVirtualization
  });


  // Row count calculations
  const topSummaryRowsCount = topSummaryRows?.length ?? 0;        // Top summary row count
  const bottomSummaryRowsCount = bottomSummaryRows?.length ?? 0;  // Bottom summary row count
  const summaryRowsCount = topSummaryRowsCount + bottomSummaryRowsCount;  // Total summary row count
  const headerAndTopSummaryRowsCount = headerRowsCount + topSummaryRowsCount;  // Combined header and top summary row count
  const groupedColumnHeaderRowsCount = headerRowsCount - 1;  // Grouped header row count
  
  // Calculate row index bounds; header and summary rows use negative indices
  const minRowIdx = -headerAndTopSummaryRowsCount;              // Minimum row index
  const mainHeaderRowIdx = minRowIdx + groupedColumnHeaderRowsCount;  // Main header row index
  const maxRowIdx = rows.length + bottomSummaryRowsCount - 1;   // Maximum row index

  // State managing the selected cell's position and mode
  // Initially in SELECT mode at an invalid position outside the grid
  let [selectedPosition, setSelectedPosition] = useState(
    (): SelectCellState | EditCellState<R> => ({ idx: -1, rowIdx: minRowIdx - 1, mode: 'SELECT' })
  );
  const sharedTooltip = useGridSharedTooltip({ rootRef: gridRef, rows, columns, rowKeyGetter, selectedPosition });
  const finishedEditorSessionsRef = useRef(new WeakSet<object>());
  const activeEditorSessionRef = useRef<object | null>(null);
  const editSession = selectedPosition.mode === 'EDIT' ? selectedPosition.editSession : null;
  useLayoutEffect(() => {
    activeEditorSessionRef.current = editSession;
    return () => { activeEditorSessionRef.current = null; };
  }, [editSession]);

  // Reuse the geometry's stable identity arrays: value-only snapshots do not
  // rebuild a row-key lookup or scan the selection. Only order changes reconcile.
  const selectionRowKeys = useStableValue(rowGeometry.identities!, sameArray);
  const selectionColumnKeys = useStableValue(useMemo(() => columnGeometry.map(column => column.key),
    [columnGeometry]), sameArray);
  const [selectionOrder, setSelectionOrder] = useState(() => ({
    rowKeys: selectionRowKeys, columnKeys: selectionColumnKeys, columns
  }));
  const [selectionReconciliation, setSelectionReconciliation] = useState<{
    position: Position;
    previousColumn: CalculatedColumn<R, SR> | undefined;
    range: CellRange | null;
    rangeChanged: boolean;
  } | null>(null);

  if (selectionOrder.rowKeys !== selectionRowKeys || selectionOrder.columnKeys !== selectionColumnKeys) {
    setSelectionOrder({ rowKeys: selectionRowKeys, columnKeys: selectionColumnKeys, columns });
    const previousPosition = selectedPosition;
    const previousRange = selectedRange;
    const resolvePosition = (position: Position): Position | null => {
      const idx = position.idx < 0 ? position.idx
        : resolveSelectionKeyIndex(selectionOrder.columnKeys, selectionColumnKeys, position.idx);
      const rowIdx = position.rowIdx < 0 ? position.rowIdx
        : position.rowIdx >= selectionOrder.rowKeys.length
          ? position.rowIdx - selectionOrder.rowKeys.length + selectionRowKeys.length
          : resolveSelectionKeyIndex(selectionOrder.rowKeys, selectionRowKeys, position.rowIdx);
      return idx < 0 && position.idx >= 0 || rowIdx < 0 && position.rowIdx >= 0 ? null : { idx, rowIdx };
    };
    const position = resolvePosition(previousPosition);
    if (position === null || !isSamePosition(position, previousPosition)) {
      // Never move an in-flight editor to another rendered cell. Committed
      // edits have already switched to SELECT before their snapshot arrives.
      selectedPosition = position === null
        ? { idx: -1, rowIdx: minRowIdx - 1, mode: 'SELECT' }
        : { ...position, mode: 'SELECT' };
      setSelectedPosition(selectedPosition);
    }
    if (previousRange) {
      const start = resolvePosition(previousRange.start);
      const end = resolvePosition(previousRange.end);
      // Endpoints alone are insufficient: a newly included record between
      // them must never become a paste/cut/fill target after sorting/filtering.
      const sameTargets = position !== null && start !== null && end !== null
        && sameSelectionKeyInterval(selectionOrder.rowKeys, selectionRowKeys,
          previousRange.start.rowIdx, previousRange.end.rowIdx, start.rowIdx, end.rowIdx)
        && sameSelectionKeyInterval(selectionOrder.columnKeys, selectionColumnKeys,
          previousRange.start.idx, previousRange.end.idx, start.idx, end.idx);
      selectedRange = !sameTargets ? null
        : isSamePosition(start!, previousRange.start) && isSamePosition(end!, previousRange.end)
          ? previousRange : { start: start!, end: end! };
      if (selectedRange !== previousRange) setSelectedRange(selectedRange);
    }
    if (selectedPosition !== previousPosition || selectedRange !== previousRange) {
      setSelectionReconciliation({ position: selectedPosition,
        previousColumn: selectionOrder.columns[previousPosition.idx],
        range: selectedRange, rangeChanged: selectedRange !== previousRange });
    }
    // Index-only pointer/row-selection anchors must not outlive an order change.
    setDraggedOverRowIdx(undefined);
    setDragging(false);
    setPreviousRowIdx(-1);
    setScrollToPosition(null);
  }
  useLayoutEffect(() => { rangeDragAnchor.current = null; }, [selectionOrder]);
  const notifySelectionReconciliation = useLatestFunc(() => {
    if (!selectionReconciliation) return;
    const { position, previousColumn, range, rangeChanged } = selectionReconciliation;
    const valid = position.idx >= 0 && position.rowIdx >= 0 && position.rowIdx < rows.length;
    // Clear a stale range before notifying the remaining single cell. For a
    // preserved rectangle, notify it last so consumers retain the whole range.
    if (rangeChanged && range === null) onSelectedRangeChange?.(null);
    const column = valid ? columns[position.idx] : previousColumn;
    if (column) onSelectedCellChange?.({ rowIdx: valid ? position.rowIdx : -1,
      row: valid ? rows[position.rowIdx] : undefined, column });
    if (rangeChanged && range !== null) onSelectedRangeChange?.(range);
  });
  useLayoutEffect(() => {
    // Only a new reconciliation notifies consumers, using this commit's rows,
    // columns and callbacks rather than replaying a past order change.
    notifySelectionReconciliation();
  }, [selectionReconciliation, notifySelectionReconciliation]);

  useLayoutEffect(() => {
    if (!transientLock) return;
    // Removing a captured fill handle can prevent its lost-capture callback.
    // Never let a later unlocked gesture inherit that interrupted target.
    setDragging(false);
    setDraggedOverRowIdx(undefined);
    if (!retainPendingEditor) setSelectedPosition(position => position.mode === 'EDIT'
      ? { idx: position.idx, rowIdx: position.rowIdx, mode: 'SELECT' } : position);
  }, [transientLock, retainPendingEditor]);

  /**
   * Ref references
   */
  // Reference to the hidden focus management element
  const focusSinkRef = useRef<HTMLDivElement>(null);

  /**
   * Calculated values
   */
  // Determine whether this is a tree grid
  const isTreeGrid = role === 'treegrid';
  
  // Height calculations
  const headerRowsHeight = headerRowsCount * headerRowHeight;      // Total header row height
  const summaryRowsHeight = summaryRowsCount * summaryRowHeight;  // Total summary row height
  const clientHeight = gridHeight - headerRowsHeight - summaryRowsHeight;  // Data display area height
  const viewportClientHeight = externalViewport
    ? Math.max(0, externalViewport.clientHeight - headerRowsHeight - topSummaryRowsCount * summaryRowHeight)
    : externalScrollRef ? 0 : clientHeight;
  const viewportScrollTop = externalViewport?.scrollTop ?? scrollTop;
  
  // Determine whether row selection is enabled
  const isSelectable = selectedRows != null && onSelectedRowsChange != null;
  
  // Map arrow keys according to text direction
  const { leftKey, rightKey } = getLeftRightKey(direction);
  
  // Total row count for ARIA accessibility
  const ariaRowCount = rawAriaRowCount ?? headerRowsCount + rows.length + summaryRowsCount;

  // Object collecting default renderers
  // Passed to child components through context
  const defaultGridComponents = useMemo(
    () => ({
      renderCheckbox,
      renderSortStatus,
      renderCell
    }),
    [renderCheckbox, renderSortStatus, renderCell]
  );

  // Object collecting DataGrid state
  const [hoveredRowIdx, setHoveredRowIdx] = useState<number | undefined>(undefined);
  const dataGridState = useMemo<DataGridState<R, SR>>(
    () => ({
      getCellBackgroundColor: getCellBackgroundColor || undefined,
      alternatingRowColors: alternatingRowColors || undefined,
      hoveredRowIdx,
      selectedRange: enableRangeSelection ? selectedRange : null,
      selectedPosition: selectedPosition.mode === 'SELECT' ? {
        idx: selectedPosition.idx,
        rowIdx: selectedPosition.rowIdx
      } : undefined
    }),
    [getCellBackgroundColor, alternatingRowColors, hoveredRowIdx, selectedPosition, enableRangeSelection, selectedRange]
  );

  // Calculate header row selection state
  // Determine fully selected, partially selected, or unselected state
  const headerSelectionValue = useMemo((): HeaderRowSelectionContextValue => {
    // Unselected if there are no selectable rows
    let hasSelectedRow = false;      // Whether any selected rows exist
    let hasUnselectedRow = false;    // Whether any unselected rows exist

    if (selectedRows != null && selectedRows.size > 0) {
      // Check selection state for each row
      for (const row of rows) {
        if (selectedRows.has(rowKeyGetter(row))) {
          hasSelectedRow = true;
        } else {
          hasUnselectedRow = true;
        }

        // Stop early once both states are found
        if (hasSelectedRow && hasUnselectedRow) break;
      }
    }

    return {
      isRowSelected: hasSelectedRow && !hasUnselectedRow,    // Fully selected state
      isIndeterminate: hasSelectedRow && hasUnselectedRow    // Partially selected (indeterminate) state
    };
  }, [rows, selectedRows, rowKeyGetter]);

  // Hook calculating viewport row information
  // Render only rows in the visible region for virtual scrolling
  const {
    rowOverscanStartIdx,    // Overscan start row index including the buffer
    rowOverscanEndIdx,      // Overscan end row index including the buffer
    totalRowHeight,         // Total height of all rows
    gridTemplateRows,       // CSS grid-template-rows value
    getRowTop,              // Function getting a specified row's top position
    getRowHeight,           // Function getting a specified row's height
    findRowIdx              // Function finding a row index from a Y coordinate
  } = useViewportRows({
    geometry: rowGeometry,
    rows,
    rowHeight,
    clientHeight: viewportClientHeight,
    scrollTop: viewportScrollTop,
    enableVirtualization
  });

  const stationaryWindow = isStationaryRows ? getStationaryRowsWindow(
    rowOverscanStartIdx, rowOverscanEndIdx, rows.length, getRowTop, getRowHeight,
    headerRowsHeight, viewportScrollTop, physicalScale) : undefined;

  // Call the callback when the viewport range changes
  useEffect(() => {
    if (onViewportChange && enableVirtualization) {
      // Get only the rows actually displayed
      const visibleRows = rows.slice(rowOverscanStartIdx, rowOverscanEndIdx + 1);
      onViewportChange(rowOverscanStartIdx, rowOverscanEndIdx, visibleRows);
    }
  }, [rowOverscanStartIdx, rowOverscanEndIdx, rows, onViewportChange, enableVirtualization]);

  // Hook calculating viewport column information
  // Determine displayed columns while accounting for colSpan
  const viewportColumns = useViewportColumns({
    columns,
    colSpanColumns,
    colOverscanStartIdx,
    colOverscanEndIdx,
    lastFrozenColumnIndex,
    rowOverscanStartIdx,
    rowOverscanEndIdx,
    rows,
    topSummaryRows,
    bottomSummaryRows
  });

  // Hook managing column widths and resizing
  const measureRef = useRef(measurePhysicalColumns);
  useLayoutEffect(() => { measureRef.current = measurePhysicalColumns; });
  const physicalMeasurementAdapter = useMemo(() => ({
    measureLogicalColumns: (plan: ColumnMeasurementPlan) => measureRef.current(plan)
  }), []);
  const { 
    gridTemplateColumns,    // CSS grid-template-columns value
    measurementPending, measurementRevision, measuringColumnKeys,
    handleColumnResize      // Column resize handler
  } = useColumnWidths(
    columns,
    viewportColumns,
    templateColumns,
    gridRef,
    gridWidth,
    columnWidths,
    onColumnWidthsChange,
    onColumnResize,
    setColumnResizing,
    isPhysicalRows ? physicalMeasurementAdapter : undefined
  );

  // Bounded paint changes only ordinary body boxes. Unsupported features
  // retain the existing full-width path, including all declared span contracts.
  // A pending geometry key must keep focus/scroll actions gated, but it need not
  // expand the already-rendered numeric column tracks back to the full table.
  // Rebase only a sample from this same coordinate system; measurements and
  // physicalLayoutReady still follow the unchanged authoritative path below.
  const canBoundPendingViewport = isStationaryRows && externalViewport !== null
    && externalViewport.clientWidth > 0 && externalViewport.zoom === physicalScale
    && externalViewport.direction === direction
    && externalViewport.owner === externalScrollRef?.current && externalViewport.root === gridRef.current;
  const physicalBodyFallback = !isPhysicalRows ? 'not-physical'
    : !enableVirtualization ? 'virtualization-disabled'
    : renderRow !== defaultRenderRow || renderCell !== defaultRenderCell ? 'custom-renderer'
    : colSpanColumns.length > 0 ? 'span'
    : headerRowsCount !== 1 || summaryRowsCount > 0 || isTreeGrid || onFill !== undefined ? 'unsupported-layout'
    : !externalViewport?.ready && !canBoundPendingViewport ? 'viewport-not-ready'
    : undefined;
  const physicalBodyWindow = useMemo(() => physicalBodyFallback === undefined
    ? createPhysicalBodyWindow(columnGeometry, columnMetrics, templateColumns,
      Math.max(lastFrozenColumnIndex + 1, colOverscanStartIdx), colOverscanEndIdx,
      externalViewport?.clientWidth ?? 0, physicalScale)
    : undefined, [physicalBodyFallback, columnGeometry, columnMetrics, templateColumns,
      lastFrozenColumnIndex, colOverscanStartIdx, colOverscanEndIdx,
      externalViewport?.clientWidth, physicalScale]);
  const physicalBodyBaseFallback = physicalBodyFallback ?? (physicalBodyWindow ? undefined : 'empty-or-width-budget');

  const physicalLayoutReady = !isPhysicalRows || Boolean(externalViewport?.ready && !measurementPending
    && (!isStationaryRows || externalViewport.ownerClientWidth > 0 && externalViewport.ownerClientHeight > 0));
  // Pending focus/reveal requests must be retried against new track metrics,
  // consumer placement/CSS, zoom, measured widths or physical viewport sizes.
  const physicalLayoutToken = useMemo(() => ({
    columnGeometry, rowGeometry, getRowTop, headerRowsHeight,
    genericGeometryInputs, externalViewportGeometryKey, style, className,
    physicalScale, measurementRevision, ownerClientWidth: externalViewport?.ownerClientWidth,
    ownerClientHeight: externalViewport?.ownerClientHeight, isStationaryRows
  }), [columnGeometry, rowGeometry, getRowTop, headerRowsHeight,
    genericGeometryInputs, externalViewportGeometryKey, style, className,
    physicalScale, measurementRevision, externalViewport?.ownerClientWidth, externalViewport?.ownerClientHeight, isStationaryRows]);
  const pendingPhysicalFocus = useRef(new Set<{
    element: HTMLElement; select: boolean; origin: Element | null; cancelled: boolean;
  }>());
  type StationaryFocusRequest = {
    element: HTMLElement; select: boolean; origin: Element | null;
    position: Position; rowIdentity: unknown; columnKey: string;
    selection: Position; expected?: { left: number; top: number; version: object };
  };
  const pendingStationaryFocus = useRef(new Map<HTMLElement, StationaryFocusRequest>());
  const lastPhysicalReveal = useRef<{ left: number; top: number; version: object } | undefined>(undefined);
  const physicalActions = useRef({ scrollPhysicalPosition, scrollPhysicalElement, requestPhysicalFocus, revealStationaryEditorIntent });
  physicalActions.current = { scrollPhysicalPosition, scrollPhysicalElement, requestPhysicalFocus, revealStationaryEditorIntent };
  const scrollPhysicalPositionStable = useCallback((position: PartialPosition) => physicalActions.current.scrollPhysicalPosition(position), []);
  const scrollPhysicalElementStable = useCallback((element: HTMLElement) => physicalActions.current.scrollPhysicalElement(element), []);
  const requestPhysicalFocusStable = useCallback((element: HTMLElement, select?: boolean) => physicalActions.current.requestPhysicalFocus(element, select), []);
  useLayoutEffect(() => {
    if (!physicalLayoutReady) return;
    for (const request of pendingPhysicalFocus.current) {
      pendingPhysicalFocus.current.delete(request);
      const active = request.element.ownerDocument.activeElement;
      if (!request.cancelled && request.element.isConnected
        && (active === request.origin || active === request.element || active === request.element.ownerDocument.body)) {
        scrollPhysicalElementStable(request.element);
        request.element.focus({ preventScroll: true });
        if (request.select && (request.element instanceof HTMLInputElement || request.element instanceof HTMLTextAreaElement)) request.element.select();
      }
    }
  }, [physicalLayoutReady, physicalLayoutToken, scrollPhysicalElementStable]);
  // React's synthetic before-input plugin is not a native beforeinput subscription.
  // One owned-root listener covers native IME/paste/input-method actions, never one per cell.
  useLayoutEffect(() => {
    const root = gridRef.current;
    if (!isStationaryRows || !root) return;
    const handleBeforeInput = (event: Event) => physicalActions.current.revealStationaryEditorIntent(event.target);
    root.addEventListener('beforeinput', handleBeforeInput, true);
    return () => root.removeEventListener('beforeinput', handleBeforeInput, true);
  }, [isStationaryRows, gridRef]);
  // Offsets do not enter context identity. Only pending requests inspect each existing commit.
  useLayoutEffect(() => { completeStationaryFocus(); });
  const physicalViewportContext = useMemo<PhysicalViewportContextValue>(() => ({
    ownerRef: externalScrollRef ?? gridRef, scale: isPhysicalRows ? physicalScale : 1,
    layout: isStationaryRows ? 'stationary-rows' : isPhysicalRows ? 'physical-rows' : 'grid',
    direction, layoutReady: physicalLayoutReady,
    layoutVersion: physicalLayoutToken, scrollToPosition: scrollPhysicalPositionStable,
    scrollToElement: scrollPhysicalElementStable, requestFocus: requestPhysicalFocusStable
  }), [isPhysicalRows, isStationaryRows, externalScrollRef, gridRef, physicalScale, direction, physicalLayoutReady,
    physicalLayoutToken, scrollPhysicalPositionStable, scrollPhysicalElementStable, requestPhysicalFocusStable]);

  // Calculate column index bounds
  const minColIdx = isTreeGrid ? -1 : 0;  // Start at -1 for tree grids to support expansion and collapse
  const maxColIdx = columns.length - 1;   // Maximum column index
  
  // Check the selected cell's position
  const selectedCellIsWithinSelectionBounds = isCellWithinSelectionBounds(selectedPosition);  // Whether it is within selectable bounds
  const selectedCellIsWithinViewportBounds = isCellWithinViewportBounds(selectedPosition);    // Whether it is within visible bounds
  
  // Total grid scroll height
  const scrollHeight =
    headerRowHeight + totalRowHeight + summaryRowsHeight + horizontalScrollbarHeight;
  
  // Whether to focus the whole grid when no cell is selected
  const shouldFocusGrid = !selectedCellIsWithinSelectionBounds;

  /**
   * Stabilize wrapper function references to preserve memoization
   */
  const handleColumnResizeLatest = useLatestFunc(handleColumnResize);
  const handleColumnResizeEndLatest = useLatestFunc(handleColumnResizeEnd);
  const onColumnsReorderLastest = useLatestFunc(onColumnsReorder);
  const onSortColumnsChangeLatest = useLatestFunc(onSortColumnsChange);
  const onCellMouseDownLatest = useLatestFunc(onCellMouseDown);
  const onCellClickLatest = useLatestFunc(onCellClick);
  const onCellDoubleClickLatest = useLatestFunc(onCellDoubleClick);
  const onCellContextMenuLatest = useLatestFunc(onCellContextMenu);
  const selectHeaderRowLatest = useLatestFunc(selectHeaderRow);
  const selectRowLatest = useLatestFunc(selectRow);
  const handleFormatterRowChangeLatest = useLatestFunc(updateRow);
  const selectCellLatest = useLatestFunc(selectCell);
  const isCellEditableLatest = useRef(isCellEditable);
  useLayoutEffect(() => { isCellEditableLatest.current = isCellEditable; });
  const selectHeaderCellLatest = useLatestFunc(selectHeaderCell);

  /**
   * Callback function definitions
   */
  const focusCell = useCallback(
    (shouldScroll = true) => {
      const cell = getCellToScroll(gridRef.current!);
      if (cell === null) return;

      if (shouldScroll && isStationaryRows) {
        physicalViewportContext.requestFocus(cell);
        return;
      }
      if (shouldScroll) {
        if (!physicalViewportContext.layoutReady) return;
        physicalViewportContext.scrollToPosition(selectedPosition);
      }

      cell.focus({ preventScroll: true });
    },
    // Context includes the committed layout snapshot, keeping focus invalidation
    // tied to geometry while its stable actions always use current metrics.
    [gridRef, isStationaryRows, physicalViewportContext, selectedPosition]
  );
  
  const handleUndo = useCallback(() => {
    if (transientLock) return;
    if (!enableUndoRedo || undoHistory.length === 0 || !onUndo) return;
    
    const lastChange = undoHistory[undoHistory.length - 1];
    
    // Run the Undo callback
    onUndo(lastChange);
    
    // Update history
    setUndoHistory(prev => prev.slice(0, -1));
    setRedoHistory(prev => [...prev, lastChange]);
  }, [enableUndoRedo, undoHistory, onUndo, transientLock]);
  
  const handleRedo = useCallback(() => {
    if (transientLock) return;
    if (!enableUndoRedo || redoHistory.length === 0 || !onRedo) return;
    
    const nextChange = redoHistory[redoHistory.length - 1];
    
    // Run the Redo callback
    onRedo(nextChange);
    
    // Update history
    setRedoHistory(prev => prev.slice(0, -1));
    setUndoHistory(prev => [...prev, nextChange]);
  }, [enableUndoRedo, redoHistory, onRedo, transientLock]);
  
  // Add to change history
  const addToUndoHistory = useCallback((changeData: RowsChangeData<R, SR>) => {
    if (!enableUndoRedo) return;
    
    setUndoHistory(prev => {
      const newHistory = [...prev, changeData];
      // Remove old history when the maximum step count is exceeded
      if (newHistory.length > maxUndoSteps) {
        return newHistory.slice(-maxUndoSteps);
      }
      return newHistory;
    });
    
    // Clear Redo history on a new change
    setRedoHistory([]);
  }, [enableUndoRedo, maxUndoSteps]);

  /**
   * effects
   */
  useLayoutEffect(() => {
    if (shouldFocusCell && physicalLayoutReady) {
      if (focusSinkRef.current !== null && selectedPosition.idx === -1) {
        focusSinkRef.current.focus({ preventScroll: true });
        scrollPhysicalPositionStable(selectedPosition);
      } else {
        focusCell();
      }
      setShouldFocusCell(false);
    }
  }, [shouldFocusCell, focusCell, selectedPosition, physicalLayoutReady, physicalLayoutToken, scrollPhysicalPositionStable]);

  useImperativeHandle(ref, () => ({
    async flushEditor(submit) {
      const draft = selectedPosition;
      if (draft.mode !== 'EDIT') return true;
      if (transientLock || isEditorCommitBlocked() || !isCellEditableLatest.current(draft)) return false;
      const success = await submit(draft.row, columns[draft.idx].key);
      if (!success) return false;
      if (finishEditorSession(draft)) {
        setSelectedPosition(current => current.mode === 'EDIT' && current.editSession === draft.editSession
          ? { idx: current.idx, rowIdx: current.rowIdx, mode: 'SELECT' } : current);
      }
      return true;
    },
    selectAll() {
      const first = rowIndicator ? 1 : 0;
      if (selectedPosition.mode === 'EDIT' || !enableRangeSelection || !rows.length || first > maxColIdx) return;
      const range = { start: { idx: first, rowIdx: 0 }, end: { idx: maxColIdx, rowIdx: rows.length - 1 } };
      const active = { idx: Math.max(first, Math.min(maxColIdx, selectedPosition.idx)),
        rowIdx: Math.max(0, Math.min(rows.length - 1, selectedPosition.rowIdx)) };
      selectCell(active, { shouldFocusCell: true });
      setSelectedRange(range); onSelectedRangeChange?.(range);
    },
    element: gridRef.current,
    scrollToCell(position) {
      const { idx, rowIdx, scrollPosition } = position;
      const scrollToIdx =
        idx !== undefined && idx > lastFrozenColumnIndex && idx < columns.length ? idx : undefined;
      const scrollToRowIdx =
        rowIdx !== undefined && isRowIdxWithinViewportBounds(rowIdx) ? rowIdx : undefined;

      if (scrollToIdx !== undefined || scrollToRowIdx !== undefined) {
        setScrollToPosition({ idx: scrollToIdx, rowIdx: scrollToRowIdx, scrollPosition });
      }
    },
    selectCell
  }));

  /**
   * event handlers
   */
  function selectHeaderRow(args: SelectHeaderRowEvent) {
    if (!onSelectedRowsChange) return;

    assertIsValidKeyGetter<R, K>(rowKeyGetter);

    const newSelectedRows = new Set(selectedRows);
    for (const row of rows) {
      if (isRowSelectionDisabled?.(row) === true) continue;
      const rowKey = rowKeyGetter(row);
      if (args.checked) {
        newSelectedRows.add(rowKey);
      } else {
        newSelectedRows.delete(rowKey);
      }
    }
    onSelectedRowsChange(newSelectedRows);
  }

  function selectRow(args: SelectRowEvent<R>) {
    if (!onSelectedRowsChange) return;

    assertIsValidKeyGetter<R, K>(rowKeyGetter);
    const { row, checked, isShiftClick } = args;
    if (isRowSelectionDisabled?.(row) === true) return;
    const newSelectedRows = new Set(selectedRows);
    const rowKey = rowKeyGetter(row);
    const rowIdx = rows.indexOf(row);
    setPreviousRowIdx(rowIdx);

    if (checked) {
      newSelectedRows.add(rowKey);
    } else {
      newSelectedRows.delete(rowKey);
    }

    if (
      isShiftClick &&
      previousRowIdx !== -1 &&
      previousRowIdx !== rowIdx &&
      previousRowIdx < rows.length
    ) {
      const step = sign(rowIdx - previousRowIdx);
      for (let i = previousRowIdx + step; i !== rowIdx; i += step) {
        const row = rows[i];
        if (isRowSelectionDisabled?.(row) === true) continue;
        if (checked) {
          newSelectedRows.add(rowKeyGetter(row));
        } else {
          newSelectedRows.delete(rowKeyGetter(row));
        }
      }
    }

    onSelectedRowsChange(newSelectedRows);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const { idx, rowIdx, mode } = selectedPosition;
    if (hasBlockingShortcutSurface()) { clearEndMode(); return; }
    if (mode === 'EDIT' || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element) || !event.currentTarget.contains(target)
      || target.closest('button, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"]')) return;
    
    // End is a one-shot boundary-navigation mode, not a direct row-end command.
    if (event.key === 'End' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!event.repeat) { endModeRef.current = !endModeRef.current; setEndMode(endModeRef.current); }
      return;
    }
    if (endModeRef.current && event.key === 'Shift') return;
    const endArrow = endModeRef.current && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key);
    if (endModeRef.current && !endArrow) clearEndMode();
    if (endArrow) { clearEndMode(); navigate(event, true); return; }

    // Ctrl+Z for Undo
    if (enableUndoRedo && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      event.preventDefault();
      handleUndo();
      return;
    }
    
    // Ctrl+Y or Ctrl+Shift+Z for Redo
    if (enableUndoRedo && (event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'y' || (event.shiftKey && event.key.toLowerCase() === 'z'))) {
      event.preventDefault();
      handleRedo();
      return;
    }

    if (!transientLock && onCellKeyDown && isRowIdxWithinViewportBounds(rowIdx)) {
      const row = rows[rowIdx];
      const cellEvent = createCellEvent(event);
      onCellKeyDown(
        {
          mode: 'SELECT',
          row,
          column: columns[idx],
          rowIdx,
          selectCell
        },
        cellEvent
      );
      if (cellEvent.isGridDefaultPrevented()) return;
    }

    if (!(event.target instanceof Element)) return;
    const isCellEvent = event.target.closest('.rdg-cell') !== null;
    const isRowEvent = isTreeGrid && event.target === focusSinkRef.current;
    if (!isCellEvent && !isRowEvent) return;

    const firstDataIdx = rowIndicator ? 1 : 0;
    const ctrl = isCtrlKeyHeldDown(event);
    if (ctrl && !event.shiftKey && event.key === 'Backspace' && rowIdx >= 0 && idx >= firstDataIdx) {
      event.preventDefault();
      if (physicalLayoutReady) scrollPhysicalPosition({ idx, rowIdx });
      else setScrollToPosition({ idx, rowIdx });
      setShouldFocusCell(true);
      return;
    }
    if (enableRangeSelection && ctrl && !event.shiftKey && event.key === '.' && selectedRange) {
      event.preventDefault();
      const top = Math.min(selectedRange.start.rowIdx, selectedRange.end.rowIdx);
      const bottom = Math.max(selectedRange.start.rowIdx, selectedRange.end.rowIdx);
      const left = Math.min(selectedRange.start.idx, selectedRange.end.idx);
      const right = Math.max(selectedRange.start.idx, selectedRange.end.idx);
      const corners = [{ idx: left, rowIdx: top }, { idx: right, rowIdx: top },
        { idx: right, rowIdx: bottom }, { idx: left, rowIdx: bottom }]
        .filter((p, i, all) => all.findIndex(q => q.idx === p.idx && q.rowIdx === p.rowIdx) === i);
      const next = corners[(corners.findIndex(p => p.idx === idx && p.rowIdx === rowIdx) + 1) % corners.length];
      setSelectedPosition({ ...next, mode: 'SELECT' }); setShouldFocusCell(true);
      if (physicalLayoutReady) scrollPhysicalPosition(next); else setScrollToPosition(next);
      onSelectedCellChange?.({ ...next, row: rows[next.rowIdx], column: columns[next.idx] });
      // The active-cell callback may reset the owner range; publish the retained rectangle last.
      onSelectedRangeChange?.(selectedRange);
      return;
    }
    if (enableRangeSelection && ctrl && (event.key === '*' || (event.shiftKey && event.key === '8'))
      && rowIdx >= 0 && idx >= firstDataIdx) {
      event.preventDefault();
      let top = rowIdx, bottom = rowIdx, left = idx, right = idx;
      const filled = (r: number, c: number) => {
        const col = columns[c]; const value = col.getNavigationValue ? col.getNavigationValue(rows[r]) : rows[r][col.key as keyof R];
        return value !== '' && value !== null && value !== undefined;
      };
      let changed = true;
      while (changed) {
        changed = false;
        if (top > 0 && Array.from({ length: right - left + 1 }, (_, i) => left + i).some(c => filled(top - 1, c))) { top--; changed = true; }
        if (bottom + 1 < rows.length && Array.from({ length: right - left + 1 }, (_, i) => left + i).some(c => filled(bottom + 1, c))) { bottom++; changed = true; }
        if (left > firstDataIdx && Array.from({ length: bottom - top + 1 }, (_, i) => top + i).some(r => filled(r, left - 1))) { left--; changed = true; }
        if (right < maxColIdx && Array.from({ length: bottom - top + 1 }, (_, i) => top + i).some(r => filled(r, right + 1))) { right++; changed = true; }
      }
      const range = { start: { idx: left, rowIdx: top }, end: { idx: right, rowIdx: bottom } };
      setSelectedRange(range); onSelectedRangeChange?.(range);
      return;
    }

    if (enableRangeSelection && rows.length && firstDataIdx <= maxColIdx &&
      ((ctrl && event.key.toLowerCase() === 'a') || (event.key === ' ' && (ctrl || event.shiftKey)))) {
      event.preventDefault();
      const all = ctrl && (event.key.toLowerCase() === 'a' || event.shiftKey);
      const active = { idx: Math.max(firstDataIdx, Math.min(maxColIdx, idx)), rowIdx: Math.max(0, Math.min(rows.length - 1, rowIdx)) };
      const range = {
        start: { idx: all || !ctrl ? firstDataIdx : active.idx, rowIdx: all || ctrl ? 0 : active.rowIdx },
        end: { idx: all || !ctrl ? maxColIdx : active.idx, rowIdx: all || ctrl ? rows.length - 1 : active.rowIdx }
      };
      selectCell(active, { shouldFocusCell: true });
      const axisRange: CellRange = { ...range, axis: all ? undefined : ctrl ? 'column' : 'row' };
      setSelectedRange(axisRange); onSelectedRangeChange?.(axisRange);
      return;
    }

    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Tab':
      case 'Enter':
      case 'Home':
      case 'End':
      case 'PageUp':
      case 'PageDown':
        navigate(event);
        break;
      default:
        handleCellInput(event);
        break;
    }
  }

  function handleFocus(event: React.FocusEvent<HTMLDivElement>) {
    // select the first header cell if the focus event is triggered by the grid
    if (event.target === event.currentTarget) {
      selectHeaderCell({ idx: minColIdx, rowIdx: headerRowsCount }, { shouldFocusCell: true });
    }
  }

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const { scrollTop, scrollLeft } = event.currentTarget;
    flushSync(() => {
      setScrollTop(scrollTop);
      // scrollLeft is nagative when direction is rtl
      setScrollLeft(abs(scrollLeft));
    });
    onScroll?.(event);
  }

  function updateRow(column: CalculatedColumn<R, SR>, rowIdx: number, row: R) {
    if (transientLock) return;
    if (typeof onRowsChange !== 'function') return;
    if (row === rows[rowIdx]) return;
    const updatedRows = [...rows.slice(0, rowIdx), row, ...rows.slice(rowIdx + 1)];
    const changeData = {
      indexes: [rowIdx],
      column
    };
    onRowsChange(updatedRows, changeData);
    
    // Add the change to history
    addToUndoHistory(changeData);
  }

  function isEditorCommitBlocked() {
    return selectedPosition.mode === 'EDIT'
      && !canCommitEditor(gridRef.current?.querySelector<HTMLElement>('.rdg-editor-container'));
  }

  function finishEditorSession(position: EditCellState<R>): boolean {
    const { editSession } = position;
    if (activeEditorSessionRef.current !== editSession
      || finishedEditorSessionsRef.current.has(editSession)) return false;
    // Claim before notifying the owner: its callback may synchronously select
    // another cell, and blur/navigation must not deliver the same edit twice.
    finishedEditorSessionsRef.current.add(editSession);
    return true;
  }

  function commitEditorChanges() {
    if (isEditorCommitBlocked() || selectedPosition.mode !== 'EDIT'
      || !isCellEditableLatest.current(selectedPosition)
      || !finishEditorSession(selectedPosition)) return;
    const { idx, rowIdx, row } = selectedPosition;
    setSelectedPosition({ idx, rowIdx, mode: 'SELECT' });
    updateRow(columns[idx], rowIdx, row);
  }

  function handleCellCopy(event: CellClipboardEvent) {
    // If range selection is enabled and a range is selected
    if (enableRangeSelection && selectedRange && onRangeCopy) {
      const cells: Array<{ column: CalculatedColumn<R, SR>; row: R; value: unknown }> = [];
      
      const startRow = Math.min(selectedRange.start.rowIdx, selectedRange.end.rowIdx);
      const endRow = Math.max(selectedRange.start.rowIdx, selectedRange.end.rowIdx);
      const startCol = Math.min(selectedRange.start.idx, selectedRange.end.idx);
      const endCol = Math.max(selectedRange.start.idx, selectedRange.end.idx);
      
      for (let rowIdx = startRow; rowIdx <= endRow; rowIdx++) {
        if (isRowIdxWithinViewportBounds(rowIdx)) {
          for (let colIdx = startCol; colIdx <= endCol; colIdx++) {
            if (isColIdxWithinSelectionBounds(colIdx)) {
              const column = columns[colIdx];
              const row = rows[rowIdx];
              cells.push({
                column,
                row,
                value: row[column.key as keyof R]
              });
            }
          }
        }
      }
      
      // Calculate rows and columns for the selected range
      const selectedRows: R[] = [];
      const selectedColumns: CalculatedColumn<R, SR>[] = [];
      
      for (let rowIdx = startRow; rowIdx <= endRow; rowIdx++) {
        if (isRowIdxWithinViewportBounds(rowIdx)) {
          selectedRows.push(rows[rowIdx]);
        }
      }
      
      for (let colIdx = startCol; colIdx <= endCol; colIdx++) {
        if (isColIdxWithinSelectionBounds(colIdx)) {
          selectedColumns.push(columns[colIdx]);
        }
      }
      
      onRangeCopy({ 
        type: 'COPY', 
        range: selectedRange, 
        rows: selectedRows,
        columns: selectedColumns
      } as RangeCopyArgs<NoInfer<R>>);
      event.preventDefault();
      return;
    }
    
    // Regular cell copy handling
    if (!selectedCellIsWithinViewportBounds) return;
    const { idx, rowIdx } = selectedPosition;
    onCellCopy?.({ row: rows[rowIdx], column: columns[idx] }, event);
  }

  function handleCellPaste(event: CellClipboardEvent) {
    if (transientLock) { event.preventDefault(); return; }
    if (selectedPosition.mode === 'EDIT'
      || (event.target instanceof Element && event.target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]'))) {
      event.stopPropagation();
      return;
    }
    // If range selection is enabled and a range is selected
    if (enableRangeSelection && selectedRange && onRangePaste && onRowsChange) {
      const pasteData = event.clipboardData?.getData('text/plain');
      if (pasteData) {
        // Get selected rows and columns for the paste operation
        const startRow = Math.min(selectedRange.start.rowIdx, selectedRange.end.rowIdx);
        const endRow = Math.max(selectedRange.start.rowIdx, selectedRange.end.rowIdx);
        const startCol = Math.min(selectedRange.start.idx, selectedRange.end.idx);
        const endCol = Math.max(selectedRange.start.idx, selectedRange.end.idx);
        
        const selectedRows: R[] = [];
        const selectedColumns: CalculatedColumn<R, SR>[] = [];
        
        for (let rowIdx = startRow; rowIdx <= endRow; rowIdx++) {
          if (isRowIdxWithinViewportBounds(rowIdx)) {
            selectedRows.push(rows[rowIdx]);
          }
        }
        
        for (let colIdx = startCol; colIdx <= endCol; colIdx++) {
          if (isColIdxWithinSelectionBounds(colIdx)) {
            selectedColumns.push(columns[colIdx]);
          }
        }
        
        onRangePaste({
          type: 'PASTE',
          range: selectedRange,
          rows: selectedRows,
          columns: selectedColumns,
          pasteData: pasteData
        });
        event.preventDefault();
        return;
      }
    }
    
    // Regular cell paste handling
    if (!onCellPaste || !onRowsChange || !isCellEditable(selectedPosition)) {
      return;
    }

    const { idx, rowIdx } = selectedPosition;
    const column = columns[idx];
    const updatedRow = onCellPaste({ row: rows[rowIdx], column }, event);
    updateRow(column, rowIdx, updatedRow);
  }

  function handleCellInput(event: KeyboardEvent<HTMLDivElement>) {
    if (transientLock) return;
    if (!selectedCellIsWithinViewportBounds) return;
    const row = rows[selectedPosition.rowIdx];
    const { key, shiftKey } = event;

    // Select the row on Shift + Space
    if (isSelectable && shiftKey && key === ' ') {
      assertIsValidKeyGetter<R, K>(rowKeyGetter);
      const rowKey = rowKeyGetter(row);
      selectRow({ row, checked: !selectedRows.has(rowKey), isShiftClick: false });
      // prevent scrolling
      event.preventDefault();
      return;
    }

    if (isCellEditable(selectedPosition) && isDefaultCellInput(event, onCellPaste != null)) {
      setSelectedPosition(({ idx, rowIdx }) => ({
        idx,
        rowIdx,
        mode: 'EDIT',
        row,
        originalRow: row,
        editSession: {}
      }));
    }
  }

  function handleColumnResizeEnd() {
    // This check is needed as double click on the resize handle triggers onPointerMove
    if (isColumnResizing) {
      onColumnWidthsChangeRaw?.(columnWidths);
      setColumnResizing(false);
    }
    onColumnResizeEnd?.();
  }

  function handleDragHandlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // keep the focus on the cell
    event.preventDefault();
    if (event.pointerType === 'mouse' && event.buttons !== 1) {
      return;
    }
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleDragHandlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (rows.length === 0) return;
    const gridEl = gridRef.current!;
    const headerAndTopSummaryRowsHeight = headerRowsHeight + topSummaryRowsCount * summaryRowHeight;
    // An external physical root already moves with its owner. Only a stationary
    // root needs the scroll offset added back before resolving the logical row.
    const scale = isPhysicalRows ? physicalScale : 1;
    const viewportOffset = isPhysicalRows ? isStationaryRows ? viewportScrollTop : 0 : gridEl.scrollTop;
    const offset = viewportOffset + (event.clientY - gridEl.getBoundingClientRect().top - gridEl.clientTop) / scale
      - headerAndTopSummaryRowsHeight;
    const overRowIdx = Math.max(0, Math.min(rows.length - 1, findRowIdx(offset)));
    setDraggedOverRowIdx(overRowIdx);
    scrollPhysicalPosition({ rowIdx: overRowIdx, idx: selectedPosition.idx });
  }

  function handleDragHandleLostPointerCapture() {
    setDragging(false);
    if (draggedOverRowIdx === undefined) return;

    const { rowIdx } = selectedPosition;
    const [startRowIndex, endRowIndex] =
      rowIdx < draggedOverRowIdx
        ? [rowIdx + 1, draggedOverRowIdx + 1]
        : [draggedOverRowIdx, rowIdx];
    updateRows(startRowIndex, endRowIndex);
    setDraggedOverRowIdx(undefined);
  }

  function handleDragHandleClick() {
    // keep the focus on the cell but do not scroll
    focusCell(false);
  }

  function handleDragHandleDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    event.stopPropagation();
    updateRows(selectedPosition.rowIdx + 1, rows.length);
  }

  function updateRows(startRowIdx: number, endRowIdx: number) {
    if (onRowsChange == null) return;

    const { rowIdx, idx } = selectedPosition;
    const column = columns[idx];
    const sourceRow = rows[rowIdx];
    const updatedRows = [...rows];
    const indexes: number[] = [];
    for (let i = startRowIdx; i < endRowIdx; i++) {
      if (isCellEditable({ rowIdx: i, idx })) {
        const updatedRow = onFill!({ columnKey: column.key, sourceRow, targetRow: rows[i] });
        if (updatedRow !== rows[i]) {
          updatedRows[i] = updatedRow;
          indexes.push(i);
        }
      }
    }

    if (indexes.length > 0) {
      const changeData = { indexes, column };
      onRowsChange(updatedRows, changeData);
      
      // Add the change to history
      addToUndoHistory(changeData);
    }
  }

  /**
   * utils
   */
  function isColIdxWithinSelectionBounds(idx: number) {
    return idx >= minColIdx && idx <= maxColIdx;
  }

  function isRowIdxWithinViewportBounds(rowIdx: number) {
    return rowIdx >= 0 && rowIdx < rows.length;
  }

  function isCellWithinSelectionBounds({ idx, rowIdx }: Position): boolean {
    return rowIdx >= minRowIdx && rowIdx <= maxRowIdx && isColIdxWithinSelectionBounds(idx);
  }

  function isCellWithinEditBounds({ idx, rowIdx }: Position): boolean {
    return isRowIdxWithinViewportBounds(rowIdx) && idx >= 0 && idx <= maxColIdx;
  }

  function isCellWithinViewportBounds({ idx, rowIdx }: Position): boolean {
    return isRowIdxWithinViewportBounds(rowIdx) && isColIdxWithinSelectionBounds(idx);
  }

  function isCellEditable(position: Position): boolean {
    return (
      !transientLock && isCellWithinEditBounds(position) &&
      isSelectedCellEditable({ columns, rows, selectedPosition: position })
    );
  }

  function selectCell(position: Position, options?: SelectCellOptions): void {
    if (!isCellWithinSelectionBounds(position) || isEditorCommitBlocked()) return;
    commitEditorChanges();

    const samePosition = isSamePosition(selectedPosition, position);
    
    // Range selection while Shift is pressed
    if (enableRangeSelection && options?.isShiftPressed && selectedPosition.mode === 'SELECT' && selectedPosition.rowIdx >= 0 && position.rowIdx >= 0) {
      const newRange = { start: selectedRange?.start ?? { rowIdx: selectedPosition.rowIdx, idx: selectedPosition.idx }, end: position };
      setSelectedRange(newRange);
      onSelectedRangeChange?.(newRange);
      setSelectedPosition({ ...position, mode: 'SELECT' });
      setShouldFocusCell(options.shouldFocusCell === true);
      return;
    }
    
    // Clear range selection
    if (enableRangeSelection && selectedRange) {
      setSelectedRange(null);
      onSelectedRangeChange?.(null);
    }

    if (options?.enableEditor && isCellEditable(position)) {
      const row = rows[position.rowIdx];
      setSelectedPosition({ ...position, mode: 'EDIT', row, originalRow: row, editSession: {} });
    } else if (samePosition) {
      // Avoid re-renders if the selected cell state is the same
      if (physicalLayoutReady) scrollPhysicalPosition(position);
      else setScrollToPosition(position);
    } else {
      setShouldFocusCell(options?.shouldFocusCell === true);
      setSelectedPosition({ ...position, mode: 'SELECT' });
    }

    if (onSelectedCellChange && (!samePosition || selectedRange !== null)) {
      onSelectedCellChange({
        rowIdx: position.rowIdx,
        row: isRowIdxWithinViewportBounds(position.rowIdx) ? rows[position.rowIdx] : undefined,
        column: columns[position.idx]
      });
    }
  }

  function selectHeaderCell({ idx, rowIdx }: Position, options?: SelectCellOptions): void {
    selectCell({ rowIdx: minRowIdx + rowIdx - 1, idx }, options);
  }

  function getNextPosition(key: string, ctrlKey: boolean, shiftKey: boolean): Position {
    const { idx, rowIdx } = selectedPosition;
    const isRowSelected = selectedCellIsWithinSelectionBounds && idx === -1;

    const firstDataIdx = rowIndicator ? 1 : 0;
    if (ctrlKey && ['ArrowUp', 'ArrowDown', leftKey, rightKey].includes(key) && rowIdx >= 0) {
      const dr = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
      const dc = key === leftKey ? -1 : key === rightKey ? 1 : 0;
      let cursor = {idx: Math.max(firstDataIdx, idx), rowIdx};
      const valid = (p: Position) => p.idx >= firstDataIdx && p.idx <= maxColIdx && p.rowIdx >= 0 && p.rowIdx < rows.length;
      const filled = (p: Position) => { const col = columns[p.idx]; const source = rows[p.rowIdx]; const value = col.getNavigationValue ? col.getNavigationValue(source) : source[col.key as keyof R]; return value !== '' && value !== null && value !== undefined; };
      let next = {idx: cursor.idx + dc, rowIdx: cursor.rowIdx + dr};
      if (!valid(next)) return cursor;
      const contiguous = filled(cursor) && filled(next);
      while (valid(next)) {
        if (contiguous && !filled(next)) break;
        cursor = next;
        if (!contiguous && filled(cursor)) break;
        next = {idx: cursor.idx + dc, rowIdx: cursor.rowIdx + dr};
      }
      return cursor;
    }
    switch (key) {
      case 'Enter':
        return { idx: Math.max(firstDataIdx, idx), rowIdx: Math.max(0, Math.min(rows.length - 1, rowIdx + (shiftKey ? -1 : 1))) };
      case 'ArrowUp':
        return { idx, rowIdx: Math.max(0, rowIdx - 1) };
      case 'ArrowDown':
        return { idx, rowIdx: rowIdx + 1 };
      case leftKey:
        return { idx: idx - 1, rowIdx };
      case rightKey:
        return { idx: idx + 1, rowIdx };
      case 'Tab':
        return { idx: idx + (shiftKey ? -1 : 1), rowIdx };
      case 'Home':
        // If row is selected then move focus to the first row
        if (isRowSelected) return { idx, rowIdx: minRowIdx };
        return { idx: firstDataIdx, rowIdx: ctrlKey ? 0 : Math.max(0, rowIdx) };
      case 'End':
        // If row is selected then move focus to the last row.
        if (isRowSelected) return { idx, rowIdx: maxRowIdx };
        return { idx: maxColIdx, rowIdx: ctrlKey ? maxRowIdx : rowIdx };
      case 'PageUp': {
        if (selectedPosition.rowIdx === minRowIdx) return selectedPosition;
        const nextRowY = getRowTop(rowIdx) + getRowHeight(rowIdx) - viewportClientHeight;
        return { idx, rowIdx: nextRowY > 0 ? findRowIdx(nextRowY) : 0 };
      }
      case 'PageDown': {
        if (selectedPosition.rowIdx >= rows.length) return selectedPosition;
        const nextRowY = getRowTop(rowIdx) + viewportClientHeight;
        return { idx, rowIdx: nextRowY < totalRowHeight ? findRowIdx(nextRowY) : rows.length - 1 };
      }
      default:
        return selectedPosition;
    }
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>, boundary = false) {
    if (isEditorCommitBlocked()) { event.preventDefault(); return; }
    const { key, shiftKey } = event;
    let cellNavigationMode: CellNavigationMode = 'NONE';
    if (key === 'Tab') {
      if (
        canExitGrid({
          shiftKey,
          maxColIdx,
          minRowIdx,
          maxRowIdx,
          selectedPosition
        })
      ) {
        commitEditorChanges();
        // Allow focus to leave the grid so the next control in the tab order can be focused
        return;
      }

      cellNavigationMode = 'CHANGE_ROW';
    }

    // prevent scrolling and do not allow focus to leave
    event.preventDefault();

    const ctrlKey = boundary || isCtrlKeyHeldDown(event);
    const nextPosition = getNextPosition(key, ctrlKey, shiftKey);
    if (key === 'Home' && gridRef.current) {
      // Sticky headers and frozen columns can be visible while the logical first
      // row/column is far offscreen. Restore the scroll origin even when selected.
      scrollToGridStart(isStationaryRows ? externalViewportExtentRef!.current! : gridRef.current,
        externalScrollRef?.current, direction, nextPosition.rowIdx === 0);
      // Update sticky cells before focus can scroll using old offsets.
      externalViewport?.refresh();
    }
    if (isSamePosition(selectedPosition, nextPosition)) { if (key === 'Enter') commitEditorChanges(); return; }

    const nextSelectedCellPosition = getNextSelectedCellPosition({
      moveUp: key === 'ArrowUp',
      moveNext: key === rightKey || (key === 'Tab' && !shiftKey),
      columns,
      colSpanColumns,
      rows,
      topSummaryRows,
      bottomSummaryRows,
      minRowIdx,
      mainHeaderRowIdx,
      maxRowIdx,
      lastFrozenColumnIndex,
      cellNavigationMode,
      currentPosition: selectedPosition,
      nextPosition,
      isCellWithinBounds: isCellWithinSelectionBounds
    });

    selectCell(nextSelectedCellPosition, { shouldFocusCell: true, isShiftPressed: shiftKey && key !== 'Tab' && key !== 'Enter' });
  }

  function getDraggedOverCellIdx(currentRowIdx: number): number | undefined {
    if (draggedOverRowIdx === undefined) return;
    const { rowIdx } = selectedPosition;

    const isDraggedOver =
      rowIdx < draggedOverRowIdx
        ? rowIdx < currentRowIdx && currentRowIdx <= draggedOverRowIdx
        : rowIdx > currentRowIdx && currentRowIdx >= draggedOverRowIdx;

    return isDraggedOver ? selectedPosition.idx : undefined;
  }

  function getDragHandle() {
    if (transientLock) return;
    if (
      onFill == null ||
      selectedPosition.mode === 'EDIT' ||
      !isCellWithinViewportBounds(selectedPosition)
    ) {
      return;
    }

    const { idx, rowIdx } = selectedPosition;
    const column = columns[idx];
    if (column.renderEditCell == null || column.editable === false) {
      return;
    }

    const isLastRow = rowIdx === maxRowIdx;
    const columnWidth = getColumnWidth(column);
    const colSpan = column.colSpan?.({ type: 'ROW', row: rows[rowIdx] }) ?? 1;
    const { insetInlineStart, ...style } = getCellStyle(column, colSpan);
    const marginEnd = 'calc(var(--rdg-drag-handle-size) * -0.5 + 1px)';
    const isLastColumn = column.idx + colSpan - 1 === maxColIdx;
    const dragHandleStyle: React.CSSProperties = {
      ...style,
      gridRowStart: headerAndTopSummaryRowsCount + rowIdx + 1,
      marginInlineEnd: isLastColumn ? undefined : marginEnd,
      marginBlockEnd: isLastRow ? undefined : marginEnd,
      insetInlineStart: insetInlineStart
        ? `calc(${insetInlineStart} + ${columnWidth}px + var(--rdg-drag-handle-size) * -0.5 - 1px)`
        : undefined
    };

    return (
      <div
        style={dragHandleStyle}
        className={clsx(cellDragHandleClassname, column.frozen && cellDragHandleFrozenClassname)}
        onPointerDown={handleDragHandlePointerDown}
        onPointerMove={isDragging ? handleDragHandlePointerMove : undefined}
        onLostPointerCapture={isDragging ? handleDragHandleLostPointerCapture : undefined}
        onClick={handleDragHandleClick}
        onDoubleClick={handleDragHandleDoubleClick}
      />
    );
  }

  function getCellEditor(rowIdx: number) {
    if (transientLock && !retainPendingEditor) return;
    if (selectedPosition.rowIdx !== rowIdx || selectedPosition.mode === 'SELECT') return;
    // A settings-only snapshot may keep the row identity while revoking editing.
    // Match external row replacement: close the draft without committing it.
    if (!(retainPendingEditor && transientLock
      ? isSelectedCellEditable({ columns, rows, selectedPosition }) : isCellEditable(selectedPosition))) {
      setSelectedPosition(({ idx, rowIdx }) => ({ idx, rowIdx, mode: 'SELECT' }));
      return;
    }

    const { idx, row, editSession } = selectedPosition;
    const column = columns[idx];
    const colSpan = getColSpan(column, lastFrozenColumnIndex, { type: 'ROW', row });
    const closeOnExternalRowChange = column.editorOptions?.closeOnExternalRowChange ?? true;

    const closeEditor = (shouldFocusCell: boolean) => {
      setShouldFocusCell(shouldFocusCell);
      setSelectedPosition(({ idx, rowIdx }) => ({ idx, rowIdx, mode: 'SELECT' }));
    };

    const onRowChange = (row: R, commitChanges: boolean, shouldFocusCell: boolean) => {
      if (commitChanges && (isEditorCommitBlocked() || !isCellEditableLatest.current(selectedPosition))) return;
      if (commitChanges) {
        if (!finishEditorSession(selectedPosition)) return;
        // Blur can run inside a focus scope's React effect. Deliver the row now,
        // but let React finish that commit rather than recursively flushing it.
        // Queue closing first so a reentrant owner can select a newer cell.
        closeEditor(shouldFocusCell);
        updateRow(column, selectedPosition.rowIdx, row);
      } else if (!finishedEditorSessionsRef.current.has(editSession)) {
        setSelectedPosition((position) => position.mode === 'EDIT' && position.editSession === editSession
          ? { ...position, row } : position);
      }
    };

    if (
      closeOnExternalRowChange &&
      rows[selectedPosition.rowIdx] !== selectedPosition.originalRow
    ) {
      // Discard changes if rows are updated from outside
      closeEditor(false);
    }

    return (
      <EditCell
        busy={transientLock}
        key={column.key}
        column={column}
        colSpan={colSpan}
        row={row}
        rowIdx={rowIdx}
        onRowChange={onRowChange}
        closeEditor={(shouldFocusCell) => {
          if (finishEditorSession(selectedPosition)) closeEditor(shouldFocusCell);
        }}
        onKeyDown={onCellKeyDown}
        navigate={navigate}
      />
    );
  }

  function getRowViewportColumns(rowIdx: number) {
    // idx can be -1 if grouping is enabled
    const selectedColumn = selectedPosition.idx === -1 ? undefined : columns[selectedPosition.idx];
    if (
      selectedColumn !== undefined &&
      selectedPosition.rowIdx === rowIdx &&
      !viewportColumns.includes(selectedColumn)
    ) {
      // Add the selected column to viewport columns if the cell is not within the viewport
      return selectedPosition.idx > colOverscanEndIdx
        ? [...viewportColumns, selectedColumn]
        : [
            ...viewportColumns.slice(0, lastFrozenColumnIndex + 1),
            selectedColumn,
            ...viewportColumns.slice(lastFrozenColumnIndex + 1)
          ];
    }
    return viewportColumns;
  }

  function getViewportRows() {
    const rowElements: React.ReactNode[] = [];
    // Most rows share this exact array; only pinned/selected rows need another scan.
    const viewportBodyWindow = resolvePhysicalBodyWindow(physicalBodyWindow, viewportColumns);

    const { idx: selectedIdx, rowIdx: selectedRowIdx } = selectedPosition;

    const startRowIdx =
      selectedCellIsWithinViewportBounds && selectedRowIdx < rowOverscanStartIdx
        ? rowOverscanStartIdx - 1
        : rowOverscanStartIdx;
    const endRowIdx =
      selectedCellIsWithinViewportBounds && selectedRowIdx > rowOverscanEndIdx
        ? rowOverscanEndIdx + 1
        : rowOverscanEndIdx;

    for (let viewportRowIdx = startRowIdx; viewportRowIdx <= endRowIdx; viewportRowIdx++) {
      const isRowOutsideViewport =
        viewportRowIdx === rowOverscanStartIdx - 1 || viewportRowIdx === rowOverscanEndIdx + 1;
      const rowIdx = isRowOutsideViewport ? selectedRowIdx : viewportRowIdx;

      let rowColumns = viewportColumns;
      const selectedColumn = selectedIdx === -1 ? undefined : columns[selectedIdx];
      if (selectedColumn !== undefined) {
        if (isRowOutsideViewport) {
          // if the row is outside the viewport then only render the selected cell
          rowColumns = [selectedColumn];
        } else {
          // if the row is within the viewport and cell is not, add the selected column to viewport columns
          rowColumns = getRowViewportColumns(rowIdx);
        }
      }

      const rowBodyWindow = rowColumns === viewportColumns
        ? viewportBodyWindow
        : resolvePhysicalBodyWindow(physicalBodyWindow, rowColumns);
      const row = rows[rowIdx];
      const gridRowStart = headerAndTopSummaryRowsCount + rowIdx + 1;
      const key = rowKeyGetter(row);
      const isRowSelected = selectedRows?.has(key) ?? false;

      const rowRange = enableRangeSelection && selectedRange
        && rowIdx >= Math.min(selectedRange.start.rowIdx, selectedRange.end.rowIdx)
        && rowIdx <= Math.max(selectedRange.start.rowIdx, selectedRange.end.rowIdx)
        ? selectedRange : undefined;
      rowElements.push(
        renderRow(key, {
          // aria-rowindex is 1 based
          'aria-rowindex': headerAndTopSummaryRowsCount + rowIdx + 1,
          'aria-selected': isSelectable ? isRowSelected : undefined,
          rowIdx,
          row,
          sharedTooltip,
          viewportColumns: rowColumns,
          transientLock,
          isRowSelectionDisabled: isRowSelectionDisabled?.(row) ?? false,
          isRowSelected,
          onCellMouseDown: onCellMouseDownLatest,
          onCellClick: onCellClickLatest,
          onCellDoubleClick: onCellDoubleClickLatest,
          onCellContextMenu: onCellContextMenuLatest,
          onRowContextMenu: onRowContextMenu as ((row: R, event: React.MouseEvent<HTMLDivElement, MouseEvent>) => void) | undefined,
          rowClass,
          gridRowStart,
          physicalRowTop: isStationaryRows ? getStationaryRowTop(rowIdx, getRowTop(rowIdx), getRowHeight(rowIdx),
            physicalScale, headerRowsHeight, viewportScrollTop, externalViewport?.ownerClientHeight ?? 0,
            stationaryWindow, isRowOutsideViewport)
            : isPhysicalRows ? (headerRowsHeight + getRowTop(rowIdx)) * physicalScale : undefined,
          physicalRowHeight: isPhysicalRows ? getRowHeight(rowIdx) : undefined,
          physicalBodyWindow: rowBodyWindow,
          physicalBodyFallback: rowBodyWindow ? undefined : physicalBodyBaseFallback ?? 'selected-pin',
          selectedCellIdx: selectedRowIdx === rowIdx ? selectedIdx : undefined,
          draggedOverCellIdx: getDraggedOverCellIdx(rowIdx),
          lastFrozenColumnIndex,
          onRowChange: handleFormatterRowChangeLatest,
          selectCell: selectCellLatest,
          selectedCellEditor: getCellEditor(rowIdx),
          isCurrentRowSelected: selectedPosition.mode === 'SELECT' && selectedRowIdx === rowIdx,
          isHovered: hoveredRowIdx === rowIdx,
          rangeStartIdx: rowRange ? Math.min(rowRange.start.idx, rowRange.end.idx) : undefined,
          rangeEndIdx: rowRange ? Math.max(rowRange.start.idx, rowRange.end.idx) : undefined,
          getCellBackgroundColor,
          onRowHover: setHoveredRowIdx
        })
      );
    }

    return rowElements;
  }

  // Reset the positions if the current values are no longer valid. This can happen if a column or row is removed
  if (selectedPosition.idx > maxColIdx || selectedPosition.rowIdx > maxRowIdx) {
    setSelectedPosition({ idx: -1, rowIdx: minRowIdx - 1, mode: 'SELECT' });
    setDraggedOverRowIdx(undefined);
  }

  // Keep the state and prop in sync
  if (isColumnWidthsControlled && columnWidthsInternal !== columnWidthsRaw) {
    setColumnWidthsInternal(columnWidthsRaw);
  }

  let templateRows = `repeat(${headerRowsCount}, ${headerRowHeight}px)`;
  if (topSummaryRowsCount > 0) {
    templateRows += ` repeat(${topSummaryRowsCount}, ${summaryRowHeight}px)`;
  }
  if (rows.length > 0) {
    templateRows += gridTemplateRows;
  }
  if (bottomSummaryRowsCount > 0) {
    templateRows += ` repeat(${bottomSummaryRowsCount}, ${summaryRowHeight}px)`;
  }

  const isGroupRowFocused =
    selectedPosition.idx === -1 && selectedPosition.rowIdx !== minRowIdx - 1;

  const mainHeaderViewportColumns = getRowViewportColumns(mainHeaderRowIdx);
  const mainHeaderBodyWindow = resolvePhysicalBodyWindow(physicalBodyWindow, mainHeaderViewportColumns);
  const physicalLogicalHeight = headerRowsHeight + totalRowHeight;
  // The stationary wrapper's CSS minimum fills the viewport. Feeding measured
  // owner sizes back into its content extent can create scrollbar feedback.
  const physicalPaintWidth = Math.max((totalColumnWidth + (externalViewportPadding?.inlineEnd ?? 0)) * physicalScale,
    isStationaryRows ? 0 : externalViewport?.ownerClientWidth ?? 0);
  const physicalPaintHeight = Math.max((physicalLogicalHeight + (externalViewportPadding?.blockEnd ?? 0)) * physicalScale,
    isStationaryRows ? 0 : externalViewport?.ownerClientHeight ?? 0);
  const measuringColumns = isPhysicalRows && measuringColumnKeys.length > 0
    ? [...viewportColumns, ...columns.filter(column => measuringColumnKeys.includes(column.key) && !viewportColumns.includes(column))]
    : viewportColumns;

  function syncPersistentPhysicalExtent(): boolean {
    const extent = externalViewportExtentRef?.current;
    if (!extent || !gridRef.current || !extent.contains(gridRef.current)) return false;
    const width = `${physicalPaintWidth}px`, height = `${physicalPaintHeight}px`;
    if (extent.style.width !== width) extent.style.width = width;
    if (extent.style.height !== height) extent.style.height = height;
    // The view owns this node. Never clear its dimensions during keyed unmount.
    return true;
  }
  function measurePhysicalColumns(plan: ColumnMeasurementPlan): ReadonlyMap<string, number> | undefined {
    const root = gridRef.current, utility = physicalUtilityRef.current;
    if (!root || !utility) return undefined;
    // An empty offscreen sentinel has no intrinsic content contribution. Keep the
    // previous width when a viewport-only max-content request cannot be measured.
    if (plan.keys.some(key => {
      const column = columns.find(column => column.key === key);
      return column !== undefined && plan.templateColumns[column.idx] === 'max-content' &&
        !viewportColumns.includes(column);
    })) return undefined;
    function readWidths() {
      const result = new Map<string, number>();
      for (const key of plan.keys) {
        const width = utility!.querySelector<HTMLElement>(`[data-measuring-cell-key="${CSS.escape(key)}"]`)?.offsetWidth;
        if (width === undefined || !Number.isFinite(width) || width <= 0) return undefined;
        result.set(key, width);
      }
      return result;
    }
    if (plan.numericResize) {
      const previous = utility.style.gridTemplateColumns;
      try { utility.style.gridTemplateColumns = plan.templateColumns.join(' '); return readWidths(); }
      finally { utility.style.gridTemplateColumns = previous; }
    }
    const attribute = root.getAttribute('data-rdg-measuring');
    const names = ['--rdg-measure-columns', '--rdg-measure-rows'] as const;
    const previous = names.map(name => [name, root.style.getPropertyValue(name), root.style.getPropertyPriority(name)] as const);
    try {
      root.style.setProperty('--rdg-measure-columns', plan.templateColumns.join(' '));
      root.style.setProperty('--rdg-measure-rows', templateRows);
      root.setAttribute('data-rdg-measuring', '');
      return readWidths();
    } finally {
      if (attribute === null) root.removeAttribute('data-rdg-measuring'); else root.setAttribute('data-rdg-measuring', attribute);
      for (const [name, value, priority] of previous) {
        if (value) root.style.setProperty(name, value, priority); else root.style.removeProperty(name);
      }
    }
  }
  function scrollPhysicalPosition(position: PartialPosition): boolean {
    const root = gridRef.current, owner = externalScrollRef?.current ?? root;
    if (!physicalLayoutReady || !owner || !root) return false;
    const scale = isPhysicalRows ? physicalScale : 1;
    const origin = isStationaryRows ? externalViewportExtentRef?.current : root;
    if (!origin || !origin.isConnected || !origin.contains(root)) return false;
    const ownerRect = owner.getBoundingClientRect(), rootRect = origin.getBoundingClientRect();
    const viewportLeft = ownerRect.left + owner.clientLeft, viewportTop = ownerRect.top + owner.clientTop;
    const originX = owner === root ? 0 : owner.scrollLeft + rootRect.left - viewportLeft + origin.clientLeft;
    const originY = owner === root ? 0 : owner.scrollTop + rootRect.top - viewportTop + origin.clientTop;
    let left = owner.scrollLeft, top = owner.scrollTop;
    const alignStart = position.scrollPosition === 'top-left';
    const idx = position.idx;
    if (idx !== undefined && idx > lastFrozenColumnIndex && idx >= 0 && idx < columns.length) {
      const column = columns[idx], metric = columnMetrics.get(column)!;
      const r = position.rowIdx;
      let spanArgs: ColSpanArgs<R, SR> = { type: 'HEADER' };
      if (r !== undefined && r >= 0 && r < rows.length) {
        const row = rows[r];
        if (row === undefined) return false;
        spanArgs = { type: 'ROW', row };
      } else if (r !== undefined && r > mainHeaderRowIdx && r < 0) {
        const row = topSummaryRows?.[r - mainHeaderRowIdx - 1];
        if (row === undefined) return false;
        spanArgs = { type: 'SUMMARY', row };
      } else if (r !== undefined && r >= rows.length && r <= maxRowIdx) {
        const row = bottomSummaryRows?.[r - rows.length];
        if (row === undefined) return false;
        spanArgs = { type: 'SUMMARY', row };
      }
      const span = getColSpan<R, SR>(column, lastFrozenColumnIndex, spanArgs) ?? 1;
      const endMetric = columnMetrics.get(columns[Math.min(columns.length - 1, idx + span - 1)])!;
      // RTL rows anchor to the root's physical inline start, including its
      // viewport minimum/trailing padding; total column width is not that edge.
      const inlineRight = originX + root.clientWidth;
      const start = direction === 'rtl' ? inlineRight - (endMetric.left + endMetric.width) * scale
        : originX + metric.left * scale;
      const end = direction === 'rtl' ? inlineRight - metric.left * scale
        : originX + (endMetric.left + endMetric.width) * scale;
      const frozen = totalFrozenColumnWidth * scale;
      const visibleStart = left + (direction === 'rtl' ? 0 : frozen);
      const visibleEnd = left + owner.clientWidth - (direction === 'rtl' ? frozen : 0);
      left += alignStart ? direction === 'rtl' ? end - visibleEnd : start - visibleStart
        : getNearestScrollOffset(start, end, visibleStart, visibleEnd);
    }
    const rowIdx = position.rowIdx;
    if (rowIdx !== undefined && rowIdx >= 0 && rowIdx < rows.length) {
      const stickyTop = headerRowsHeight + topSummaryRowsCount * summaryRowHeight;
      const start = originY + (stickyTop + getRowTop(rowIdx)) * scale;
      const end = start + getRowHeight(rowIdx) * scale;
      const visibleStart = top + stickyTop * scale;
      const visibleEnd = top + owner.clientHeight - bottomSummaryRowsCount * summaryRowHeight * scale;
      if (alignStart) {
        const previousTrackTop = rowIdx === 0 ? 0 : stickyTop + getRowTop(rowIdx - 1);
        top = originY + (previousTrackTop - 5 - stickyTop) * scale;
      } else top += getNearestScrollOffset(start, end, visibleStart, visibleEnd);
    } else if (alignStart && rowIdx === undefined) top = originY;
    owner.scrollTo({ left, top, behavior: 'instant' });
    // Read actual clamped offsets only for an explicit reveal, never on the scroll hot path.
    if (isStationaryRows) lastPhysicalReveal.current = {
      left: Math.max(0, (owner.scrollLeft - originX) / scale),
      top: Math.max(0, (owner.scrollTop - originY) / scale), version: physicalLayoutToken
    };
    if (externalViewport) externalViewport.refresh();
    else { setScrollTop(owner.scrollTop); setScrollLeft(abs(owner.scrollLeft)); }
    return true;
  }
  function scrollPhysicalElement(element: HTMLElement): boolean {
    const cell = element.closest<HTMLElement>('[role="gridcell"], [role="columnheader"]');
    const row = cell?.closest<HTMLElement>('[role="row"]');
    if (!cell || !row || (isStationaryRows
      ? !gridRef.current || !getOwnedPhysicalCell(gridRef.current, element)
      : row.parentElement !== gridRef.current)) return false;
    const rowIdx = row.dataset.rowIndex !== undefined ? Number(row.dataset.rowIndex)
      : cell.dataset.rowIndex !== undefined ? Number(cell.dataset.rowIndex)
      : Number(row.getAttribute('aria-rowindex')) - headerAndTopSummaryRowsCount - 1;
    return scrollPhysicalPosition({ idx: Number(cell.getAttribute('aria-colindex')) - 1, rowIdx });
  }
  function requestPhysicalFocus(element: HTMLElement, select = false): () => void {
    if (!element.isConnected) return () => {};
    if (isStationaryRows) {
      const owned = gridRef.current && getOwnedPhysicalCell(gridRef.current, element);
      if (!owned) return () => {};
      const position = { idx: Number(owned.cell.getAttribute('aria-colindex')) - 1,
        rowIdx: Number(owned.row.getAttribute('aria-rowindex')) - headerRowsCount - 1 };
      if (!isCellWithinSelectionBounds(position)) return () => {};
      const request: StationaryFocusRequest = { element, select, origin: element.ownerDocument.activeElement,
        position, rowIdentity: getFocusRowIdentity(position.rowIdx), columnKey: columns[position.idx].key,
        selection: { idx: selectedPosition.idx, rowIdx: selectedPosition.rowIdx } };
      pendingStationaryFocus.current.set(element, request);
      if (physicalLayoutReady && scrollPhysicalPosition(position)) request.expected = lastPhysicalReveal.current;
      completeStationaryFocus();
      return () => { if (pendingStationaryFocus.current.get(element) === request) pendingStationaryFocus.current.delete(element); };
    }
    if (physicalLayoutReady) {
      scrollPhysicalElement(element);
      element.focus({ preventScroll: true });
      if (select && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) element.select();
      return () => {};
    }
    const request = { element, select, origin: element.ownerDocument.activeElement, cancelled: false };
    pendingPhysicalFocus.current.add(request);
    return () => { request.cancelled = true; pendingPhysicalFocus.current.delete(request); };
  }

  function getFocusRowIdentity(rowIdx: number): unknown {
    return rowIdx < 0 ? rowIdx : rowKeyGetter(rows[rowIdx]);
  }
  function isStationaryPositionRevealed(position: Position): boolean {
    if (!physicalLayoutReady || !externalViewport || !isCellWithinSelectionBounds(position)) return false;
    // Only the visible edge admits one physical CSS pixel of native scroll rounding.
    // Pending focus separately requires the actual clamped owner offset to match the commit.
    const edgeTolerancePx = 1;
    if (position.rowIdx >= 0) {
      if (!stationaryWindow || position.rowIdx < stationaryWindow.start || position.rowIdx > stationaryWindow.end) return false;
      const top = headerRowsHeight + getRowTop(position.rowIdx);
      if (Math.abs(getNearestScrollOffset(top, top + getRowHeight(position.rowIdx),
        externalViewport.scrollTop + headerRowsHeight, externalViewport.scrollTop + externalViewport.clientHeight)) * physicalScale > edgeTolerancePx) return false;
    }
    if (position.idx > lastFrozenColumnIndex) {
      const metric = columnMetrics.get(columns[position.idx])!;
      if (!viewportColumns.includes(columns[position.idx]) || Math.abs(getNearestScrollOffset(metric.left,
        metric.left + metric.width, externalViewport.scrollLeft + totalFrozenColumnWidth,
        externalViewport.scrollLeft + externalViewport.clientWidth)) * physicalScale > edgeTolerancePx) return false;
    }
    return true;
  }
  function revealStationaryEditorIntent(target: EventTarget | null) {
    if (!isStationaryRows || !physicalLayoutReady || !(target instanceof HTMLElement) || !gridRef.current) return;
    const owned = getOwnedPhysicalCell(gridRef.current, target);
    if (!owned) return;
    const input = target.closest<HTMLElement>('input, textarea, [contenteditable="true"]');
    if (!input || !owned.cell.contains(input) || input.matches('input[type="checkbox"], input[type="radio"], input[type="range"], input[type="button"], input[type="submit"]')) return;
    const isCellEditor = owned.cell.classList.contains('rdg-editor-container');
    const isVersionInput = input.matches('[data-version-badge="true"] > .version-badge-input > input[type="text"]');
    if (!isCellEditor && !isVersionInput) return;
    const position = { idx: Number(owned.cell.getAttribute('aria-colindex')) - 1,
      rowIdx: Number(owned.row.getAttribute('aria-rowindex')) - headerRowsCount - 1 };
    if (!(isVersionInput ? isCellWithinSelectionBounds(position) : isCellWithinEditBounds(position))
      || isStationaryPositionRevealed(position)) return;
    // Native caret actions must see the model row, not a parked proxy rectangle.
    // Only explicit editor intent flushes the existing refresh before default input;
    // scrolling alone neither reveals nor focuses/reselects an offscreen draft.
    flushSync(() => { scrollPhysicalPosition(position); });
  }
  function completeStationaryFocus() {
    if (pendingStationaryFocus.current.size === 0) return;
    if (!isStationaryRows) { pendingStationaryFocus.current.clear(); return; }
    for (const [element, request] of pendingStationaryFocus.current) {
      const { position } = request;
      const active = element.ownerDocument.activeElement;
      const owned = gridRef.current && getOwnedPhysicalCell(gridRef.current, element);
      if (!element.isConnected || !owned || !isCellWithinSelectionBounds(position)
        || getFocusRowIdentity(position.rowIdx) !== request.rowIdentity || columns[position.idx]?.key !== request.columnKey
        || Number(owned.cell.getAttribute('aria-colindex')) - 1 !== position.idx
        || Number(owned.row.getAttribute('aria-rowindex')) - headerRowsCount - 1 !== position.rowIdx
        || !isSamePosition(request.selection, selectedPosition)
        || (active !== request.origin && active !== element && active !== element.ownerDocument.body)) {
        pendingStationaryFocus.current.delete(element); continue;
      }
      if (!physicalLayoutReady || !externalViewport) continue;
      if (request.expected?.version !== physicalLayoutToken) {
        if (!scrollPhysicalPosition(position)) continue;
        request.expected = lastPhysicalReveal.current;
      }
      const expected = request.expected;
      if (!expected || Math.abs(externalViewport.scrollLeft - expected.left) * physicalScale > 0.01
        || Math.abs(externalViewport.scrollTop - expected.top) * physicalScale > 0.01) continue;
      // A parked row or overscan cell can exist without its requested reveal being committed.
      if (!isStationaryPositionRevealed(position)) continue;
      pendingStationaryFocus.current.delete(element);
      element.focus({ preventScroll: true });
      if (request.select && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) element.select();
    }
  }

  return (
    // biome-ignore lint/a11y/useValidAriaProps: aria-description is a valid prop
    <div
      role={role}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-description={ariaDescription}
      aria-describedby={ariaDescribedBy}
      aria-multiselectable={isSelectable ? true : undefined}
      aria-colcount={columns.length}
      aria-rowcount={ariaRowCount}
      // Scrollable containers without tabIndex are keyboard focusable in Chrome only if there is no focusable element inside
      // whereas they are always focusable in Firefox. We need to set tabIndex to have a consistent behavior across browsers.
      tabIndex={shouldFocusGrid ? 0 : -1}
      className={clsx(
        rootClassname,
        isPhysicalRows && physicalRowsClassname,
        isStationaryRows && stationaryRowsClassname,
        {
          [viewportDraggingClassname]: isDragging,
          'rdg-physical-rows-viewport': isPhysicalRows,
          'rdg-stationary-rows-viewport': isStationaryRows,
          'rdg-alternating-rows': alternatingRowColors !== undefined && alternatingRowColors !== false
        },
        className
      )}
      style={
        {
          ...style,
          ...(isPhysicalRows ? { width: isStationaryRows ? externalViewport?.ownerClientWidth ?? 0 : physicalPaintWidth,
            height: isStationaryRows ? externalViewport?.ownerClientHeight ?? 0 : physicalPaintHeight, minWidth: 0, minHeight: 0 } : {}),
          '--rdg-stationary-client-width': isStationaryRows ? `${externalViewport?.ownerClientWidth ?? 0}px` : undefined,
          // Custom alternatingRowColors settings
          ...(alternatingRowColors && typeof alternatingRowColors === 'object' ? {
            '--rdg-row-even-background-color': alternatingRowColors.even,
            '--rdg-row-odd-background-color': alternatingRowColors.odd
          } as React.CSSProperties : {}),
          // set scrollPadding to correctly position non-sticky cells after scrolling
          scrollPaddingInlineStart:
            selectedPosition.idx > lastFrozenColumnIndex || scrollToPosition?.idx !== undefined
              ? `${totalFrozenColumnWidth}px`
              : undefined,
          scrollPaddingBlock:
            isRowIdxWithinViewportBounds(selectedPosition.rowIdx) ||
            scrollToPosition?.rowIdx !== undefined
              ? `${headerRowsHeight + topSummaryRowsCount * summaryRowHeight}px ${
                  bottomSummaryRowsCount * summaryRowHeight
                }px`
              : undefined,
          gridTemplateColumns: isPhysicalRows ? 'minmax(0, 1fr)' : gridTemplateColumns,
          gridTemplateRows: isPhysicalRows ? 'minmax(0, 1fr)' : templateRows,
          '--rdg-physical-scale': isPhysicalRows ? physicalScale : undefined,
          '--rdg-physical-cell-width': isPhysicalRows ? `${totalColumnWidth * physicalScale}px` : undefined,
          '--rdg-physical-logical-height': isPhysicalRows ? `${physicalLogicalHeight + (externalViewportPadding?.blockEnd ?? 0)}px` : undefined,
          '--rdg-physical-logical-width': isPhysicalRows ? `${totalColumnWidth}px` : undefined,
          '--rdg-physical-frozen-width': isPhysicalRows ? `${totalFrozenColumnWidth}px` : undefined,
          '--rdg-physical-columns': isPhysicalRows ? gridTemplateColumns : undefined,
          '--rdg-physical-prefix-columns': isPhysicalRows ? templateColumns.slice(0, lastFrozenColumnIndex + 1).join(' ') : undefined,
          '--rdg-physical-transform-origin': isPhysicalRows ? (direction === 'rtl' ? '100% 0' : '0 0') : undefined,
          '--rdg-header-row-height': `${headerRowHeight}px`,
          // Native sticky offsets are not scale-aware across an external scroller.
          '--rdg-scroll-height': `${scrollHeight}px`,
          ...layoutCssVars
        } as unknown as React.CSSProperties
      }
      dir={direction}
      ref={gridRef}
      onFocus={shouldFocusGrid ? handleFocus : undefined}
      onScroll={handleScroll}
      onPointerDownCapture={event => {
        if (!enableRangeSelection || event.button !== 0 || !(event.target instanceof Element)) return;
        if (isEditorCommitBlocked()) { rangeDragAnchor.current = null; return; }
        if (event.target.closest('input, button, textarea, select, .rdg-cell-resizer, .rdg-editor-container')) return;
        const cell = event.target.closest<HTMLElement>('[data-row-index][data-column-index]');
        if (!cell) return;
        const position = { rowIdx: Number(cell.dataset.rowIndex), idx: Number(cell.dataset.columnIndex) };
        if (position.rowIdx < 0 || position.idx < 0) return;
        rangeDragAnchor.current = event.shiftKey && selectedPosition.rowIdx >= 0 ? selectedRange?.start ?? selectedPosition : position;
      }}
      onPointerMove={event => {
        const anchor = rangeDragAnchor.current;
        if (!enableRangeSelection || !anchor || event.buttons !== 1 || !(event.target instanceof Element)) return;
        if (isEditorCommitBlocked()) { rangeDragAnchor.current = null; return; }
        const cell = event.target.closest<HTMLElement>('[data-row-index][data-column-index]');
        if (!cell) return;
        const end = { rowIdx: Number(cell.dataset.rowIndex), idx: Number(cell.dataset.columnIndex) };
        if (end.rowIdx < 0 || end.idx < 0) return;
        if (selectedRange && isSamePosition(selectedRange.start, anchor) && isSamePosition(selectedRange.end, end)) return;
        event.preventDefault();
        const range = { start: anchor, end };
        setSelectedRange(range); onSelectedRangeChange?.(range);
        setSelectedPosition({ ...end, mode: 'SELECT' });
      }}
      onKeyDownCapture={isStationaryRows ? event => {
        if ((!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1)
          || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown',
            'Backspace', 'Delete', 'Enter'].includes(event.key)) revealStationaryEditorIntent(event.target);
      } : undefined}
      onPasteCapture={isStationaryRows ? event => revealStationaryEditorIntent(event.target) : undefined}
      onCompositionStartCapture={isStationaryRows ? event => revealStationaryEditorIntent(event.target) : undefined}
      onFocusCapture={isStationaryRows ? event => revealStationaryEditorIntent(event.target) : undefined}
      onKeyDown={handleKeyDown}
      onCopy={handleCellCopy}
      onPaste={handleCellPaste}
      data-testid={testId}
      data-cy={dataCy}
    >
      {endMode && <div role="status" aria-live="polite" data-end-mode
        style={{ position: 'sticky', bottom: 4, left: 4, zIndex: 10, gridColumn: '1 / -1',
          justifySelf: 'start', pointerEvents: 'none', padding: '2px 6px', background: 'var(--rdg-background-color)' }}>End</div>}
      <GridSharedTooltipPortal controller={sharedTooltip} />
      {/* Reset every grid boundary; only moving panes consume the committed X. */}
      <StationaryScrollXContext value={isStationaryRows ? (externalViewport?.scrollLeft ?? 0) * physicalScale : undefined}>
      <DataGridViewportContext value={physicalViewportContext}>
      <DataGridDefaultRenderersContext value={defaultGridComponents}>
        <DataGridStateContext value={dataGridState}>
          <HeaderRowSelectionChangeContext value={selectHeaderRowLatest}>
            <HeaderRowSelectionContext value={headerSelectionValue}>
            {Array.from({ length: groupedColumnHeaderRowsCount }, (_, index) => (
              <GroupedColumnHeaderRow
                key={index}
                rowIdx={index + 1}
                level={-groupedColumnHeaderRowsCount + index}
                columns={getRowViewportColumns(minRowIdx + index)}
                selectedCellIdx={
                  selectedPosition.rowIdx === minRowIdx + index ? selectedPosition.idx : undefined
                }
                selectCell={selectHeaderCellLatest}
              />
            ))}
            <HeaderRow
              headerRowClass={headerRowClass}
              physicalRowHeight={isPhysicalRows ? headerRowHeight : undefined}
              physicalBodyWindow={mainHeaderBodyWindow}
              physicalBodyFallback={mainHeaderBodyWindow ? undefined : physicalBodyBaseFallback ?? 'selected-pin'}
              rowIdx={headerRowsCount}
              columns={mainHeaderViewportColumns}
              allColumns={columns}
              onColumnResize={handleColumnResizeLatest}
              onColumnResizeEnd={handleColumnResizeEndLatest}
              onColumnsReorder={onColumnsReorderLastest}
              sortColumns={sortColumns}
              onSortColumnsChange={onSortColumnsChangeLatest}
              lastFrozenColumnIndex={lastFrozenColumnIndex}
              selectedCellIdx={
                selectedPosition.rowIdx === mainHeaderRowIdx ? selectedPosition.idx : undefined
              }
              selectCell={selectHeaderCellLatest}
              direction={direction}
            />
          </HeaderRowSelectionContext>
        </HeaderRowSelectionChangeContext>
        {rows.length === 0 && noRowsFallback ? (
          isPhysicalRows ? <div className="rdg-physical-empty" style={{ top: headerRowsHeight * physicalScale,
            width: (isStationaryRows ? externalViewport?.ownerClientWidth ?? 0 : physicalPaintWidth) / physicalScale, transform: `scale(${physicalScale})`, transformOrigin: '0 0' }}>{noRowsFallback}</div> : noRowsFallback
        ) : (
          <>
            {topSummaryRows?.map((row, rowIdx) => {
              const gridRowStart = headerRowsCount + 1 + rowIdx;
              const summaryRowIdx = mainHeaderRowIdx + 1 + rowIdx;
              const isSummaryRowSelected = selectedPosition.rowIdx === summaryRowIdx;
              const top = headerRowsHeight + summaryRowHeight * rowIdx;

              return (
                <SummaryRow
                  key={rowIdx}
                  aria-rowindex={gridRowStart}
                  rowIdx={summaryRowIdx}
                  gridRowStart={gridRowStart}
                  row={row}
                  top={top}
                  bottom={undefined}
                  viewportColumns={getRowViewportColumns(summaryRowIdx)}
                  lastFrozenColumnIndex={lastFrozenColumnIndex}
                  selectedCellIdx={isSummaryRowSelected ? selectedPosition.idx : undefined}
                  isTop
                  selectCell={selectCellLatest}
                />
              );
            })}
            <RowSelectionChangeContext value={selectRowLatest}>
              {isStationaryRows ? <div role="rowgroup" className="rdg-stationary-rowgroup" style={{
                top: stationaryWindow?.groupY ?? 0, height: stationaryWindow?.groupHeight ?? 0,
                width: externalViewport?.ownerClientWidth ?? 0
              }}>{getViewportRows()}</div> : getViewportRows()}
            </RowSelectionChangeContext>
            {bottomSummaryRows?.map((row, rowIdx) => {
              const gridRowStart = headerAndTopSummaryRowsCount + rows.length + rowIdx + 1;
              const summaryRowIdx = rows.length + rowIdx;
              const isSummaryRowSelected = selectedPosition.rowIdx === summaryRowIdx;
              const top =
                clientHeight > totalRowHeight
                  ? gridHeight - summaryRowHeight * (bottomSummaryRows.length - rowIdx)
                  : undefined;
              const bottom =
                top === undefined
                  ? summaryRowHeight * (bottomSummaryRows.length - 1 - rowIdx)
                  : undefined;

              return (
                <SummaryRow
                  aria-rowindex={ariaRowCount - bottomSummaryRowsCount + rowIdx + 1}
                  key={rowIdx}
                  rowIdx={summaryRowIdx}
                  gridRowStart={gridRowStart}
                  row={row}
                  top={top}
                  bottom={bottom}
                  viewportColumns={getRowViewportColumns(summaryRowIdx)}
                  lastFrozenColumnIndex={lastFrozenColumnIndex}
                  selectedCellIdx={isSummaryRowSelected ? selectedPosition.idx : undefined}
                  isTop={false}
                  selectCell={selectCellLatest}
                />
              );
            })}
          </>
        )}
        </DataGridStateContext>
      </DataGridDefaultRenderersContext>

      {getDragHandle()}

      {/* render empty cells that span only 1 column so we can safely measure column widths, regardless of colSpan */}
      {isPhysicalRows ? <div ref={physicalUtilityRef} className="rdg-physical-row-utility-grid" style={{
        width: totalColumnWidth, height: headerRowsHeight, gridTemplateColumns,
        gridTemplateRows: `${headerRowsHeight}px`, transform: `scale(${physicalScale})`,
        transformOrigin: direction === 'rtl' ? '100% 0' : '0 0'
      }}>{renderMeasuringCells(measuringColumns)}</div> : renderMeasuringCells(viewportColumns)}

      {/* extra div is needed for row navigation in a treegrid */}
      {isTreeGrid && (
        <div
          ref={focusSinkRef}
          tabIndex={isGroupRowFocused ? 0 : -1}
          className={clsx(focusSinkClassname, {
            [focusSinkHeaderAndSummaryClassname]: !isRowIdxWithinViewportBounds(
              selectedPosition.rowIdx
            ),
            [rowSelected]: isGroupRowFocused,
            [rowSelectedWithFrozenCell]: isGroupRowFocused && lastFrozenColumnIndex !== -1
          })}
          style={{
            gridRowStart: selectedPosition.rowIdx + headerAndTopSummaryRowsCount + 1
          }}
        />
      )}

      {scrollToPosition !== null && (
        <ScrollToCell
          scrollToPosition={scrollToPosition}
          setScrollToCellPosition={setScrollToPosition}
        />
      )}
      </DataGridViewportContext>
      </StationaryScrollXContext>
    </div>
  );
}

function getCellToScroll(gridEl: HTMLDivElement) {
  // Tooltip/custom renderer wrappers use display: contents but remain DOM nodes.
  // The focused cell can therefore be a descendant, not a direct child of its row.
  if (!gridEl.classList.contains('rdg-stationary-rows-viewport')) {
    return gridEl.querySelector<HTMLDivElement>(':scope > [role="row"] [tabindex="0"]');
  }
  const candidates = gridEl.querySelectorAll<HTMLDivElement>(
    ':scope > [role="row"] [tabindex="0"], :scope > .rdg-stationary-rowgroup > [role="row"] [tabindex="0"]');
  return Array.from(candidates).find(element => getOwnedPhysicalCell(gridEl, element)) ?? null;
}

function isSamePosition(p1: Position, p2: Position) {
  return p1.idx === p2.idx && p1.rowIdx === p2.rowIdx;
}
