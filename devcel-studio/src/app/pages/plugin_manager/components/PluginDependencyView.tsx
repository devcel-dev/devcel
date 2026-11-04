import { t, useI18n, localizeError } from '@/app/i18n';
import { usePlugins } from '@/app/contexts/PluginContext';
import { PluginDependencyResolver } from '@/app/services/PluginDependencyResolver';
export function PluginDependencyView() {
  useI18n();
  const { plugins } = usePlugins();
  const resolver = new PluginDependencyResolver();
  for (const entry of plugins.values()) resolver.addPlugin(entry.plugin);
  const result = resolver.resolveDependencies();
  return <div className="p-6 h-full overflow-auto space-y-4">
    <h2 className="text-lg font-semibold">{t('plugin.manager.dependencies')}</h2>
    {result.errors.map((error, index) => <p key={index} role="alert" className="text-red-600">{localizeError(error)}</p>)}
    {result.success && <p>{t('plugin.dependencies.noConflicts')}</p>}
    {[...plugins].map(([id, entry]) => <section key={id} className="border rounded p-4 space-y-2">
      <h3 className="font-medium">{entry.plugin.metadata.name} {entry.plugin.metadata.version}</h3>
      {Object.entries(entry.plugin.metadata.dependencies || {}).map(([dependency, range]) => <p key={dependency}>{t('plugin.dependencies.installed', { dependency, range, version: plugins.get(dependency)?.plugin.metadata.version || t('plugin.none') })}</p>)}
      {!Object.keys(entry.plugin.metadata.dependencies || {}).length && <p>{t('plugin.dependencies.none')}</p>}
      <p className="text-sm">{t('plugin.dependencies.dependents', { plugins: resolver.analyzeRemovalImpact(id).affectedPlugins.join(', ') || t('plugin.none') })}</p>
    </section>)}
  </div>;
}
