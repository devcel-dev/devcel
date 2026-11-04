import { DataExporter } from '../types/pluginTypes';

/** One explicit example format, accepting the current TableData contract. */
export function createExporterExtensions(): DataExporter[] {
  return [{
    id: 'your-plugin-exporter',
    name: 'Your Format',
    description: 'Export a current Devcel table without changing cell values',
    fileExtension: 'yourformat',
    mimeType: 'application/json',
    export: async (table) => JSON.stringify({
      format: 'YourFormat',
      schema_version: 1,
      table
    }, null, 2)
  }];
}
