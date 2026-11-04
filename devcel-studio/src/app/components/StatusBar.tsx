import { isSettingsEditor } from '@/app/applicationMode';
import { useI18n, t } from '@/app/i18n';
import { P2PStatusIndicator } from "./P2PStatusIndicator";
import { Folder, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";
import type { ProjectSession } from "../commands/projectCommands";
import { listen } from "@tauri-apps/api/event";

/**
 * Status bar component displayed at the bottom of the main window
 */
interface BackgroundLoadingEvent {
  project_session: string;
  table_name: string;
  current: number;
  total: number;
  progress: number;
}

export function StatusBar({ projectSession }: { projectSession: ProjectSession }) {
  useI18n();
  const projectName = projectSession.name;
  const [isLoadingTables, setIsLoadingTables] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState<BackgroundLoadingEvent | null>(null);

  useEffect(() => {
    let active = true;
    const loading = listen<BackgroundLoadingEvent>("background-table-loading", event => {
      if (!active || event.payload.project_session !== projectSession.id) return;
      setIsLoadingTables(true);
      setLoadingProgress(event.payload);
    });
    const complete = listen<{ project_session: string }>("background-table-loading-complete", event => {
      if (!active || event.payload.project_session !== projectSession.id) return;
      setIsLoadingTables(false);
      setLoadingProgress(null);
    });
    return () => {
      active = false;
      void loading.then(unlisten => unlisten());
      void complete.then(unlisten => unlisten());
    };
  }, [projectSession.id]);

  return (
    <div className="h-8 border-t bg-background px-3 flex items-center justify-between text-sm">
      {/* Left side - Project info */}
      <div className="flex items-center gap-4">
        {projectName && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Folder className="h-3.5 w-3.5" />
            <span>{projectName}</span>
          </div>
        )}

        {/* Background loading indicator */}
        {isLoadingTables && loadingProgress && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <div className="w-24 h-1 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${loadingProgress.progress}%` }}
              />
            </div>
            <span className="text-xs">
              {t('status.loadingTables', {current: loadingProgress.current, total: loadingProgress.total, name: loadingProgress.table_name})}
            </span>
          </div>
        )}
      </div>

      {/* Right side - Status indicators */}
      <div className="flex items-center gap-3">
        {!isSettingsEditor() && <P2PStatusIndicator />}
      </div>
    </div>
  );
}
