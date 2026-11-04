import type { LocalizedMessage } from '@/app/i18n';
import type { Key, ReactElement, ReactNode } from 'react';

import type { DataGridProps } from './DataGrid';
import type { GridSharedTooltipController } from './GridSharedTooltip';

/**
 * Utility type excluding specified keys from a type
 * Redefinition of TypeScript's built-in Omit type
 */
export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

/**
 * Interface representing a validation result
 * Include whether the cell value is valid and any error message
 */
export interface ValidationResult {
  /** Optional application-owned message, resolved at display time. */
  localizedMessage?: LocalizedMessage;
  /** Whether the value is valid */
  readonly isValid: boolean;
  
  /** Error message when invalid */
  readonly errorMessage?: string;
  
  /** Warning message when valid but requiring attention */
  readonly warningMessage?: string;
}

/**
 * Nullable utility type
 * Accept a value of T, undefined, or null
 */
export type Maybe<T> = T | undefined | null;

/**
 * Type alias for a React state setter
 * Accept a direct value or a function receiving the previous state
 */
export type StateSetter<S> = React.Dispatch<React.SetStateAction<S>>;

/**
 * Data grid column definition interface
 * @template TRow - Row data type
 * @template TSummaryRow - Summary row data type, defaulting to unknown
 */
export interface Column<TRow, TSummaryRow = unknown> {
  /** Canonical value for keyboard region boundaries in projected views. */
  readonly getNavigationValue?: (row: TRow) => unknown;
  /** Supplement the cell's value announcement without an extra content wrapper. */
  readonly cellDescription?: (row: TRow) => { title?: string; description?: string; invalid?: boolean } | undefined;

  /** 
   * Column display name, shown in the header cell by default
   * Accept a string or React element
   */
  readonly name: string | ReactElement;
  
  /** 
   * Unique key distinguishing each column
   * Used to identify columns in operations such as sorting
   */
  readonly key: string;
  
  /**
   * Column width; if unspecified, determine it from the grid width and other column widths
   * Accept a number in pixels or a string such as 'auto'
   * @default 'auto'
   */
  readonly width?: Maybe<number | string>;
  
  /**
   * Minimum column width in pixels
   * Resizing cannot go below this value
   * @default 50
   */
  readonly minWidth?: Maybe<number>;
  
  /** 
   * Maximum column width in pixels
   * Resizing cannot exceed this value
   */
  readonly maxWidth?: Maybe<number>;
  
  /** 
   * Class name applied to cells
   * Accept a static string or a function deriving the class name from row data
   */
  readonly cellClass?: Maybe<string | ((row: TRow) => Maybe<string>)>;
  
  /** 
   * Class name applied to header cells
   */
  readonly headerCellClass?: Maybe<string>;
  
  /** 
   * Class name applied to summary cells
   * Accept a static string or a function deriving the class name from summary row data
   */
  readonly summaryCellClass?: Maybe<string | ((row: TSummaryRow) => Maybe<string>)>;
  
  /** 
   * Function rendering cell content
   * Used to implement custom cell renderers
   */
  readonly renderCell?: Maybe<(props: RenderCellProps<TRow, TSummaryRow>) => ReactNode>;
  /** Explicit pure numeric text contract. No child DOM, hooks or renderer-local state. */
  readonly renderTextCell?: (row: TRow) => string;
  
  /** 
   * Function rendering header cell content
   * Used to implement custom header renderers
   */
  readonly renderHeaderCell?: Maybe<(props: RenderHeaderCellProps<TRow, TSummaryRow>) => ReactNode>;
  
  /** 
   * Function rendering summary cell content
   * Used to implement custom summary renderers
   */
  readonly renderSummaryCell?: Maybe<
    (props: RenderSummaryCellProps<TSummaryRow, TRow>) => ReactNode
  >;
  
  /** 
   * Function rendering group cell content
   * Customize group row cells when row grouping is used
   */
  readonly renderGroupCell?: Maybe<(props: RenderGroupCellProps<TRow, TSummaryRow>) => ReactNode>;
  
