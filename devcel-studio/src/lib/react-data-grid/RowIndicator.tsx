import { formatNumber } from '@/app/i18n';
import type { RowIndicatorProps } from './types';

/**
 * Default row indicator renderer
 * Basic implementation displaying the row number
 */
export function defaultRenderRowIndicator<R, SR = unknown>({
  rowNumber,
  tabIndex,
  row,
  rowIndicatorConfig
}: RowIndicatorProps<R, SR>) {
  // Determine the display content
  let displayContent: string | number = formatNumber(rowNumber);
  
  if (rowIndicatorConfig) {
    const { format = 'number', getRowLabel } = rowIndicatorConfig;
    
    if ((format === 'label' || format === 'combined') && getRowLabel && row) {
      const label = getRowLabel(row);
      
      if (format === 'label') {
        displayContent = label;
      } else if (format === 'combined') {
        displayContent = `${formatNumber(rowNumber)}: ${label}`;
      }
    }
  }
  
  return (
    <div
      className="rdg-row-indicator"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        width: '100%',
        fontSize: '0.875rem',
        color: '#6b7280',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        overflow: 'visible', // Changed from 'hidden' to allow inline buttons
        textOverflow: 'ellipsis',
        padding: '0 8px'
      }}
      tabIndex={tabIndex}
      title={displayContent.toString()}
    >
      {displayContent}
    </div>
  );
}