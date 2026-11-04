import { useSyncExternalStore } from 'react';
import { getSettingsSnapshot, subscribeSettings } from '@/app/settings';

export type ColorValueType = 'Color32' | 'ColorFloat';
export type ColorPickerType = ColorValueType | 'UiColor';
export type ColorInterpretation = 'srgb' | 'linear';
export type ColorChannels = [number, number, number, number];
export interface ColorPreview {
  canonical: string;
  channels: ColorChannels;
  preview_css: string;
  hex: string | null;
}

export function isColorType(type: string): type is ColorValueType {
  return type === 'Color32' || type === 'ColorFloat';
}

/** Presentation only. Invalid DTOs never become white or a replacement stored value. */
export function displayChannels(value: string): ColorChannels | null {
  try {
    const tuple: unknown = JSON.parse(value);
    return Array.isArray(tuple) && tuple.length === 4 && tuple.every(item => typeof item === 'number' && Number.isFinite(item))
      ? tuple as ColorChannels : null;
  } catch { return null; }
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const srgbToLinear = (value: number) => Math.abs(value) <= 0.04045 ? value / 12.92 : Math.sign(value) * ((Math.abs(value) + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (value: number) => value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;

/** Same SDR clip preview contract as Rust color_preview: white=1; EV never changes stored values.
 * This display-only arithmetic is not an input validator or color value canonicalizer. */
export function colorPreviewRgba(channels: ColorChannels, type: ColorPickerType, interpretation: ColorInterpretation, exposure = 0): ColorChannels {
  const scale = type === 'ColorFloat' ? 1 : 255;
  const rgb = channels.slice(0, 3).map(value => {
    const normalized = value / scale;
    const linear = interpretation === 'srgb' ? srgbToLinear(normalized) : normalized;
    return Math.round(linearToSrgb(clamp(Math.max(0, linear) * 2 ** exposure)) * 255);
  });
  return [...rgb, clamp(channels[3] / scale)] as ColorChannels;
}
export function colorPreviewCss(channels: ColorChannels, type: ColorPickerType, interpretation: ColorInterpretation, exposure = 0): string {
  const [r, g, b, a] = colorPreviewRgba(channels, type, interpretation, exposure);
  return `rgba(${r},${g},${b},${a})`;
}

export function colorPreviewLinear(channels: ColorChannels, type: ColorPickerType, interpretation: ColorInterpretation, exposure = 0): ColorChannels {
  const scale = type === 'ColorFloat' ? 1 : 255;
  return [0, 1, 2].map(index => {
    const channel = channels[index] / scale;
    return (interpretation === 'srgb' ? srgbToLinear(channel) : channel) * 2 ** exposure;
  }).concat(channels[3] / scale) as ColorChannels;
}

export function getColorInterpretation(type: ColorPickerType): ColorInterpretation {
  if (type === 'UiColor') return 'srgb';
  return getSettingsSnapshot().bundle.values[type === 'Color32' ? 'color32Display' : 'colorFloatDisplay'];
}
export function useColorInterpretation(type: ColorPickerType): ColorInterpretation {
  return useSyncExternalStore(subscribeSettings, () => getColorInterpretation(type), () => getColorInterpretation(type));
}

/** HSV controls address the normalized stored RGB coordinates, independent of display interpretation.
 * V may exceed 1 for float HDR values; numeric RGBA keeps negative channels accessible. */
export function rgbToHsv(channels: ColorChannels, type: ColorPickerType): [number, number, number] {
  const scale = type === 'ColorFloat' ? 1 : 255;
  const [r, g, b] = channels.map(value => value / scale);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const hue = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [((hue * 60) + 360) % 360, max > 0 ? delta / max : 0, max];
}
export function hsvToRgb(h: number, s: number, v: number, alpha: number, type: ColorPickerType): ColorChannels {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const parts = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const rgb = parts.map(channel => type === 'ColorFloat' ? channel + m : Math.round((channel + m) * 255));
  return [...rgb, alpha] as ColorChannels;
}