  /** 
   * Function rendering edit cell content
   * Setting this automatically makes the column editable
   */
  readonly renderEditCell?: Maybe<(props: RenderEditCellProps<TRow, TSummaryRow>) => ReactNode>;
  
  /** 
   * Whether to enable cell editing
   * Accept true or a function determining editability from row data
   * Use text input by default if no editor is specified
   */
  readonly editable?: Maybe<boolean | ((row: TRow) => boolean)>;
  
  /**
   * Number of columns a cell spans
   * Can return different values for header, regular, and summary rows
   */
  readonly colSpan?: Maybe<(args: ColSpanArgs<TRow, TSummaryRow>) => Maybe<number>>;
  
  /** 
   * Whether to freeze the column
   * If true, the column stays fixed during horizontal scrolling
   */
  readonly frozen?: Maybe<boolean>;
  
  /** 
   * Whether to enable column resizing
   * If true, users can resize columns by dragging
   */
  readonly resizable?: Maybe<boolean>;
  
  /** 
   * Whether to enable column sorting
   * If true, clicking the header sorts the column
   */
  readonly sortable?: Maybe<boolean>;
  
  /** 
   * Whether to enable column dragging
   * If true, columns can be reordered
   */
  readonly draggable?: Maybe<boolean>;
  
  /** 
   * Whether the initial sort starts descending
   * Starts ascending by default
   */
  readonly sortDescendingFirst?: Maybe<boolean>;
  
  /**
   * Callback when the header cell is clicked
   * Used for custom actions other than sorting
   */
  readonly onHeaderClick?: Maybe<(event: React.MouseEvent<HTMLDivElement>) => void>;
  
  /**
   * Callback when the header cell is double-clicked
   * Used for actions such as opening a column editing dialog
   */
  readonly onHeaderDoubleClick?: Maybe<(event: React.MouseEvent<HTMLDivElement>) => void>;
  
  /**
   * Callback when the header cell is right-clicked
   * Used to display context menus
   */
  readonly onHeaderContextMenu?: Maybe<(event: React.MouseEvent<HTMLDivElement>) => void>;
  
  /**
   * Custom style settings
   * Specify cell background color, text color, font size, and more
   */
  readonly customStyles?: Maybe<{
    readonly backgroundColor?: string;
    readonly color?: string;
    readonly fontSize?: number;
    readonly fontWeight?: number | string;
    readonly textAlign?: 'left' | 'center' | 'right';
  }>;
  
  /**
   * Data type
   * Used for style resolution and validation
   */
  readonly dataType?: Maybe<string>;
  
  /**
   * Function resolving styles dynamically from values
   * Used to apply conditional styles based on a cell's value
   */
  readonly styleResolver?: Maybe<(value: any, row: unknown) => React.CSSProperties | undefined>;
  
  /**
   * Function validating a cell value
   * Check input validity and return an error message
   */
  readonly validator?: Maybe<(value: any) => ValidationResult>;
  
  /**
   * When to run validation
   * onChange: Validate whenever the value changes
   * onBlur: Validate when focus leaves
   * onSubmit: Validate when editing finishes
   */
  readonly validationMode?: Maybe<'onChange' | 'onBlur' | 'onSubmit'>;
  
  /**
   * Tooltip text
   * Displayed on hover over both headers and cells
   * A string or a function generating text from row data
   */
  readonly tooltip?: Maybe<string | ((row: TRow) => string)>;
  /** Description belonging only to the selected column header, never body cells. */
  readonly headerMemoText?: string;
  
  /**
   * Memo text with detailed information
   * Used to display more detailed information
   * A string or a function generating text from row data
   */
  readonly memoText?: Maybe<string | ((row: TRow) => string)>;
  
  /**
   * Tooltip position
   * @default 'top'
   */
  readonly tooltipPlacement?: Maybe<'top' | 'bottom' | 'left' | 'right'>;
  
