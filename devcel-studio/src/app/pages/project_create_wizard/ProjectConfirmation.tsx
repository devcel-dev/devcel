import { Button } from '@/components/ui/button';
import { useI18n, t } from '@/app/i18n';
import { ProjectCreateDetails } from '@/app/commands/projectCommands';

type ProjectConfirmationProps = {
  details: ProjectCreateDetails;
  onBack: () => void;
  onSubmit: () => Promise<void>;
  creating?: boolean;
};

export function ProjectConfirmation({ details, onBack, onSubmit, creating }: ProjectConfirmationProps) {
  useI18n();
  return (
    <div className="p-4 space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-bold text-foreground">{t('project.confirmTitle')}</h2>
      </div>

      <div className="bg-muted rounded p-3 space-y-3">
        <div className="grid grid-cols-1 gap-3">
          <div>
            <h3 className="text-xs font-medium text-foreground mb-1">{t('project.location')}</h3>
            <p className="text-foreground bg-background p-2 rounded border text-xs font-mono break-all">
              {details.path}/{details.name}
            </p>
          </div>

          <div>
            <h3 className="text-xs font-medium text-foreground mb-1">{t('project.name')}</h3>
            <p className="text-foreground bg-background p-2 rounded border text-sm break-words">
              {details.name}
            </p>
          </div>

          <div>
            <h3 className="text-xs font-medium text-foreground mb-1">{t('common.description')}</h3>
            <p className="text-foreground bg-background p-2 rounded border text-sm break-words">
              {details.description}
            </p>
          </div>

          <div>
            <h3 className="text-xs font-medium text-foreground mb-1">{t('project.headerColor')}</h3>
            <div className="flex items-center gap-2">
              <div
                className="w-8 h-8 shrink-0 rounded border border-border"
                style={{ backgroundColor: details.headerColor }}
              />
              <div className="text-xs">
                <div className="font-mono text-foreground">
                  {details.headerColor}
                </div>
                <div className="text-muted-foreground">
                  {t('project.selectedColor')}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap justify-between gap-2 pt-2">
        <Button
          disabled={creating}
          onClick={onBack}
          variant="secondary"
          className="h-auto min-h-9 whitespace-normal break-words"
        >
          {t('common.back')}</Button>
        <Button
          disabled={creating}
          onClick={onSubmit}
          className="h-auto min-h-9 whitespace-normal break-words"
        >
          {t('project.create')}</Button>
      </div>
    </div>
  );
}