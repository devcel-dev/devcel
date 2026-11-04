import { memo } from 'react';
import { useI18n } from '@/app/i18n';
import type { Column } from '@/app/types/tableTypes';
import { getEffectiveCellValue } from '@/app/types/tableTypes';
import { ColorSwatch } from '@/app/components/color/ColorSwatch';
import { colorPreviewCss, displayChannels, useColorInterpretation, type ColorValueType } from '@/app/components/color/colorDisplay';
import { colorCellText } from '@/app/components/color/colorCellDisplay';
import type { GridRow } from './DataGridView';
import './ColorCell.css';

/** Compact text plus a small SDR swatch; canonical data remains in the row and tooltip. */
export const ColorCell = memo(function ColorCell({ row, column, onOpen, readOnly = false }: {
  readOnly?: boolean;
  row: GridRow; column: Column; onOpen: (row: GridRow, column: Column) => void;
}) {
  const { t } = useI18n();
  const type = column.data_type as ColorValueType;
  const interpretation = useColorInterpretation(type);
  const cell = row.cellPresentations?.[column.uuid];
  const value = cell?.display_value ?? String(row[column.uuid] ?? '');
  const channels = cell?.formula_error ? null : displayChannels(value);
  const display = channels ? colorCellText(channels, type, interpretation) : null;
  const raw = cell?.raw_value ?? (row.tableRecord ? getEffectiveCellValue(row.tableRecord, column) : '');
  const formula = (raw || column.default_value).trimStart().startsWith('=');
  return <div className="color-cell-container h-full min-w-0 w-full" title={value}>
    <div className="color-cell-content flex h-full min-w-0 items-center gap-2 overflow-hidden px-2">
    <button type="button" aria-label={formula ? t('color.openFormula') : t('color.open')} title={readOnly ? t('table.edit.cellsBlocked') : formula ? t('color.formulaReadonly') : t('color.open')}
      className="flex shrink-0 rounded focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      onMouseDown={event => event.preventDefault()} onClick={event => {
        event.stopPropagation();
        // Mousedown keeps grid selection but suppresses native button focus.
        // Capture this exact opener before the in-app dialog takes focus.
        event.currentTarget.focus({ preventScroll: true });
        onOpen(row, column);
      }}>
      <ColorSwatch color={channels ? colorPreviewCss(channels, type, interpretation) : null} className="color-cell-preview h-4 w-5" />
    </button>
    <span data-color-cell-value className={`min-w-0 truncate font-mono text-xs ${cell?.formula_error ? 'text-red-700' : ''}`} title={value}>{display ?? value}</span>
    {formula && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground" aria-label={t('color.formulaLabel')}>{t('color.formulaSymbol')}</span>}
    </div>
  </div>;
});
