import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { colorPickerId } from '@/app/utils/color_picker_window';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { ColorField } from '@/app/components/color/ColorField';
import { getColorInterpretation, type ColorPreview, type ColorValueType } from '@/app/components/color/colorDisplay';
import { localizeError, useI18n } from '@/app/i18n';
import type { SavedColorSwatch } from '@/app/types/colorTypes';

/** This edits only the column form's draft. Its owner performs preview and atomic save. */
export function ColumnColorSwatches({ value, onChange, type, disabled, context }: {
  value: SavedColorSwatch[];
  onChange: (value: SavedColorSwatch[]) => void;
  type: ColorValueType;
  disabled: boolean;
  context: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const identity = JSON.stringify([context, type, disabled, value]);
  const current = useRef(identity); current.current = identity;
  useEffect(() => {
    pending.current = false; setAdding(false); setError(null);
    return () => { generation.current += 1; pending.current = false; };
  }, [identity]);
  const add = async () => {
    if (disabled || pending.current) return;
    pending.current = true; setAdding(true); setError(null);
    const requestGeneration = generation.current;
    try {
      // Obtain the canonical type default from Rust; the UI does not validate or
      // reconstruct RGBA, including f32 rounding, HDR and alpha semantics.
      const preview = await invoke<ColorPreview>('preview_color', {
        colorType: type, input: '', interpretation: getColorInterpretation(type), exposure: 0,
      });
      if (generation.current !== requestGeneration || current.current !== identity) return;
      onChange([...value, {
        id: colorPickerId(), name: t('column.swatches.defaultName', { index: String(value.length + 1) }),
        data_type: type, value: preview.canonical,
      }]);
    } catch (reason) {
      if (generation.current === requestGeneration && current.current === identity) setError(reason);
    } finally {
      if (generation.current === requestGeneration && current.current === identity) {
        pending.current = false; setAdding(false);
      }
    }
  };
  const update = (swatchId: string, patch: Partial<Pick<SavedColorSwatch, 'name' | 'value'>>) => {
    if (disabled || pending.current) return;
    onChange(value.map(swatch => swatch.id === swatchId ? { ...swatch, ...patch } : swatch));
  };
  const move = (index: number, direction: -1 | 1) => {
    if (disabled || pending.current || index + direction < 0 || index + direction >= value.length) return;
    const next = [...value];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    onChange(next);
  };
  return <section className="editor-section" aria-labelledby={`${id}-heading`} data-column-swatches>
    <h3 id={`${id}-heading`}>{t('column.swatches.title')}</h3>
    {value.length === 0 && <p className="editor-hint mb-3">{t('column.swatches.empty')}</p>}
    <ol className="space-y-3" aria-label={t('column.swatches.title')}>
      {value.map((swatch, index) => {
        const mismatch = swatch.data_type !== type;
        const label = swatch.name || t('column.swatches.defaultName', { index: String(index + 1) });
        return <li key={swatch.id} data-swatch-id={swatch.id} className="rounded-lg border border-slate-200 p-3">
          <div className="mb-2 flex items-end gap-2">
            <div className="min-w-0 flex-1"><label htmlFor={`${id}-${swatch.id}-name`}>{t('column.swatches.name')}</label>
              <input id={`${id}-${swatch.id}-name`} className="editor-input" value={swatch.name} disabled={disabled || adding}
                onChange={event => update(swatch.id, { name: event.target.value })} autoComplete="off" />
            </div>
            <button type="button" className="editor-action p-2" disabled={disabled || adding || index === 0}
              aria-label={t('column.swatches.moveUp', { name: label })} title={t('column.swatches.moveUp', { name: label })} onClick={() => move(index, -1)}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
            <button type="button" className="editor-action p-2" disabled={disabled || adding || index === value.length - 1}
              aria-label={t('column.swatches.moveDown', { name: label })} title={t('column.swatches.moveDown', { name: label })} onClick={() => move(index, 1)}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
            <button type="button" className="editor-action p-2" disabled={disabled || adding}
              aria-label={t('column.swatches.remove', { name: label })} title={t('column.swatches.remove', { name: label })}
              onClick={() => { if (!disabled && !pending.current) onChange(value.filter(item => item.id !== swatch.id)); }}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
          </div>
          <p className={`mb-2 text-xs ${mismatch ? 'text-amber-700' : 'text-muted-foreground'}`}>{mismatch ? t('column.swatches.mismatch', { type: swatch.data_type }) : swatch.data_type}</p>
          <ColorField type={swatch.data_type} value={swatch.value} label={label} columnSwatches={value}
            context={`${context}:${swatch.id}`} disabled={disabled || adding || mismatch}
            onChange={newValue => update(swatch.id, { value: newValue })} />
        </li>;
      })}
    </ol>
    <button type="button" className="editor-action mt-3 inline-flex items-center gap-2" disabled={disabled || adding} onClick={() => void add()}>
      <Plus className="h-4 w-4" aria-hidden="true" />{t('column.swatches.add')}
    </button>
    {Boolean(error) && <p role="alert" className="mt-2 text-xs text-red-700">{localizeError(error)}</p>}
  </section>;
}
