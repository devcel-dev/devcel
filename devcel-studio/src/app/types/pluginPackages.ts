import type { AppError } from './tableRules';
import type { PluginMetadata } from './pluginTypes';

export interface InstalledPluginPackage {
  metadata: PluginMetadata;
  permissions: string[];
  digest: string;
  approved: boolean;
  /** Installation execution permission, independent of PluginStates.enabled and runtime status. */
  enabled: boolean;
  canRollback: boolean;
  rollbackDigest: string | null;
  /** Present only when this exact digest was copied from the named release. */
  migratedFromVersion?: string | null;
  /** A known committed resource installation needs attention, not a retry. */
  resourceWarning?: AppError | null;
}
export interface PackagePreview {
  metadata: PluginMetadata;
  permissions: string[];
  digest: string;
  compatible: boolean;
  /** Legacy native versions sent literal strings; current errors retain their descriptor. */
  compatibilityErrors: (AppError | string)[];
  dependencyIssues: (AppError | string)[];
  installedVersion: string | null;
  conflict: 'new' | 'same' | 'update' | 'downgrade' | 'same-version-different-content';
  entryCount: number;
  expandedBytes: number;
}
export interface PluginCatalogEntry {
  metadata: PluginMetadata;
  digest?: string;
  downloadUrl?: string;
}
export interface PluginCatalog { formatVersion: 1; plugins: PluginCatalogEntry[] }