  /** 
   * Cell editing options
   */
  readonly editorOptions?: Maybe<{
    /**
     * Whether to render cell content alongside the edit cell
     * Enable when the editor renders outside the grid, such as in a modal
     * By default, cell content is not rendered while the edit cell is open
     * @default false
     */
    readonly displayCellContent?: Maybe<boolean>;
    
    /**
     * Whether to commit changes when clicking outside the cell
     * @default true
     */
    readonly commitOnOutsideClick?: Maybe<boolean>;
    
    /**
     * Whether to close the editor when the row changes externally
     * @default true
     */
    readonly closeOnExternalRowChange?: Maybe<boolean>;
  }>;
}

/**
 * Calculated column interface
 * Column definition used for rendering, with all required properties calculated
 */
export interface CalculatedColumn<TRow, TSummaryRow = unknown> extends Column<TRow, TSummaryRow> {
  /** Parent column reference for column groups */
  readonly parent: CalculatedColumnParent<TRow, TSummaryRow> | undefined;
  
  /** Column index, starting at 0 */
  readonly idx: number;
  
  /** Column nesting level for column groups */
  readonly level: number;
  
  /** Calculated column width, always set */
  readonly width: number | string;
  
  /** Calculated minimum width with defaults applied */
  readonly minWidth: number;
  
  /** Calculated maximum width */
  readonly maxWidth: number | undefined;
  
  /** Calculated resizability */
  readonly resizable: boolean;
  
  /** Calculated sortability */
  readonly sortable: boolean;
  
  /** Calculated draggability */
  readonly draggable: boolean;
  
  /** Calculated frozen state */
  readonly frozen: boolean;
  
  /** Cell renderer, always set to a function */
  readonly renderCell: (props: RenderCellProps<TRow, TSummaryRow>) => ReactNode;
  
  /** Header cell renderer, always set to a function */
  readonly renderHeaderCell: (props: RenderHeaderCellProps<TRow, TSummaryRow>) => ReactNode;
}

/**
 * Column group interface
 * Group multiple columns to create a header hierarchy
 */
export interface ColumnGroup<R, SR = unknown> {
  /** Group name displayed in the header cell */
  readonly name: string | ReactElement;
  
  /** Class name applied to the group header */
  readonly headerCellClass?: Maybe<string>;
  
  /** Columns or child groups within the group */
  readonly children: readonly ColumnOrColumnGroup<R, SR>[];
}

/**
 * Calculated column parent (column group) interface
 */
export interface CalculatedColumnParent<R, SR> {
  /** Parent column name */
  readonly name: string | ReactElement;
  
  /** Reference to a higher-level parent column */
  readonly parent: CalculatedColumnParent<R, SR> | undefined;
  
  /** Parent column index */
  readonly idx: number;
  
  /** Number of columns spanned by this parent */
  readonly colSpan: number;
  
  /** Nesting level */
  readonly level: number;
  
  /** Header cell class name */
  readonly headerCellClass?: Maybe<string>;
}

/**
 * Union of columns and column groups
 */
export type ColumnOrColumnGroup<R, SR = unknown> = Column<R, SR> | ColumnGroup<R, SR>;

/**
 * Union of calculated columns and calculated column groups
 */
export type CalculatedColumnOrColumnGroup<R, SR> =
  | CalculatedColumnParent<R, SR>
  | CalculatedColumn<R, SR>;

/**
 * Interface representing a position within the grid
 */
export interface Position {
  /** Column index */
  readonly idx: number;
  
  /** Row index */
  readonly rowIdx: number;
}

/**
 * Cell rendering properties
 */
export interface RenderCellProps<TRow, TSummaryRow = unknown> {
  isCellSelected?: boolean;
  /** Column definition */
  column: CalculatedColumn<TRow, TSummaryRow>;
  
  /** Row data */
  row: TRow;
  
  /** Row index */
  rowIdx: number;
  
  /** Whether the cell is editable */
  isCellEditable: boolean;
  
  /** Tab index for keyboard navigation */
  tabIndex: number;
  
  /** Callback updating row data */
  onRowChange: (row: TRow) => void;
}

/**
 * Summary cell rendering properties
 */
