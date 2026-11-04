import { csvT } from './csvLocalization';
import { createEffectiveCellInputResolver, type TableData } from '@/app/types/tableTypes';
import { Plugin, PluginAPI } from '@/app/types/pluginTypes';
import { AdvancedCSVExportDialog } from './components/AdvancedCSVExportDialog';

let pluginApi: PluginAPI | null = null;

// CSV export plugin
const CSVExporterPlugin: Plugin = {
  metadata: {
    id: 'csv-exporter',
    apiVersion: '2.0.0',
    get name() { return csvT('name'); },
    version: '1.2.0',
    get description() { return csvT('description'); },
    author: 'Devcel Team',
    homepage: 'https://github.com/devcel-dev/devcel',
    license: 'MIT',
    keywords: ['export', 'csv', 'data', 'table'],
    // Stable compatibility floor; repository builds add RC opt-in in memory.
    devcelVersion: '>=0.0.0'
  },

  extensions: {
    exporters: [
      {
        id: 'csv-basic',
        get name() { return csvT('basicName'); },
        get description() { return csvT('basicDescription'); },
        fileExtension: 'csv',
        mimeType: 'text/csv',
        export: async (data: TableData, options?: any) => {
          return generateCSV(data, options || { delimiter: ',', includeHeaders: true });
        },
        getOptions: () => [
          {
            name: 'delimiter',
            label: csvT('delimiter'),
            type: 'select',
            default: ',',
            options: [
              { value: ',', label: csvT('comma') },
              { value: ';', label: csvT('semicolon') },
              { value: '\t', label: csvT('tab') },
              { value: '|', label: csvT('pipe') }
            ]
          },
          {
            name: 'includeHeaders',
            label: csvT('headers'),
            type: 'boolean',
            default: true
          },
          {
            name: 'encoding',
            label: csvT('encoding'),
            type: 'select',
            default: 'utf-8',
            options: [
              { value: 'utf-8', label: 'UTF-8' }
            ]
          }
        ]
      },
      {
        id: 'csv-advanced',
        get name() { return csvT('advancedName'); },
        get description() { return csvT('advancedDescription'); },
        fileExtension: 'csv',
        mimeType: 'text/csv',
        export: async (data: TableData, options?: any) => {
          return generateAdvancedCSV(data, options || {});
        },
        getOptions: () => [
          {
            name: 'delimiter',
            label: csvT('delimiter'),
            type: 'select',
            default: ',',
            options: [
              { value: ',', label: csvT('comma') },
              { value: ';', label: csvT('semicolon') },
              { value: '\t', label: csvT('tab') },
              { value: '|', label: csvT('pipe') }
            ]
          },
          {
            name: 'quoteChar',
            label: csvT('quote'),
            type: 'text',
            default: '"'
          },
          {
            name: 'escapeChar',
            label: csvT('escape'),
            type: 'text',
            default: '\\'
          },
          {
            name: 'includeHeaders',
            label: csvT('headers'),
            type: 'boolean',
            default: true
          },
          {
            name: 'includeRowNumbers',
            label: csvT('rowNumbers'),
            type: 'boolean',
            default: false
          },
          {
            name: 'dateFormat',
            label: csvT('dateFormat'),
            type: 'select',
            default: 'ISO',
            options: [
              { value: 'ISO', label: csvT('isoDate') },
              { value: 'US', label: csvT('usDate') },
              { value: 'EU', label: csvT('euDate') },
              { value: 'JP', label: csvT('jpDate') }
            ]
          },
          {
            name: 'numberFormat',
            label: csvT('numberFormat'),
            type: 'select',
            default: 'auto',
            options: [
              { value: 'auto', label: csvT('autoNumber') },
              { value: 'decimal-dot', label: csvT('decimalDot') },
              { value: 'decimal-comma', label: csvT('decimalComma') }
            ]
          }
        ]
      }
    ],

    menus: {
      'export-menu': {
        groups: [
          {
            id: 'csv-export',
            get label() { return csvT('menu'); },
            actions: [
              {
                get label() { return csvT('exportBasic'); },
                onClick: () => {
                  console.log('Export as basic CSV triggered');
                  if (pluginApi) pluginApi.ui.executeCommand('csv.exportBasic');
                }
              },
              {
                get label() { return csvT('exportAdvanced'); },
                onClick: () => {
                  console.log('Export as advanced CSV triggered');
                  if (pluginApi) pluginApi.ui.executeCommand('csv.exportAdvanced');
                }
              }
            ]
          }
        ]
      }
    },

    toolbarButtons: [
      {
        id: 'csv-export-button',
        label: 'CSV',
        get tooltip() { return csvT('export'); },
        onClick: () => {
          console.log('CSV export button clicked');
          if (pluginApi) pluginApi.ui.executeCommand('csv.exportBasic');
        },
        position: 'right',
        order: 200,
        isVisible: () => {
          // Display only when a table is open
          // TODO: Check the actual condition, such as whether pluginApi.app.getState().activeTable exists
          return true;
        }
      }
    ],

    contextMenus: {
      'table-context': [
        {
          id: 'csv-export-context',
          get label() { return csvT('export'); },
          onClick: (_context) => {
            console.log('Export to CSV from context menu');
            if (pluginApi) pluginApi.ui.executeCommand('csv.exportBasic');
          },
          isVisible: (context) => {
            return context && context.type === 'table';
          }
        }
      ]
    }
  },

  hooks: {
    onInstall: async (_api: PluginAPI) => {
      console.log('CSV Exporter Plugin installed');

      // Initialize default settings

      // Built-in installation at startup is silent; status is visible in the manager.
    },

    onActivate: async (api: PluginAPI) => {
      pluginApi = api;
      console.log('CSV Exporter Plugin activated');

      // Register export commands
      api.ui.registerCommand('csv.exportBasic', async () => {
        const target = api.app.getState().activeTable;
        const currentTable = target ? await api.data.getTable(target.uuid, target.projectSession) : null;
        if (currentTable) {
          const csv = generateCSV(currentTable, {
            delimiter: await api.settings.getTable<{ defaultDelimiter: string; defaultEncoding: string }>('settings').defaultDelimiter,
            encoding: await api.settings.getTable<{ defaultDelimiter: string; defaultEncoding: string }>('settings').defaultEncoding,
            includeHeaders: true
          });

          // Show the file save dialog
          const filePath = await api.ui.showSaveDialog({
            filters: [{
              name: csvT('fileFilter'),
              extensions: ['csv']
            }]
          });

          if (filePath) {
            await api.fs.writeFile(filePath, csv);
            api.ui.showNotification(csvT('success'), 'success');
          }
        } else {
          api.ui.showNotification(csvT('noTable'), 'warning');
        }
      });

      api.ui.registerCommand('csv.exportAdvanced', async () => {
        const target = api.app.getState().activeTable;
        const currentTable = target ? await api.data.getTable(target.uuid, target.projectSession) : null;
        if (!currentTable) {
          api.ui.showNotification(csvT('noTable'), 'warning');
          return;
        }

        // Show advanced export dialog
        const options = await api.ui.showModal(AdvancedCSVExportDialog, {
          get title() { return csvT('advancedTitle'); }
        });

        if (options) {
          const csv = generateAdvancedCSV(currentTable, options);

          const filePath = await api.ui.showSaveDialog({
            filters: [{
              name: csvT('fileFilter'),
              extensions: ['csv']
            }]
          });

          if (filePath) {
            await api.fs.writeFile(filePath, csv);
            api.ui.showNotification(csvT('success'), 'success');
          }
        }
      });
    },

    onDeactivate: async (api: PluginAPI) => {
      console.log('CSV Exporter Plugin deactivated');
      api.ui.showNotification(csvT('deactivated'), 'info');
      pluginApi = null;
    },

    onUninstall: async (api: PluginAPI) => {
      console.log('CSV Exporter Plugin uninstalled');

      // Clean up settings

      api.ui.showNotification(csvT('uninstalled'), 'info');
    }
  },

  activate: async (_api: PluginAPI) => {
    console.log('CSV Exporter Plugin: activate() called');

    // Lifecycle hooks are invoked exactly once by PluginManager.
  },

  deactivate: async () => {
    console.log('CSV Exporter Plugin: deactivate() called');
  }
};

