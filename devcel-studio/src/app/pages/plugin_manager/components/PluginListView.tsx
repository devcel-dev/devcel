import { appConfirm } from '@/app/services/appDialogs';
import { useEffect, useRef } from 'react';
import { t, useI18n, localizeError } from '@/app/i18n';
import { PluginRegistryEntry } from '@/app/types/pluginTypes';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu';
import { 
  Settings, 
  Pause, 
  Trash2, 
  MoreVertical, 
  CheckCircle, 
  XCircle, 
  Clock, 
  AlertCircle,
  Info
} from 'lucide-react';

interface PluginListViewProps {
  plugins: [string, PluginRegistryEntry][];
  selectedPlugin: string | null;
  onSelectPlugin: (pluginId: string) => void;
  onOpenSettings: () => Promise<void>;
  onUninstallPlugin: (pluginId: string) => Promise<boolean>;
}

export function PluginListView({
  plugins,
  selectedPlugin,
  onSelectPlugin,
  onOpenSettings,
  onUninstallPlugin
}: PluginListViewProps) {
  useI18n();
  const pendingUninstalls = useRef(new Set<string>());
  const currentPlugins = useRef(plugins);
  currentPlugins.current = plugins;
  useEffect(() => { currentPlugins.current = plugins; return () => { currentPlugins.current = []; }; }, [plugins]);
  const getStatusBadge = (status: PluginRegistryEntry['status']) => {
    switch (status) {
      case 'active':
        return (
          <Badge variant="default" className="bg-green-100 text-green-800 border-green-200">
            <CheckCircle size={12} className="mr-1" />
            {t('plugin.status.active')}
          </Badge>
        );
      case 'inactive':
        return (
          <Badge variant="secondary" className="bg-muted text-foreground border-border">
            <Pause size={12} className="mr-1" />
            {t('plugin.status.inactive')}
          </Badge>
        );
      case 'error':
        return (
          <Badge variant="destructive" className="bg-red-100 text-red-800 border-red-200">
            <XCircle size={12} className="mr-1" />
            {t('plugin.status.error')}
          </Badge>
        );
      case 'loading':
        return (
          <Badge variant="outline" className="bg-blue-100 text-blue-800 border-blue-200">
            <Clock size={12} className="mr-1" />
            {t('plugin.status.loading')}
          </Badge>
        );
      default:
        return (
          <Badge variant="outline">
            <Info size={12} className="mr-1" />
            {t('plugin.status.installed')}
          </Badge>
        );
    }
  };

  const handleAction = async (action: 'settings' | 'uninstall', pluginId: string) => {
    try {
      switch (action) {
        case 'settings':
          await onOpenSettings();
          break;
        case 'uninstall':
          await onUninstallPlugin(pluginId);
          break;
      }
    } catch (error) {
      console.error(`Failed to ${action} plugin ${pluginId}:`, error);
    }
  };

  if (plugins.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Info size={48} className="mx-auto mb-4 opacity-50" />
          <p>{t('plugin.list.empty')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {plugins.map(([pluginId, entry]) => (
        <Card
          key={pluginId}
          className={`cursor-pointer transition-all hover:shadow-md ${
            selectedPlugin === pluginId
              ? 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-900/20'
              : 'hover:bg-muted'
          }`}
          onClick={() => onSelectPlugin(pluginId)}
        >
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                {/* Plugin name and version */}
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <h3 className="font-medium text-foreground truncate">
                    {entry.plugin.metadata.name}
                  </h3>
                  <Badge variant="outline" className="text-xs">
                    v{entry.plugin.metadata.version}
                  </Badge>
                </div>

                {/* Plugin ID */}
                <p className="text-xs text-muted-foreground mb-2">
                  {pluginId}
                </p>

                {/* Description */}
                <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                  {entry.plugin.metadata.description}
                </p>

                {/* Author and status */}
                <div className="flex flex-wrap gap-2 items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {t('plugin.authorBy', { author: entry.plugin.metadata.author })}
                  </span>
                  {getStatusBadge(entry.status)}
                </div>

                {/* Error information */}
                {entry.status === 'error' && entry.error && (
                  <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs">
                    <div className="flex items-center gap-1 text-red-800 dark:text-red-200">
                      <AlertCircle size={12} />
                      <span className="font-medium">{t('plugin.errorLabel')}</span>
                    </div>
                    <p className="text-red-700 dark:text-red-300 mt-1 truncate">
                      {localizeError(entry.error)}
                    </p>
                  </div>
                )}
              </div>

              {/* Action menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label={t('plugin.list.actions')}
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 ml-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreVertical size={14} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={e => { e.stopPropagation(); void handleAction('settings', pluginId); }}>
                    <Settings size={14} />{t('plugin.settings.openProject')}
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (pendingUninstalls.current.has(pluginId)) return;
                      pendingUninstalls.current.add(pluginId);
                      try {
                        if (await appConfirm(t('plugin.uninstallConfirm', { name: entry.plugin.metadata.name }),
                          { destructive: true, confirmLabel: t('plugin.uninstall') })
                          && currentPlugins.current.some(([id]) => id === pluginId)) {
                          await handleAction('uninstall', pluginId);
                        }
                      } finally { pendingUninstalls.current.delete(pluginId); }
                    }}
                    className="flex items-center gap-2 text-red-600 dark:text-red-400"
                  >
                    <Trash2 size={14} />
                    {t('plugin.uninstall')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}