export interface RenderSummaryCellProps<TSummaryRow, TRow = unknown> {
  /** Column definition */
  column: CalculatedColumn<TRow, TSummaryRow>;
  
  /** Summary row data */
  row: TSummaryRow;
  
  /** Tab index */
  tabIndex: number;
}

/**
 * Group cell rendering properties
 */
export interface RenderGroupCellProps<TRow, TSummaryRow = unknown> {
  /** Group key */
  groupKey: unknown;
  
  /** Column definition */
  column: CalculatedColumn<TRow, TSummaryRow>;
  
  /** Group row data */
  row: GroupRow<TRow>;
  
  /** Child rows in the group */
  childRows: readonly TRow[];
  
  /** Whether the group is expanded */
  isExpanded: boolean;
  
  /** Tab index */
  tabIndex: number;
  
  /** Function toggling group expansion and collapse */
  toggleGroup: () => void;
}

/**
 * Edit cell rendering properties
 */
export interface RenderEditCellProps<TRow, TSummaryRow = unknown> {
  /** Column definition */
  column: CalculatedColumn<TRow, TSummaryRow>;
  
  /** Row data */
  row: TRow;
  
  /** Row index */
  rowIdx: number;
  
  /** 
   * Function updating row data
   * @param row - New row data
   * @param commitChanges - Whether to commit changes
   */
  onRowChange: (row: TRow, commitChanges?: boolean) => void;
  
  /** 
   * Function closing the editor
   * @param commitChanges - Whether to commit changes
   * @param shouldFocusCell - Whether to return focus to the cell
   */
  onClose: (commitChanges?: boolean, shouldFocusCell?: boolean) => void;
}

/**
 * Header cell rendering properties
 */
export interface RenderHeaderCellProps<TRow, TSummaryRow = unknown> {
  /** Column definition */
  column: CalculatedColumn<TRow, TSummaryRow>;
  
  /** Sort direction (ASC/DESC/undefined) */
  sortDirection: SortDirection | undefined;
  
  /** Sort priority for multi-column sorting */
  priority: number | undefined;
  
  /** Tab index */
  tabIndex: number;
}

/**
 * Base cell renderer properties
 * Properties shared by all cell renderers
 */
interface BaseCellRendererProps<TRow, TSummaryRow = unknown>
  extends Omit<React.ComponentProps<'div'>, 'children'>,
    Pick<
      DataGridProps<TRow, TSummaryRow>,
      'onCellMouseDown' | 'onCellClick' | 'onCellDoubleClick' | 'onCellContextMenu'
    > {
  /** Row index */
  rowIdx: number;
  
  /** 
   * Function selecting a cell
   * @param position - Position to select
   * @param options - Selection options, such as enabling the editor
   */
  selectCell: (position: Position, options?: SelectCellOptions) => void;
}

/**
 * Cell renderer properties
 */
export interface CellRendererProps<TRow, TSummaryRow>
  extends BaseCellRendererProps<TRow, TSummaryRow> {
  sharedTooltip?: GridSharedTooltipController;
  /** Pass only display state affecting this cell; do not subscribe to global context updates. */
  /** Physical body cells reuse their div as the tooltip host for their mounted lifetime. */
  tooltipUsesCellHost?: boolean;
  transientLock?: boolean;
  isHovered?: boolean;
  isInRange?: boolean;
  getCellBackgroundColor?: DataGridProps<TRow, TSummaryRow>['getCellBackgroundColor'];
  /** Column definition */
  column: CalculatedColumn<TRow, TSummaryRow>;
  
  /** Row data */
  row: TRow;
  
  /** Number of columns spanned by the cell */
  colSpan: number | undefined;
  
  /** Whether a drag is over the cell */
  isDraggedOver: boolean;
  
  /** Whether the cell is selected */
  isCellSelected: boolean;
  
  /** Whether the row is selected */
  isRowSelected?: boolean;
  
  /** Function updating row data */
  onRowChange: (column: CalculatedColumn<TRow, TSummaryRow>, newRow: TRow) => void;
}

