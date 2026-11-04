import { useEffect, useRef, useState } from 'react';
import { Pipette } from 'lucide-react';
import { useI18n, localizeError } from '@/app/i18n';
import { showColorPicker } from '@/app/utils/color_picker_window';
import { colorPreviewCss, displayChannels, useColorInterpretation, type ColorPickerType } from './colorDisplay';
import type { SavedColorSwatch, ColorSwatchColumnContext } from '@/app/types/colorTypes';
import { ColorSwatch } from './ColorSwatch';

/** Local form draft only. The owning project/column form decides when to persist. */
export function ColorField({ value, onChange, type = 'UiColor', label, disabled = false, context = '', id, columnSwatches, columnContext }: {
  value: string; onChange: (value: string) => void; type?: ColorPickerType; label: string; disabled?: boolean; context?: string; id?: string; columnSwatches?: SavedColorSwatch[]; columnContext?: ColorSwatchColumnContext;
}) {
  const { t } = useI18n();
  const interpretation = useColorInterpretation(type);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const active = useRef<AbortController | null>(null);
  const latestOnChange = useRef(onChange); latestOnChange.current = onChange;
  const trigger = useRef<HTMLButtonElement>(null);
  const identity = JSON.stringify([value, type, disabled, context, columnSwatches, columnContext]);
  const current = useRef(identity); current.current = identity;
  useEffect(() => {
    setBusy(false); setError(null);
    return () => { active.current?.abort(); active.current = null; };
  }, [identity]);
  const channels = type === 'UiColor' ? null : displayChannels(value);
  const color = type === 'UiColor' ? value : channels ? colorPreviewCss(channels, type, interpretation) : null;
  const formula = value.trimStart().startsWith('=');
  const show = async () => {
    if (disabled || active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(null);
    try {
      const selected = await showColorPicker({ type, value, label, readonly: formula, formula, columnSwatches, columnContext }, controller.signal);
      if (!controller.signal.aborted && current.current === identity && selected !== null && selected !== value) latestOnChange.current(selected);
    } catch (reason) { if (!controller.signal.aborted && current.current === identity) setError(reason); }
    finally {
      if (active.current === controller) { active.current = null; setBusy(false); if (!controller.signal.aborted) trigger.current?.focus(); }
    }
  };
  return <div className="min-w-0">
    <button ref={trigger} id={id} type="button" aria-haspopup="dialog" aria-expanded={busy} aria-label={`${label}: ${t('color.open')}`}
      disabled={disabled || busy} onClick={() => void show()} className="flex w-full items-center gap-3 rounded border border-input bg-background px-3 py-2 text-left text-sm disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
      <ColorSwatch color={color} className="h-7 w-10" /><span className="min-w-0 flex-1 truncate font-mono text-xs">{value || t('color.defaultWhite')}</span>
      <Pipette className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
    </button>
    {Boolean(error) && <p role="alert" className="mt-2 text-xs text-red-700">{localizeError(error)}</p>}
  </div>;
}
