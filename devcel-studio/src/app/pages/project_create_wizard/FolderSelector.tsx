import { Button } from '@/components/ui/button';
import { useI18n, t } from '@/app/i18n';
import { open } from '@tauri-apps/plugin-dialog';

type FolderSelectorProps = {
  value: string;
  onChange: (path: string) => void;
  onNext: () => void;
};

export function FolderSelector({ value, onChange, onNext }: FolderSelectorProps) {
  useI18n();
  const handleSelectFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t('project.selectFolder'),
      defaultPath: value || undefined
    });

    if (selected && typeof selected === 'string') {
      onChange(selected);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-bold text-foreground">{t('project.locationTitle')}</h2>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">
          {t('project.destinationFolder')}</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={value}
            title={value}
            readOnly
            className="min-w-0 flex-1 p-2 border border-border rounded bg-muted text-foreground placeholder:text-muted-foreground cursor-pointer hover:bg-muted transition-colors text-sm"
            placeholder={t('project.folderPlaceholder')}
            onClick={handleSelectFolder}
          />
          <Button
            onClick={handleSelectFolder}
            className="h-auto min-h-9 whitespace-normal break-words"
          >
            {t('common.browse')}</Button>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button
          onClick={onNext}
          disabled={!value}
          className="h-auto min-h-9 whitespace-normal break-words"
        >
          {t('common.next')}</Button>
      </div>
    </div>
  );
}