/**
 * Cell event type definition
 * Add the ability to prevent default behavior
 */
export type CellEvent<E extends React.SyntheticEvent<HTMLDivElement>> = E & {
  /** Prevent the grid's default behavior */
  preventGridDefault: () => void;
  
  /** Check whether the grid's default behavior was prevented */
  isGridDefaultPrevented: () => boolean;
};

/** Cell mouse event type */
export type CellMouseEvent = CellEvent<React.MouseEvent<HTMLDivElement>>;

/** Cell keyboard event type */
export type CellKeyboardEvent = CellEvent<React.KeyboardEvent<HTMLDivElement>>;

/** Cell clipboard event type */
export type CellClipboardEvent = React.ClipboardEvent<HTMLDivElement>;

/**
 * Cell mouse event arguments
 */
export interface CellMouseArgs<TRow, TSummaryRow = unknown> {
  /** Column definition */
  column: CalculatedColumn<TRow, TSummaryRow>;
  
  /** Row data */
  row: TRow;
  
  /** Row index */
  rowIdx: number;
  
  /** 
   * Function selecting a cell
   * @param enableEditor - Whether to enable the editor
   */
  selectCell: (enableEditor?: boolean) => void;
}

/**
 * Key down event arguments in cell selection mode
 */
interface SelectCellKeyDownArgs<TRow, TSummaryRow = unknown> {
  /** Mode (selection mode) */
  mode: 'SELECT';
  
  /** Column definition */
  column: CalculatedColumn<TRow, TSummaryRow>;
  
  /** Row data */
  row: TRow;
  
  /** Row index */
  rowIdx: number;
  
  /** Function selecting a cell */
  selectCell: (position: Position, options?: SelectCellOptions) => void;
}

/**
 * Key down event arguments in cell editing mode
 */
export interface EditCellKeyDownArgs<TRow, TSummaryRow = unknown> {
  /** Mode (editing mode) */
  mode: 'EDIT';
  
  /** Column definition */
  column: CalculatedColumn<TRow, TSummaryRow>;
  
  /** Row data */
  row: TRow;
  
  /** Row index */
  rowIdx: number;
  
  /** Function performing navigation */
  navigate: () => void;
  
  /** Function closing the editor */
  onClose: (commitChanges?: boolean, shouldFocusCell?: boolean) => void;
}

/**
 * Union of cell key down event arguments
 * Either selection mode or editing mode
 */
export type CellKeyDownArgs<TRow, TSummaryRow = unknown> =
  | SelectCellKeyDownArgs<TRow, TSummaryRow>
  | EditCellKeyDownArgs<TRow, TSummaryRow>;

/**
 * Cell selection event arguments
 */
export interface CellSelectArgs<TRow, TSummaryRow = unknown> {
  /** Row index */
  rowIdx: number;
  
  /** Row data, which may be absent */
  row: TRow | undefined;
  
  /** Column definition */
  column: CalculatedColumn<TRow, TSummaryRow>;
}

/**
 * Cell mouse event handler type
 * NoInfer disables type inference, requiring explicit type specification
 */
export type CellMouseEventHandler<R, SR> = Maybe<
  (args: CellMouseArgs<NoInfer<R>, NoInfer<SR>>, event: CellMouseEvent) => void
>;

/**
 * Base row renderer properties
 */
/** Optional bounded body box. Frozen prefix and semantic row stay unchanged. */
export interface PhysicalBodyWindow {
  readonly startIdx: number;
  readonly endIdx: number;
  readonly logicalOffset: number;
  readonly logicalWidth: number;
  readonly physicalOffset: number;
  readonly physicalWidth: number;
  readonly templateColumns: string;
}

