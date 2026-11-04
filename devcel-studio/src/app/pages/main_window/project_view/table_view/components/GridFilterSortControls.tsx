import { settingsDisplayLabel, settingsSelectOptionLabel } from '@/app/settings/displayLabels';
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDown, ArrowDownAZ, ArrowUp, ArrowUpAZ, ArrowUpDown, ChevronDown, ChevronRight, Filter, Plus, Search, Trash2, X } from 'lucide-react';
import { useI18n, formatNumber, getLocaleDirection } from '@/app/i18n';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { getTableCatalog } from '@/app/commands/tableCommands';
import type { Column, TableData, ValueType } from '@/app/types/tableTypes';
import type { GridRow } from './DataGridView';
import { canSortColumn, collectFilterValues, validateCondition, type ColumnFilter, type FilterCondition, type SortLevel } from './gridFilterSort';
import { useReferenceOptions } from './useReferenceOptions';
import './GridFilterSortControls.css';

type Operator = FilterCondition['operator'];
type FilterKind = 'text' | 'number' | 'date' | 'value';
type Translate = ReturnType<typeof useI18n>['t'];
interface FilterValue { value: string; label: string }

function filterKind(dataType: ValueType): FilterKind {
  if (/^[UI](8|16|32|64)$|^F(32|64)$/.test(dataType)) return 'number';
  if (dataType === 'DateTime') return 'date';
  return dataType === 'String' ? 'text' : 'value';
}

function filterTitle(kind: FilterKind, t: Translate): string {
  if (kind === 'number') return t('grid.filterSort.numberFilter');
  if (kind === 'date') return t('grid.filterSort.dateFilter');
  if (kind === 'text') return t('grid.filterSort.textFilter');
  return t('grid.filterSort.valueFilter');
}

function operatorsFor(kind: FilterKind): Operator[] {
  if (kind === 'value') return ['empty', 'not_empty'];
  return [
    'equals', 'not_equals',
    ...(kind === 'text'
      ? ['contains', 'not_contains', 'starts_with', 'ends_with'] as const
      : ['greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'] as const),
    'empty', 'not_empty',
  ];
}

function operatorLabel(operator: Operator, kind: FilterKind, t: Translate): string {
  switch (operator) {
    case 'equals': return t('grid.filterSort.equals');
    case 'not_equals': return t('grid.filterSort.notEquals');
    case 'contains': return t('grid.filterSort.contains');
    case 'not_contains': return t('grid.filterSort.notContains');
    case 'starts_with': return t('grid.filterSort.startsWith');
    case 'ends_with': return t('grid.filterSort.endsWith');
    case 'greater_than': return kind === 'date' ? t('grid.filterSort.after') : t('grid.filterSort.greaterThan');
    case 'greater_than_or_equal': return kind === 'date' ? t('grid.filterSort.onOrAfter') : t('grid.filterSort.greaterThanOrEqual');
    case 'less_than': return kind === 'date' ? t('grid.filterSort.before') : t('grid.filterSort.lessThan');
    case 'less_than_or_equal': return kind === 'date' ? t('grid.filterSort.onOrBefore') : t('grid.filterSort.lessThanOrEqual');
    case 'between': return t('grid.filterSort.between');
    case 'empty': return t('grid.filterSort.empty');
    case 'not_empty': return t('grid.filterSort.notEmpty');
  }
}

