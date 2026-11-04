import { getLocaleDirection, t, useI18n } from '@/app/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, Database, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  COLUMN_TYPE_CATEGORIES,
  COLUMN_TYPE_FAMILIES,
  columnTypeDetails,
  columnTypeFamily,
  columnTypeLabel,
} from '@/app/utils/columnTypes';
import type { ColumnTypeCategoryId, ColumnTypeFamily, ColumnTypeFamilyId } from '@/app/utils/columnTypes';

export interface ColumnTypePickerPanelProps {
  value: string;
  allowSelect: boolean;
  onSelect: (value: string) => void;
  onCancel: () => void;
  busy?: boolean;
}

const FAMILY_SYMBOLS: Record<ColumnTypeFamilyId, string> = {
  string: 'Aa', integer: '123', decimal: '0.5', boolean: '✓',
  reference: '↗', 'table-reference': '▦', select: '☷', color: '◉', curve: '∿',
};
const INTEGER_WIDTHS = ['8', '16', '32', '64'] as const;

/** Keep a technical color name separate from its translated parenthetical explanation. */
function PrecisionLabel({ type, label }: { type: string; label: string }) {
  if (type === 'ColorFloat') return <bdi dir="ltr">{label}</bdi>;
  if (type === 'Color32') {
    // Bundled labels use ASCII or full-width parentheses; preserve every source character.
    const asciiOpening = label.indexOf('(');
    const opening = asciiOpening >= 0 ? asciiOpening : label.indexOf('（');
    const closing = opening >= 0 ? label.lastIndexOf(label[opening] === '(' ? ')' : '）') : -1;
    if (closing > opening) {
      return <><bdi dir="ltr" className="inline-block">{label.slice(0, opening)}</bdi><bdi dir={getLocaleDirection()} className="inline-block">{label.slice(opening)}</bdi></>;
    }
  }
  return <>{label}</>;
}

/** Keep the width sequence LTR while its translated unit keeps the locale direction. */
function IntegerWidths() {
  return <>{t('column.typePicker.integerWidths').split(/(8\s*\/\s*16\s*\/\s*32\s*\/\s*64)/).map((part, index) =>
    index % 2 ? <bdi key={index} dir="ltr">{part}</bdi> : part,
  )}</>;
}

/** Notes remain prose; only a numeric precision interval needs LTR isolation. */
function TypeNote({ note }: { note: string }) {
  return <>{note.split(/(\d+[–〜]\d+)/u).map((part, index) =>
    index % 2 ? <bdi key={index} dir="ltr">{part}</bdi> : part,
  )}</>;
}

/** Isolate technical ranges without changing the direction of translated prose. */
function TypeRange({ value, range }: { value: string; range: string }) {
  if (/^(?:[IU](?:8|16|32|64)|F(?:32|64)|Boolean)$/.test(value)) {
    return <bdi dir="ltr">{range}</bdi>;
  }
  if (value === 'Color32' || value === 'ColorFloat') {
    // Color descriptions mix prose with numbers; do not split identifiers such as f32.
    return <>{range.split(/((?<![\p{L}\p{N}])[−-]?\d+(?:[.,]\d+)*(?:[–−-]\d+(?:[.,]\d+)*)?)/u).map((part, index) =>
      index % 2 ? <bdi key={index} dir="ltr">{part}</bdi> : part,
    )}</>;
  }
  return <>{range}</>;
}