export interface BaseRenderRowProps<TRow, TSummaryRow = unknown>
  extends BaseCellRendererProps<TRow, TSummaryRow> {
  /** Viewport columns currently displayed */
  viewportColumns: readonly CalculatedColumn<TRow, TSummaryRow>[];
  
  /** Row index */
  rowIdx: number;
  
  /** Selected cell index */
  selectedCellIdx: number | undefined;
  
  /** Whether row selection is disabled */
  isRowSelectionDisabled: boolean;
  
  /** Whether the row is selected */
  isRowSelected: boolean;
  
  /** CSS grid starting row */
  gridRowStart: number;
  /** Physical rows retain logical cell metrics and global ARIA indices. */
  physicalRowTop?: number;
  physicalRowHeight?: number;
  physicalBodyWindow?: PhysicalBodyWindow;
  physicalBodyFallback?: string;
}

/**
 * Row renderer properties
 */
export interface RenderRowProps<TRow, TSummaryRow = unknown>
  extends BaseRenderRowProps<TRow, TSummaryRow> {
  transientLock?: boolean;
  sharedTooltip?: GridSharedTooltipController;
  /** Pass only selection and hover values relevant to this row; out-of-range values remain undefined. */
  isCurrentRowSelected?: boolean;
  isHovered?: boolean;
  rangeStartIdx?: number;
  rangeEndIdx?: number;
  getCellBackgroundColor?: DataGridProps<TRow, TSummaryRow>['getCellBackgroundColor'];
  onRowHover?: (rowIdx: number | undefined) => void;
  /** Row data */
  row: TRow;
  
  /** Index of the last frozen column */
  lastFrozenColumnIndex: number;
  
  /** Index of the cell being dragged over */
  draggedOverCellIdx: number | undefined;
  
  /** Editor component for the selected cell */
  selectedCellEditor: ReactElement<RenderEditCellProps<TRow>> | undefined;
  
  /** Function updating row data */
  onRowChange: (column: CalculatedColumn<TRow, TSummaryRow>, rowIdx: number, newRow: TRow) => void;
  
  /** Row-level context menu handler */
  onRowContextMenu?: (row: TRow, event: React.MouseEvent<HTMLDivElement>) => void;
  
  /** Function returning the class name applied to a row */
  rowClass: Maybe<(row: TRow, rowIdx: number) => Maybe<string>>;
  
  /** Function selecting a cell */
  selectCell: (position: Position, options?: SelectCellOptions) => void;
  
  /** Handler when the pointer enters the row */
  onMouseEnter?: () => void;
  
  /** Handler when the pointer leaves the row */
  onMouseLeave?: () => void;
}

/**
 * Row change data
 * Used to process changes to multiple rows together
 */
export interface RowsChangeData<R, SR = unknown> {
  /** Array of changed row indices */
  indexes: number[];
  
  /** Column where the change occurred */
  column: CalculatedColumn<R, SR>;
}

/**
 * Row selection event
 */
export interface SelectRowEvent<TRow> {
  /** Row selected or deselected */
  row: TRow;
  
  /** Checked state */
  checked: boolean;
  
  /** Whether Shift was pressed */
  isShiftClick: boolean;
}

/**
 * Header row selection event for selecting or deselecting all rows
 */
export interface SelectHeaderRowEvent {
  /** Checked state */
  checked: boolean;
}

/**
 * Fill event for drag-fill
 */
export interface FillEvent<TRow> {
  /** Target column key */
  columnKey: string;
  
  /** Source row */
  sourceRow: TRow;
  
  /** Target row */
  targetRow: TRow;
}

/**
 * Shared arguments for cell copy and paste
 */
interface CellCopyPasteArgs<TRow, TSummaryRow = unknown> {
  /** Column definition */
  column: CalculatedColumn<TRow, TSummaryRow>;
  
  /** Row data */
  row: TRow;
}

/** Cell copy event arguments */
export type CellCopyArgs<TRow, TSummaryRow = unknown> = CellCopyPasteArgs<TRow, TSummaryRow>;

/** Cell paste event arguments */
export type CellPasteArgs<TRow, TSummaryRow = unknown> = CellCopyPasteArgs<TRow, TSummaryRow>;

/**
 * Interface representing a cell range
 * Used for range selection
 */
export interface CellRange {
  /** Explicit whole-axis selection; ordinary rectangles do not imply deletion intent. */
  axis?: 'row' | 'column';
  /** Start position */
  start: Position;
  