function navigateMenu(event: React.KeyboardEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement;
  if (!target.matches('.grid-fs-menu-row') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > .grid-fs-menu-row:not(:disabled)')];
  const index = buttons.indexOf(target as HTMLButtonElement);
  if (index < 0 || !buttons.length) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus();
}

function hasOperand(operator: Operator): boolean {
  return operator !== 'empty' && operator !== 'not_empty';
}

function cloneFilter(filter: ColumnFilter | undefined): ColumnFilter | undefined {
  return filter && { ...filter, values: filter.values?.slice(), conditions: filter.conditions?.map(condition => ({ ...condition })) };
}

function Checkbox({ checked, indeterminate = false, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input {...props} ref={ref} type="checkbox" checked={checked} />;
}

const VALUE_HEIGHT = 29;
const VALUE_VIEWPORT = VALUE_HEIGHT * 6;
const VALUE_OVERSCAN = 3;

/** Keep even very high-cardinality columns cheap to open and scroll. */
function VirtualValues({ values, selected, onToggle, numeric }: {
  values: FilterValue[];
  numeric: boolean;
  selected: ReadonlySet<string> | null;
  onToggle: (value: string) => void;
}) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const height = Math.min(VALUE_VIEWPORT, values.length * VALUE_HEIGHT);
  const start = Math.max(0, Math.floor(scrollTop / VALUE_HEIGHT) - VALUE_OVERSCAN);
  const end = Math.min(values.length, Math.ceil((scrollTop + height) / VALUE_HEIGHT) + VALUE_OVERSCAN);

  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
    setScrollTop(0);
  }, [values]);
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    const target = viewport.current?.querySelector<HTMLInputElement>(`[data-value-index="${pendingFocus.current}"]`);
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = null; }
  });

  const navigate = (event: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowDown') next = Math.min(values.length - 1, index + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = values.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    const container = viewport.current;
    if (!container) return;
    pendingFocus.current = next;
    const nextTop = next * VALUE_HEIGHT;
    const nextScroll = nextTop < container.scrollTop ? nextTop
      : nextTop + VALUE_HEIGHT > container.scrollTop + height ? nextTop + VALUE_HEIGHT - height : container.scrollTop;
    container.scrollTop = nextScroll;
    setScrollTop(nextScroll);
    const target = container.querySelector<HTMLInputElement>(`[data-value-index="${next}"]`);
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = null; }
  };

  if (!values.length) return <div className="grid-fs-no-values" role="status">{t('grid.filterSort.noValues')}</div>;
  return <div ref={viewport} className="grid-fs-value-viewport" role="group" aria-label={t('grid.filterSort.values')}
    style={{ height }} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
    <div className="grid-fs-value-spacer" style={{ height: values.length * VALUE_HEIGHT }}>
      {values.slice(start, end).map((option, offset) => <label className="grid-fs-value-row" key={option.value}
        style={{ top: (start + offset) * VALUE_HEIGHT }} title={option.label}>
        <input type="checkbox" checked={selected === null || selected.has(option.value)} data-value-index={start + offset}
          onChange={() => onToggle(option.value)} onKeyDown={event => navigate(event, start + offset)} />
        <span dir={numeric && option.value !== '' ? 'ltr' : undefined}
          style={numeric && option.value !== '' ? { unicodeBidi: 'isolate' } : undefined}>{option.label}</span>
      </label>)}
    </div>
  </div>;
}

interface ReferenceScope {
  expectedProjectSession?: string;
  tableData?: TableData;
  refreshVersion?: number;
}

export interface GridColumnFilterButtonProps extends ReferenceScope {
  column: Column;
  rows: GridRow[];
  filter?: ColumnFilter;
  sorts: SortLevel[];
  onFilterChange: (filter: ColumnFilter | undefined) => void;
  onSortChange: (sorts: SortLevel[]) => void;
  onOpenSort: () => void;
  disabled?: boolean;
}

interface ConditionRequest { initial: ColumnFilter | undefined; operator?: Operator }

