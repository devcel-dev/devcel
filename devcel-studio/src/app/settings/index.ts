import { inheritVersionedLayout } from './storageKey';
import { useSyncExternalStore } from 'react';
import { version as appVersion } from '../../../src-tauri/tauri.conf.json';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { applyRuntimeLocalization, applyPluginTranslationTables, toAppError, matchLocale, type AppError } from '@/app/i18n';
import { catalog, type AppSettings, type SettingKey } from './generated/catalog';
export { catalog };
export type { AppSettings, SettingKey };
export interface SettingsSnapshot {
  revision: string;
  generation: string;
  bundle: typeof catalog;
  warning: AppError[] | null;
  migrationFailed: boolean;
  appVersion: string;
  migratedFromVersion: string | null;
  source: 'project' | 'lastValid' | 'embedded';
  projectPath: string;
  resolvedLocale: string;
  availableLocales: string[];
}
const listeners = new Set<() => void>();
let snapshot: SettingsSnapshot = {
  revision: '', generation: '', bundle: catalog, warning: null, migrationFailed: false, appVersion, migratedFromVersion: null, source: 'embedded', projectPath: '',
  resolvedLocale: matchLocale(navigator.languages), availableLocales: Object.keys(catalog.localization.locales).filter(code => code !== 'en-XA'),
};
export function subscribeSettings(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getSettingsSnapshot() { return snapshot; }
export function useAppSettings() { return useSyncExternalStore(subscribeSettings, getSettingsSnapshot, getSettingsSnapshot); }
function apply(next: SettingsSnapshot) {
  // The native compiler validates the entire project; publish one immutable bundle.
  // Synchronous locale subscribers must observe the new settings, including plugin gates.
  snapshot = next;
  if (!next.migrationFailed && next.migratedFromVersion) {
    try { inheritVersionedLayout(localStorage, next.migratedFromVersion, next.appVersion); }
    catch (error) { console.warn('[settings] Layout migration deferred', error); }
  }
  let style = document.getElementById('devcel-settings-theme') as HTMLStyleElement | null;
  if (!style) { style = document.createElement('style'); style.id = 'devcel-settings-theme'; document.head.appendChild(style); }
  style.textContent = next.bundle.themeCss;
  applyPluginTranslationTables(next.bundle.pluginTranslations);
  applyRuntimeLocalization(next.bundle.localization, {
    preference: next.bundle.values.locale === 'system' ? null : next.bundle.values.locale,
    locale: next.resolvedLocale, revision: next.revision, availableLocales: next.availableLocales,
  });
  for (const listener of listeners) { try { listener(); } catch (error) { console.warn('[settings] Subscriber failed', error); } }
}
let readSequence = 0;
let latestRead: Promise<SettingsSnapshot> = Promise.resolve(snapshot);
/** Resolve only after the newest read has actually published to this window. */
export function refreshAppSettings(): Promise<SettingsSnapshot> {
  const sequence = ++readSequence;
  const read = (async (): Promise<SettingsSnapshot> => {
    if (!isTauri()) { apply(snapshot); return snapshot; }
    try {
      const next = await invoke<SettingsSnapshot>('get_app_settings');
      if (sequence !== readSequence) return latestRead;
      apply(next);
    } catch (error) {
      if (sequence !== readSequence) return latestRead;
      snapshot = { ...snapshot, warning: [toAppError(error)] };
      for (const listener of listeners) { try { listener(); } catch (failure) { console.warn('[settings] Subscriber failed', failure); } }
    }
    return snapshot;
  })();
  latestRead = read;
  return read;
}
let initialization: Promise<void> | undefined;
export function initializeAppSettings(): Promise<void> {
  return initialization ??= (async () => {
    if (isTauri()) {
      await listen('devcel-app-settings-changed', () => { void refreshAppSettings(); }).catch(console.warn);
      window.addEventListener('focus', () => { void refreshAppSettings(); });
    }
    await refreshAppSettings();
  })();
}
/** Reset is the only specialized settings mutation; all ordinary edits use Devcel tables. */
export async function resetSettingsProject(): Promise<void> {
  await invoke('reset_settings_project', { expectedGeneration: snapshot.generation });
  await refreshAppSettings();
}
