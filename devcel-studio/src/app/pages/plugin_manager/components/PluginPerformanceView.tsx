import { t, useI18n, formatNumber, formatDateTime, localizeError } from '@/app/i18n';
import { useEffect, useState } from 'react';
import { PluginBridge } from '@/app/services/PluginBridge';
import { AggregatedMetrics } from '@/app/services/PluginPerformanceMonitor';
import { usePlugins } from '@/app/contexts/PluginContext';
export function PluginPerformanceView() {
  useI18n();
  const { plugins } = usePlugins();
  const [metrics, setMetrics] = useState<AggregatedMetrics[]>([]);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true, busy = false;
    const refresh = async () => {
      if (busy) return; busy = true;
      try { const result = await PluginBridge.request('diagnostics'); if (alive) { setMetrics(result.metrics); setError(null); } }
      catch (e) { if (alive) setError(e); } finally { busy = false; }
    };
    void refresh(); const timer = setInterval(refresh, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return <div className="p-6 h-full overflow-auto space-y-4">
    <h2 className="text-lg font-semibold">{t('plugin.performance.title')}</h2>
    <p className="text-sm text-muted-foreground">{t('plugin.performance.description')}</p>
    {error !== null && <p role="alert" className="text-red-600">{localizeError(error)}</p>}
    {!metrics.length && <p>{t('plugin.performance.empty')}</p>}
    {metrics.map(metric => <section key={metric.pluginId} className="border rounded p-4 space-y-2">
      <h3 className="font-medium">{plugins.get(metric.pluginId)?.plugin.metadata.name || metric.pluginId}</h3>
      <p>{t('plugin.performance.calls', { calls: metric.totalCalls, average: formatNumber(metric.avgDuration, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), minimum: formatNumber(metric.minDuration, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), maximum: formatNumber(metric.maxDuration, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}</p>
      <p>{t('plugin.performance.success', { rate: formatNumber(metric.successRate, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), count: metric.errorCount })}</p>
      {metric.lastError && <p className="text-red-600">{localizeError(metric.lastError)}</p>}
      <p className="text-xs text-muted-foreground">{t('plugin.performance.updated', { date: formatDateTime(metric.lastUpdated, { dateStyle: 'medium', timeStyle: 'medium' }) })}</p>
    </section>)}
  </div>;
}
