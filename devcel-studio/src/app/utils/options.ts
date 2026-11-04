import { invoke } from '@tauri-apps/api/core';
import { refreshAppSettings } from '@/app/settings';
let opening: Promise<void> | undefined;
/** A real Devcel editor process owns the fixed settings project and its own undo state. */
export function showOptions(): Promise<void> {
  return opening ??= invoke<void>('open_settings_editor').catch(async (error: unknown) => {
    if (error && typeof error === 'object' && 'kind' in error && error.kind === 'code' && 'code' in error && error.code === 'settings.migrationFailed') {
      // The existing localized nonmodal notice owns migration failures.
      // Explicit Reset remains available; opening Options never commits defaults.
      await refreshAppSettings();
      return;
    }
    throw error;
  }).finally(() => { opening = undefined; });
}