  /** End position */
  end: Position;
}


/**
 * Type representing a cell range
 */
export interface CellRange {
  start: Position;
  end: Position;
}



/**
 * Group row interface
 * Used for row grouping
 */
export interface GroupRow<TRow> {
  /** Child rows in the group */
  readonly childRows: readonly TRow[];
  
  /** Group ID */
  readonly id: string;
  
  /** Parent group ID */
  readonly parentId: unknown;
  
  /** Group key, the value used for grouping */
  readonly groupKey: unknown;
  
  /** Whether the group is expanded */
  readonly isExpanded: boolean;
  
  /** Group nesting level */
  readonly level: number;
  
  /** Position among groups with the same parent */
  readonly posInSet: number;
  
  /** Total number of groups with the same parent */
  readonly setSize: number;
  
  /** Group starting row index */
  readonly startRowIndex: number;
}

/**
 * Sort column definition
 */
export interface SortColumn {
  /** Key of the column being sorted */
  readonly columnKey: string;
  
  /** Sort direction */
  readonly direction: SortDirection;
}

/** 
 * Cell navigation mode
 * NONE: No navigation
 * CHANGE_ROW: Allow movement between rows
 */
export type CellNavigationMode = 'NONE' | 'CHANGE_ROW';

/** 
 * Sort direction
 * ASC: Ascending
 * DESC: Descending
 */
export type SortDirection = 'ASC' | 'DESC';

/**
 * Arguments for colSpan calculation
 * Allow different handling for header, regular, and summary rows
 */
export type ColSpanArgs<TRow, TSummaryRow> =
  | { type: 'HEADER' }
  | { type: 'ROW'; row: TRow }
  | { type: 'SUMMARY'; row: TSummaryRow };

/**
 * Arguments for row height calculation
 * Allow different handling for regular and group rows
 */
export type RowHeightArgs<TRow> =
  | { type: 'ROW'; row: TRow }
  | { type: 'GROUP'; row: GroupRow<TRow> };

/**
 * Sort icon rendering properties
 */
export interface RenderSortIconProps {
  /** Sort direction, or undefined if unsorted */
  sortDirection: SortDirection | undefined;
}

/**
 * Sort priority rendering properties
 */
export interface RenderSortPriorityProps {
  /** Sort priority, indicating order in multi-column sorting */
  priority: number | undefined;
}

/**
 * Sort status rendering properties
 * Include both icon and priority
 */
export interface RenderSortStatusProps extends RenderSortIconProps, RenderSortPriorityProps {}

/**
 * Checkbox rendering properties
 */
export interface RenderCheckboxProps
  extends Pick<
    React.ComponentProps<'input'>,
    'aria-label' | 'aria-labelledby' | 'checked' | 'tabIndex' | 'disabled'
  > {
  /** 
   * Indeterminate state when some rows are selected
   * Used by the header checkbox
   */
  indeterminate?: boolean | undefined;
  
  /** 
   * Handler when the checked state changes
   * @param checked - New checked state
   * @param shift - Whether Shift was pressed
   */
  onChange: (checked: boolean, shift: boolean) => void;
}

/**
 * Collection of custom renderers
 * Allow customizing how each part of the grid is rendered
 */
export interface Renderers<TRow, TSummaryRow> {
  /** Custom cell renderer */
  renderCell?: Maybe<(key: Key, props: CellRendererProps<TRow, TSummaryRow>) => ReactNode>;
  
  /** Custom checkbox renderer */
  renderCheckbox?: Maybe<(props: RenderCheckboxProps) => ReactNode>;
  
  /** Custom row renderer */
  renderRow?: Maybe<(key: Key, props: RenderRowProps<TRow, TSummaryRow>) => ReactNode>;
  
  /** Custom sort status renderer */
  renderSortStatus?: Maybe<(props: RenderSortStatusProps) => ReactNode>;
  
  /** Fallback display when there is no data */
  noRowsFallback?: Maybe<ReactNode>;
}

