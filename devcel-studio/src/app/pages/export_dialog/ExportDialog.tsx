import { normalizeTableData } from '@/app/types/tableTypes';
import type { TableData } from '@/app/types/tableTypes';
import type { Diagnostic } from '@/app/i18n';
import { t, useI18n, localizeError, localizedError, message as i18nMessage } from '@/app/i18n';
import { useExporters } from '@/app/contexts/PluginContext';
import { PluginOptions, pluginOptions } from '@/app/components/plugins/PluginExtensions';
import { writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { FileText, Database, Download } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { message, ask } from '@/app/services/appDialogs';
import { save } from '@tauri-apps/plugin-dialog';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

type ExportScope = 'all' | 'current';
type ExportMode = 'full' | 'minimal';

/** Run the same Rust preflight for all targets. Propagate failures to the export operation. */
async function collectConstraintWarnings(tableUuid: string | null, expectedProjectSession: string): Promise<string[]> {
  const issues = await invoke<{table_name:string; column_name:string; diagnostic:Diagnostic; table_uuid:string; kind:string}[]>('lint_project_export', {tableUuid, version:null, expectedProjectSession});
  return issues.map(issue => `${issue.table_name} / ${issue.column_name}: ${localizeError(issue)}`);
}

export default function ExportDialog() {
  useI18n();
  const [searchParams] = useSearchParams();
  const [scope, setScope] = useState<ExportScope>('all');
  const [mode, setMode] = useState<ExportMode>('full');
  const [isExporting, setIsExporting] = useState(false);
  const expectedProjectSession = searchParams.get('expectedProjectSession');
  const exportRunning = useRef(false);
  const exporters = useExporters();
  const [format, setFormat] = useState('json');
  const [options, setOptions] = useState<Record<string, any>>({});
  const exporter = exporters.find(item => item.id === format);
  const optionSchema = exporter?.getOptions?.() || [];

  const handleExport = async () => {
    if (exportRunning.current || !expectedProjectSession) return;
    exportRunning.current = true;
    try {
      setIsExporting(true);
      if (format !== 'json' && !exporter) throw localizedError(i18nMessage('export.error.pluginInactive'));
      if (exporter && (scope !== 'current' || !searchParams.get('uuid'))) throw localizedError(i18nMessage('export.error.pluginScope'));

      const warnings = await collectConstraintWarnings(scope === 'current' ? searchParams.get('uuid') : null, expectedProjectSession);
      let allowInvalid = false;
      if (warnings.length) {
        const summary = warnings.slice(0,8).join('\n');
        allowInvalid = await ask(t('export.validationConfirm', { count: warnings.length, summary, more: warnings.length > 8 ? t('export.validationMore', { count: warnings.length - 8 }) : '' }), {title:t('export.validationTitle'),kind:'warning'});
        if (!allowInvalid) return;
      }

      // Show the file save dialog
      const filePath = await save({
        title: t('export.saveTitle', { format: exporter?.name || 'JSON' }),
        defaultPath: scope === 'all' ? 'all_tables.json' : `table.${exporter?.fileExtension.replace(/^\./, '') || 'json'}`,
        filters: [
          {
            name: exporter?.name || 'JSON',
            extensions: [exporter?.fileExtension.replace(/^\./, '') || 'json']
          }
        ]
      });

      if (!filePath) {
        setIsExporting(false);
        return;
      }

      // Run the export
      let result: string;
      if (exporter) {
        const uuid = searchParams.get('uuid');
        const data = await invoke<TableData>('get_table_data', { uuid, expectedProjectSession }).then(normalizeTableData);
        const output = await exporter.export(data, pluginOptions(optionSchema, options));
        if (typeof output === 'string') await writeTextFile(filePath, output);
        else if (output instanceof Blob) await writeFile(filePath, new Uint8Array(await output.arrayBuffer()));
        else throw localizedError(i18nMessage('export.error.pluginResult'));
        result = 'ok';
      } else if (scope === 'all') {
        if (mode === 'full') {
          result = await invoke('export_all_tables_json_full', { outputPath: filePath, allowInvalid, expectedProjectSession });
        } else {
          result = await invoke('export_all_tables_json_minimal', { outputPath: filePath, allowInvalid, expectedProjectSession });
        }
      } else {
        // Get the current table UUID
        const uuid = searchParams.get('uuid');

        if (!uuid) {
          console.error('Table UUID not found', searchParams.toString());
          await message(t('export.missingUuid'), { title: t('export.genericError'), kind: 'error' });
          setIsExporting(false);
          return;
        }

        if (mode === 'full') {
          result = await invoke('export_table_json_full', { uuid, outputPath: filePath, allowInvalid, expectedProjectSession });
        } else {
          result = await invoke('export_table_json_minimal', { uuid, outputPath: filePath, allowInvalid, expectedProjectSession });
        }
      }

      if (result === 'ok') {

        // Display the success message
        const fileName = filePath.split(/[/\\]/).pop() || t('export.fileFallback');
        await message(t('export.success', { name: fileName, path: filePath }), {
          title: t('export.successTitle'),
          kind: 'info'
        });

        // Close the dialog on success
        const currentWindow = getCurrentWebviewWindow();
        await currentWindow.close();
      } else {
        console.error('Export failed:', result);
        await message(t('export.failed', { error: localizeError(result) }), {
          title: t('export.errorTitle'),
          kind: 'error'
        });
      }
    } catch (error) {
      console.error('Export error:', JSON.stringify(error, null, 2));
      await message(t('export.error', { error: localizeError(error) }), {
        title: t('export.errorTitle'),
        kind: 'error'
      });
    } finally {
      exportRunning.current = false;
      setIsExporting(false);
    }
  };

  const handleCancel = async () => {
    const currentWindow = getCurrentWebviewWindow();
    await currentWindow.close();
  };

  return (
    <div className="p-6 w-full h-screen overflow-y-auto bg-background">
      <div className="space-y-6">
        <div className="text-center">
          <h1 className="text-xl font-semibold">{t('export.title')}</h1>
        </div>

        <Separator />

        <label className="block space-y-2"><span>{t('export.format')}</span>
          <select aria-label={t('export.format')} className="w-full border rounded p-2 bg-background" disabled={isExporting} value={format} onChange={e => { setFormat(e.target.value); setOptions({}); if (e.target.value !== 'json') setScope('current'); }}>
            <option value="json">JSON</option>{exporters.map(item => <option key={item.id} value={item.id} disabled={!searchParams.get('uuid')}>{item.name}</option>)}
          </select>
        </label>
        {exporter && <PluginOptions schema={optionSchema} value={options} onChange={setOptions} />}
        {/* Export scope */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="h-4 w-4" />
              {t('export.scope')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center space-x-3">
                <input
                  type="radio"
                  id="scope-all"
                  name="scope"
                  value="all"
                  checked={scope === 'all'}
                  disabled={!!exporter || isExporting}
                  onChange={(e) => setScope(e.target.value as ExportScope)}
                  className="w-4 h-4"
                />
                <Label htmlFor="scope-all" className="flex-1 cursor-pointer">
                  <div>
                    <div className="font-medium">{t('export.all')}</div>
                  </div>
                </Label>
              </div>
              <div className="flex items-center space-x-3">
                <input
                  type="radio"
                  id="scope-current"
                  name="scope"
                  value="current"
                  checked={scope === 'current'}
                  onChange={(e) => setScope(e.target.value as ExportScope)}
                  disabled={!searchParams.get('uuid')}
                  className="w-4 h-4"
                />
                <Label htmlFor="scope-current" className={`flex-1 ${!searchParams.get('uuid') ? 'opacity-50' : ''}`}>
                  <div>
                    <div className="font-medium">{t('export.current')}</div>
                  </div>
                </Label>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Export mode */}
        {!exporter && <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4" />
              {t('export.mode')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center space-x-3">
                <input
                  type="radio"
                  id="mode-full"
                  name="mode"
                  value="full"
                  checked={mode === 'full'}
                  onChange={(e) => setMode(e.target.value as ExportMode)}
                  className="w-4 h-4"
                />
                <Label htmlFor="mode-full" className="flex-1 cursor-pointer">
                  <div>
                    <div className="font-medium">{t('export.full')}</div>
                    <div className="text-sm text-muted-foreground">
                      {t('export.fullHelp')}
                    </div>
                  </div>
                </Label>
              </div>
              <div className="flex items-center space-x-3">
                <input
                  type="radio"
                  id="mode-minimal"
                  name="mode"
                  value="minimal"
                  checked={mode === 'minimal'}
                  onChange={(e) => setMode(e.target.value as ExportMode)}
                  className="w-4 h-4"
                />
                <Label htmlFor="mode-minimal" className="flex-1 cursor-pointer">
                  <div>
                    <div className="font-medium">{t('export.minimal')}</div>
                    <div className="text-sm text-muted-foreground">
                      {t('export.minimalHelp')}
                    </div>
                  </div>
                </Label>
              </div>
            </div>
          </CardContent>
        </Card>}

        <Separator />

        {/* Buttons */}
        <div className="flex flex-wrap justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={handleCancel}
            disabled={isExporting}
          >
            {t('export.cancel')}
          </Button>
          <Button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              handleExport();
            }}
            disabled={isExporting}
          >
            <Download className="h-4 w-4 mr-2" />
            {isExporting ? t('export.working') : t('export.action')}
          </Button>
        </div>
      </div>
    </div>
  );
}
