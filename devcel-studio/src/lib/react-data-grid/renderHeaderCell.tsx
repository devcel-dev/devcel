import { useI18n } from '@/app/i18n';
import { css } from '@linaria/core';

import type { RenderHeaderCellProps } from './types';
import { useDefaultRenderers } from './DataGridDefaultRenderersContext';

/**
 * Styles for sortable header cells
 * Arrange the column name and sort icon with flex layout
 */
const headerSortCellClassname = css`
  @layer rdg.SortableHeaderCell {
    display: flex;
  }
`;

/**
 * Styles for the column name within a header cell
 * Truncate long text with an ellipsis
 */
const headerSortName = css`
  @layer rdg.SortableHeaderCellName {
    flex-grow: 1;
    overflow: clip;
    text-overflow: ellipsis;
  }
`;

// Combine class names
const headerSortNameClassname = `rdg-header-sort-name ${headerSortName}`;

/**
 * Default header cell renderer
 * Display sorting controls for sortable columns; otherwise display plain text
 * 
 * @param column - Column definition
 * @param sortDirection - Current sort direction ('ASC' | 'DESC' | undefined)
 * @param priority - Priority for multi-column sorting
 * @returns The rendered header cell content
 */
export default function renderHeaderCell<R, SR>({
  column,
  sortDirection,
  priority
}: RenderHeaderCellProps<R, SR>) {
  // Return only the column name for non-sortable columns
  if (!column.sortable) return column.name;

  // Display sortable columns with sorting controls
  return (
    <SortableHeaderCell sortDirection={sortDirection} priority={priority}>
      {column.name}
    </SortableHeaderCell>
  );
}

/**
 * Type selecting the required properties from RenderHeaderCellProps
 * Properties shared by sortable header cells
 */
type SharedHeaderCellProps<R, SR> = Pick<
  RenderHeaderCellProps<R, SR>,
  'sortDirection' | 'priority'
>;

/**
 * Sortable header cell props
 */
interface SortableHeaderCellProps<R, SR> extends SharedHeaderCellProps<R, SR> {
  /** Child elements such as the displayed column name */
  children: React.ReactNode;
}

/**
 * Sortable header cell component
 * Display the column name and sort status indicator
 * 
 * @description
 * This component provides the following features:
 * - Column name display with text overflow handling
 * - Sort direction indicator
 * - Priority display for multi-column sorting
 * - Customizable sort status renderer
 */
function SortableHeaderCell<R, SR>({
  sortDirection,
  priority,
  children
}: SortableHeaderCellProps<R, SR>) {
  useI18n();
  // Get the sort status renderer from the default renderers
  const renderSortStatus = useDefaultRenderers<R, SR>()!.renderSortStatus!;

  return (
    <span className={headerSortCellClassname}>
      {/* Column name: Use flex-grow to fill the remaining width */}
      <span className={headerSortNameClassname}>{children}</span>
      {/* Sort status: Display the icon and priority */}
      <span>{renderSortStatus({ sortDirection, priority })}</span>
    </span>
  );
}