// String exports are saved as UTF-8 by the host. Reject stale/direct requests
// for other encodings before generating output or writing a file.
function requireSupportedCSVEncoding(encoding: unknown): void {
  if (encoding !== undefined && encoding !== 'utf-8') {
    throw new Error(csvT('unsupportedEncoding'));
  }
}

// Basic CSV generation function
function generateCSV(data: TableData, options: any): string {
  requireSupportedCSVEncoding(options.encoding);
  const { delimiter = ',', includeHeaders = true } = options;

  // Backend data structure: { schema: { columns: [...] }, records: [...] }
  const columns = data.schema.columns;
  const records = data.records;
  const resolveInput = createEffectiveCellInputResolver(data);


  const lines: string[] = [];

  // Header row
  if (includeHeaders && columns) {
    const headers = columns.map((col) => escapeCSVField(col.display_name, delimiter));
    lines.push(headers.join(delimiter));
  }

  // Data rows
  for (const record of records) {
    const fields = columns.map((col) => {
      const value = resolveInput(record, col);

      return escapeCSVField(String(value), delimiter);
    });
    lines.push(fields.join(delimiter));
  }

  return lines.join('\n');
}

// Advanced CSV generation function
function generateAdvancedCSV(data: TableData, options: any): string {
  requireSupportedCSVEncoding(options.encoding);
  const {
    delimiter = ',',
    quoteChar = '"',
    escapeChar = '\\',
    includeHeaders = true,
    includeRowNumbers = false,
    dateFormat = 'ISO',
    numberFormat = 'auto'
  } = options;

  // Backend data structure support
  const columns = data.schema.columns;
  const records = data.records;
  const resolveInput = createEffectiveCellInputResolver(data);


  const lines: string[] = [];

  // Header row
  if (includeHeaders) {
    let headers: string[] = [];

    if (includeRowNumbers) {
      headers.push(escapeCSVFieldAdvanced('Row', delimiter, quoteChar, escapeChar));
    }

    if (columns) {
      headers.push(...columns.map((col) =>
        escapeCSVFieldAdvanced(col.display_name, delimiter, quoteChar, escapeChar)
      ));
    }

    lines.push(headers.join(delimiter));
  }

  // Data rows
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    let fields: string[] = [];

    if (includeRowNumbers) {
      fields.push(String(i + 1));
    }

    if (columns) {
      fields.push(...columns.map((col) => {
        let value = resolveInput(record, col);

        // Format according to data type
        if (col.data_type === 'DateTime' && value) {
          value = formatDate(value, dateFormat);
        } else if (/^(?:[UI](?:8|16|32|64)|F(?:32|64))$/.test(col.data_type) && value) {
          value = formatNumber(value, numberFormat);
        }

        return escapeCSVFieldAdvanced(String(value), delimiter, quoteChar, escapeChar);
      }));
    }

    lines.push(fields.join(delimiter));
  }

  return lines.join('\n');
}

