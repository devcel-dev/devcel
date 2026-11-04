import { t, useI18n } from '@/app/i18n';
import { useHeaderRowSelection, useRowSelection } from './hooks/useRowSelection';
import type { Column, RenderCellProps, RenderGroupCellProps, RenderHeaderCellProps } from './types';
import { SelectCellFormatter } from './cellRenderers';

/**
 * Stable key for the selection column
 * Constant identifying the row-selection checkbox column
 */
export const SELECT_COLUMN_KEY = 'rdg-select-column';

/**
 * Stable key for the row indicator column
 * Constant identifying the column displaying row numbers and action buttons
 */
export const ROW_INDICATOR_COLUMN_KEY = 'rdg-row-indicator-column';

/**
 * Selection checkbox renderer for the header row
 * Controls selection and deselection of all rows
 * 
 * @description
 * - Checked when all rows are selected
 * - Indeterminate when only some rows are selected
 * - Unchecked when no rows are selected
 */
function HeaderRenderer(props: RenderHeaderCellProps<unknown>) {
  useI18n();
  // Get state and actions from the header row selection hook
  const { isIndeterminate, isRowSelected, onRowSelectionChange } = useHeaderRowSelection();

  return (
    <SelectCellFormatter
      aria-label={t('grid.selectAll')}
      tabIndex={props.tabIndex}
      // Indeterminate state for partial selection
      indeterminate={isIndeterminate}
      // Checkbox value
      value={isRowSelected}
      onChange={(checked) => {
        // Use false for the indeterminate state; otherwise use the checked value
        onRowSelectionChange({ checked: isIndeterminate ? false : checked });
      }}
    />
  );
}

/**
 * Selection checkbox renderer for regular rows
 * Controls selection of individual rows
 * 
 * @description
 * - Supports range selection with the Shift key
 * - Supports the disabled state
 * - Selects and deselects individual rows
 */
function SelectFormatter(props: RenderCellProps<unknown>) {
  useI18n();
  // Get state and actions from the row selection hook
  const { isRowSelectionDisabled, isRowSelected, onRowSelectionChange } = useRowSelection();

  return (
    <SelectCellFormatter
      aria-label={t('grid.selectRow')}
      tabIndex={props.tabIndex}
      // Whether row selection is disabled
      disabled={isRowSelectionDisabled}
      // Current selection state
      value={isRowSelected}
      onChange={(checked, isShiftClick) => {
        // Change selection using the row, checked state, and Shift key state
        onRowSelectionChange({ row: props.row, checked, isShiftClick });
      }}
    />
  );
}

/**
 * Selection checkbox renderer for grouped rows
 * Controls selection of grouped rows
 * 
 * @description
 * - Selects or deselects all rows in a group
 * - Does not support Shift selection (always false)
 */
function SelectGroupFormatter(props: RenderGroupCellProps<unknown>) {
  useI18n();
  // Get state and actions from the row selection hook
  const { isRowSelected, onRowSelectionChange } = useRowSelection();

  return (
    <SelectCellFormatter
      aria-label={t('grid.selectGroup')}
      tabIndex={props.tabIndex}
      // Group selection state
      value={isRowSelected}
      onChange={(checked) => {
        // Disable Shift selection for group row changes
        onRowSelectionChange({ row: props.row, checked, isShiftClick: false });
      }}
    />
  );
}

/**
 * Selection column definition
 * Special column providing row selection in the data grid
 * 
 * @description
 * This column has the following properties:
 * - Fixed width (35px), not resizable
 * - Not sortable
 * - Frozen at the left edge (frozen: true)
 * - Dedicated renderers for header, regular, and group rows
 * 
 * Usage:
 * ```typescript
 * const columns = [SelectColumn, ...otherColumns];
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SelectColumn: Column<any, any> = {
  /** Column identifier key */
  key: SELECT_COLUMN_KEY,
  /** Column name (empty string) */
  name: '',
  /** Fixed width */
  width: 35,
  /** Minimum width */
  minWidth: 35,
  /** Maximum width */
  maxWidth: 35,
  /** Not resizable */
  resizable: false,
  /** Not sortable */
  sortable: false,
  /** Frozen at the left edge */
  frozen: true,
  /** Header cell renderer */
  renderHeaderCell(props) {
    return <HeaderRenderer {...props} />;
  },
  /** Regular cell renderer */
  renderCell(props) {
    return <SelectFormatter {...props} />;
  },
  /** Group cell renderer */
  renderGroupCell(props) {
    return <SelectGroupFormatter {...props} />;
  }
};
