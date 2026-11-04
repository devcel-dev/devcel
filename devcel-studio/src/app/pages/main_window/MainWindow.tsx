import { isComposingKey, isModalTarget, isTextInputTarget, hasBlockingShortcutSurface } from '@/app/utils/shortcutGuards';
import { saveProjectWithNotification } from '@/app/utils/saveProjectNotification';
import { setMainWindowMode } from '@/app/utils/mainWindowGeometry';
import { SettingsApplyNotice } from '@/app/components/SettingsApplyNotice';
import { dismiss as dismissToast } from '@/components/ui/use-toast';
import { StringEditorHost } from '@/app/pages/string_editor/StringEditorHost';
import { useAppSettings } from '@/app/settings';
import { isSettingsEditor } from '@/app/applicationMode';
import { DEFAULT_PROJECT_HEADER_COLOR } from '@/app/config/brand';
import { installMainWindowCloseGuard, requestCloseStringEditor } from '@/app/utils/string_editor_window';
import { MarkdownRecoveryNotice } from '@/app/components/MarkdownRecoveryNotice';
import { flushMarkdownEdits, hasPendingMarkdownEdits } from '@/app/utils/markdownSaveLifecycle';
import { columnDraftStore, confirmColumnDraftDiscard } from '@/app/utils/columnDraftLifecycle';
import { useI18n, t, localizeError } from '@/app/i18n';
import { usePlugins } from '@/app/contexts/PluginContext';
import { PluginExtensionHost, PluginSidebar, runPluginAction } from '@/app/components/plugins/PluginExtensions';
import ProjectView from "@/app/pages/main_window/project_view/ProjectView";
import WelcomeView from "@/app/pages/main_window/welcome_view/WelcomeView";
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { listen } from '@tauri-apps/api/event';
import { PluginManager } from "@/app/services/PluginManager";
import { getProjectSession, type ProjectSession, openProject, closeProject } from "@/app/commands/projectCommands";
import { WindowHeader } from "@/app/components/common/WindowHeader";
import { showProjectCreateWizard } from "@/app/utils/project_create_wizard";
import { message } from '@/app/services/appDialogs';
import { open } from '@tauri-apps/plugin-dialog';
import { getWelcomeMenuConfig, getProjectMenuConfig } from "@/app/config/menuConfigs";
import { getPluginMenuGroup } from "@/app/config/pluginMenus";
import { checkForUpdatesOnStartup } from "@/app/utils/updater";
import { cancelTableLoads, setTableLoadingSession } from "@/app/commands/tableCommands";


export interface IMainWindowProps {
  hasProject: boolean;
  projectName: string;
  projectDescription: string;
  projectHeaderColor: string;
  isOpenWizard: boolean;
  setHasProject: (value: boolean) => void;
  setProjectName: (value: string) => void;
  setProjectDescription: (value: string) => void;
  setProjectHeaderColor: (value: string) => void;
  setIsOpenWizard: (value: boolean) => void;
  refreshProjectState: () => Promise<void>;
  runProjectOperation: (action: () => Promise<void>) => Promise<void>;
  beginProjectTransition: () => void;
}


export async function updateProjectState(props: IMainWindowProps) {
  await props.refreshProjectState();
}

/** A flush captures the currently known documents. Closing also drains any
 * document opened or dirtied while an earlier write was in flight. */
export async function flushAllMarkdownEditsForClose(): Promise<void> {
  do { await flushMarkdownEdits(); } while (hasPendingMarkdownEdits());
}

async function runDraftProtectedTransition(action: () => Promise<void>, onTransition?: () => void) {
  if (!await requestCloseStringEditor()) return;
  const session = await getProjectSession();
  if (session && !await confirmColumnDraftDiscard(session.id)) return;
  if (session) await flushMarkdownEdits(session.id);
  // A native/plugin project open while the question is visible cannot inherit this approval.
  if ((await getProjectSession())?.id !== session?.id) return;
  try {
    await action();
  } finally {
    // A cancelled wizard or failed open keeps the current session and its recoverable drafts.
    const current = await getProjectSession();
    if (session && current?.id !== session.id) {
      onTransition?.();
      columnDraftStore.discardSession(session.id);
    }
  }
}

