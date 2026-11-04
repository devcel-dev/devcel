import { Button } from '@/components/ui/button';
import { ColorField } from '@/app/components/color/ColorField';
import { useI18n, t } from '@/app/i18n';
import { ProjectCreateDetails } from '@/app/commands/projectCommands';
import { validateDataName } from '@/app/utils/validation';

type ProjectDetailsFormProps = {
  details: ProjectCreateDetails;
  onChange: (details: ProjectCreateDetails) => void;
  onBack: () => void;
  onNext: () => void;
};

export function ProjectDetailsForm({ details, onChange, onBack, onNext }: ProjectDetailsFormProps) {
  useI18n();
  const handleChange = (field: keyof ProjectCreateDetails) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    onChange({
      ...details,
      [field]: e.target.value
    });
  };

  const nameValidation = validateDataName(details.name);
  const isValid = nameValidation.isValid && Boolean(details.headerColor);

  return (
    <div className="p-4 space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-bold text-foreground">{t('project.detailsTitle')}</h2>
      </div>
      
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('project.name')}<span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={details.name}
            onChange={handleChange('name')}
            className={`w-full bg-background text-foreground placeholder:text-muted-foreground p-2 border rounded focus:ring-2 focus:ring-ring focus:border-primary transition-colors text-sm ${
              !nameValidation.isValid && details.name ? 'border-red-500' : 'border-border'
            }`}
            placeholder={t('project.namePlaceholder')}
          />
          {!nameValidation.isValid && details.name && (
            <p className="mt-1 text-xs text-red-600">{nameValidation.errorMessage}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {t('project.nameHint')}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('common.description')}
          </label>
          <textarea
            value={details.description}
            onChange={handleChange('description')}
            className="w-full bg-background text-foreground placeholder:text-muted-foreground p-2 border border-border rounded focus:ring-2 focus:ring-ring focus:border-primary transition-colors resize-none text-sm"
            placeholder={t('project.descriptionPlaceholder')}
            rows={2}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            {t('project.headerColor')}<span className="text-red-500">*</span>
          </label>
          <ColorField value={details.headerColor} label={t('project.headerColor')}
            onChange={headerColor => onChange({ ...details, headerColor })} />
        </div>
      </div>

      <div className="flex flex-wrap justify-between gap-2 pt-2">
        <Button
          onClick={onBack}
          variant="secondary"
          className="h-auto min-h-9 whitespace-normal break-words"
        >
          {t('common.back')}</Button>
        <Button
          onClick={onNext}
          disabled={!isValid}
          className="h-auto min-h-9 whitespace-normal break-words"
        >
          {t('common.next')}</Button>
      </div>
    </div>
  );
}