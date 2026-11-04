import { appConfirm } from '@/app/services/appDialogs';
import { t, useI18n, formatNumber, formatDateTime, localizeError } from '@/app/i18n';
import { useEffect, useRef, useState } from 'react';
import { PluginRegistryEntry } from '@/app/types/pluginTypes';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Pause, 
  Trash2, 
  ExternalLink, 
 
  User, 
  Package, 
  Settings,
  Activity,
  GitBranch,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  Copy,
  Code
} from 'lucide-react';

interface PluginDetailsViewProps {
  plugin: PluginRegistryEntry;
  onOpenSettings: () => Promise<void>;
  onUninstall: () => Promise<void>;
}

export function PluginDetailsView({
  plugin,
  onOpenSettings,
  onUninstall
}: PluginDetailsViewProps) {
  useI18n();
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('info');
  const pendingConfirmation = useRef(false);
  const currentPlugin = useRef<string | null>(plugin.plugin.metadata.id);
  currentPlugin.current = plugin.plugin.metadata.id;
  useEffect(() => { currentPlugin.current = plugin.plugin.metadata.id; return () => { currentPlugin.current = null; }; }, [plugin.plugin.metadata.id]);

  const handleAction = async (action: () => Promise<void>) => {
    setIsLoading(true);
    try {
      await action();
    } catch (error) {
      console.error('Action failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusIcon = (status: PluginRegistryEntry['status']) => {
    switch (status) {
      case 'active':
        return <CheckCircle className="text-green-500" size={20} />;
      case 'inactive':
        return <Pause className="text-muted-foreground" size={20} />;
      case 'error':
        return <XCircle className="text-red-500" size={20} />;
      case 'loading':
        return <Clock className="text-blue-500" size={20} />;
      default:
        return <AlertCircle className="text-yellow-500" size={20} />;
    }
  };

  const formatTimestamp = (timestamp?: number) => {
    if (!timestamp) return t('plugin.unknown');
    return formatDateTime(timestamp, { dateStyle: 'medium', timeStyle: 'medium' });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const extensionCounts = {
    menus: Object.keys(plugin.plugin.extensions?.menus || {}).length,
    toolbarButtons: plugin.plugin.extensions?.toolbarButtons?.length || 0,
    contextMenus: Object.keys(plugin.plugin.extensions?.contextMenus || {}).length,
    sidePanels: plugin.plugin.extensions?.sidePanels?.length || 0,
    exporters: plugin.plugin.extensions?.exporters?.length || 0,
    importers: plugin.plugin.extensions?.importers?.length || 0,
    themes: plugin.plugin.extensions?.themes?.length || 0
  };

  const totalExtensions = Object.values(extensionCounts).reduce((sum, count) => sum + count, 0);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="p-6 border-b border-border">
        <div className="flex flex-wrap gap-3 items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            {getStatusIcon(plugin.status)}
            <div>
              <h2 className="text-xl font-bold text-foreground">
                {plugin.plugin.metadata.name}
              </h2>
              <p className="text-sm text-muted-foreground">
                {plugin.plugin.metadata.id}
              </p>
            </div>
          </div>
          
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              v{plugin.plugin.metadata.version}
            </Badge>
            
            <Button onClick={() => void handleAction(onOpenSettings)} disabled={isLoading} variant="outline" size="sm">
              <Settings size={14} />{t('plugin.settings.openProject')}
            </Button>

            <Button
              onClick={async () => {
                if (pendingConfirmation.current) return;
                pendingConfirmation.current = true;
                const id = plugin.plugin.metadata.id;
                try {
                  if (await appConfirm(t('plugin.uninstallConfirm', { name: plugin.plugin.metadata.name }),
                    { destructive: true, confirmLabel: t('plugin.uninstall') }) && currentPlugin.current === id) {
                    await handleAction(onUninstall);
                  }
                } finally { pendingConfirmation.current = false; }
              }}
              disabled={isLoading}
              variant="destructive"
              size="sm"
              className="flex flex-wrap items-center gap-2"
            >
              <Trash2 size={14} />
              {t('plugin.uninstall')}
            </Button>
          </div>
        </div>

        <p className="text-muted-foreground">
          {plugin.plugin.metadata.description}
        </p>

        {/* Error display */}
        {plugin.status === 'error' && plugin.error && (
          <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded">
            <div className="flex flex-wrap items-center gap-2 text-red-800 dark:text-red-200 font-medium">
              <AlertCircle size={16} />
              {t('plugin.details.error')}
            </div>
            <p className="text-red-700 dark:text-red-300 mt-1 text-sm">
              {localizeError(plugin.error)}
            </p>
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
          <div className="px-6 pt-4">
            <TabsList className="grid w-full grid-cols-2 xl:grid-cols-4 h-auto">
              <TabsTrigger value="info">{t('plugin.details.info')}</TabsTrigger>
              <TabsTrigger value="extensions">{t('plugin.details.extensions')}</TabsTrigger>
              <TabsTrigger value="advanced">{t('plugin.details.advanced')}</TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-auto p-6">
            <TabsContent value="info" className="mt-0">
              <div className="space-y-6">
                {/* Basic information */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center gap-2">
                      <Package size={18} />
                      {t('plugin.details.basic')}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium text-foreground">
                          {t('plugin.details.id')}
                        </label>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          <code className="flex-1 px-2 py-1 bg-muted rounded text-sm">
                            {plugin.plugin.metadata.id}
                          </code>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('plugin.details.copyId')}
                            onClick={() => copyToClipboard(plugin.plugin.metadata.id)}
                          >
                            <Copy size={12} />
                          </Button>
                        </div>
                      </div>
                      
                      <div>
                        <label className="text-sm font-medium text-foreground">
                          {t('plugin.details.version')}
                        </label>
                        <p className="mt-1 text-sm">{plugin.plugin.metadata.version}</p>
                      </div>
                    </div>

                    <div>
                      <label className="text-sm font-medium text-foreground">
                        {t('plugin.details.author')}
                      </label>
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <User size={14} />
                        <span className="text-sm">{plugin.plugin.metadata.author}</span>
                      </div>
                    </div>

                    {plugin.plugin.metadata.keywords && (
                      <div>
                        <label className="text-sm font-medium text-foreground">
                          {t('plugin.details.keywords')}
                        </label>
                        <div className="flex flex-wrap gap-2 mt-1">
                          {plugin.plugin.metadata.keywords.map((keyword, index) => (
                            <Badge key={index} variant="secondary" className="text-xs">
                              {keyword}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {plugin.plugin.metadata.license && (
                      <div>
                        <label className="text-sm font-medium text-foreground">
                          {t('plugin.details.license')}
                        </label>
                        <p className="mt-1 text-sm">{plugin.plugin.metadata.license}</p>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Links */}
                {(plugin.plugin.metadata.homepage || plugin.plugin.metadata.repository) && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex flex-wrap items-center gap-2">
                        <ExternalLink size={18} />
                        {t('plugin.details.links')}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {plugin.plugin.metadata.homepage && (
                        <a
                          href={plugin.plugin.metadata.homepage}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex flex-wrap items-center gap-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                        >
                          <ExternalLink size={14} />
                          {t('plugin.details.homepage')}
                        </a>
                      )}
                      {plugin.plugin.metadata.repository && (
                        <a
                          href={plugin.plugin.metadata.repository}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex flex-wrap items-center gap-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                        >
                          <GitBranch size={14} />
                          {t('plugin.details.repository')}
                        </a>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Status information */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center gap-2">
                      <Activity size={18} />
                      {t('plugin.details.statusInfo')}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">{t('plugin.details.status')}</span>
                      <div className="flex flex-wrap items-center gap-2">
                        {getStatusIcon(plugin.status)}
                        <span className="capitalize">{t(({ active: 'plugin.status.active', inactive: 'plugin.status.inactive', error: 'plugin.status.error', loading: 'plugin.status.loading', installed: 'plugin.status.installed' } as const)[plugin.status])}</span>
                      </div>
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">{t('plugin.details.enabled')}</span>
                      <span>{plugin.settings.enabled ? t('plugin.yes') : t('plugin.no')}</span>
                    </div>
                    
                    {plugin.loadTime && (
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">{t('plugin.details.loadedAt')}</span>
                        <span className="text-sm">{formatTimestamp(plugin.loadTime)}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="extensions" className="mt-0">
              <Card>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    <Code size={18} />
                    {t('plugin.details.extensionCount', { count: totalExtensions })}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm">{t('plugin.details.menus')}</span>
                        <Badge variant={extensionCounts.menus > 0 ? 'default' : 'secondary'}>
                          {formatNumber(extensionCounts.menus)}
                        </Badge>
                      </div>
                      
                      <div className="flex items-center justify-between">
                        <span className="text-sm">{t('plugin.details.toolbarButtons')}</span>
                        <Badge variant={extensionCounts.toolbarButtons > 0 ? 'default' : 'secondary'}>
                          {formatNumber(extensionCounts.toolbarButtons)}
                        </Badge>
                      </div>
                      
                      <div className="flex items-center justify-between">
                        <span className="text-sm">{t('plugin.details.contextMenus')}</span>
                        <Badge variant={extensionCounts.contextMenus > 0 ? 'default' : 'secondary'}>
                          {formatNumber(extensionCounts.contextMenus)}
                        </Badge>
                      </div>
                      
                      <div className="flex items-center justify-between">
                        <span className="text-sm">{t('plugin.details.sidePanels')}</span>
                        <Badge variant={extensionCounts.sidePanels > 0 ? 'default' : 'secondary'}>
                          {formatNumber(extensionCounts.sidePanels)}
                        </Badge>
                      </div>
                    </div>
                    
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm">{t('plugin.details.exporters')}</span>
                        <Badge variant={extensionCounts.exporters > 0 ? 'default' : 'secondary'}>
                          {formatNumber(extensionCounts.exporters)}
                        </Badge>
                      </div>
                      
                      <div className="flex items-center justify-between">
                        <span className="text-sm">{t('plugin.details.importers')}</span>
                        <Badge variant={extensionCounts.importers > 0 ? 'default' : 'secondary'}>
                          {formatNumber(extensionCounts.importers)}
                        </Badge>
                      </div>
                      
                      <div className="flex items-center justify-between">
                        <span className="text-sm">{t('plugin.details.themes')}</span>
                        <Badge variant={extensionCounts.themes > 0 ? 'default' : 'secondary'}>
                          {formatNumber(extensionCounts.themes)}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  {totalExtensions === 0 && (
                    <div className="text-center py-8 text-muted-foreground">
                      <Code size={32} className="mx-auto mb-2 opacity-50" />
                      <p>{t('plugin.details.noExtensions')}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="advanced" className="mt-0">
              <div className="space-y-6">
                {/* Dependencies */}
                {plugin.plugin.metadata.dependencies && Object.keys(plugin.plugin.metadata.dependencies).length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex flex-wrap items-center gap-2">
                        <GitBranch size={18} />
                        {t('plugin.manager.dependencies')}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {Object.entries(plugin.plugin.metadata.dependencies).map(([dep, version]) => (
                          <div key={dep} className="flex items-center justify-between">
                            <span className="text-sm font-mono">{dep}</span>
                            <Badge variant="outline">{version}</Badge>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Debug information */}
                <Card>
                  <CardHeader>
                    <CardTitle>{t('plugin.details.debug')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3 text-xs">
                      <div>
                        <span className="font-medium">{t('plugin.details.object')}</span>
                        <pre className="mt-1 p-3 bg-muted rounded overflow-auto max-h-40">
                          {JSON.stringify({
                            metadata: plugin.plugin.metadata,
                            hasExtensions: !!plugin.plugin.extensions,
                            hasHooks: !!plugin.plugin.hooks
                          }, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}