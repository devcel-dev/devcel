import type { CSSProperties } from 'react';
import { colorPreviewRgba, hsvToRgb, type ColorChannels, type ColorInterpretation, type ColorPickerType } from './colorDisplay';

export type ColorTrack =
  | { kind: 'rgba'; channel: 0 | 1 | 2 | 3; min: number; max: number }
  | { kind: 'hsv'; channel: 0 | 1 | 2; min: number; max: number; hsv: readonly [number, number, number] }
  | { kind: 'exposure'; min: number; max: number };

const SAMPLE_INTERVALS = 64;
const MAX_EXTRA_STOPS = 192;
/** Display-only sampling of the color produced at each slider position. Sampling is
 * necessary because linear-light RGB and exposure are nonlinear on an sRGB screen.
 * Every other component, including straight alpha and HDR values, stays unchanged.
 * The checker makes alpha tracks and transparent colors visible without inventing
 * an opaque replacement value. No sample is used as a persisted input. */
export function colorTrackGradient(
  channels: ColorChannels,
  type: ColorPickerType,
  interpretation: ColorInterpretation,
  exposure: number,
  track: ColorTrack,
): string {
  if (!channels.every(Number.isFinite) || ![exposure, track.min, track.max].every(Number.isFinite)
    || track.min > track.max || (track.kind === 'hsv' && !track.hsv.every(Number.isFinite))) return 'none';
  type Sample = { fraction: number; color: ColorChannels };
  const sample = (fraction: number): Sample => {
    const position = track.min + (track.max - track.min) * fraction;
    let color = [...channels] as ColorChannels;
    let previewExposure = exposure;
    if (track.kind === 'rgba') {
      color[track.channel] = type === 'ColorFloat' ? position : Math.round(position);
    } else if (track.kind === 'hsv') {
      const hsv = [...track.hsv] as [number, number, number];
      hsv[track.channel] = position;
      color = hsvToRgb(hsv[0], hsv[1], hsv[2], channels[3], type);
    } else {
      previewExposure = position;
    }
    // Decorative project colors always use opaque SDR/sRGB, matching Rust preview_color.
    return { fraction, color: colorPreviewRgba(color, type, type === 'UiColor' ? 'srgb' : interpretation, type === 'UiColor' ? 0 : previewExposure) };
  };
  const samples = [sample(0)];
  let extraStops = 0;
  const subdivide = (left: Sample, right: Sample, depth: number) => {
    const middle = sample((left.fraction + right.fraction) / 2);
    // Densify only transfer-curve bends and clipping transitions. Uniform stops
    // alone visibly smear the near-black edge at large positive preview EV.
    const nonlinear = middle.color.some((value, channel) => Math.abs(value - (left.color[channel] + right.color[channel]) / 2) * (channel === 3 ? 255 : 1) > 1);
    if (nonlinear && depth < 10 && extraStops < MAX_EXTRA_STOPS) {
      extraStops++;
      subdivide(left, middle, depth + 1); subdivide(middle, right, depth + 1);
    } else samples.push(right);
  };
  for (let index = 1; index <= SAMPLE_INTERVALS; index++) subdivide(samples[samples.length - 1], sample(index / SAMPLE_INTERVALS), 0);
  const stops = samples.map(({ fraction, color }) => `rgba(${color.join(',')}) ${fraction * 100}%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** Native 16px thumbs travel between centers 8px inside each edge. Position each
 * sample within that travel rather than the full input width. CSS extends the
 * endpoint colors into the remaining edges without duplicating alpha layers.
 * Track pseudo-elements remain transparent; both browser thumbs use border-box. */
export function colorTrackStyle(gradient: string): CSSProperties {
  const aligned = gradient.replace(/(\d+(?:\.\d+)?)%/g, (position, percentage: string) => {
    const offset = 8 - Number(percentage) * 0.16;
    return offset === 0 ? position : `calc(${position} ${offset < 0 ? '-' : '+'} ${Math.abs(offset)}px)`;
  });
  return {
    backgroundColor: '#ffffff',
    backgroundImage: `${aligned}, conic-gradient(#cccccc 25%, transparent 0 50%, #cccccc 0 75%, transparent 0)`,
    backgroundSize: '100% 100%, 12px 12px',
    backgroundRepeat: 'no-repeat, repeat',
  };
}