/** In-app dialog contents. Selection is local until the parent accepts the session result. */
export function ColumnTypePickerPanel({ value, allowSelect, onSelect, onCancel, busy = false }: ColumnTypePickerPanelProps) {
  useI18n();
  const id = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<HTMLFieldSetElement>(null);
  const [draftValue, setDraftValue] = useState(value);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ColumnTypeCategoryId>(columnTypeFamily(value)?.category ?? 'basic');
  const family = columnTypeFamily(draftValue);
  const details = columnTypeDetails(draftValue);
  const searchTerms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const searching = searchTerms.length > 0;
  // Rust checks the saved column, allowing a return to the existing Select after an unsaved type change.
  const availableFamilies = COLUMN_TYPE_FAMILIES.filter((item) => !item.existingOnly || allowSelect);
  const visibleFamilies = availableFamilies.filter((item) => {
    if (!searching) return item.category === category;
    const text = [item.label, item.description, item.keywords, ...item.values, ...item.values.map(columnTypeLabel)].join(' ').toLocaleLowerCase();
    return searchTerms.every((term) => text.includes(term));
  });
  const canSelect = availableFamilies.some((item) => item.values.includes(draftValue));

  useEffect(() => { searchRef.current?.focus(); }, []);
  const closePicker = () => { if (!busy) onCancel(); };

  const selectFamily = (item: ColumnTypeFamily) => {
    // When searching for a specific type name such as "U16", use that candidate as the draft.
    const matchingValue = searching
      ? item.values.find((candidate) => candidate.toLocaleLowerCase() === query.trim().toLocaleLowerCase())
      : undefined;
    setDraftValue(matchingValue ?? (item.values.includes(draftValue) ? draftValue : item.defaultValue));
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key !== 'ArrowDown' && event.key !== 'Enter') return;
    // Do not submit the parent form when Enter is pressed during a search.
    event.preventDefault();
    const selected = optionsRef.current?.querySelector<HTMLInputElement>('input:checked');
    const first = optionsRef.current?.querySelector<HTMLInputElement>('input[type="radio"]');
    (selected ?? first)?.focus();
  };

  return (
        <section
          id={`${id}-panel`}
          aria-labelledby={`${id}-heading`}
          className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              event.stopPropagation();
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closePicker();
            }
          }}
        >
          <div className="shrink-0 space-y-3 border-b border-border px-5 py-3">
            <div className="flex items-center justify-between gap-2">
              <h3 id={`${id}-heading`} className="flex items-center gap-2 text-sm font-semibold">
                <Database aria-hidden="true" className="h-4 w-4 text-primary" />{t('column.typePicker.heading')}
              </h3>
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" aria-label={t('column.typePicker.close')} disabled={busy} onClick={closePicker}>
                <X aria-hidden="true" />
              </Button>
            </div>
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                aria-label={t('column.typePicker.search')}
                placeholder={t('column.typePicker.searchPlaceholder')}
                className="border-border bg-background pl-8 text-sm"
              />
            </div>
            <div role="group" aria-label={t('column.typePicker.categories')} className="flex flex-wrap gap-1.5">
              {COLUMN_TYPE_CATEGORIES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={!searching && category === item.id}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                    !searching && category === item.id
                      ? 'border-primary/30 bg-accent text-primary'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted',
                  )}
                  onClick={() => { setCategory(item.id); setQuery(''); }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid min-h-0 min-w-0 flex-1 content-start gap-5 overflow-y-auto p-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 13rem), 1fr))' }}>
            <fieldset ref={optionsRef} className="min-w-0 space-y-2">
              <legend className="mb-2 text-xs font-medium text-muted-foreground">
                {searching ? t('column.typePicker.resultCount', { count: visibleFamilies.length }) : t('column.typePicker.choose')}
              </legend>
              {visibleFamilies.map((item) => (
                <label
                  key={item.id}
                  className={cn(
                    'column-type-choice relative flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1',
                    item.id === family?.id ? 'border-primary bg-accent' : 'border-border bg-background hover:border-primary/30 hover:bg-muted',
                  )}
                >
                  <input
                    type="radio"
                    name={`${id}-family`}
                    value={item.id}
                    checked={item.id === family?.id}
                    onChange={() => selectFamily(item)}
                    onClick={() => { if (item.id === family?.id) selectFamily(item); }}
                    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); selectFamily(item); } }}
                    className="sr-only"
                    aria-label={item.existingOnly ? t('column.typePicker.existingLabel', { label: item.label }) : item.label}
                  />
                  <span aria-hidden="true" className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold', item.id === family?.id ? 'bg-primary text-primary-foreground' : 'bg-accent text-primary')}>
                    {FAMILY_SYMBOLS[item.id]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{item.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {item.existingOnly ? t('column.typePicker.existing') : item.id === 'integer' ? <IntegerWidths /> : <bdi dir="ltr">{item.values.join(' / ')}</bdi>}
                    </span>
                  </span>
                  {item.id === family?.id && <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />}
                </label>
              ))}
              {visibleFamilies.length === 0 && (
                <p role="status" className="rounded-lg border border-dashed border-border p-4 text-sm leading-relaxed text-muted-foreground">
                  {t('column.typePicker.noResults')}
                </p>
              )}
            </fieldset>

            <div className="min-w-0 space-y-4">
              <div className="space-y-1">
                <h4 className="text-sm font-semibold">{family?.label ?? (columnTypeLabel(draftValue) || t('column.typePicker.selectPrompt'))}</h4>
              </div>

              {family?.id === 'integer' && (
                <>
                  <fieldset className="min-w-0">
                    <legend className="mb-2 text-xs font-medium">{t('column.typePicker.bitWidth')}</legend>
                    <div className="grid grid-cols-4 gap-1">
                      {INTEGER_WIDTHS.map((width) => (
                        <label key={width} className={cn('column-type-choice relative cursor-pointer rounded-md border py-2 text-center text-xs focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1', draftValue.slice(1) === width ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-accent')}>
                          <input
                            type="radio"
                            name={`${id}-width`}
                            checked={draftValue.slice(1) === width}
                            onChange={() => setDraftValue(`${draftValue.startsWith('U') ? 'U' : 'I'}${width}`)}
                            onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
                            aria-label={t('column.typePicker.widthLabel', { width })}
                            className="sr-only"
                          />
                          {width}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend className="mb-2 text-xs font-medium">{t('column.typePicker.sign')}</legend>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {[{ prefix: 'I', label: t('column.typePicker.signed') }, { prefix: 'U', label: t('column.typePicker.unsigned') }].map((sign) => (
                        <label key={sign.prefix} className="column-type-choice relative flex cursor-pointer items-center gap-2 text-xs">
                          <input
                            type="radio"
                            name={`${id}-sign`}
                            checked={draftValue.startsWith(sign.prefix)}
                            onChange={() => setDraftValue(`${sign.prefix}${draftValue.slice(1)}`)}
                            onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
                            className="h-4 w-4 accent-primary"
                          />
                          {sign.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </>
              )}

              {(family?.id === 'decimal' || family?.id === 'color') && (
                <fieldset>
                  <legend className="mb-2 text-xs font-medium">{t('column.typePicker.precision')}</legend>
                  <div className="flex flex-wrap gap-2">
                    {(family.id === 'color' ? [{ type: 'Color32', label: t('column.type.color32') }, { type: 'ColorFloat', label: t('column.type.colorFloat') }] : [{ type: 'F32', label: t('column.typePicker.singlePrecision') }, { type: 'F64', label: t('column.typePicker.doublePrecision') }]).map((precision) => (
                      <label key={precision.type} className={cn('column-type-choice relative cursor-pointer rounded-md border px-2.5 py-2 text-xs focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1', draftValue === precision.type ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-accent')}>
                        <input
                          type="radio"
                          name={`${id}-precision`}
                          checked={draftValue === precision.type}
                          onChange={() => setDraftValue(precision.type)}
                          onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
                          className="sr-only"
                        />
                        <PrecisionLabel type={precision.type} label={precision.label} />
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              {details && (
                <div className="min-w-0 space-y-2 rounded-lg bg-accent p-3" aria-live="polite" aria-atomic="true">
                  <p className="font-mono text-base font-semibold text-primary"><bdi dir="ltr">{draftValue}</bdi></p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    <span className="block font-medium">{details.rangeLabel}</span>
                    <span className="break-words [overflow-wrap:anywhere]"><TypeRange value={draftValue} range={details.range} /></span>
                  </p>
                  {details.note && <p className="text-xs leading-relaxed text-muted-foreground"><TypeNote note={details.note} /></p>}
                </div>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-muted/60 px-5 py-3">
            <div className="ml-auto flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" className="border-border bg-background" disabled={busy} onClick={closePicker}>{t('common.cancel')}</Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || !canSelect}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => onSelect(draftValue)}
              >
                {t('column.typePicker.select')}
              </Button>
            </div>
          </div>
        </section>
  );
}
