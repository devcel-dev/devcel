import { t, useI18n, formatNumber, localizeError, localizedError, message } from '@/app/i18n';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Upload,
  Globe,
  Code,
  Package,
  AlertCircle,
  CheckCircle,
  Loader2
} from 'lucide-react';

interface PluginInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onInstall: (source: string, type: 'file' | 'url' | 'code') => Promise<boolean>;
}

export function PluginInstallDialog({
  isOpen,
  onClose,
  onInstall
}: PluginInstallDialogProps) {
  useI18n();
  const [activeTab, setActiveTab] = useState('file');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState(false);

  // File selection state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // URL input state
  const [pluginUrl, setPluginUrl] = useState('');

  // Code input state
  const [pluginCode, setPluginCode] = useState(`// Example plugin code
let pluginApi;
const MyPlugin = {
  metadata: {
    id: 'my-custom-plugin',
    name: 'My Custom Plugin',
    version: '1.0.0',
    description: 'A custom plugin created inline',
    author: 'Your Name'
  },

  activate: async (api) => {
    pluginApi = api;
    console.log('Custom plugin activated!');
    api.ui.showNotification('Custom plugin loaded!', 'success');
  },

  deactivate: async () => {
    console.log('Custom plugin deactivated');
  },

  extensions: {
    menus: {
      'custom-menu': {
        groups: [
          {
            id: 'custom',
            label: 'Custom',
            actions: [
              {
                label: 'Custom Action',
                onClick: () => {
                  pluginApi.ui.showNotification('Hello from custom plugin!', 'info');
                }
              }
            ]
          }
        ]
      }
    }
  }
};

// Export the plugin
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MyPlugin;
} else {
  window.MyPlugin = MyPlugin;
}`);

  const handleInstall = async () => {
    setIsLoading(true);
    setError(null);
    setSuccess(false);

    try {
      let source = '';
      let type: 'file' | 'url' | 'code' = 'file';

      switch (activeTab) {
        case 'file':
          if (!selectedFile) {
            throw localizedError(message('plugin.install.error.selectFile'));
          }
          // Read the file contents
          source = await readFileAsText(selectedFile);
          type = 'code'; // Treat the file contents as code
          break;

        case 'url':
          if (!pluginUrl.trim()) {
            throw localizedError(message('plugin.install.error.validUrl'));
          }
          source = pluginUrl.trim();
          type = 'url';
          break;

        case 'code':
          if (!pluginCode.trim()) {
            throw localizedError(message('plugin.install.error.enterCode'));
          }
          source = pluginCode;
          type = 'code';
          break;

        default:
          throw localizedError(message('plugin.install.error.invalidMethod'));
      }

      const result = await onInstall(source, type);

      if (result) {
        setSuccess(true);
        setTimeout(() => {
          onClose();
          resetForm();
        }, 2000);
      } else {
        throw localizedError(message('plugin.install.error.failed'));
      }
    } catch (err) {
      setError(err ?? message('plugin.install.error.unknown'));
    } finally {
      setIsLoading(false);
    }
  };

  const readFileAsText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result;
        if (typeof result === 'string') {
          resolve(result);
        } else {
          reject(localizedError(message('plugin.install.error.readFailed')));
        }
      };
      reader.onerror = () => reject(localizedError(message('plugin.install.error.readFailed')));
      reader.readAsText(file);
    });
  };

  const resetForm = () => {
    setSelectedFile(null);
    setPluginUrl('');
    setPluginCode('');
    setError(null);
    setSuccess(false);
    setActiveTab('file');
  };

  const handleClose = () => {
    if (!isLoading) {
      onClose();
      resetForm();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent aria-describedby={undefined} className="max-w-4xl h-[600px] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package size={20} />
            {t('plugin.install.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="file" className="flex items-center gap-2">
                <Upload size={16} />
                {t('plugin.install.fileUpload')}
              </TabsTrigger>
              <TabsTrigger value="url" className="flex items-center gap-2">
                <Globe size={16} />
                {t('plugin.install.urlTab')}
              </TabsTrigger>
              <TabsTrigger value="code" className="flex items-center gap-2">
                <Code size={16} />
                {t('plugin.install.inlineCode')}
              </TabsTrigger>
            </TabsList>

            <div className="flex-1 overflow-auto mt-4">
              <TabsContent value="file" className="mt-0 h-full">
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="plugin-file">{t('plugin.install.file')}</Label>
                    <div className="mt-2">
                      <input
                        id="plugin-file"
                        type="file"
                        accept=".js,.mjs,.ts"
                        onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                        className="block w-full text-sm text-muted-foreground file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('plugin.install.formats')}
                    </p>
                  </div>

                  {selectedFile && (
                    <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded">
                      <div className="flex items-center gap-2 text-green-800 dark:text-green-200">
                        <CheckCircle size={16} />
                        <span>{selectedFile.name}</span>
                      </div>
                      <p className="text-green-700 dark:text-green-300 text-xs mt-1">
                        {t('plugin.install.fileSize', { size: formatNumber(selectedFile.size / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
                      </p>
                    </div>
                  )}

                </div>
              </TabsContent>

              <TabsContent value="url" className="mt-0 h-full">
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="plugin-url">{t('plugin.install.url')}</Label>
                    <Input
                      id="plugin-url"
                      type="url"
                      placeholder="https://example.com/my-plugin.js"
                      value={pluginUrl}
                      onChange={(e) => setPluginUrl(e.target.value)}
                      className="mt-2"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('plugin.install.urlHelp')}
                    </p>
                  </div>

                  <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded">
                    <div className="flex items-center gap-2 text-yellow-800 dark:text-yellow-200 mb-2">
                      <AlertCircle size={16} />
                      <span className="font-medium">{t('plugin.install.securityTitle')}</span>
                    </div>
                    <p className="text-yellow-700 dark:text-yellow-300 text-sm">
                      {t('plugin.install.securityHelp')}
                    </p>
                  </div>

                </div>
              </TabsContent>

              <TabsContent value="code" className="mt-0 h-full">
                <div className="space-y-4 h-full flex flex-col">
                  <div className="flex-1 flex flex-col">
                    <Label htmlFor="plugin-code">{t('plugin.install.code')}</Label>
                    <Textarea
                      id="plugin-code"
                      value={pluginCode}
                      onChange={(e) => setPluginCode(e.target.value)}
                      className="mt-2 flex-1 font-mono text-sm"
                      placeholder={t('plugin.install.codePlaceholder')}
                    />
                  </div>

                  <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded">
                    <h4 className="font-medium text-blue-800 dark:text-blue-200 mb-2">
                      {t('plugin.install.codeInstructions')}
                    </h4>
                    <ul className="text-blue-700 dark:text-blue-300 text-sm space-y-1">
                      <li>{t('plugin.install.codeStep2')}</li>
                      <li>{t('plugin.install.codeStep3')}</li>
                    </ul>
                  </div>
                </div>
              </TabsContent>
            </div>
          </Tabs>
        </div>

        {/* Error and success display */}
        {!!error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded">
            <div className="flex items-center gap-2 text-red-800 dark:text-red-200">
              <AlertCircle size={16} />
              <span className="font-medium">{t('plugin.install.failureTitle')}</span>
            </div>
            <p className="text-red-700 dark:text-red-300 text-sm mt-1">{localizeError(error)}</p>
          </div>
        )}

        {success && (
          <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded">
            <div className="flex items-center gap-2 text-green-800 dark:text-green-200">
              <CheckCircle size={16} />
              <span className="font-medium">{t('plugin.install.successTitle')}</span>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isLoading}>
            {t('plugin.install.cancel')}
          </Button>
          <Button
            onClick={handleInstall}
            disabled={isLoading || success}
            className="flex items-center gap-2"
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {t('plugin.install.working')}
              </>
            ) : success ? (
              <>
                <CheckCircle size={16} />
                {t('plugin.install.installed')}
              </>
            ) : (
              <>
                <Package size={16} />
                {t('plugin.install.title')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}