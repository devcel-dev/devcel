import { useEffect, useLayoutEffect, useState } from 'react';
import { useThemes } from '@/app/contexts/PluginContext';
import { themeCssVariables } from '@/app/config/brand';
import { useAppSettings } from './index';
import { readDialogTheme } from './dialogTheme';

/** One theme owner shared by every route, including detached dialogs. */
export function AppTheme() {
  const settings = useAppSettings();
  const [inherited] = useState(readDialogTheme);
  const themes = useThemes();
  const pluginId = settings.bundle.values.pluginTheme;
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setSystemDark(media.matches);
    media.addEventListener('change', changed); changed();
    return () => media.removeEventListener('change', changed);
  }, []);
  const selectedTheme = themes.find(theme => theme.id === pluginId);
  // Detached windows may mount before their first settings read completes. Keep
  // the parent's presentation until then, but never freeze live built-in themes.
  // Once settings arrive, only a matching unresolved plugin may use the bridge.
  const inheritedTheme = inherited && (!settings.revision
    || (pluginId && !selectedTheme && inherited.id === pluginId && inherited.revision === settings.revision))
    ? inherited : null;
  useLayoutEffect(() => {
    const root = document.documentElement;
    const mode = selectedTheme?.type ?? settings.bundle.values.theme;
    const catalogKey = mode === 'auto' || mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
    const catalogTheme = settings.bundle.themes.find(theme => theme.key === catalogKey);
    const dark = inheritedTheme?.dark ?? (!selectedTheme && catalogTheme ? catalogTheme.isDark : (mode === 'dark' || ((mode === 'auto' || mode === 'system') && systemDark)));
    const vars = selectedTheme ? themeCssVariables(selectedTheme) : inheritedTheme?.variables ?? {};
    const previous = Object.fromEntries(Object.keys(vars).map(key => [key, root.style.getPropertyValue(key)]));
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
    root.dataset.devcelTheme = selectedTheme?.id ?? inheritedTheme?.id ?? catalogKey;
    for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
    return () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value) root.style.setProperty(key, value); else root.style.removeProperty(key);
      }
    };
  }, [selectedTheme, settings.bundle.values.theme, settings.bundle.themes, systemDark, inheritedTheme]);
  return null;
}
