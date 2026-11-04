import { useI18n, formatNumber, message, resolveMessage, type LocalizedMessage } from '@/app/i18n';
import { useState, useEffect } from 'react';
import { ReferenceSelectPopover } from '@/components/ui/reference-select-popover';
import { ChevronDown } from 'lucide-react';
import type { Column, TableData } from '@/app/types/tableTypes';
import type { RenderCellProps, RenderEditCellProps } from '@/lib/react-data-grid';
import type { GridRow } from './DataGridView';
import { useReferenceOptions } from './useReferenceOptions';

interface ReferenceCellProps {
  column: Column;
  tableUuid: string;
  expectedProjectSession: string;
  value: string | null;
  onValueChange: (value: string | null) => void;
  readonly?: boolean;
}

export function ReferenceCell({
  column,
  tableUuid,
  expectedProjectSession,
  value,
  onValueChange,
  readonly = false,
}: ReferenceCellProps) {
  const { t } = useI18n();
  const { data, loading, refreshing, refresh: handleRefresh } = useReferenceOptions({
    column, tableUuid, expectedProjectSession,
  });
  const options = data.options;
  const [searchQuery, setSearchQuery] = useState('');

  if (readonly) {
    const selectedOption = value ? data.byUuid.get(value)?.option : undefined;
    return (
      <div className="px-2 py-1">
        {!column.reference_config ? (
          <span className="text-muted-foreground">{t('reference.notConfigured')}</span>
        ) : selectedOption ? (
          selectedOption.display_value
        ) : value ? (
          loading ? t('common.loading') : t('reference.missing')
        ) : (
          t('reference.none')
        )}
      </div>
    );
  }
  
  // Convert to popover options
  const popoverOptions = options.map((opt, index) => ({
    value: opt.uuid,
    label: opt.display_value || `${formatNumber(index + 1)}:`
  }));
  
  return (
    <ReferenceSelectPopover
      value={value || '__NULL__'}
      onValueChange={(v) => onValueChange(v === '__NULL__' ? null : v)}
      placeholder={loading ? t('common.loading') : t('reference.select')}
      options={popoverOptions}
      searchValue={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder={t('reference.search')}
      nullLabel={t('reference.none')}
      triggerClassName="h-full border-0 rounded-none focus:ring-0 px-2 justify-between"
      contentClassName="min-w-[200px]"
      onRefresh={handleRefresh}
      refreshing={refreshing}
    />
  );
}

// Cell renderer for read-only display
export function ReferenceCellRenderer(props: RenderCellProps<GridRow> & { columnData: Column, tableUuid: string, expectedProjectSession: string, tableData?: TableData, refreshVersion?: number, onReferenceClick?: (targetTableUuid: string, recordUuid: string) => void, selectCell?: (position: { rowIdx: number; idx: number }, options?: { enableEditor?: boolean }) => void }) {
  const { t } = useI18n();
  const value = props.row[props.column.key];
  const { data, loading, failed } = useReferenceOptions({
    column: props.columnData,
    tableUuid: props.tableUuid,
    expectedProjectSession: props.expectedProjectSession,
    tableData: props.tableData,
    refreshVersion: props.refreshVersion,
    enabled: !!value,
    shared: true,
  });
  const selected = data.byUuid.get(value);
  const displayValue: string | LocalizedMessage = !value ? '' : failed
    ? message('reference.loadFailed')
    : selected
      ? selected.option.display_value || `${formatNumber(selected.index + 1)}:`
      : message('reference.missing');

  const isEmpty = !value;
  const defaultValue = props.columnData?.default_value || '';
  
  const targetTableUuid = props.columnData.reference_config?.target_table_uuid;
  const isClickable = !isEmpty && !loading && !!selected && !failed && !!targetTableUuid && !!props.onReferenceClick;

  const handleClick = (e: React.MouseEvent) => {
    if (isClickable && targetTableUuid && props.onReferenceClick) {
      e.stopPropagation();
      e.preventDefault();
      props.onReferenceClick(targetTableUuid, value);
    }
  };
  
  return (
    <div 
      className={`h-full flex items-center justify-between px-2 ${isEmpty && defaultValue ? 'opacity-50 italic' : ''}`}
    >
      <span 
        className={`truncate ${isClickable ? 'cursor-pointer hover:underline' : ''}`}
        style={isClickable && !props.column.customStyles?.backgroundColor && !props.row.cellPresentations?.[props.column.key]?.style.background_color && !props.row.cellPresentations?.[props.column.key]?.style.text_color ? { color: 'hsl(var(--primary-ink))' } : undefined}
        onClick={isClickable ? handleClick : undefined}
        title={isClickable ? t('reference.openTarget') : undefined}
      >
        {loading && !selected ? t('common.loading') : (isEmpty && defaultValue ? defaultValue : resolveMessage(displayValue))}
      </span>
      <ChevronDown 
        className="h-4 w-4 opacity-50 flex-shrink-0 ml-1 cursor-pointer hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          // Put the cell into edit mode
          if (props.selectCell && 'rowIdx' in props && props.rowIdx !== undefined) {
            const columnIndex = props.column.idx;
            props.selectCell({ rowIdx: props.rowIdx, idx: columnIndex }, { enableEditor: true });
          }
        }}
      />
    </div>
  );
}

// Cell editor for editing
export function ReferenceCellEditor(props: RenderEditCellProps<GridRow> & { columnData: Column, tableUuid: string; expectedProjectSession: string; tableData?: TableData; refreshVersion?: number }) {
  const { t } = useI18n();
  const initialValue = props.row[props.column.key];
  const [value, setValue] = useState(!initialValue ? '__NULL__' : initialValue);
  const { data, loading, refreshing, refresh: handleRefresh } = useReferenceOptions({
    column: props.columnData,
    tableUuid: props.tableUuid,
    expectedProjectSession: props.expectedProjectSession,
    tableData: props.tableData,
    refreshVersion: props.refreshVersion,
  });
  const options = data.options;
  const [isOpen, setIsOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    setValue(!initialValue ? '__NULL__' : initialValue);
    setSearchQuery('');
  }, [initialValue, props.row.rowId, props.column.key, props.expectedProjectSession]);

  const handleChange = (newValue: string) => {
    const actualValue = newValue === '__NULL__' ? '' : newValue;
    setValue(newValue); // Keep the display value with __NULL__
    
    // Update the row data
    const newRow = { ...props.row };
    newRow[props.column.key] = actualValue;
    
    // Update the row and commit immediately
    // The second parameter true means both commit changes and focus cell
    props.onRowChange(newRow, true);
    
    // Close the dropdown
    setIsOpen(false);
  };
  
  // Convert to popover options
  const popoverOptions = options.map((opt, index) => ({
    value: opt.uuid,
    label: opt.display_value || `${formatNumber(index + 1)}:`
  }));
  
  return (
    <ReferenceSelectPopover
      value={value}
      onValueChange={handleChange}
      placeholder={loading ? t('common.loading') : t('reference.select')}
      options={popoverOptions}
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) {
          // Reset search when opening
          setSearchQuery('');
        }
        // Don't commit here - handleChange will do it
      }}
      searchValue={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder={t('reference.search')}
      nullLabel={t('reference.none')}
      triggerClassName="h-full border-0 rounded-none focus:ring-0 px-2 justify-between"
      contentClassName="min-w-[200px]"
      onRefresh={handleRefresh}
      refreshing={refreshing}
    />
  );
}