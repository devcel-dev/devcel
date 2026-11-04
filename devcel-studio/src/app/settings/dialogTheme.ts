import { THEME_COLOR_TOKENS } from '@/app/config/brand';
import { getSettingsSnapshot } from './index';

interface DialogTheme { dark: boolean; id: string; revision: string; variables: Record<string, string> }
/** Carry presentation only, never project data, to a newly created native dialog. */
export function captureDialogTheme(): string {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  return JSON.stringify({ dark: root.classList.contains('dark'), id: root.dataset.devcelTheme ?? '',
    revision: getSettingsSnapshot().revision,
    variables: Object.fromEntries(THEME_COLOR_TOKENS.map(key => [`--${key}`, styles.getPropertyValue(`--${key}`).trim()])) });
}
export function readDialogTheme(search = window.location.search): DialogTheme | null {
  const encoded = new URLSearchParams(search).get('dialogTheme');
  if (!encoded || encoded.length > 8192) return null;
  try {
    const value = JSON.parse(encoded) as Partial<DialogTheme>;
    if (typeof value.dark !== 'boolean' || typeof value.id !== 'string' || typeof value.revision !== 'string'
      || !value.variables || typeof value.variables !== 'object' || Array.isArray(value.variables)) return null;
    const allowed = new Set(THEME_COLOR_TOKENS.map(key => `--${key}`));
    if (Object.keys(value.variables).length !== allowed.size
      || Object.entries(value.variables).some(([key, token]) => !allowed.has(key) || typeof token !== 'string'
        || token.length > 120 || !/^[\d.%\s,+/()-]+$/.test(token))) return null;
    return value as DialogTheme;
  } catch { return null; }
}
