import { appAlert } from '@/app/services/appDialogs';
import { getProjectSession } from '@/app/commands/projectCommands';
import { t } from '@/app/i18n';
/**
 * Debug commands for development mode
 */

import { Window } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

/**
 * Reload the current window
 */
export async function reloadWindow(): Promise<void> {
  // Use location.reload() instead of window.reload()
  window.location.reload();
}

/**
 * Open developer tools
 */
export async function openDevTools(): Promise<void> {
  // Developer tools require a debug build.
  await appAlert(t('debug.devToolsUnavailable'));
}

/**
 * Clear console logs
 */
export function clearConsole(): void {
  console.clear();
}

/**
 * Log current window state
 */
export async function logWindowState(): Promise<void> {
  const window = await Window.getCurrent();
  const isMaximized = await window.isMaximized();
  const isMinimized = await window.isMinimized();
  const isFullscreen = await window.isFullscreen();
  const isVisible = await window.isVisible();
  const scaleFactor = await window.scaleFactor();

  console.log("Window State:", JSON.stringify({
    isMaximized,
    isMinimized,
    isFullscreen,
    isVisible,
    scaleFactor
  }, null, 2));
}

/**
 * Log current project state
 */
export async function logProjectState(): Promise<void> {
  try {
    const session = await getProjectSession();
    const hasProject = session !== null;
    const projectInfo = hasProject ? {
      name: await invoke("get_project_name"),
      description: await invoke("get_project_description"),
      path: await invoke("get_project_path"),
      headerColor: await invoke("get_project_header_color"),
      loadedTables: await invoke("get_loaded_tables", { expectedProjectSession: session!.id }),
      projectEntries: await invoke("get_project_entries", { expectedProjectSession: session!.id })
    } : null;

    console.log("Project State:", JSON.stringify({
      hasProject,
      projectInfo
    }, null, 2));
  } catch (error) {
    console.error("Failed to get project state:", error);
  }
}

/**
 * Log environment variables
 */
export function logEnvironment(): void {
  console.log("Environment:", JSON.stringify({
    NODE_ENV: import.meta.env.NODE_ENV,
    DEV: import.meta.env.DEV,
    PROD: import.meta.env.PROD,
    MODE: import.meta.env.MODE,
    BASE_URL: import.meta.env.BASE_URL,
    VITE_DEBUG: import.meta.env.VITE_DEBUG
  }, null, 2));
}

/**
 * Generate system information report
 */
export async function generateSystemReport(): Promise<void> {
  const window = await Window.getCurrent();
  const report = {
    timestamp: new Date().toISOString(),
    window: {
      isMaximized: await window.isMaximized(),
      isMinimized: await window.isMinimized(),
      isFullscreen: await window.isFullscreen(),
      isVisible: await window.isVisible(),
      scaleFactor: await window.scaleFactor()
    },
    environment: {
      NODE_ENV: import.meta.env.NODE_ENV,
      DEV: import.meta.env.DEV,
      PROD: import.meta.env.PROD,
      MODE: import.meta.env.MODE,
      BASE_URL: import.meta.env.BASE_URL,
      VITE_DEBUG: import.meta.env.VITE_DEBUG
    },
    userAgent: navigator.userAgent
  };

  console.log("System Report:", JSON.stringify(report, null, 2));
}