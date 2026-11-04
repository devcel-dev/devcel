import './welcome.css';
import { useI18n, t } from '@/app/i18n';
import { handleOpenProject, handleCreateProject, IMainWindowProps } from "@/app/pages/main_window/MainWindow";
import { Button } from "@/components/ui/button";
import { FolderPlus, FolderOpen } from "lucide-react";
import AnimatedBackgroundManager from "./backgrounds";

function WelcomeContent(props: IMainWindowProps) {
  useI18n();
  // Enable debug mode in development builds
  const isDebugMode = import.meta.env.DEV;

    return (
      <div className="relative h-full w-full overflow-hidden">
        {/* Three.js animated background */}
        <AnimatedBackgroundManager debugMode={isDebugMode} />
        
        {/* Content overlay */}
        <div className="relative z-10 flex h-full w-full flex-col items-center overflow-auto p-6">
        <div className="welcome-card my-auto shrink-0 max-w-full text-center space-y-8 rounded-2xl p-8">
          <div className="space-y-6">
            <h1>
              <span className="sr-only">{t('welcome.title')}</span>
              <img
                src="/brand/devcel-lockup-stacked-transparent.svg"
                alt=""
                aria-hidden="true"
                className="welcome-logo welcome-logo-light mx-auto h-auto w-48 select-none"
                draggable={false}
              />
              <img
                src="/brand/devcel-lockup-stacked-inverse.svg"
                alt=""
                aria-hidden="true"
                className="welcome-logo welcome-logo-dark mx-auto h-auto w-48 select-none"
                draggable={false}
              />
            </h1>
          </div>
          
          <div className="flex flex-wrap gap-6 justify-center">
            <Button 
              onClick={() => handleCreateProject(props)}
              className="welcome-action welcome-action-primary px-8 py-10 text-lg flex flex-col items-center gap-4"
              variant="ghost"
            >
              <FolderPlus size={32} />
              {t('welcome.newProject')}</Button>
            
            <Button 
              onClick={() => handleOpenProject(props)}
              className="welcome-action px-8 py-10 text-lg flex flex-col items-center gap-4"
              variant="ghost"
            >
              <FolderOpen size={32} />
              {t('menu.openProject')}</Button>
          </div>
        </div>
        </div>
      </div>
    );
  }

// Keep the background component identity stable across settings and plugin refreshes.
function WelcomeView(props: IMainWindowProps) {
  return (
    <div className="h-full overflow-hidden">
      {props.isOpenWizard ? null : <WelcomeContent {...props} />}
    </div>
  );
}

export default WelcomeView;
