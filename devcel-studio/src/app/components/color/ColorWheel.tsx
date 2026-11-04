import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '@/app/i18n';
import { colorPreviewRgba, hsvToRgb, type ColorInterpretation, type ColorPickerType } from './colorDisplay';

export type ColorHsv = [number, number, number];
const unit = (value: number) => Math.max(0, Math.min(1, value));
const hueWrap = (hue: number) => (hue % 360 + 360) % 360;
export function hueAtPoint(x: number, y: number, width: number, height: number): number {
  return hueWrap(Math.atan2(x - width / 2, height / 2 - y) * 180 / Math.PI);
}
export function svAtPoint(x: number, y: number, width: number, height: number, valueMax: number): [number, number] {
  return [unit(x / width), unit(1 - y / height) * valueMax];
}

/** A two-dimensional selection control only. No source channels change until an explicit gesture.
 * Latent H/S and HDR V range belong to the parent draft, independently of backend validation latency. */
export function ColorWheel({ hsv, valueMax, type, interpretation, exposure, disabled, onChange }: {
  hsv: ColorHsv; valueMax: number; type: ColorPickerType; interpretation: ColorInterpretation; exposure: number;
  disabled: boolean; onChange: (hsv: ColorHsv) => void;
}) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const hueControl = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!disabled && !focused.current) { focused.current = true; hueControl.current?.focus({ preventScroll: true }); }
  }, [disabled]);
  const latest = useRef({ hsv, valueMax, disabled, onChange }); latest.current = { hsv, valueMax, disabled, onChange };
  const drag = useRef<{ id: number; target: HTMLDivElement; kind: 'hue' | 'sv'; fallback: boolean } | null>(null);
  const stop = () => {
    const active = drag.current; drag.current = null;
    if (active) try { active.target.releasePointerCapture?.(active.id); } catch { /* Already released by the OS. */ }
  };
  const move = (event: Pick<PointerEvent, 'clientX' | 'clientY' | 'pointerId'>) => {
    const active = drag.current, current = latest.current;
    if (!active || active.id !== event.pointerId || current.disabled) return;
    const rect = active.target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    current.onChange(active.kind === 'hue'
      ? [hueAtPoint(x, y, rect.width, rect.height), current.hsv[1], current.hsv[2]]
      : [current.hsv[0], ...svAtPoint(x, y, rect.width, rect.height, current.valueMax)]);
  };
  useEffect(() => {
    const up = (event: PointerEvent) => { if (drag.current?.id === event.pointerId) { if (drag.current.fallback && event.type === 'pointerup') move(event); stop(); } };
    const fallbackMove = (event: PointerEvent) => { if (drag.current?.fallback) move(event); };
    const blur = () => stop();
    const visibility = () => { if (document.visibilityState === 'hidden') stop(); };
    window.addEventListener('pointermove', fallbackMove);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stop(); window.removeEventListener('pointermove', fallbackMove); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up); window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useEffect(() => { if (disabled) stop(); }, [disabled]);
  const start = (kind: 'hue' | 'sv', event: ReactPointerEvent<HTMLDivElement>) => {
    if (latest.current.disabled || event.button !== 0 || !event.isPrimary) return;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (kind === 'hue') {
      const radius = Math.hypot((event.clientX - rect.left) / rect.width - 0.5, (event.clientY - rect.top) / rect.height - 0.5);
      if (radius < 0.39 || radius > 0.52) return;
    }
    event.preventDefault(); event.stopPropagation(); stop(); target.focus();
    let fallback = false;
    try { target.setPointerCapture(event.pointerId); } catch { fallback = true; }
    drag.current = { id: event.pointerId, target, kind, fallback }; move(event);
  };
  const key = (kind: 'hue' | 'sv', event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (latest.current.disabled || event.nativeEvent.isComposing) return;
    const current = latest.current;
    const next = [...current.hsv] as ColorHsv;
    const large = event.shiftKey ? 10 : 1;
    if (kind === 'hue') {
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next[0] = hueWrap(next[0] + large);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next[0] = hueWrap(next[0] - large);
      else if (event.key === 'Home') next[0] = 0;
      else if (event.key === 'End') next[0] = 359;
      else return;
    } else {
      if (event.key === 'ArrowRight') next[1] = unit(next[1] + large / 100);
      else if (event.key === 'ArrowLeft') next[1] = unit(next[1] - large / 100);
      else if (event.key === 'ArrowUp') next[2] = unit(next[2] / current.valueMax + large / 100) * current.valueMax;
      else if (event.key === 'ArrowDown') next[2] = unit(next[2] / current.valueMax - large / 100) * current.valueMax;
      else if (event.key === 'Home') next[2] = 0;
      else if (event.key === 'End') next[2] = current.valueMax;
      else return;
    }
    event.preventDefault(); event.stopPropagation(); current.onChange(next);
  };
  const hue = hsv[0];
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const size = 96, pixels = context.createImageData(size, size);
    const alpha = type === 'ColorFloat' ? 1 : 255;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const rgba = colorPreviewRgba(hsvToRgb(hue, x / (size - 1), (1 - y / (size - 1)) * valueMax, alpha, type), type, interpretation, exposure);
      const at = (y * size + x) * 4;
      pixels.data[at] = rgba[0]; pixels.data[at + 1] = rgba[1]; pixels.data[at + 2] = rgba[2]; pixels.data[at + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  }, [hue, valueMax, type, interpretation, exposure]);
  const pointerHandlers = {
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current?.target === event.currentTarget) move(event); },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current?.id === event.pointerId) { move(event); stop(); } },
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current?.id === event.pointerId) stop(); },
    onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current?.id === event.pointerId) stop(); },
  };
  const angle = hsv[0] * Math.PI / 180;
  return <div className={disabled ? 'color-wheel opacity-60' : 'color-wheel'}>
    <div className="relative mx-auto aspect-square w-full max-w-[244px] select-none">
      <div ref={hueControl} data-color-wheel="hue" role="slider" aria-label={t('color.wheelHue')} aria-disabled={disabled}
        aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv[0])} tabIndex={disabled ? -1 : 0}
        className="absolute inset-0 rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        style={{ touchAction: 'none' }} onPointerDown={event => start('hue', event)} onKeyDown={event => key('hue', event)} {...pointerHandlers}>
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full" style={{ background: 'conic-gradient(#ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)', maskImage: 'radial-gradient(closest-side, transparent 78%, black 79%)', WebkitMaskImage: 'radial-gradient(closest-side, transparent 78%, black 79%)' }} />
        <span aria-hidden="true" className="color-wheel-handle pointer-events-none absolute" style={{ left: `${50 + Math.sin(angle) * 44.5}%`, top: `${50 - Math.cos(angle) * 44.5}%`, backgroundColor: `hsl(${hsv[0]} 100% 50%)` }} />
      </div>
      <div data-color-wheel="sv" role="slider" aria-label={t('color.wheelSv')} aria-disabled={disabled}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv[1] * 100)}
        aria-valuetext={t('color.wheelSvValue', { saturation: Math.round(hsv[1] * 100), value: Number(hsv[2].toPrecision(4)) })}
        tabIndex={disabled ? -1 : 0} className="absolute left-[22%] top-[22%] h-[56%] w-[56%] rounded-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        style={{ touchAction: 'none', background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv[0]} 100% 50%))` }}
        onPointerDown={event => start('sv', event)} onKeyDown={event => key('sv', event)} {...pointerHandlers}>
        <canvas ref={canvas} width={96} height={96} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full rounded-sm" />
        <span aria-hidden="true" className="color-wheel-handle pointer-events-none absolute" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - unit(hsv[2] / valueMax)) * 100}%` }} />
      </div>
    </div>
  </div>;
}
