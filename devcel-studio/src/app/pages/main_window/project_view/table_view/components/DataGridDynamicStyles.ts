// Small helpers for DataGrid column colors.
//
// Background decisions are centralized in DataGridView's getCellBackgroundColor
// callback. This module only detects unset colors and computes readable text colors.
//
// Note: The core always returns canonical data_type names, such as "String" and "Boolean",
// so the frontend does not need to handle aliases such as "Str" and "Bool".

// Determine whether a column background represents the default, unspecified color.
//
// The core ColumnStyle default is white (#FFFFFF), and the color picker treats white as "no color"
// (black #000000 is an actual selectable palette color, so it is not treated as unset here).
export const isDefaultColumnColor = (color?: string | null): boolean => {
  if (!color) return true;
  const c = color.trim().toLowerCase();
  return c === '' || c === 'transparent' || c === '#ffffff' || c === '#fff';
};

// Return a readable text color, black or white, for the specified background.
//
// Preserve the user's selected background without lightening or otherwise altering it,
// and choose the higher-contrast text color using relative luminance for readable text at any shade.
// Reference: WCAG relative luminance, using a simplified sRGB linearization.
export const getContrastingTextColor = (background: string): string => {
  const hex = background.replace('#', '');
  // Cannot evaluate colors other than 3 or 6 digits; default to black text
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return '#000000';

  const toLinear = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = toLinear(parseInt(full.substring(0, 2), 16));
  const g = toLinear(parseInt(full.substring(2, 4), 16));
  const b = toLinear(parseInt(full.substring(4, 6), 16));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

  // Black text on bright backgrounds, white text on dark backgrounds
  return luminance > 0.45 ? '#000000' : '#ffffff';
};
