import { normalizeTableData } from '@/app/types/tableTypes';
import { t, useI18n } from '@/app/i18n';
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getTableCatalog, loadTableByUuid, type TableReference } from '@/app/commands/tableCommands';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Column, ReferenceConfig, TableData } from '@/app/types/tableTypes';

interface ReferenceConfigSelectorProps {
  expectedProjectSession: string;
  config?: ReferenceConfig;
  onChange: (config: ReferenceConfig) => void;
}

export function ReferenceConfigSelector({ expectedProjectSession, config, onChange }: ReferenceConfigSelectorProps) {
  useI18n();
  const [tables, setTables] = useState<TableReference[]>([]);
  const [targetColumns, setTargetColumns] = useState<Column[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentConfig, setCurrentConfig] = useState<ReferenceConfig>(
    config || {
      target_table_uuid: '',
      display_column_uuid: null,
    }
  );

  // Synchronize when the config property changes
  useEffect(() => {
    setCurrentConfig(config || { target_table_uuid: '', display_column_uuid: null });
  }, [config]);

  // Discover references from metadata only; unopened tables remain selectable.
  useEffect(() => {
    let active = true;
    void getTableCatalog(expectedProjectSession).then(result => {
      if (active) setTables(result);
    }).catch(error => {
      if (active) console.error('Failed to load tables:', error);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [expectedProjectSession]);

  // Only the selected reference target needs content. Ignore a superseded target.
  useEffect(() => {
    let active = true;
    setTargetColumns([]);
    if (currentConfig.target_table_uuid) {
      void loadTableByUuid(currentConfig.target_table_uuid, expectedProjectSession).then(() => {
        if (!active) return null;
        return invoke<TableData>('get_table_data', { uuid: currentConfig.target_table_uuid, expectedProjectSession }).then(normalizeTableData);
      }).then(response => {
        if (active && response) setTargetColumns(response.schema.columns);
      }).catch(() => { if (active) setTargetColumns([]); });
    }
    return () => { active = false; };
  }, [currentConfig.target_table_uuid, expectedProjectSession]);

  const handleTargetTableChange = (value: string) => {

    const newConfig = {
      ...currentConfig,
      target_table_uuid: value,
      display_column_uuid: null // Reset
    };
    setCurrentConfig(newConfig);
    onChange(newConfig);
  };

  const handleDisplayColumnChange = (value: string) => {
    const newConfig = {
      ...currentConfig,
      display_column_uuid: value === '__USE_UUID__' ? null : value
    };
    setCurrentConfig(newConfig);
    onChange(newConfig);
  };

  return (
    <div className="space-y-3">
      {/* Reference target table selection */}
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">{t('reference.targetTable')}</Label>
        <Select
          value={currentConfig.target_table_uuid}
          onValueChange={handleTargetTableChange}
          disabled={loading}
        >
          <SelectTrigger className="w-full h-8 text-sm">
            <SelectValue placeholder={t('reference.selectTable')} />
          </SelectTrigger>
          <SelectContent className="z-[10000]">
            {tables.map(table => (
              <SelectItem key={table.uuid} value={table.uuid}>
                {table.display_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Display column selection */}
      {currentConfig.target_table_uuid && targetColumns.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs font-medium text-muted-foreground">{t('reference.displayColumn')}</Label>
          <Select
            value={currentConfig.display_column_uuid || '__USE_UUID__'}
            onValueChange={handleDisplayColumnChange}
          >
            <SelectTrigger className="w-full h-8 text-sm">
              <SelectValue placeholder={t('reference.selectDisplayColumn')} />
            </SelectTrigger>
            <SelectContent className="z-[10000]">
              <SelectItem value="__USE_UUID__">
                <span className="text-muted-foreground">{t('reference.useLabelOrRow')}</span>
              </SelectItem>
              {targetColumns.map(col => (
                <SelectItem key={col.uuid} value={col.uuid}>
                  {col.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
