import { colorPreviewRgba, type ColorChannels, type ColorInterpretation, type ColorValueType } from './colorDisplay';

/** Display-only HEX. Float uses the shared SDR preview transform; stored/copy/export RGBA stays exact. */
export function colorCellText(channels: ColorChannels, type: ColorValueType, interpretation: ColorInterpretation): string {
  const shown = type === 'ColorFloat' ? colorPreviewRgba(channels, type, interpretation) : channels;
  return `#${shown.slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