export function GridColumnFilterButton({ column, rows, filter, sorts, onFilterChange, onSortChange, onOpenSort,
  disabled = false, expectedProjectSession, tableData, refreshVersion }: GridColumnFilterButtonProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [condition, setCondition] = useState<ConditionRequest | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const activeFilter = filter?.columnUuid === column.uuid && filter.dataType === column.data_type ? filter : undefined;
  const sortIndex = sorts.findIndex(sort => sort.columnUuid === column.uuid && sort.dataType === column.data_type);
  const activeSort = sortIndex < 0 ? undefined : sorts[sortIndex];
  const title = t('grid.filterSort.openColumn', { column: settingsDisplayLabel(column.uuid, column.display_name || column.data_name) || column.data_name });
  useEffect(() => { if (disabled) { setOpen(false); setCondition(null); } }, [disabled]);
  useEffect(() => { setOpen(false); setCondition(null); }, [column.uuid, column.data_type, expectedProjectSession, tableData?.uuid]);

  return <>
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button ref={trigger} data-filter-column={column.uuid} type="button" className={`grid-fs-trigger${activeFilter ? ' is-filtered' : ''}${activeSort ? ' is-sorted' : ''}`}
          aria-label={title} title={title} disabled={disabled}
          onMouseDown={event => event.stopPropagation()} onDragStart={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
          onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}>
          {activeFilter ? <Filter aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          {activeSort && <span className="grid-fs-sort-marker" aria-hidden="true">{activeSort.direction === 'asc' ? '↑' : '↓'}{sorts.length > 1 ? formatNumber(sortIndex + 1) : ''}</span>}
        </button>
      </PopoverTrigger>
      {open && !disabled && <PopoverContent className="grid-fs-popover" align="end" sideOffset={6} collisionPadding={8}
        aria-label={title} onMouseDown={event => event.stopPropagation()} onDragStart={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
          onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}
        onKeyDown={event => { event.stopPropagation(); navigateMenu(event); }}
        onCloseAutoFocus={event => { if (condition) event.preventDefault(); }}>
        <ColumnFilterPanel column={column} rows={rows} filter={activeFilter} sorts={sorts}
          expectedProjectSession={expectedProjectSession} tableData={tableData} refreshVersion={refreshVersion}
          onFilterChange={next => { onFilterChange(next); setOpen(false); }}
          onSortChange={next => { onSortChange(next); setOpen(false); }}
          onOpenSort={() => { setOpen(false); trigger.current?.focus(); onOpenSort(); }}
          onOpenCondition={(initial, operator) => { setCondition({ initial: cloneFilter(initial), operator }); setOpen(false); }} />
      </PopoverContent>}
    </Popover>
    {condition && !disabled && <ConditionDialog column={column} initial={condition.initial} initialOperator={condition.operator}
      onCancel={() => setCondition(null)} onApply={next => { onFilterChange(next); setCondition(null); }}
      onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }} />}
  </>;
}