export async function handleCreateProject(props: IMainWindowProps) {
  if (isSettingsEditor()) return;
  await props.runProjectOperation(() => runDraftProtectedTransition(showProjectCreateWizard, props.beginProjectTransition));
}

export async function handleOpenProject(props: IMainWindowProps) {
  if (isSettingsEditor()) return;
  await props.runProjectOperation(async () => {
    const selected = await open({
      directory: false,
      multiple: false,
      title: t('project.select'),
      filters: [{ name: t('project.fileFilter'), extensions: ["devcelproj.toml"] }]
    });
    if (selected && typeof selected === "string") {
      // Dismiss old editors/timers before replacing the backend project. Cancel leaves them intact.
      await runDraftProtectedTransition(async () => {
        props.beginProjectTransition();
        await openProject(selected);
      });
    }
  });
}

export async function handleCloseProject(props: IMainWindowProps) {
  if (isSettingsEditor()) return;
  await props.runProjectOperation(() => runDraftProtectedTransition(async () => {
    props.beginProjectTransition();
    await closeProject();
  }));
}

export function MainWindow() {
  useI18n();
  const settings = useAppSettings();
  const pluginExtensions = usePlugins();
  const { menus, activePlugins } = pluginExtensions;
  const [hasProject, setHasProject] = useState(false);
  useEffect(() => {
    if (!isSettingsEditor()) void setMainWindowMode(hasProject).catch(error => console.error('Unable to restore main window dimensions', error));
  }, [hasProject]);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectHeaderColor, setProjectHeaderColor] = useState(DEFAULT_PROJECT_HEADER_COLOR);
  const [isOpenWizard, setIsOpenWizard] = useState(false);
  const [projectSession, setProjectSession] = useState<ProjectSession | null>(null);
  // A visible save result belongs to the project that produced it.
  useEffect(() => { dismissToast('project-save'); }, [projectSession?.id]);
  const [isProjectTransitioning, setIsProjectTransitioning] = useState(false);
  const operationRunning = useRef(false);
  const pendingProjectRefresh = useRef(false);
  const stateRequest = useRef(0);
  const mounted = useRef(false);

  const refreshProjectState = useCallback(async () => {
    const request = ++stateRequest.current;
    const session = await getProjectSession();
    if (!mounted.current || request !== stateRequest.current) return;
    if (!isSettingsEditor()) PluginManager.getInstance().setHasProject(session !== null);
    setTableLoadingSession(session);
    setProjectSession(session);
    if (!operationRunning.current) setIsProjectTransitioning(false);
    setHasProject(session !== null);
    setProjectName(session?.name ?? "");
    setProjectDescription(session?.description ?? "");
    setProjectHeaderColor(session?.header_color ?? DEFAULT_PROJECT_HEADER_COLOR);
  }, []);

  const beginProjectTransition = useCallback(() => {
    ++stateRequest.current;
    cancelTableLoads();
    flushSync(() => setIsProjectTransitioning(true));
  }, []);

  const runProjectOperation = useCallback(async (action: () => Promise<void>) => {
    // A ref closes the same-render double-click gap; the picker itself is also single-flight.
    if (operationRunning.current) return;
    operationRunning.current = true;
    ++stateRequest.current;
    setIsOpenWizard(true);
    try {
      await action();
    } catch (error) {
      await message(t('project.operationFailed', {error: localizeError(error)}), { title: t('project.title'), kind: 'error' });
    } finally {
      try {
        // An event arriving during the final read requests another read; it cannot
        // supersede that read and accidentally release the old session's view.
        do {
          pendingProjectRefresh.current = false;
          await refreshProjectState();
        } while (mounted.current && pendingProjectRefresh.current);
      } catch (error) {
        console.error('Failed to retrieve project state:', error);
        // Never remount an unverified old session after a backend transition.
        if (mounted.current) { setTableLoadingSession(null); setProjectSession(null); setHasProject(false); }
        if (!isSettingsEditor()) PluginManager.getInstance().setHasProject(false);
      } finally {
        operationRunning.current = false;
        if (mounted.current) {
          setIsOpenWizard(false);
          setIsProjectTransitioning(false);
        }
      }
    }
  }, [refreshProjectState]);

  useEffect(() => {
    if (!isSettingsEditor()) void checkForUpdatesOnStartup().catch(error => console.warn("Startup update check failed. Retry from Help:", String(error)));
  }, []);

  const props: IMainWindowProps = {
    hasProject: hasProject,
    projectName: projectName,
    projectDescription: projectDescription,
    projectHeaderColor: projectHeaderColor,
    isOpenWizard: isOpenWizard,
    setProjectName: setProjectName,
    setProjectDescription: setProjectDescription,
    setProjectHeaderColor: setProjectHeaderColor,
    setHasProject: setHasProject,
    setIsOpenWizard: setIsOpenWizard,
    refreshProjectState,
    runProjectOperation,
    beginProjectTransition
  }

  const shortcutProps = useRef(props);
  useLayoutEffect(() => { shortcutProps.current = props; });
  useLayoutEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposingKey(event) || event.repeat || event.altKey || event.shiftKey
        || !(event.ctrlKey || event.metaKey) || isModalTarget(event.target) || hasBlockingShortcutSurface()) return;
      const current = shortcutProps.current;
      if (current.isOpenWizard || operationRunning.current) return;
      const value = event.key.toLowerCase();
      if (value === 's' && current.hasProject) {
        event.preventDefault(); event.stopPropagation(); void saveProjectWithNotification();
      } else if (!isSettingsEditor() && !isTextInputTarget(event.target) && (value === 'n' || value === 'o')) {
        event.preventDefault(); event.stopPropagation();
        void (value === 'n' ? handleCreateProject(current) : handleOpenProject(current));
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const invalidateRequests = () => { ++stateRequest.current; };
    void refreshProjectState().catch(console.error);
    // Native/plugin opens also replace the project without passing through the menu.
    const subscriptions = ['project-info-updated', 'project-opened', 'project-closed', 'project-modified']
      .map(event => listen(event, () => {
        if (operationRunning.current) {
          pendingProjectRefresh.current = true;
          return;
        }
        if (event === 'project-opened' || event === 'project-closed') beginProjectTransition();
        void refreshProjectState().catch(console.error);
      }));
    return () => {
      mounted.current = false;
      invalidateRequests();
      subscriptions.forEach(subscription => { void subscription.then(unlisten => unlisten()).catch(console.error); });
      cancelTableLoads();
    };
  }, [refreshProjectState, beginProjectTransition]);

  useEffect(() => installMainWindowCloseGuard(
    flushAllMarkdownEditsForClose,
    error => message(t('project.saveFailed', { error: localizeError(error) }), { title: t('project.title'), kind: 'error' }),
  ), []);

  // Select appropriate menu configuration based on current view
  const menuConfig = props.hasProject
    ? getProjectMenuConfig(props)
    : getWelcomeMenuConfig(props);

  const pluginMenu = getPluginMenuGroup(activePlugins, menus, t('menu.pluginActions'), runPluginAction, pluginExtensions);
  const extendedMenu = { groups: [...menuConfig.groups, ...(pluginMenu ? [pluginMenu] : [])] };

  return (
    <div className="flex flex-col h-screen">
      <WindowHeader {...props} menuConfig={extendedMenu} />
      {!isSettingsEditor() && <PluginExtensionHost />}
      <MarkdownRecoveryNotice />
      {isSettingsEditor() && <SettingsApplyNotice />}
      <StringEditorHost projectSessionId={projectSession?.id ?? null} />
      {(settings.migrationFailed || settings.warning) && <p role="alert" className="border-b border-destructive bg-destructive/10 text-foreground p-3 text-sm whitespace-pre-wrap break-words select-text shrink-0 max-h-40 overflow-auto">{settings.migrationFailed ? t('settings.migrationFailed') : settings.warning?.map(warning => localizeError(warning)).join('\n')}</p>}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!isSettingsEditor() && <PluginSidebar position="left" />}
        <div className="flex-1 min-w-0 overflow-auto" inert={isOpenWizard}>
          {isProjectTransitioning ? null : projectSession
            ? <ProjectView key={projectSession.id} projectSession={projectSession} />
            : isSettingsEditor() ? null : <WelcomeView {...props} />}
        </div>
        {!isSettingsEditor() && <PluginSidebar position="right" />}
      </div>
    </div>
  )
}
