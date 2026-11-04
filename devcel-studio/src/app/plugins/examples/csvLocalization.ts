import { translatePluginMessage } from '@/app/i18n';
/** All CSV labels belong to the plugin's editable translation table. */
export function csvT(key: string, values?: Record<string, string | number | Date>): string {
  return translatePluginMessage('csv-exporter', key, values);
}