function ColumnFilterPanel({ column, rows, filter, sorts, onFilterChange, onSortChange, onOpenSort,
  onOpenCondition, expectedProjectSession, tableData, refreshVersion }: Omit<GridColumnFilterButtonProps, 'disabled'> & {
  onOpenCondition: (initial: ColumnFilter | undefined, operator?: Operator) => void;
}) {
  const { t, locale } = useI18n();
  const rtl = getLocaleDirection() === 'rtl';
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string> | null>(() => filter?.values ? new Set(filter.values) : null);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const kind = filterKind(column.data_type);
  const reference = useReferenceOptions({ column, tableUuid: tableData?.uuid ?? '',
    expectedProjectSession: expectedProjectSession ?? '', tableData, refreshVersion,
    enabled: column.data_type === 'Reference' && !!expectedProjectSession && !!tableData, shared: true });
  const [tableNames, setTableNames] = useState<Map<string, string> | null>(null);
  const [tableNamesFailed, setTableNamesFailed] = useState(false);
  useEffect(() => {
    if (column.data_type !== 'TableRef' || !expectedProjectSession) return;
    let current = true;
    setTableNames(null); setTableNamesFailed(false);
    void getTableCatalog(expectedProjectSession).then(tables => {
      if (current) setTableNames(new Map(tables.map(table => [table.uuid, settingsDisplayLabel(table.uuid, table.display_name) || table.path])));
    }, () => { if (current) setTableNamesFailed(true); });
    return () => { current = false; };
  }, [column.data_type, expectedProjectSession, locale]);
  // These helpers read ambient translations. Keep their locale together with
  // the computed options so an unchanged rows/column snapshot is relabeled.
  const localizedOptions = useMemo(() => ({ locale, values: collectFilterValues(rows, column).map(option => ({
    ...option, label: settingsSelectOptionLabel(column.uuid, option.value, option.label),
  })) }), [rows, column, locale]);
  // Empty/reference labels also read ambient translations, so retain the
  // resolved locale explicitly with this second-stage options snapshot.
  const resolvedOptions = useMemo(() => ({ locale, values: localizedOptions.values.map(option => {
    if (option.value === '') return { ...option, label: t('grid.filterSort.emptyValue') };
    if (column.data_type === 'Reference') {
      const record = reference.data.byUuid.get(option.value);
      return { ...option, label: reference.loading ? t('common.loading') : reference.failed ? t('reference.loadFailed')
        : record ? record.option.display_value || `${formatNumber(record.index + 1)}:` : t('reference.missing') };
    }
    if (column.data_type === 'TableRef') return { ...option, label: tableNamesFailed ? t('reference.loadFailed')
      : tableNames === null && expectedProjectSession ? t('common.loading') : tableNames?.get(option.value) || t('reference.tableMissing') };
    return option;
  }) }), [locale, localizedOptions, column.data_type, reference.data, reference.loading, reference.failed, tableNames, tableNamesFailed, expectedProjectSession, t]);
  const options = resolvedOptions.values;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = useMemo(() => options.filter(option => !normalizedQuery
    || option.label.toLocaleLowerCase().includes(normalizedQuery)), [options, normalizedQuery]);
  const checkedCount = selected === null ? visibleOptions.length : visibleOptions.reduce((count, option) => count + Number(selected.has(option.value)), 0);
  const allSelected = visibleOptions.length > 0 && checkedCount === visibleOptions.length;
  const currentSort = sorts.find(sort => sort.columnUuid === column.uuid);
  const selectedValues = () => {
    if (normalizedQuery) return visibleOptions.filter(option => selected === null || selected.has(option.value)).map(option => option.value);
    return selected === null || (options.length > 0 && options.every(option => selected.has(option.value))) ? undefined : [...selected];
  };
  const draftFilter = (): ColumnFilter => ({ columnUuid: column.uuid, dataType: column.data_type,
    values: selectedValues(), conditions: filter?.conditions, join: filter?.join });
  const toggle = (value: string) => setSelected(previous => {
    const next = new Set(previous ?? options.map(option => option.value));
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  });
  const toggleAll = () => setSelected(previous => {
    const next = new Set(previous ?? options.map(option => option.value));
    for (const option of visibleOptions) { if (allSelected) next.delete(option.value); else next.add(option.value); }
    return next;
  });
  const sort = (direction: SortLevel['direction']) => {
    onSortChange([{ columnUuid: column.uuid, dataType: column.data_type, direction }]);
  };
  const apply = () => {
    const next = draftFilter();
    onFilterChange(next.values === undefined && !next.conditions?.length ? undefined : next);
  };

  return <>
    <button type="button" className="grid-fs-menu-row" disabled={!canSortColumn(column)} onClick={() => sort('asc')}>
      <ArrowDownAZ aria-hidden="true" />{t('grid.filterSort.sortAscending')}
    </button>
    <button type="button" className="grid-fs-menu-row" disabled={!canSortColumn(column)} onClick={() => sort('desc')}>
      <ArrowUpAZ aria-hidden="true" />{t('grid.filterSort.sortDescending')}
    </button>
    <button type="button" className="grid-fs-menu-row" onClick={onOpenSort}><ArrowUpDown aria-hidden="true" />{t('grid.filterSort.multipleSort')}</button>
    {currentSort && <button type="button" className="grid-fs-menu-row" onClick={() => onSortChange(sorts.filter(sort => sort.columnUuid !== column.uuid))}>
      <X aria-hidden="true" />{t('grid.filterSort.clearColumnSort')}
    </button>}
    <div className="grid-fs-separator" />
    <Popover open={submenuOpen} onOpenChange={setSubmenuOpen}>
      <PopoverTrigger asChild><button type="button" className="grid-fs-menu-row" onKeyDown={event => {
        if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) { event.preventDefault(); setSubmenuOpen(true); }
      }}><Filter aria-hidden="true" />{filterTitle(kind, t)}<ChevronRight className="grid-fs-menu-right rtl:rotate-180" aria-hidden="true" /></button></PopoverTrigger>
      <PopoverContent className="grid-fs-submenu" side={rtl ? 'left' : 'right'} align="start" sideOffset={8} collisionPadding={8}
        aria-label={filterTitle(kind, t)} onKeyDown={event => {
          event.stopPropagation();
          navigateMenu(event);
          if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) { event.preventDefault(); setSubmenuOpen(false); }
        }}>
        {operatorsFor(kind).map(operator => <button key={operator} type="button" className="grid-fs-menu-row"
          onClick={() => {
            setSubmenuOpen(false);
            if (!hasOperand(operator)) onFilterChange({ ...draftFilter(), conditions: [{ operator }], join: 'and' });
            else onOpenCondition(draftFilter(), operator);
          }}>{operatorLabel(operator, kind, t)}</button>)}
        {kind !== 'value' && <><div className="grid-fs-separator" /><button type="button" className="grid-fs-menu-row"
          onClick={() => { setSubmenuOpen(false); onOpenCondition(draftFilter()); }}>{t('grid.filterSort.customFilter')}</button></>}
      </PopoverContent>
    </Popover>
    <div className="grid-fs-separator" />
    <label className="grid-fs-value-search"><Search aria-hidden="true" /><input type="search" value={query}
      onChange={event => setQuery(event.target.value)} placeholder={t('grid.filterSort.searchValues')} aria-label={t('grid.filterSort.searchValues')} /></label>
    <div className="grid-fs-values">
      <label className="grid-fs-select-all"><Checkbox checked={allSelected} indeterminate={checkedCount > 0 && !allSelected}
        disabled={!visibleOptions.length} onChange={toggleAll} /><span>{t('grid.filterSort.selectAll')}</span></label>
      <VirtualValues values={visibleOptions} selected={selected} onToggle={toggle} numeric={kind === 'number'} />
    </div>
    <div className="grid-fs-menu-footer"><Button type="button" variant="outline" size="sm" onClick={() => onFilterChange(undefined)}>{t('grid.filterSort.clear')}</Button>
      <Button type="button" size="sm" onClick={apply}>{t('grid.filterSort.apply')}</Button></div>
  </>;
}