/**
 * Cell selection options
 */
export interface SelectCellOptions {
  /** Whether to enable the editor */
  enableEditor?: Maybe<boolean>;
  
  /** Whether to focus the cell */
  shouldFocusCell?: Maybe<boolean>;
  
  /** Whether Shift is pressed for range selection */
  isShiftPressed?: Maybe<boolean>;
}

/**
 * Column width information
 */
export interface ColumnWidth {
  /** 
   * Width type
   * resized: Resized by the user
   * measured: Automatically measured
   */
  readonly type: 'resized' | 'measured';
  
  /** Width value in pixels */
  readonly width: number;
}

/** Column width map: Column key to width information */
export type ColumnWidths = ReadonlyMap<string, ColumnWidth>;

/** 
 * Text direction
 * ltr: Left to right
 * rtl: Right to left
 */
export type Direction = 'ltr' | 'rtl';

/** 
 * Resized width
 * A number in pixels or 'max-content' for content-based maximum width
 */
export type ResizedWidth = number | 'max-content';

/**
 * Cell range definition
 * Represent ranges used for selection, copy/paste, and other operations
 */
export interface CellRange {
  /** Start position */
  start: Position;
  
  /** End position */
  end: Position;
}

/**
 * Base interface for range selection arguments
 */
export interface RangeSelectionArgs<TRow, TSummaryRow = unknown> {
  /** Selected range */
  range: CellRange;
  
  /** Array of selected row data */
  rows: TRow[];
  
  /** Array of selected columns */
  columns: CalculatedColumn<TRow, TSummaryRow>[];
}

/**
 * Range copy event arguments
 */
export interface RangeCopyArgs<TRow, TSummaryRow = unknown> extends RangeSelectionArgs<TRow, TSummaryRow> {
  /** Event type */
  type: 'COPY';
}

/**
 * Range paste event arguments
 */
export interface RangePasteArgs<TRow, TSummaryRow = unknown> extends RangeSelectionArgs<TRow, TSummaryRow> {
  /** Event type */
  type: 'PASTE';
  
  /** Data to paste as tab-delimited text */
  pasteData: string;
}

/**
 * Row indicator properties
 * Information for displaying row numbers and action buttons
 */
export interface RowIndicatorProps<TRow, TSummaryRow = unknown> {
  isCellSelected?: boolean;
  /** Row index, starting at 0 */
  rowIdx: number;
  
  /** Row data */
  row: TRow;
  
  /** Displayed row number, starting at 1 */
  rowNumber: number;
  
  /** Total row count */
  totalRows: number;
  
  /** Tab index */
  tabIndex: number;
  
  /** Whether the row is selected */
  isRowSelected: boolean;
  
  /** Column definition for the indicator column */
  column: CalculatedColumn<TRow, TSummaryRow>;
  
  /** Row indicator settings */
  rowIndicatorConfig?: RowIndicatorConfig<TRow, TSummaryRow>;
}

/**
 * Row indicator settings
 * Settings for displaying row numbers and action buttons
 */
export interface RowIndicatorConfig<TRow, TSummaryRow = unknown> {
  /** Indicator column width in pixels */
  width?: number;
  
  /** Whether to display row numbers */
  showNumbers?: boolean;
  
  /** Whether to display action buttons */
  showActions?: boolean;
  
  /** Custom renderer */
  renderIndicator?: (props: RowIndicatorProps<TRow, TSummaryRow>) => ReactNode;
  
  /** Content displayed in the header cell */
  headerContent?: ReactNode;
  
  /** Indicator column class name */
  className?: string;
  
  /** Header cell class name */
  headerClassName?: string;
  
  /** Row number display format
   * 'number': Row number only, for example "1"
   * 'label': Label only, for example "Record A"
   * 'combined': Row number and label together, for example "1: Record A"
   * @default 'number'
   */
  format?: 'number' | 'label' | 'combined';
  
  /** Function retrieving the label, required when format is 'label' or 'combined' */
  getRowLabel?: (row: TRow) => string;
}