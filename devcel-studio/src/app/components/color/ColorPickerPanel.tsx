import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n, localizeError } from '@/app/i18n';
import { ColorWheel, type ColorHsv } from './ColorWheel';
import { colorTrackGradient, colorTrackStyle } from './colorTrack';
import './color-picker.css';
import { HdrColorSwatch } from './HdrColorSwatch';
import type { HdrPreviewStatus } from '@/app/utils/hdrColorPreview';
import { ColorSwatchPalette, canSelectColorSwatch } from './ColorSwatchPalette';
import type { SavedColorSwatch } from '@/app/types/colorTypes';
import { colorPreviewCss, colorPreviewLinear, hsvToRgb, rgbToHsv, displayChannels, useColorInterpretation,
  type ColorPreview, type ColorChannels } from './colorDisplay';
import type { ColorPickerRequest } from '@/app/utils/color_picker_window';

const RGBA = ['R', 'G', 'B', 'A'] as const;
const HSV = ['H', 'S', 'V'] as const;
const COMPLETE_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const RGB_HEX = /^#[0-9a-fA-F]{6}$/;

/** UI drafts and display transforms only. Rust preview_color is the sole validator/canonicalizer. */
export function ColorPickerPanel({ request, onApply, onCancel, busy = false, error: externalError, title }: {
  request: ColorPickerRequest; onApply: (value: string) => Promise<void>; onCancel: () => void;
  busy?: boolean; error?: string | null; title?: ReactNode;
}) {
  const { t } = useI18n();
  const interpretation = useColorInterpretation(request.type);
  const [exposure, setExposure] = useState(0);
  const [hdrStatus, setHdrStatus] = useState<HdrPreviewStatus>('unavailable');
  const showHdr = hdrStatus === 'candidate';
  const [channelMode, setChannelMode] = useState('rgb');
  const [input, setInput] = useState(request.value);
  const [fields, setFields] = useState<string[]>([]);
  const [inputKind, setInputKind] = useState<'initial' | 'rgba' | 'hsv'>('initial');
  const [preview, setPreview] = useState<ColorPreview | null>(null);
  const [initial, setInitial] = useState<ColorPreview | null>(null);
  // HSV is an interaction draft: achromatic RGB cannot reconstruct a selected hue or saturation.
  const [pickerHsv, setPickerHsv] = useState<ColorHsv>([0, 0, 1]);
  const [hsvDraft, setHsvDraft] = useState<string[] | null>(null);
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const [valueMax, setValueMax] = useState(1);
  const [selectingSwatch, setSelectingSwatch] = useState(false);
  const selectingSwatchRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const sequence = useRef(0);
  const readonly = request.readonly === true;
  const isFloat = request.type === 'ColorFloat';
  const isUi = request.type === 'UiColor';
  const scale = isFloat ? 1 : 255;

  const syncHsvView = useCallback((channels: ColorChannels) => {
    // Rendering a nonnegative HSV view never writes the original negative/HDR channels.
    const shown = [...channels] as ColorChannels;
    for (let index = 0; index < 3; index++) shown[index] = Math.max(0, request.type === 'ColorFloat' ? shown[index] : Math.min(255, shown[index]));
    const next = rgbToHsv(shown, request.type);
    setPickerHsv(previous => [next[1] === 0 ? previous[0] : next[0], next[2] === 0 ? previous[1] : next[1], next[2]]);
    setValueMax(Math.max(1, next[2]));
  }, [request.type]);

  useEffect(() => {
    const ticket = ++sequence.current;
    let active = true;
    setPending(true); setError(null);
    const timer = setTimeout(() => {
      void invoke<ColorPreview>('preview_color', { colorType: request.type, input, interpretation, exposure }).then(result => {
        if (!active || sequence.current !== ticket) return;
        setPreview(result); setInitial(previous => previous ?? result);
        if (inputKind === 'initial') setFields(result.channels.map(String));
        if (inputKind !== 'hsv') syncHsvView(result.channels);
        setPending(false);
      }).catch(reason => { if (active && sequence.current === ticket) { setError(reason); setPreview(null); setPending(false); } });
    }, inputKind === 'initial' ? 0 : 80);
    return () => { active = false; clearTimeout(timer); };
  }, [request.type, input, interpretation, exposure, inputKind, syncHsvView]);

  const enterChannels = (values: string[], kind: 'rgba' | 'hsv' = 'rgba', preserveDrafts = false) => {
    if (readonly || busy || !initial || selectingSwatchRef.current) return;
    if (!preserveDrafts) { setHsvDraft(null); setHexDraft(null); }
    const nextInput = `[${values.join(',')}]`;
    setFields(values); setInputKind(kind); setInput(nextInput);
    if (nextInput !== input || kind !== inputKind) setPending(true);
    // Only display coordinates are parsed here. Apply remains gated by the current Rust response.
    const displayed = displayChannels(`[${values.join(',')}]`);
    if (kind === 'rgba' && displayed && !preserveDrafts) syncHsvView(displayed);
  };
  const enterAlpha = (value: string) => enterChannels(fields.map((field, index) => index === 3 ? value : field), inputKind === 'hsv' ? 'hsv' : 'rgba', true);
  const enterHex = (value: string) => {
    if (readonly || busy || !initial || selectingSwatchRef.current) return;
    setHexDraft(value);
    if (!RGB_HEX.test(value)) return;
    const rgb = value.slice(1).match(/../g)!.map(channel => String(parseInt(channel, 16)));
    setHsvDraft(null);
    // RGB is updated synchronously; an alpha edit before Rust responds cannot restore stale RGB.
    enterChannels([...rgb, fields[3]], 'rgba', true);
  };
  const channels = displayChannels(`[${fields.join(',')}]`) ?? preview?.channels ?? initial?.channels;
  const enterHsv = (next: ColorHsv, draft: string[] | null = null) => {
    if (readonly || busy || !initial || selectingSwatchRef.current) return;
    setPickerHsv(next); setValueMax(previous => Math.max(previous, next[2]));
    const rgb = hsvToRgb(next[0], next[1], next[2], 0, request.type).slice(0, 3).map(String);
    // Preserve the exact latest alpha draft, including edits still awaiting Rust validation.
    enterChannels([...rgb, fields[3]], 'hsv');
    setHsvDraft(draft);
  };
  const hsvText = hsvDraft ?? pickerHsv.map(value => String(Number(value.toPrecision(8))));
  const hsvNumbers = hsvText.map(value => COMPLETE_NUMBER.test(value.trim()) ? Number(value) : NaN);
  const hsvLimits = [360, 1, isFloat ? Infinity : 1];
  const invalidHsvIndex = hsvDraft ? hsvNumbers.findIndex((value, index) => !Number.isFinite(value) || value < 0 || value > hsvLimits[index]) : -1;
  const invalidHex = hexDraft !== null && !RGB_HEX.test(hexDraft);
  const rgbBytes = fields.slice(0, 3).map(value => COMPLETE_NUMBER.test(value.trim()) ? Number(value) : NaN);
  const displayedHex = rgbBytes.length === 3 && rgbBytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    ? '#' + rgbBytes.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()
    : (preview?.hex ?? initial?.hex)?.slice(0, 7) ?? ''; 
  const draftInvalid = invalidHsvIndex >= 0 || invalidHex;
  const changeHsv = (index: number, value: string) => {
    if (readonly || busy || !initial || selectingSwatchRef.current) return;
    const nextText = hsvText.map((field, at) => at === index ? value : field);
    setHsvDraft(nextText);
    const next = nextText.map(field => COMPLETE_NUMBER.test(field.trim()) ? Number(field) : NaN);
    if (next.some((number, at) => !Number.isFinite(number) || number < 0 || number > hsvLimits[at])) return;
    enterHsv(next as ColorHsv, nextText);
  };
  const hsvValueMax = isFloat ? Math.max(8, valueMax) : 1;
  const track = (kind: 'rgba' | 'hsv' | 'exposure', index: number, min: number, max: number) => channels
    ? colorTrackStyle(colorTrackGradient(channels, request.type, interpretation, exposure,
      kind === 'exposure' ? { kind, min, max } : kind === 'hsv' ? { kind, channel: index as 0 | 1 | 2, min, max, hsv: pickerHsv }
        : { kind, channel: index as 0 | 1 | 2 | 3, min, max })) : undefined;
  const disabled = busy || readonly || !initial || selectingSwatch;
  const selectSwatch = async (swatch: SavedColorSwatch) => {
    if (disabled || selectingSwatchRef.current || !canSelectColorSwatch(swatch, request.type)) return;
    selectingSwatchRef.current = true; setSelectingSwatch(true);
    try {
      const canonical = await invoke<string>('apply_color_swatch', { swatch, targetType: request.type });
      if (!alive.current) return;
      const selected = displayChannels(swatch.value);
      if (!selected) return;
      setFields(selected.map(String)); setInputKind('rgba'); setInput(canonical);
      setHsvDraft(null); setHexDraft(null); syncHsvView(selected); setError(null);
      if (canonical !== input || inputKind !== 'rgba') setPending(true);
    } catch (reason) { if (alive.current) setError(reason); }
    finally { selectingSwatchRef.current = false; if (alive.current) setSelectingSwatch(false); }
  };
  const draftError = invalidHsvIndex >= 0 ? `${HSV[invalidHsvIndex]}: ${!Number.isFinite(hsvNumbers[invalidHsvIndex])
    ? t('error.validation.valueType') : t('error.validation.numberRange', { min: '0', max: String(hsvLimits[invalidHsvIndex]) })}`
    : invalidHex ? t('color.hexInvalid') : null;
  const shownError = externalError || draftError || (error ? localizeError(error) : null);
  return <form className="color-picker-panel flex h-full min-h-0 flex-col bg-background text-foreground" noValidate onSubmit={event => {
    event.preventDefault(); if (!disabled && !pending && !draftInvalid && preview) void onApply(preview.canonical);
  }} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && !busy) { event.preventDefault(); event.stopPropagation(); onCancel(); }
  }}>
    <header className="color-picker-header shrink-0 border-b border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">{title ?? <h1 className="text-sm font-semibold">{t('color.title')}</h1>}
        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px]">{request.type}</span></div>
      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={request.label}>{request.label}</p>
    </header>
    <div className="color-picker-body flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <div data-color-controls className="shrink-0 space-y-2">
      {readonly && <p role="status" className="rounded border border-border bg-muted px-2 py-1 text-xs">{request.formula ? `${t('color.formulaLabel')} · ${t('color.readonly')}` : t('color.readonly')}</p>}
      <div data-color-top className="color-picker-top grid items-start gap-3">
        <div className="min-w-0 space-y-2">
          <section aria-label={t('color.wheel')} className="min-w-0">
            <ColorWheel hsv={pickerHsv} valueMax={valueMax} type={request.type} interpretation={interpretation} exposure={exposure} disabled={disabled} onChange={enterHsv} />
          </section>
          <section aria-label={t('common.preview')} className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-1 text-[11px]"><h2>{t('common.preview')}</h2>
              <span className="text-muted-foreground">{t(showHdr ? 'color.hdrBadge' : 'color.sdrBadge')}</span></div>
            <div data-color-preview="current"><HdrColorSwatch enabled={!isUi} showHdr={showHdr} linear={channels ? colorPreviewLinear(channels, request.type, interpretation, exposure) : null} fallbackCss={channels ? colorPreviewCss(channels, request.type, interpretation, exposure) : null} onStatus={setHdrStatus} /></div>
          </section>
        </div>
        <div data-color-inspector className="min-w-0 space-y-2">
      <Tabs value={channelMode} onValueChange={setChannelMode} className="flex flex-col gap-2">
        <TabsList aria-label={t('color.channels')} className="h-8 self-start">
          <TabsTrigger type="button" value="rgb" className="border border-transparent data-[state=active]:border-border">{t('color.rgb')}</TabsTrigger>
          <TabsTrigger type="button" value="hsv" className="border border-transparent data-[state=active]:border-border">{t('color.hsv')}</TabsTrigger>
        </TabsList>
        <TabsContent value="rgb" className="mt-0">
          <fieldset disabled={disabled} className="space-y-2 disabled:opacity-70">
            {RGBA.slice(0, 3).map((channel, index) => <div key={channel} className="grid grid-cols-[0.75rem_minmax(0,1fr)_5.5rem] items-center gap-2">
              <label className="text-xs font-semibold" htmlFor={`color-${channel}-slider`}>{channel}</label>
              <input id={`color-${channel}-slider`} aria-label={t('color.channelSlider', { channel })} type="range" min={0} max={isFloat ? 8 : scale}
                step={isFloat ? 0.001 : 1} className="color-value-slider" style={track('rgba', index, 0, isFloat ? 8 : scale)}
                value={Number.isFinite(Number(fields[index])) ? Number(fields[index]) : 0}
                onChange={event => enterChannels(fields.map((value, at) => at === index ? event.target.value : value))} />
              <input id={`color-${channel}`} aria-label={t('color.channelInput', { channel })} type="text" inputMode={isFloat ? 'decimal' : 'numeric'} value={fields[index] ?? ''}
                className="min-w-0 w-full rounded border border-input bg-background px-1.5 py-1 text-right font-mono text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                onChange={event => enterChannels(fields.map((value, at) => at === index ? event.target.value : value))} />
            </div>)}
          </fieldset>
        </TabsContent>
        <TabsContent value="hsv" className="mt-0">
          <fieldset disabled={disabled} className="space-y-2 disabled:opacity-70">
            {HSV.map((channel, index) => <div key={channel} className="grid grid-cols-[0.75rem_minmax(0,1fr)_5.5rem] items-center gap-2">
              <label className="text-xs font-semibold" htmlFor={`color-${channel}-slider`}>{channel}</label>
              <input id={`color-${channel}-slider`} aria-label={t('color.channelSlider', { channel })} type="range" min={0} max={index === 0 ? 359.99 : index === 2 ? hsvValueMax : 1} step={index === 0 ? 0.1 : 0.001}
                className="color-value-slider" style={track('hsv', index, 0, index === 0 ? 359.99 : index === 2 ? hsvValueMax : 1)} value={pickerHsv[index]} onChange={event => changeHsv(index, event.target.value)} />
              <input id={`color-${channel}`} aria-label={t('color.channelInput', { channel })} type="text" inputMode="decimal" value={hsvText[index]} aria-invalid={invalidHsvIndex === index}
                className="min-w-0 w-full rounded border border-input bg-background px-1.5 py-1 text-right font-mono text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                onChange={event => changeHsv(index, event.target.value)} />
            </div>)}
          </fieldset>
        </TabsContent>
      </Tabs>
      <fieldset disabled={disabled} className="disabled:opacity-70">
        <div className="grid grid-cols-[0.75rem_minmax(0,1fr)_5.5rem] items-center gap-2">
          <label className="text-xs font-semibold" htmlFor="color-A-slider">A</label>
          <input id="color-A-slider" aria-label={t('color.channelSlider', { channel: 'A' })} type="range" min={0} max={scale} step={isFloat ? 0.001 : 1}
            disabled={isUi} className="color-value-slider" style={track('rgba', 3, 0, scale)} value={Number.isFinite(Number(fields[3])) ? Number(fields[3]) : 0}
            onChange={event => enterAlpha(event.target.value)} />
          <input id="color-A" aria-label={t('color.channelInput', { channel: 'A' })} type="text" inputMode={isFloat ? 'decimal' : 'numeric'} disabled={isUi} value={fields[3] ?? ''}
            className="min-w-0 w-full rounded border border-input bg-background px-1.5 py-1 text-right font-mono text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
            onChange={event => enterAlpha(event.target.value)} />
        </div>
      </fieldset>
          <section data-color-details className="space-y-2 border-t border-border pt-2">
            {!isFloat && <label className="flex items-center gap-2 text-xs" htmlFor="color-hex"><span>{t('color.hex')}</span>
              <input id="color-hex" type="text" aria-invalid={invalidHex} value={hexDraft ?? displayedHex} disabled={disabled}
                spellCheck={false} className="min-w-0 flex-1 rounded border border-input bg-background px-1.5 py-1 font-mono text-xs"
                onChange={event => enterHex(event.target.value)} /></label>}
            {!isUi && <>
              <div className="flex items-center justify-between gap-2 text-[11px]"><span>{t('color.interpretation')}</span><span>{t(interpretation === 'srgb' ? 'color.asSrgb' : 'color.asLinear')}</span></div>
              {isFloat && <div className="text-xs"><label htmlFor="color-exposure" className="mb-1 block">{t('color.exposure')}</label>
                <div className="flex items-center gap-2"><input id="color-exposure" className="color-value-slider min-w-0 flex-1" style={track('exposure', 0, -12, 12)} type="range" min={-12} max={12} step={0.1} value={exposure} onChange={event => setExposure(Number(event.target.value))} />
                  <output className="w-7 shrink-0 text-right font-mono text-xs">{exposure.toFixed(1)}</output>
                  <button type="button" className="shrink-0 underline" onClick={() => setExposure(0)}>{t('color.reset')}</button></div></div>}
            </>}
          </section>
        </div>
      </div>
      {channels?.slice(0, 3).some(value => value < 0) && <p className="text-[11px] leading-snug text-muted-foreground">{t('color.nonnegativeSelection')}</p>}
      {shownError && <p role="alert" className="rounded border border-border bg-muted p-2 text-xs">{shownError}</p>}
      </div>
      <ColorSwatchPalette type={request.type} interpretation={interpretation} exposure={exposure} disabled={disabled}
        columnSwatches={request.columnSwatches}
        current={!pending && !draftInvalid && preview ? {
          data_type: isFloat ? 'ColorFloat' : 'Color32', value: isUi ? JSON.stringify(preview.channels) : preview.canonical,
        } : null}
        onSelect={swatch => void selectSwatch(swatch)} onEscape={() => { if (!busy) onCancel(); }} />
    </div>
    <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-3 py-2">
      <button type="button" disabled={busy} onClick={onCancel} className="rounded border border-input px-3 py-1.5 text-xs disabled:opacity-50">{readonly ? t('common.close') : t('common.cancel')}</button>
      {!readonly && <button type="submit" disabled={busy || selectingSwatch || pending || draftInvalid || !preview} className="color-picker-apply rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">{busy ? t('common.saving') : t('color.apply')}</button>}
    </footer>
  </form>;
}
