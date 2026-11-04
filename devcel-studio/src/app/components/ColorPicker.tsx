import { t, useI18n } from '@/app/i18n';

interface ColorPickerProps {
  selectedColor: string;
  onColorSelect: (color: string) => void;
  className?: string;
}

const PRESET_COLORS = [
  { color: '#ffffff', get title() { return t('column.color.defaultWhite'); } },
  { color: '#e3f2fd', get title() { return t('column.color.lightBlue'); } },
  { color: '#e8f5e8', get title() { return t('column.color.lightGreen'); } },
  { color: '#fffde7', get title() { return t('column.color.lightYellow'); } },
  { color: '#f5f5f5', get title() { return t('column.color.lightGray'); } },
  { color: '#ffe5e5', get title() { return t('column.color.lightRed'); } },
  { color: '#f3e5ff', get title() { return t('column.color.lightPurple'); } },
  { color: '#fff0e5', get title() { return t('column.color.lightOrange'); } },
  { color: '#e5f5ff', get title() { return t('column.color.lightCyan'); } },
  { color: '#ffeee5', get title() { return t('column.color.lightPink'); } },
];

export function ColorPicker({ selectedColor, onColorSelect, className = '' }: ColorPickerProps) {
  useI18n();
  return (
    <div className={`space-y-3 ${className}`}>
      <div className="text-sm font-medium">{t('column.color.select')}</div>
      <div className="grid grid-cols-5 gap-2">
        {PRESET_COLORS.map(({ color, title }) => (
          <button
            key={color}
            className={`w-8 h-8 rounded border-2 hover:border-gray-400 transition-colors ${
              selectedColor === color ? 'border-primary' : 'border-gray-300'
            }`}
            style={{ backgroundColor: color }}
            onClick={() => onColorSelect(color)}
            title={title}
            aria-label={title}
          />
        ))}
      </div>
      <div className="pt-2 border-t border-gray-200">
        <button
          className="w-full text-sm text-gray-600 hover:text-gray-800 py-1 transition-colors"
          onClick={() => onColorSelect('#000000')}
        >
          {t('column.color.restoreDefault')}
        </button>
      </div>
    </div>
  );
}