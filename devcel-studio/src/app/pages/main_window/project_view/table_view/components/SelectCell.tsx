import { useI18n } from '@/app/i18n';
import { settingsDisplayLabel, settingsSelectOptionLabel, useSettingsSelectOptions } from '@/app/settings/displayLabels';
import type { Column } from '@/app/types/tableTypes';
import type { RenderCellProps, RenderEditCellProps } from '@/lib/react-data-grid';
import { ChevronDown } from 'lucide-react';
import type { GridRow } from './DataGridView';

/** Keep the stored option value separate from its localized presentation. */
export function SelectCellRenderer(props: RenderCellProps<GridRow> & {
  columnData: Column; readOnly: boolean; onEdit: (rowIdx: number, columnIdx: number) => void;
}) {
  const { t } = useI18n();
  const value = String(props.row[props.column.key] ?? '');
  const options = useSettingsSelectOptions(props.columnData.uuid, props.columnData.select_config?.options ?? []);
  const knownValue = options.some(option => option.value === value);
  return <div className="relative flex h-full w-full min-w-0 items-center">
    <select className="h-full w-full min-w-0 appearance-none border-0 bg-transparent ps-2 pe-7 text-foreground outline-none disabled:opacity-70"
      disabled={props.readOnly} tabIndex={props.tabIndex} value={value}
      aria-label={settingsDisplayLabel(props.columnData.uuid, props.columnData.display_name)}
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => { if (['Enter', ' ', 'Escape', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.stopPropagation(); }}
      onChange={event => { if (!props.readOnly) props.onRowChange({ ...props.row, [props.column.key]: event.target.value }); }}>
      {!options.some(option => option.value === '') && <option value="">{t('column.empty')}</option>}
      {value !== '' && !knownValue && <option value={value} disabled>{value}</option>}
      {options.map(option => <option key={option.value} value={option.value}>{settingsSelectOptionLabel(props.columnData.uuid, option.value, option.label || option.value)}</option>)}
    </select>
    <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2" />
  </div>;
}

/** A native list keeps keyboard/IME behavior and stays inside the editor's
 * interaction boundary, including when projected into the transposed view. */
export function SelectCellEditor(props: RenderEditCellProps<GridRow> & { columnData: Column }) {
  const { t } = useI18n();
  const value = String(props.row[props.column.key] ?? '');
  const options = useSettingsSelectOptions(props.columnData.uuid, props.columnData.select_config?.options ?? []);
  const knownValue = options.some(option => option.value === value);
  return <select autoFocus className="h-full w-full border-0 bg-background px-2 text-foreground outline-none"
    aria-label={settingsDisplayLabel(props.columnData.uuid, props.columnData.display_name)} value={value}
    onChange={event => props.onRowChange({ ...props.row, [props.column.key]: event.target.value }, true)}
    onKeyDown={event => {
      // Arrow keys belong to the open list, not the grid's cell navigation.
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(event.key)) event.stopPropagation();
    }}>
    {!options.some(option => option.value === '') && <option value="">{t('column.empty')}</option>}
    {value !== '' && !knownValue && <option value={value} disabled>{value}</option>}
    {options.map(option => <option key={option.value} value={option.value}>
      {settingsSelectOptionLabel(props.columnData.uuid, option.value, option.label || option.value)}
    </option>)}
  </select>;
}
