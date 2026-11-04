import { refreshAppSettings } from '@/app/settings';
import { toAppError, message, localizedError } from '@/app/i18n';
import { invoke } from '@tauri-apps/api/core';
import type { PluginManager } from './PluginManager';
import type { InstalledPluginPackage, PackagePreview } from '@/app/types/pluginPackages';

const errorText = toAppError;

// Only the main PluginBridge calls these methods, on its serialized mutation queue.
// Rust owns validation, immutable content, consent, dependencies and persistence.
export class PluginPackageTransactions {
  private replacements = new Map<string, { digest: string; previous: InstalledPluginPackage }>();
  constructor(private manager: PluginManager) {}

  async list() { return invoke<InstalledPluginPackage[]>('list_installed_plugin_packages'); }
  private async current(id: string) { return (await this.list()).find(item => item.metadata.id === id); }
  private async restoreRuntime(previous: InstalledPluginPackage | undefined) {
    if (previous?.approved && previous.enabled) {

      // A refusal to stop can leave the old runtime active. loadPackage is then a
      // no-op, but Rust rollback deliberately reset enabled=false: restore it too.
      await invoke('set_plugin_package_enabled', { pluginId: previous.metadata.id, enabled: true, expectedDigest: previous.digest });
      await this.manager.reconcileSettings(true, previous.metadata.id);
    }
  }
  async install(args: { path: string; expectedDigest: string; conflictPolicy: string }) {
    const preview = await invoke<PackagePreview>('preview_plugin_package', { path: args.path });
    if (preview.digest !== args.expectedDigest) throw localizedError(message('plugin.transaction.zipChanged'));
    const id = preview.metadata.id;
    const previous = await this.current(id);
    if (this.manager.getPlugin(id) && !previous) throw localizedError(message('plugin.transaction.duplicateId'));
    // Install first preserves the previous enabled state in Rust's rollback history.
    // No candidate code is evaluated. The main queue prevents concurrent activation.
    const installed = await invoke<InstalledPluginPackage>('install_plugin_package', {
      path: args.path, expectedDigest: args.expectedDigest, conflictPolicy: args.conflictPolicy,
    });
    // A confirmed install is never replayed because a presentation refresh failed.
    await refreshAppSettings().catch(error => { console.warn('Installed plugin resources need refresh', error); });
    if (previous?.digest === installed.digest) return installed;
    try {
      if (this.manager.getPlugin(id)?.status === 'active') await this.manager.deactivatePlugin(id);
      this.manager.discardPackageDefinition(id);
    } catch (error) {
      try {
        if (!installed.rollbackDigest) throw localizedError(message('plugin.transaction.packageChanged'));
        await invoke('rollback_plugin_package', { pluginId: id, expectedDigest: installed.digest, expectedRestoreDigest: installed.rollbackDigest });
        await this.restoreRuntime(previous);
      } catch (restoreError) {
        throw localizedError(message('plugin.transaction.restoreFailed', { error: errorText(error), restoreError: errorText(restoreError) }));
      }
      throw localizedError(message('plugin.transaction.updateReverted', { error: errorText(error) }));
    }
    if (previous) this.replacements.set(id, { digest: installed.digest, previous });
    await this.manager.reconcileSettings();
    return installed;
  }
  async activate(id: string, digest?: string, allowFullAppAccess = false) {
    let current = await this.current(id);
    if (!current) throw localizedError(message('plugin.transaction.notInstalled'));
    if (digest && digest !== current.digest) throw localizedError(message('plugin.transaction.packageChanged'));
    if (!current.approved) {
      if (!allowFullAppAccess || !digest) throw localizedError(message('plugin.transaction.approvalRequired'));
      current = await invoke<InstalledPluginPackage>('approve_plugin_package', { pluginId: id, digest, allowFullAppAccess: true });
    }
    let armed = false;
    try {
      await invoke('set_plugin_package_enabled', { pluginId: id, expectedDigest: current.digest, enabled: true });
      armed = true;
      await this.manager.reconcileSettings(true, id);
      this.replacements.delete(id);
    } catch (error) {
      if (!armed) throw error;
      // A changed package never leaves a failed candidate enabled for the next launch.
      const replacement = this.replacements.get(id);
      try {
        if (this.manager.getPlugin(id)?.status === 'active') await this.manager.deactivatePlugin(id);
        this.manager.discardPackageDefinition(id);
        await invoke('set_plugin_package_enabled', { pluginId: id, expectedDigest: current.digest, enabled: false });
        if (current.canRollback) {
          if (!current.rollbackDigest) throw localizedError(message('plugin.transaction.packageChanged'));
          await invoke('rollback_plugin_package', { pluginId: id, expectedDigest: current.digest, expectedRestoreDigest: current.rollbackDigest });
          if (replacement?.digest === current.digest) await this.restoreRuntime(replacement.previous);
          this.replacements.delete(id);
        }
      } catch (restoreError) {
        throw localizedError(message('plugin.transaction.disableRestoreFailed', { error: errorText(error), restoreError: errorText(restoreError) }));
      }
      throw localizedError(message(current.canRollback ? 'plugin.transaction.activationReverted' : 'plugin.transaction.activationDisabled', { error: errorText(error) }));
    }
  }
  async deactivate(id: string) {
    const current = await this.current(id);
    if (!current) throw localizedError(message('plugin.transaction.notInstalled'));
    // This is an explicit package-permission operation, not a preference toggle.
    await invoke('set_plugin_package_enabled', { pluginId: id, expectedDigest: current.digest, enabled: false });
    await this.manager.reconcileSettings();
  }
  async remove(id: string, expectedDigest: string) {
    const previous = await this.current(id);
    if (!previous) throw localizedError(message('plugin.transaction.missing'));
    if (previous.digest !== expectedDigest) throw localizedError(message('plugin.transaction.packageChanged'));
    // Runtime dependency checks and uninstall hooks complete before changing disk state.
    if (this.manager.getPlugin(id)) await this.manager.uninstallPlugin(id);
    try { await invoke('remove_plugin_package', { pluginId: id, expectedDigest }); }
    catch (error) {
      try { await this.restoreRuntime(previous); }
      catch (restoreError) { throw localizedError(message('plugin.transaction.resumeFailed', { error: errorText(error), restoreError: errorText(restoreError) })); }
      throw error;
    }
    this.replacements.delete(id);
    await this.manager.reconcileSettings();
  }
  async rollback(id: string, expectedDigest: string | null, expectedRestoreDigest: string) {
    const previous = await this.current(id);
    if ((previous?.digest ?? null) !== expectedDigest || !expectedRestoreDigest) throw localizedError(message('plugin.transaction.packageChanged'));
    const restoreDigest = previous ? previous.rollbackDigest
      : (await invoke<InstalledPluginPackage[]>('list_removed_plugin_packages')).find(item => item.metadata.id === id)?.digest;
    if (restoreDigest !== expectedRestoreDigest) throw localizedError(message('plugin.transaction.packageChanged'));
    if (this.manager.getPlugin(id)?.status === 'active') await this.manager.deactivatePlugin(id);
    let restored: InstalledPluginPackage;
    try { restored = await invoke<InstalledPluginPackage>('rollback_plugin_package', { pluginId: id, expectedDigest, expectedRestoreDigest }); }
    catch (error) {
      try { await this.restoreRuntime(previous); }
      catch (restoreError) { throw localizedError(message('plugin.transaction.resumeFailed', { error: errorText(error), restoreError: errorText(restoreError) })); }
      throw error;
    }
    this.manager.discardPackageDefinition(id);
    this.replacements.delete(id);
    // Restoring a package is never implicit permission to execute it.
    await this.manager.reconcileSettings();
    return restored;
  }
}
