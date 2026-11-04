import { getSettingsSnapshot, useAppSettings } from '@/app/settings';
import { isSettingsEditor } from '@/app/applicationMode';
import { t, getLocaleName, localizeError, translatePluginMessage, type MessageKey } from '@/app/i18n';

// Presentation only: saved schema names and user overrides are never rewritten.
// Both stable identity and the bundled original must match before translating.
const labels: Readonly<Record<string, readonly [string, MessageKey]>> = {
  "0de0da47-cf7c-5dce-b945-b6583fec0148": ["プラグイン有効・無効", "settings.labels.PluginStates.title"],
  "5041794f-89ab-5c1e-a048-55eaaf168f56": ["プラグインID", "settings.labels.PluginStates.pluginId"],
  "7a7e1d99-c56e-5e38-a219-4aa723f9f368": ["有効", "settings.labels.PluginStates.enabled"],
  "b7b25d20-7d0c-56e9-a47e-142a84f59d9c": ["個人スウォッチ Color32", "settings.labels.UserColor32Swatches.title"],
  "56816789-f367-5c53-ad81-cd6166fddc6f": ["名前", "settings.labels.UserColor32Swatches.name"],
  "b34fb640-aa1b-5242-ba4a-eff998a7464c": ["値", "settings.labels.UserColor32Swatches.value"],
  "4b41dadc-f27b-53af-b268-ab726835145f": ["表示順", "settings.labels.UserColor32Swatches.order"],
  "f5d2cb66-255e-5290-b774-4c423e921938": ["個人スウォッチ ColorFloat", "settings.labels.UserColorFloatSwatches.title"],
  "7982c2a1-393b-5dcc-9c5e-863970116c1b": ["名前", "settings.labels.UserColorFloatSwatches.name"],
  "b4c9627d-d239-5ffd-a1f2-daa4d604a843": ["値", "settings.labels.UserColorFloatSwatches.value"],
  "03f4299e-79db-5556-9a81-f8fc62c75711": ["表示順", "settings.labels.UserColorFloatSwatches.order"],
  "6a6882ac-5a9a-51fc-b1d3-3ba3169b3a6e": ["アプリ設定", "settings.labels.UserSettings.title"],
  "0b0c717a-e3e5-5c57-b2a8-6460d753b954": ["表示言語", "settings.labels.UserSettings.locale"],
  "af3c91ac-5b4d-5d65-89d3-41102912eb8b": ["テーマ", "settings.labels.UserSettings.theme"],
  "e663c97a-889b-5bbb-91d8-c08515e2c921": ["起動時に更新を確認", "settings.labels.UserSettings.automaticUpdateChecks"],
  "b3572d14-bf5c-523f-b559-6306092b875a": ["Color32 表示", "settings.labels.UserSettings.color32Display"],
  "3b75d243-5adc-5582-ac98-364ec79df602": ["ColorFloat 表示", "settings.labels.UserSettings.colorFloatDisplay"],
  "96f3a457-f644-545c-af7e-6d820510b800": ["プラグインテーマ ID", "settings.labels.UserSettings.pluginTheme"],
  "ba576d0d-140d-5227-9ede-6752eb40cce2": ["プラグインカタログURL", "settings.labels.UserSettings.pluginCatalogUrl"],
};

export function settingsDisplayLabel(uuid: string, storedName: string): string {
  if (!isSettingsEditor()) return storedName;
  const plugin = getSettingsSnapshot().bundle.pluginLabels?.[uuid];
  if (plugin && storedName === plugin.source) return translatePluginMessage(plugin.owner, plugin.key, undefined, storedName);
  const entry = labels[uuid];
  return entry && storedName === entry[0] ? t(entry[1]) : storedName;
}

// Tooltips are presentation metadata; custom text must remain verbatim.
const tooltips: Readonly<Record<string, readonly [string, MessageKey]>> = {
  '96f3a457-f644-545c-af7e-6d820510b800': ['空欄は組み込みテーマを使用', 'settings.labels.UserSettings.pluginThemeTooltip'],
  'ba576d0d-140d-5227-9ede-6752eb40cce2': ['空欄は未設定。認証情報やfragmentを含まないHTTPS URL。', 'settings.labels.UserSettings.pluginCatalogUrlTooltip'],
};
export function settingsTooltip(uuid: string, storedTooltip: string): string {
  if (!isSettingsEditor()) return storedTooltip;
  const entry = tooltips[uuid];
  return entry && storedTooltip === entry[0] ? t(entry[1]) : storedTooltip;
}

/** Display only: candidate identity, stored labels and sorting stay unchanged. */
export function settingsSelectOptionLabel(uuid: string, value: string, storedLabel: string): string {
  if (!isSettingsEditor()) return storedLabel;
  const userOptions: Readonly<Record<string, Readonly<Record<string, MessageKey>>>> = {
    'af3c91ac-5b4d-5d65-89d3-41102912eb8b': { system: 'appOptions.system' },
    'b3572d14-bf5c-523f-b559-6306092b875a': { srgb: 'appOptions.srgb', linear: 'appOptions.linear' },
    '3b75d243-5adc-5582-ac98-364ec79df602': { srgb: 'appOptions.srgb', linear: 'appOptions.linear' },
  };
  if (storedLabel === value) {
    if (uuid === 'af3c91ac-5b4d-5d65-89d3-41102912eb8b' && value !== 'system') {
      const theme = getSettingsSnapshot().bundle.themes.find(entry => entry.key === value);
      if (theme) return localizeError({ kind: 'code', code: theme.labelKey, params: {} });
    }
    if (uuid === '0b0c717a-e3e5-5c57-b2a8-6460d753b954') return value === 'system' ? t('appOptions.system') : getLocaleName(value);
    const key = userOptions[uuid]?.[value];
    if (key) return t(key);
  }
  const plugin = getSettingsSnapshot().bundle.pluginLabels?.[`${uuid}\0${value}`];
  return plugin && storedLabel === plugin.source ? translatePluginMessage(plugin.owner, plugin.key, undefined, storedLabel) : storedLabel;
}


type Choice = { value: string; label: string };
/** Mode is stored once; available IDs come from validated theme/locale records. */
export function settingsSelectOptions(uuid: string, stored: readonly Choice[], bundle = getSettingsSnapshot().bundle): readonly Choice[] {
  if (!isSettingsEditor()) return stored;
  let values: string[];
  if (uuid === 'af3c91ac-5b4d-5d65-89d3-41102912eb8b') values = bundle.themes.map(theme => theme.key);
  else if (uuid === '0b0c717a-e3e5-5c57-b2a8-6460d753b954') values = Object.keys(bundle.localization.locales).filter(locale => locale !== 'en-XA');
  else return stored;
  return ['system', ...values].map(value => ({ value, label: value }));
}
export function useSettingsSelectOptions(uuid: string, stored: readonly Choice[]): readonly Choice[] {
  const { bundle } = useAppSettings();
  return settingsSelectOptions(uuid, stored, bundle);
}