// Basic CSV field escaping
function escapeCSVField(field: string, delimiter: string): string {
  if (field.includes(delimiter) || field.includes('"') || /[\r\n]/.test(field)) {
    return '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

// Advanced CSV field escaping
function escapeCSVFieldAdvanced(field: string, delimiter: string, quoteChar: string, escapeChar: string): string {
  if (field.includes(delimiter) || field.includes(quoteChar) || /[\r\n]/.test(field)) {
    const escaped = field.split(quoteChar).join(escapeChar + quoteChar);
    return quoteChar + escaped + quoteChar;
  }
  return field;
}

// Date formatting
function formatDate(value: any, format: string): string {
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);

  switch (format) {
    case 'US':
      return date.toLocaleDateString('en-US');
    case 'EU':
      return date.toLocaleDateString('en-GB');
    case 'JP':
      return date.toLocaleDateString('ja-JP');
    case 'ISO':
    default:
      return date.toISOString().split('T')[0];
  }
}

// Number formatting
function formatNumber(value: any, format: string): string {
  // Integer cells are decimal strings; converting them to Number loses u64/i64 bits.
  const text = String(value);
  if (/^[+-]?\d+$/.test(text)) return text;
  const num = Number(value);
  if (isNaN(num)) return String(value);

  switch (format) {
    case 'decimal-comma':
      return num.toString().replace('.', ',');
    case 'decimal-dot':
      return num.toString();
    case 'auto':
    default:
      return num.toString();
  }
}

export default CSVExporterPlugin;
