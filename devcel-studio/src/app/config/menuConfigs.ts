import { getVersion } from '@tauri-apps/api/app';
import { showThirdPartyLicenses } from '@/app/utils/third_party_licenses';
import { resetSettingsProject } from '@/app/settings';
import { isSettingsEditor } from '@/app/applicationMode';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { t, localizeError } from '@/app/i18n';
import { MenuConfiguration } from "@/app/types/menuTypes";
import { IMainWindowProps, handleCreateProject, handleOpenProject, handleCloseProject } from "@/app/pages/main_window/MainWindow";
import { showProjectEditDialog } from "@/app/utils/project_edit_dialog";
import { showAppUpdater } from "@/app/utils/updater";
import { showOptions } from '@/app/utils/options';
import { showPluginManager } from "@/app/utils/plugin_manager";
import { isDevelopmentMode } from "@/app/utils/development";
import {
  reloadWindow,
  openDevTools,
  clearConsole,
  logWindowState,
  logProjectState,
  logEnvironment,
  generateSystemReport
} from "@/app/utils/debugCommands";
import { saveProjectWithNotification } from '@/app/utils/saveProjectNotification';
import { ask, message } from '@/app/services/appDialogs';

import { open as openUrl } from '@tauri-apps/plugin-shell';

export function getWelcomeMenuConfig(props: IMainWindowProps): MenuConfiguration {
  if (isSettingsEditor()) return getSettingsEditorMenuConfig(props);
  const groups = [
    {
      id: 'file',
      label: t('menu.file'),
      actions: [
        {
          label: t('menu.newProject'), shortcut: 'Ctrl+N',
          onClick: () => handleCreateProject(props)
        },
        {
          label: t('menu.openProject'), shortcut: 'Ctrl+O',
          onClick: () => handleOpenProject(props)
        }
      ]
    },
    { id: 'view', label: t('menu.view'), actions: [optionsAction(), resetSettingsAction()] },
    {
      id: 'help',
      label: t('menu.help'),
      actions: [
        { label: t('menu.ossLicenses'), onClick: async () => {
          try { await showThirdPartyLicenses(); }
          catch (error) { await message(localizeError(error), { title: t('menu.ossLicenses'), kind: 'error' }); }
        } },
        {
          label: t('menu.about'),
          onClick: async () => {
            try {
              const version = await getVersion();
              await message(`Devcel Studio v${version}\n\n${t('menu.aboutText')}`, { title: t('menu.about'), kind: 'info' });
            } catch (error) {
              console.error('[About] Unable to read application version', error);
              await message(localizeError(error), { title: t('menu.about'), kind: 'error' });
            }
          }
        },
        {
          label: t('menu.update'),
          onClick: async () => {
            try { await showAppUpdater(); }
            catch (error) { await message(t('menu.openUpdateFailed', {error: localizeError(error)}), { title: t('file.updated'), kind: 'error' }); }
          }
        },
        {
          label: t('menu.documentation'),
          onClick: async () => {
            await openUrl('https://github.com/devcel-dev/devcel');
          }
        }
      ]
    }
  ];

  // Add debug menu only in development mode
  if (isDevelopmentMode()) {
    groups.push({
      id: 'debug',
      label: t('menu.debug'),
      actions: [
        {
          label: t('menu.reloadWindow'),
          onClick: async () => reloadWindow()
        },
        {
          label: t('menu.devTools'),
          onClick: async () => openDevTools()
        },
        {
          label: t('menu.clearConsole'),
          onClick: async () => clearConsole()
        },
        {
          label: t('menu.logWindow'),
          onClick: async () => logWindowState()
        },
        {
          label: t('menu.logEnvironment'),
          onClick: async () => logEnvironment()
        },
        {
          label: t('menu.systemReport'),
          onClick: async () => generateSystemReport()
        }
      ]
    });
  }

  return { groups };
}

