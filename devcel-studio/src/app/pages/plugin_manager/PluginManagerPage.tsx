import { showOptions } from '@/app/utils/options';
import { t, useI18n, formatNumber, localizeError } from '@/app/i18n';
import { useState } from 'react';
import { usePlugins } from '@/app/contexts/PluginContext';
import { PluginListView } from './components/PluginListView';
import { PluginDetailsView } from './components/PluginDetailsView';
import { showPluginPackages } from '@/app/utils/plugin_packages';
import { PluginPerformanceView } from './components/PluginPerformanceView';
import { PluginDependencyView } from './components/PluginDependencyView';
import { PluginCatalogView } from './components/PluginCatalogView';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Plus,
  Search,
  Settings,
  Activity,
  GitBranch,
  AlertCircle,
  CheckCircle,
  Clock,
  Download
} from 'lucide-react';

export function PluginManagerPage() {
  useI18n();
  const {
    plugins,
    activePlugins,
    isLoading,
    error,
    uninstallPlugin
  } = usePlugins();

  const [selectedPlugin, setSelectedPlugin] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [windowError, setWindowError] = useState<unknown>('');
  const [activeTab, setActiveTab] = useState('overview');

  // Plugin statistics
  const stats = {
    total: plugins.size,
    active: activePlugins.size,
    inactive: plugins.size - activePlugins.size,
    errors: Array.from(plugins.values()).filter(p => p.status === 'error').length
  };

  // Filtered plugin list
  const filteredPlugins = Array.from(plugins.entries())
    .filter(([id, entry]) => {
      // Filter by search query
      if (searchQuery) {
        const searchLower = searchQuery.toLowerCase();
        return (
          entry.plugin.metadata.name.toLowerCase().includes(searchLower) ||
          entry.plugin.metadata.description.toLowerCase().includes(searchLower) ||
          entry.plugin.metadata.author.toLowerCase().includes(searchLower) ||
          id.toLowerCase().includes(searchLower)
        );
      }
      return true;
    })
    .filter(([, entry]) => {
      // Filter by status
      switch (filterStatus) {
        case 'active':
          return entry.status === 'active';
        case 'inactive':
          return entry.status !== 'active';
        default:
          return true;
      }
    });

  const selectedPluginEntry = selectedPlugin ? plugins.get(selectedPlugin) : null;

  return (
    <div className="h-full flex flex-col bg-muted">
      {/* Header */}
      <div className="bg-background border-b border-border px-6 py-4">
        <div className="flex flex-wrap gap-2 items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              {t('plugin.manager.title')}
            </h1>
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={() => { setWindowError(''); void showPluginPackages().catch(e => setWindowError(e)); }}
              className="flex items-center gap-2"
            >
              <Plus size={16} />
              {t('plugin.manager.packages')}
            </Button>
          </div>
        </div>

        {/* Statistics */}
        <div className="mt-6 grid grid-cols-2 xl:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-2 items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t('plugin.manager.total')}</p>
                  <p className="text-2xl font-bold">{formatNumber(stats.total)}</p>
                </div>
                <Settings className="h-8 w-8 text-blue-500" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-2 items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t('plugin.status.active')}</p>
                  <p className="text-2xl font-bold text-green-600">{formatNumber(stats.active)}</p>
                </div>
                <CheckCircle className="h-8 w-8 text-green-500" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-2 items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t('plugin.status.inactive')}</p>
                  <p className="text-2xl font-bold text-muted-foreground">{formatNumber(stats.inactive)}</p>
                </div>
                <Clock className="h-8 w-8 text-muted-foreground" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap gap-2 items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t('plugin.manager.errors')}</p>
                  <p className="text-2xl font-bold text-red-600">{formatNumber(stats.errors)}</p>
                </div>
                <AlertCircle className="h-8 w-8 text-red-500" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
          <div className="bg-background border-b border-border px-6">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="overview" className="flex items-center gap-2">
                <Settings size={16} />
                {t('plugin.manager.overview')}
              </TabsTrigger>
              <TabsTrigger value="performance" className="flex items-center gap-2">
                <Activity size={16} />
                {t('plugin.manager.performance')}
              </TabsTrigger>
              <TabsTrigger value="dependencies" className="flex items-center gap-2">
                <GitBranch size={16} />
                {t('plugin.manager.dependencies')}
              </TabsTrigger>
              <TabsTrigger value="marketplace" className="flex items-center gap-2">
                <Download size={16} />
                {t('plugin.manager.catalog')}
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-hidden">
            <TabsContent value="overview" className="h-full m-0">
              <div className="h-full flex">
                {/* Plugin list */}
                <div className="w-1/2 border-r border-border flex flex-col">
                  {/* Search and filters */}
                  <div className="p-4 bg-background border-b border-border">
                    <div className="flex gap-3 mb-3">
                      <div className="flex-1 relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground" size={16} />
                        <Input
                          placeholder={t('plugin.manager.search')}
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="pl-10"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant={filterStatus === 'all' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setFilterStatus('all')}
                      >
                        {t('plugin.manager.allCount', { count: stats.total })}
                      </Button>
                      <Button
                        variant={filterStatus === 'active' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setFilterStatus('active')}
                      >
                        {t('plugin.manager.activeCount', { count: stats.active })}
                      </Button>
                      <Button
                        variant={filterStatus === 'inactive' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setFilterStatus('inactive')}
                      >
                        {t('plugin.manager.inactiveCount', { count: stats.inactive })}
                      </Button>
                    </div>
                  </div>

                  {/* Plugin list */}
                  <div className="flex-1 overflow-auto">
                    <PluginListView
                      plugins={filteredPlugins}
                      selectedPlugin={selectedPlugin}
                      onSelectPlugin={setSelectedPlugin}
                      onOpenSettings={showOptions}
                      onUninstallPlugin={uninstallPlugin}
                    />
                  </div>
                </div>

                {/* Plugin details */}
                <div className="w-1/2 flex flex-col">
                  {selectedPluginEntry ? (
                    <PluginDetailsView
                      plugin={selectedPluginEntry}
                      onOpenSettings={showOptions}
                      onUninstall={async () => {
                        await uninstallPlugin(selectedPlugin!);
                        setSelectedPlugin(null);
                      }}
                    />
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                      <div className="text-center">
                        <Settings size={48} className="mx-auto mb-4 opacity-50" />
                        <p>{t('plugin.manager.selectDetails')}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="performance" className="h-full m-0">
              <PluginPerformanceView />
            </TabsContent>

            <TabsContent value="dependencies" className="h-full m-0">
              <PluginDependencyView />
            </TabsContent>

            <TabsContent value="marketplace" className="h-full m-0">
              <PluginCatalogView />
            </TabsContent>
          </div>
        </Tabs>
      </div>

      {!!windowError && <p role="alert" className="p-3 text-red-600">{localizeError(windowError)}</p>}
      {/* Error display */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border-t border-red-200 dark:border-red-800 p-4">
          <div className="flex items-center gap-2 text-red-800 dark:text-red-200">
            <AlertCircle size={16} />
            <span className="font-medium">{t('plugin.errorLabel')}</span>
            <span>{localizeError(error)}</span>
          </div>
        </div>
      )}

      {/* Loading display */}
      {isLoading && (
        <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
          <div className="bg-background rounded-lg p-6 flex items-center gap-3">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
            <span>{t('plugin.manager.loading')}</span>
          </div>
        </div>
      )}

    </div>
  );
}
