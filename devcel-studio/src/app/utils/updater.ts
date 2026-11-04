import { getSettingsSnapshot } from '@/app/settings';
import { t, message, localizedError } from '@/app/i18n';
import { invoke, Resource } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { UpdaterConfiguration, UpdaterTransport } from '@/app/services/AppUpdaterController';

export function getAutomaticUpdateCheck(): boolean {
  return getSettingsSnapshot().bundle.values.automaticUpdateChecks;
}
export function getUpdaterConfiguration(): Promise<UpdaterConfiguration> {
  return invoke<UpdaterConfiguration>('get_updater_configuration');
}

/** Reject an insecure or unsigned candidate before even starting its download. */
export function validateUpdateManifest(raw: Record<string, unknown>, platform: string): void {
  const platforms = raw.platforms;
  // Recent Tauri versions prefer os-arch-bundle_type, then fall back to os-arch.
  // Validate every possible matching candidate so a preferred bundle cannot bypass HTTPS.
  const candidates = platforms && typeof platforms === 'object' && !Array.isArray(platforms)
    ? Object.entries(platforms as Record<string, unknown>)
      .filter(([key]) => key === platform || key.startsWith(`${platform}-`)).map(([, item]) => item)
    : [raw];
  if (!candidates.length) throw localizedError(message('updater.manifest.noPlatform', { platform }));
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') throw localizedError(message('updater.manifest.invalid'));
    const { url, signature } = candidate as Record<string, unknown>;
    if (typeof url !== 'string') throw localizedError(message('updater.manifest.missingUrl'));
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
      throw localizedError(message('updater.manifest.secureUrl'));
    }
    if (typeof signature !== 'string' || !signature.trim()) throw localizedError(message('updater.manifest.missingSignature'));
  }
}

async function withSettingsUpdateLease<T>(action: () => Promise<T>): Promise<T> {
  const lease = new Resource(await invoke<number>('acquire_settings_update_lease'));
  try { return await action(); } finally { await lease.close(); }
}

export const nativeUpdaterTransport: UpdaterTransport = {
  configuration: getUpdaterConfiguration,
  async check(configuration) {
    // Defence in depth: never call the plugin for an unconfigured build.
    if (!configuration.supported || configuration.configurationStatus !== 'ready') throw localizedError(message('updater.manifest.disabled'));
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({ timeout: 15_000 });
    if (!update) return null;
    try {
      validateUpdateManifest(update.rawJson, configuration.platform);
    } catch (error) {
      await update.close().catch(() => {});
      throw error;
    }
    return {
      version: update.version, currentVersion: update.currentVersion, body: update.body, date: update.date,
      download: onEvent => update.download(onEvent, { timeout: 120_000 }),
      install: () => withSettingsUpdateLease(() => update.install()),
      async close() {
        try { await update.close(); }
        catch {
          // A failed native install may already have consumed the downloaded-bytes resource.
          // Its failed close must not prevent releasing the checked Update handle itself.
          await Resource.prototype.close.call(update).catch(() => {});
        }
      },
    };
  },
  async restart() {
    await withSettingsUpdateLease(async () => {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    });
  },
};

let opening: Promise<void> | undefined;
export function showAppUpdater(checkOnOpen = false): Promise<void> {
  return opening ||= openUpdater(checkOnOpen).finally(() => { opening = undefined; });
}
async function openUpdater(checkOnOpen: boolean): Promise<void> {
  const existing = await WebviewWindow.getByLabel('app-updater');
  if (existing) {
    await existing.show();
    await existing.unminimize();
    await existing.setFocus();
    return;
  }
  const window = new WebviewWindow('app-updater', {
    title: t('updater.title'), url: `app_updater${checkOnOpen ? '?check=1' : ''}`,
    width: 720, height: 740, minWidth: 520, minHeight: 500,
    resizable: true, center: true, decorations: true,
  });
  await new Promise<void>((resolve, reject) => {
    void window.once('tauri://created', () => resolve());
    void window.once('tauri://error', event => reject(new Error(String(event.payload))));
  });
}
let startupChecked = false;
export async function checkForUpdatesOnStartup(): Promise<void> {
  // The preference is off by default. Do not even invoke a configuration check then.
  if (startupChecked || !getAutomaticUpdateCheck()) return;
  startupChecked = true;
  const configuration = await getUpdaterConfiguration();
  if (configuration.configurationStatus === 'ready' && configuration.supported) await showAppUpdater(true);
}
