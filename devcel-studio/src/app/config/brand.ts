import type { Theme, ThemeColorToken } from '@/app/types/pluginTypes';

// Neutral chrome lets the mint brand accent stand out. Keep in sync with Rust's project default.
export const DEFAULT_PROJECT_HEADER_COLOR = '#242A30';

/** Chosen once for a new project; reopening never replaces its saved color. */
export function randomProjectHeaderColor(random: () => number = Math.random): string {
  const palette = ['#63C6A3', '#7AB8E8', '#A895DB', '#E5AE76', '#D98FAC', '#9EBE72', '#69C5CE', '#D6BD68'];
  return palette[Math.min(palette.length - 1, Math.max(0, Math.floor(random() * palette.length)))];
}

export const THEME_COLOR_TOKENS = [
  'accent',
  'accent-foreground',
  'background',
  'border',
  'card',
  'card-foreground',
  'destructive',
  'destructive-foreground',
  'foreground',
  'input',
  'muted',
  'muted-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'primary-ink',
  'ring',
  'secondary',
  'secondary-foreground',
] as const satisfies readonly ThemeColorToken[];

/** Plugin themes define every semantic color explicitly. */
export function isCompleteTheme(theme: Theme): boolean {
  return theme !== null && typeof theme === 'object'
    && ['light', 'dark', 'auto'].includes(theme.type)
    && theme.colors !== null && typeof theme.colors === 'object'
    && THEME_COLOR_TOKENS.every(key => typeof theme.colors[key] === 'string' && theme.colors[key].trim().length > 0)
    && Object.keys(theme.colors).every(key => THEME_COLOR_TOKENS.includes(key as ThemeColorToken))
    && (theme.cssVariables === undefined || (theme.cssVariables !== null && typeof theme.cssVariables === 'object'
      && Object.entries(theme.cssVariables).every(([key, value]) => /^--[a-zA-Z][a-zA-Z0-9-]*$/.test(key)
        && !THEME_COLOR_TOKENS.includes(key.slice(2) as ThemeColorToken)
        && typeof value === 'string' && value.trim().length > 0)));
}

export function themeCssVariables(theme: Theme): Record<string, string> {
  return {
    ...Object.fromEntries(THEME_COLOR_TOKENS.map(key => [`--${key}`, theme.colors[key]])),
    ...theme.cssVariables,
  };
}