export function getProjectMenuConfig(props: IMainWindowProps): MenuConfiguration {
  if (isSettingsEditor()) return getSettingsEditorMenuConfig(props);
  const groups = [
    {
      id: 'file',
      label: t('menu.file'),
      actions: [
        {
          label: t('menu.newProject'), shortcut: 'Ctrl+N',
          onClick: () => handleCreateProject(props)
        },
        {
          label: t('menu.openProject'), shortcut: 'Ctrl+O',
          onClick: () => handleOpenProject(props)
        },
        {
          label: t('menu.saveProject'), shortcut: 'Ctrl+S',
          onClick: saveProjectWithNotification,
          disabled: !props.hasProject
        },
        {
          label: t('menu.closeProject'),
          onClick: () => handleCloseProject(props),
          disabled: !props.hasProject,
          separator: true
        }
      ]
    },
    {
      id: 'edit',
      label: t('common.edit'),
      actions: [
        {
          label: t('menu.editProject'),
          onClick: () => showProjectEditDialog(),
          disabled: !props.hasProject
        },
        {
          label: t('menu.undo'),
          onClick: () => {
            window.dispatchEvent(new CustomEvent('devcel-undo'));
          },
          disabled: !props.hasProject,
          separator: true
        },
        {
          label: t('menu.redo'),
          onClick: () => {
            window.dispatchEvent(new CustomEvent('devcel-redo'));
          },
          disabled: !props.hasProject
        }
      ]
    },
    {
      id: 'view',
      label: t('menu.view'),
      actions: [
        {
          label: t('menu.fileBrowser'),
          onClick: async () => {
            window.dispatchEvent(new CustomEvent('devcel-toggle-file-browser'));
          },
          disabled: !props.hasProject
        },
        {
          label: t('menu.properties'),
          onClick: async () => {
            window.dispatchEvent(new CustomEvent('devcel-toggle-properties-panel'));
          },
          disabled: !props.hasProject
        },
        { ...optionsAction(), separator: true },
        resetSettingsAction()
      ]
    },
    {
      id: 'tools',
      label: t('menu.tools'),
      actions: [
        {
          label: t('menu.plugins'),
          onClick: async () => showPluginManager(),
          separator: true
        }
      ]
    },
    {
      id: 'help',
      label: t('menu.help'),
      actions: [
        { label: t('menu.ossLicenses'), onClick: async () => {
          try { await showThirdPartyLicenses(); }
          catch (error) { await message(localizeError(error), { title: t('menu.ossLicenses'), kind: 'error' }); }
        } },
        {
          label: t('menu.about'),
          onClick: async () => {
            try {
              const version = await getVersion();
              await message(`Devcel Studio v${version}\n\n${t('menu.aboutText')}`, { title: t('menu.about'), kind: 'info' });
            } catch (error) {
              console.error('[About] Unable to read application version', error);
              await message(localizeError(error), { title: t('menu.about'), kind: 'error' });
            }
          }
        },
        {
          label: t('menu.update'),
          onClick: async () => {
            try { await showAppUpdater(); }
            catch (error) { await message(t('menu.openUpdateFailed', {error: localizeError(error)}), { title: t('file.updated'), kind: 'error' }); }
          }
        },
        {
          label: t('menu.documentation'),
          onClick: async () => {
            await openUrl('https://github.com/devcel-dev/devcel');
          }
        }
      ]
    }
  ];

  // Add debug menu only in development mode
  if (isDevelopmentMode()) {
    groups.push({
      id: 'debug',
      label: t('menu.debug'),
      actions: [
        {
          label: t('menu.reloadWindow'),
          onClick: async () => reloadWindow()
        },
        {
          label: t('menu.devTools'),
          onClick: async () => openDevTools()
        },
        {
          label: t('menu.clearConsole'),
          onClick: async () => clearConsole()
        },
        {
          label: t('menu.logWindow'),
          onClick: async () => logWindowState()
        },
        {
          label: t('menu.logProject'),
          onClick: async () => logProjectState()
        },
        {
          label: t('menu.logEnvironment'),
          onClick: async () => logEnvironment()
        },
        {
          label: t('menu.systemReport'),
          onClick: async () => generateSystemReport()
        }
      ]
    });
  }

  return { groups };
}
function optionsAction() {
  return {
    label: t('options.title'),
    onClick: async () => {
      try { await showOptions(); }
      catch (error) { await message(t('options.openFailed', { error: localizeError(error) }), { title: t('common.error'), kind: 'error' }); }
    }
  };
}

/** The private settings project keeps ordinary editing without project switching. */
function getSettingsEditorMenuConfig(props: IMainWindowProps): MenuConfiguration {
  return { groups: [
    { id: 'file', label: t('menu.file'), actions: [
      { label: t('menu.saveProject'), shortcut: 'Ctrl+S', disabled: !props.hasProject, onClick: saveProjectWithNotification },
      { label: t('common.close'), onClick: async () => { await getCurrentWindow().close(); } },
    ] },
    { id: 'edit', label: t('common.edit'), actions: [
      { label: t('menu.undo'), disabled: !props.hasProject, onClick: () => { window.dispatchEvent(new CustomEvent('devcel-undo')); } },
      { label: t('menu.redo'), disabled: !props.hasProject, onClick: () => { window.dispatchEvent(new CustomEvent('devcel-redo')); } },
    ] },
    { id: 'view', label: t('menu.view'), actions: [
      { label: t('menu.fileBrowser'), onClick: () => { window.dispatchEvent(new CustomEvent('devcel-toggle-file-browser')); } },
      { label: t('menu.properties'), onClick: () => { window.dispatchEvent(new CustomEvent('devcel-toggle-properties-panel')); } },
    ] },
  ] };
}

function resetSettingsAction() {
  return { label: t('settings.resetProject'), onClick: async () => {
    if (isSettingsEditor()) return;
    if (!await ask(t('settings.resetProjectConfirm'), { title: t('settings.resetProject'), kind: 'warning' })) return;
    try { await resetSettingsProject(); }
    catch (error) { await message(localizeError(error), { title: t('common.error'), kind: 'error' }); }
  } };
}