function DialogFrame({ title, className = '', children, onCloseAutoFocus }: {
  title: string;
  className?: string;
  children: React.ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useI18n();
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return <Dialog.Portal>
    <Dialog.Overlay className="grid-fs-dialog-overlay" />
    <Dialog.Content className={`grid-fs-dialog ${className}`} aria-describedby={undefined}
      onCloseAutoFocus={onCloseAutoFocus ?? (event => { event.preventDefault(); if (returnFocus?.isConnected) returnFocus.focus(); })} onMouseDown={event => event.stopPropagation()} onDragStart={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onContextMenu={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <div className="grid-fs-dialog-title"><Dialog.Title>{title}</Dialog.Title>
        <Dialog.Close className="grid-fs-dialog-close" aria-label={t('grid.filterSort.close')}><X aria-hidden="true" /></Dialog.Close></div>
      {children}
    </Dialog.Content>
  </Dialog.Portal>;
}

function ConditionDialog({ column, initial, initialOperator, onCancel, onApply, onCloseAutoFocus }: {
  column: Column;
  initial: ColumnFilter | undefined;
  initialOperator?: Operator;
  onCancel: () => void;
  onApply: (filter: ColumnFilter | undefined) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const kind = filterKind(column.data_type);
  const [conditions, setConditions] = useState<Array<FilterCondition | undefined>>(() => [
    initialOperator ? { operator: initialOperator, value: initial?.conditions?.[0]?.value ?? '', max: initial?.conditions?.[0]?.max }
      : initial?.conditions?.[0] ? { ...initial.conditions[0] } : { operator: 'equals', value: '' },
    initial?.conditions?.[1] ? { ...initial.conditions[1] } : undefined,
  ]);
  const [join, setJoin] = useState<'and' | 'or'>(initial?.join ?? 'and');
  const valid = conditions.every(condition => !condition || validateCondition(condition, column.data_type));
  const setCondition = (index: number, next: FilterCondition | undefined) => setConditions(previous => previous.map((condition, i) => i === index ? next : condition));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const nextConditions = conditions.filter((condition): condition is FilterCondition => !!condition).map(condition => hasOperand(condition.operator)
      ? { operator: condition.operator, value: condition.value ?? '', ...(condition.operator === 'between' ? { max: condition.max ?? '' } : {}) }
      : { operator: condition.operator });
    onApply({ columnUuid: column.uuid, dataType: column.data_type, values: initial?.values, conditions: nextConditions, join });
  };
  return <Dialog.Root open onOpenChange={open => { if (!open) onCancel(); }}>
    <DialogFrame title={filterTitle(kind, t)} className="grid-fs-condition-dialog" onCloseAutoFocus={onCloseAutoFocus}>
      <form onSubmit={submit}>
        <div className="grid-fs-condition-column"><span>{t('grid.filterSort.conditionColumn')}</span><strong>{settingsDisplayLabel(column.uuid, column.display_name || column.data_name) || column.data_name}</strong></div>
        {conditions.map((condition, index) => <React.Fragment key={index}>
          {index === 1 && <fieldset className="grid-fs-condition-join">
            <label><input type="radio" name={`${id}-join`} value="and" checked={join === 'and'} onChange={() => setJoin('and')} />{t('grid.filterSort.and')}</label>
            <label><input type="radio" name={`${id}-join`} value="or" checked={join === 'or'} onChange={() => setJoin('or')} />{t('grid.filterSort.or')}</label>
          </fieldset>}
          <div className="grid-fs-condition-row">
            <label className="grid-fs-condition-label" htmlFor={`${id}-operator-${index}`}>{index === 0 ? t('grid.filterSort.conditionFirst') : t('grid.filterSort.conditionSecond')}</label>
            <select id={`${id}-operator-${index}`} value={condition?.operator ?? ''} onChange={event => setCondition(index, event.target.value
              ? { operator: event.target.value as Operator, value: condition?.value ?? '', max: condition?.max } : undefined)}>
              {index === 1 && <option value="">{t('grid.filterSort.noCondition')}</option>}
              {operatorsFor(kind).map(operator => <option key={operator} value={operator}>{operatorLabel(operator, kind, t)}</option>)}
            </select>
            {condition && hasOperand(condition.operator) && <div className="grid-fs-condition-inputs">
              <input type={kind === 'date' ? 'datetime-local' : 'text'} step="any" inputMode={kind === 'number' ? 'decimal' : undefined}
                dir={kind === 'number' ? 'ltr' : undefined} style={kind === 'number' ? { unicodeBidi: 'isolate' } : undefined}
                aria-invalid={!validateCondition(condition, column.data_type)}
                aria-label={`${index === 0 ? t('grid.filterSort.conditionFirst') : t('grid.filterSort.conditionSecond')}: ${t('grid.filterSort.conditionValue')}`}
                value={condition.value ?? ''} onChange={event => setCondition(index, { ...condition, value: event.target.value })} />
              {condition.operator === 'between' && <><span aria-hidden="true">〜</span><input type={kind === 'date' ? 'datetime-local' : 'text'} step="any" inputMode={kind === 'number' ? 'decimal' : undefined}
                dir={kind === 'number' ? 'ltr' : undefined} style={kind === 'number' ? { unicodeBidi: 'isolate' } : undefined}
                aria-invalid={!validateCondition(condition, column.data_type)}
                aria-label={`${index === 0 ? t('grid.filterSort.conditionFirst') : t('grid.filterSort.conditionSecond')}: ${t('grid.filterSort.conditionMaximum')}`}
                value={condition.max ?? ''} onChange={event => setCondition(index, { ...condition, max: event.target.value })} /></>}
            </div>}
          </div>
        </React.Fragment>)}
        <div className="grid-fs-dialog-footer"><Button type="button" variant="outline" onClick={onCancel}>{t('grid.filterSort.cancel')}</Button>
          <Button type="submit" disabled={!valid}>{t('grid.filterSort.apply')}</Button></div>
      </form>
    </DialogFrame>
  </Dialog.Root>;
}

export interface GridSortDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: Column[];
  sorts: SortLevel[];
  onApply: (sorts: SortLevel[]) => void;
}

export function GridSortDialog({ open, onOpenChange, columns, sorts, onApply }: GridSortDialogProps) {
  const { t } = useI18n();
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    {open && <DialogFrame title={t('grid.filterSort.sortTitle')}>
      <SortEditor columns={columns} sorts={sorts} onCancel={() => onOpenChange(false)}
        onApply={next => { onApply(next); onOpenChange(false); }} />
    </DialogFrame>}
  </Dialog.Root>;
}

function SortEditor({ columns, sorts, onApply, onCancel }: {
  columns: Column[];
  sorts: SortLevel[];
  onApply: (sorts: SortLevel[]) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const sortableColumns = useMemo(() => columns.filter(canSortColumn), [columns]);
  const [levels, setLevels] = useState<SortLevel[]>(() => {
    const seen = new Set<string>();
    const initial = sorts.filter(sort => {
      if (seen.has(sort.columnUuid) || !sortableColumns.some(column => column.uuid === sort.columnUuid && column.data_type === sort.dataType)) return false;
      seen.add(sort.columnUuid); return true;
    }).map(sort => ({ ...sort }));
    return initial.length || !sortableColumns.length ? initial
      : [{ columnUuid: sortableColumns[0].uuid, dataType: sortableColumns[0].data_type, direction: 'asc' }];
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const unusedColumns = sortableColumns.filter(column => !levels.some(level => level.columnUuid === column.uuid));
  const canMoveUp = selectedIndex > 0 && selectedIndex < levels.length;
  const canMoveDown = selectedIndex >= 0 && selectedIndex < levels.length - 1;
  const move = (offset: number) => {
    const nextIndex = selectedIndex + offset;
    if (nextIndex < 0 || nextIndex >= levels.length) return;
    setLevels(previous => {
      const next = [...previous];
      [next[selectedIndex], next[nextIndex]] = [next[nextIndex], next[selectedIndex]];
      return next;
    });
    setSelectedIndex(nextIndex);
  };
  const update = (index: number, next: SortLevel) => setLevels(previous => previous.map((level, i) => i === index ? next : level));
  const apply = (event: React.FormEvent) => {
    event.preventDefault();
    onApply(levels.filter(level => sortableColumns.some(column => column.uuid === level.columnUuid && column.data_type === level.dataType)));
  };
  return <form onSubmit={apply}>
    <div className="grid-fs-sort-tools">
      <Button type="button" variant="outline" size="sm" disabled={!unusedColumns.length} onClick={() => {
        const column = unusedColumns[0];
        if (!column) return;
        setSelectedIndex(levels.length);
        setLevels(previous => [...previous, { columnUuid: column.uuid, dataType: column.data_type, direction: 'asc' }]);
      }}><Plus aria-hidden="true" />{t('grid.filterSort.addLevel')}</Button>
      <Button type="button" variant="outline" size="sm" disabled={!levels.length} onClick={() => {
        setLevels(previous => previous.filter((_, index) => index !== selectedIndex));
        setSelectedIndex(Math.max(0, Math.min(selectedIndex, levels.length - 2)));
      }}><Trash2 aria-hidden="true" />{t('grid.filterSort.deleteLevel')}</Button>
      <span />
      <Button type="button" variant="outline" size="icon" aria-label={t('grid.filterSort.moveUp')} title={t('grid.filterSort.moveUp')} disabled={!canMoveUp} onClick={() => move(-1)}><ArrowUp aria-hidden="true" /></Button>
      <Button type="button" variant="outline" size="icon" aria-label={t('grid.filterSort.moveDown')} title={t('grid.filterSort.moveDown')} disabled={!canMoveDown} onClick={() => move(1)}><ArrowDown aria-hidden="true" /></Button>
    </div>
    <div className="grid-fs-sort-table" role="table" aria-label={t('grid.filterSort.sortTitle')}>
      <div className="grid-fs-sort-head" role="row"><span role="columnheader">{t('grid.filterSort.priority')}</span><span role="columnheader">{t('grid.filterSort.column')}</span><span role="columnheader">{t('grid.filterSort.direction')}</span></div>
      <div className="grid-fs-sort-levels" role="rowgroup">
        {levels.map((level, index) => <div key={level.columnUuid} role="row" className={`grid-fs-sort-level${selectedIndex === index ? ' is-selected' : ''}`}
          onClick={() => setSelectedIndex(index)} onFocus={() => setSelectedIndex(index)}>
          <span role="cell">{index === 0 ? t('grid.filterSort.firstPriority') : t('grid.filterSort.nextPriority')}</span>
          <span role="cell"><select aria-label={t('grid.filterSort.levelColumn', { index: formatNumber(index + 1) })} value={level.columnUuid}
            onChange={event => {
              const column = sortableColumns.find(column => column.uuid === event.target.value);
              if (column) update(index, { ...level, columnUuid: column.uuid, dataType: column.data_type });
            }}>
            {sortableColumns.filter(column => column.uuid === level.columnUuid || !levels.some(other => other.columnUuid === column.uuid))
              .map(column => <option key={column.uuid} value={column.uuid}>{settingsDisplayLabel(column.uuid, column.display_name || column.data_name) || column.data_name}</option>)}
          </select></span>
          <span role="cell"><select aria-label={t('grid.filterSort.levelDirection', { index: formatNumber(index + 1) })} value={level.direction}
            onChange={event => update(index, { ...level, direction: event.target.value as SortLevel['direction'] })}>
            <option value="asc">{t('grid.filterSort.ascending')}</option><option value="desc">{t('grid.filterSort.descending')}</option>
          </select></span>
        </div>)}
      </div>
    </div>
    <div className="grid-fs-dialog-footer"><Button type="button" variant="outline" onClick={onCancel}>{t('grid.filterSort.cancel')}</Button>
      <Button type="submit">{t('grid.filterSort.apply')}</Button></div>
  </form>;
}
