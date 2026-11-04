import { randomProjectHeaderColor } from '@/app/config/brand';
import { useI18n, t, localizeError } from '@/app/i18n';
import { useState } from 'react';
import { createProject } from '@/app/commands/projectCommands';
import { ProjectConfirmation } from '@/app/pages/project_create_wizard/ProjectConfirmation';
import { ProjectDetailsForm } from '@/app/pages/project_create_wizard/ProjectDetailsForm';
import { FolderSelector } from '@/app/pages/project_create_wizard/FolderSelector';
import { ProjectCreateDetails } from '@/app/commands/projectCommands';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export function ProjectCreateWizard() {
  useI18n();
  return (
      <ProjectCreateWizardImpl />
  )
}

function ProjectCreateWizardImpl() {
  useI18n();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [projectDetails, setProjectDetails] = useState<ProjectCreateDetails>(() => ({
    path: '',
    name: '',
    description: '',
    headerColor: randomProjectHeaderColor()
  }));

  const handleNext = () => setStep(step + 1);
  const handleBack = () => setStep(step - 1);

  const handleSubmit = async () => {
    if (creating) return;
    setCreating(true); setError(null);
    try {
    await createProject(projectDetails);

    const currentWindow = await WebviewWindow.getByLabel('wizard');
    if (currentWindow) {
      if(await currentWindow.isClosable()) {
        await currentWindow.close();
      }
    }
    } catch (error) { setError(error); }
    finally { setCreating(false); }
  };

  return (
      <div className="min-h-screen bg-muted text-foreground">
        {/* Progress indicator */}
        <div className="px-4 py-3 bg-background shadow-sm border-b">
          <div className="flex items-center justify-between max-w-lg mx-auto">
            <div className={`flex items-center ${step >= 1 ? 'text-primary-ink' : 'text-muted-foreground'}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${step >= 1 ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                1
              </div>
              <span className="ml-1 text-xs font-medium hidden sm:inline">{t('project.stepLocation')}</span>
            </div>
            <div className={`flex-1 h-0.5 mx-2 ${step >= 2 ? 'bg-primary' : 'bg-muted'}`} />
            <div className={`flex items-center ${step >= 2 ? 'text-primary-ink' : 'text-muted-foreground'}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${step >= 2 ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                2
              </div>
              <span className="ml-1 text-xs font-medium hidden sm:inline">{t('project.stepDetails')}</span>
            </div>
            <div className={`flex-1 h-0.5 mx-2 ${step >= 3 ? 'bg-primary' : 'bg-muted'}`} />
            <div className={`flex items-center ${step >= 3 ? 'text-primary-ink' : 'text-muted-foreground'}`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${step >= 3 ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                3
              </div>
              <span className="ml-1 text-xs font-medium hidden sm:inline">{t('common.confirm')}</span>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-3">
          {error != null && <p role="alert" className="mb-3 text-red-600 break-words">{t('project.createFailed', {error: localizeError(error)})}</p>}
          <div className="bg-background rounded-lg shadow-sm">
            {step === 1 && (
            <FolderSelector
              value={projectDetails.path}
              onChange={(path) => setProjectDetails({...projectDetails, path})}
              onNext={handleNext}
            />
          )}
          {step === 2 && (
            <ProjectDetailsForm
              details={projectDetails}
              onChange={setProjectDetails}
              onBack={handleBack}
              onNext={handleNext}
            />
          )}
          {step === 3 && (
            <ProjectConfirmation
              details={projectDetails}
              onBack={handleBack}
              onSubmit={handleSubmit}
              creating={creating}
            />
            )}
          </div>
        </div>
      </div>
  );
}

export function ProjectWizardRoute() {
  useI18n();
  return (
    <div className="min-h-screen">
      <ProjectCreateWizard />
    </div>
  );
}