import { version as hostVersion } from '../../../src-tauri/tauri.conf.json';
import { message, localizedError } from '@/app/i18n';
import * as semver from 'semver';

/** Validate the current plugin contract and declared host/dependency ranges. */
export class PluginVersionManager {
  private static instance: PluginVersionManager;
  private constructor() {}

  public static getInstance(): PluginVersionManager {
    if (!PluginVersionManager.instance) PluginVersionManager.instance = new PluginVersionManager();
    return PluginVersionManager.instance;
  }

  public validateMetadata(metadata: { version: string; devcelVersion?: string; apiVersion?: string; dependencies?: Record<string, string> }): void {
    if (!semver.valid(metadata.version)) throw localizedError(message('plugin.version.invalid', { version: metadata.version }));
    if (metadata.apiVersion !== '2.0.0') throw localizedError(message('plugin.version.unsupportedApi', { version: metadata.apiVersion ?? '(missing)' }));
    if (metadata.devcelVersion && (!semver.validRange(metadata.devcelVersion) || !semver.satisfies(hostVersion, metadata.devcelVersion))) {
      throw localizedError(message('plugin.version.devcelRequired', { required: metadata.devcelVersion, installed: hostVersion }));
    }
    for (const [id, range] of Object.entries(metadata.dependencies || {})) {
      if (!/^[a-z0-9._-]+$/.test(id) || !semver.validRange(range)) throw localizedError(message('plugin.version.invalidDependency', { id, range }));
    }
  }

}
