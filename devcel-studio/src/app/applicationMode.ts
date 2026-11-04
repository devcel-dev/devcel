import { localizedError, message } from '@/app/i18n';
import { invoke, isTauri } from '@tauri-apps/api/core';

export type ApplicationMode = 'standard' | 'settings-editor';
let mode: ApplicationMode = 'standard';
let initialization: Promise<ApplicationMode> | undefined;
/** Synchronous consumers run only after bootstrap has established native mode. */
export function getApplicationMode(): ApplicationMode { return mode; }
export function isSettingsEditor(): boolean { return mode === 'settings-editor'; }
export function initializeApplicationMode(): Promise<ApplicationMode> {
  return initialization ??= (async () => {
    const value = isTauri() ? await invoke<unknown>('get_application_mode') : 'standard';
    if (value !== 'standard' && value !== 'settings-editor') throw localizedError(message('error.invalidApplicationMode'));
    mode = value;
    return mode;
  })();
}

const settingsEditorRoutes = new Set(['/', '/bulk_row_dialog', '/table_rule_dialog']);
export function isApplicationRouteAllowed(pathname: string): boolean {
  return !isSettingsEditor() || settingsEditorRoutes.has(pathname);
}
