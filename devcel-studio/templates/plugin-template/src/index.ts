import { Plugin, PluginAPI } from './types/pluginTypes';
import { createMenuExtensions } from './extensions/menuExtensions';
import { createToolbarExtensions } from './extensions/toolbarExtensions';
import { createExporterExtensions } from './extensions/exporterExtensions';

/**
 * Your Plugin Name
 *
 * Write your plugin description here.
 * Clearly explain what the plugin does and which features it provides.
 */
const YourPluginName: Plugin = {
  metadata: {
    id: 'your-plugin-name',
    apiVersion: '2.0.0',
    name: 'Your Plugin Name',
    version: '1.0.0',
    description: 'Description of what your plugin does',
    author: 'Your Name',
    homepage: 'https://github.com/your-username/your-plugin-name',
    repository: 'https://github.com/your-username/your-plugin-name.git',
    license: 'MIT',
    keywords: ['devcel', 'plugin', 'your-keywords'],
    // Supported stable hosts; plugin authors explicitly opt in to tested prerelease hosts.
    devcelVersion: '>=0.0.0'
  },

  extensions: {
    // Menu extensions
    menus: createMenuExtensions(),

    // Toolbar extensions
    toolbarButtons: createToolbarExtensions(),

    // Exporter extensions
    exporters: createExporterExtensions(),

    // Add other extensions here
    // contextMenus: createContextMenuExtensions(),
    // sidePanels: createSidePanelExtensions(),
    // importers: createImporterExtensions(),
    // themes: createThemeExtensions(),
  },

  hooks: {
    onInstall: async (api: PluginAPI) => {
      console.log('YourPluginName: Installing...');

      // Plugin installation handling
      // - Initialize default settings
      // - Create required resources

      // Preferences are authored as ordinary Devcel tables; no startup writes.

      api.ui.showNotification('YourPluginName installed successfully!', 'success');
    },

    onActivate: async (api: PluginAPI) => {
      console.log('YourPluginName: Activating...');

      // Plugin activation handling
      // - Register event listeners
      // - Initialize resources
      // - Register commands

      await registerCommands(api);
      await registerEventListeners(api);

      api.ui.showNotification('YourPluginName activated!', 'info');
    },

    onDeactivate: async (api: PluginAPI) => {
      console.log('YourPluginName: Deactivating...');

      // Plugin deactivation handling
      // - Remove event listeners
      // - Clean up resources

      await cleanupResources(api);

      api.ui.showNotification('YourPluginName deactivated', 'info');
    },

    onUninstall: async (api: PluginAPI) => {
      console.log('YourPluginName: Uninstalling...');

      // Plugin uninstallation handling
      // - Delete settings
      // - Clean up files

      // Uninstallation does not erase user-authored settings tables.

      api.ui.showNotification('YourPluginName uninstalled', 'info');
    },

    onProjectOpen: async (api: PluginAPI, project: any) => {
      console.log('YourPluginName: Project opened', project.name);

      // Project opened handling
      // - Project-specific initialization
      // - Load data
    },

    onProjectClose: async (api: PluginAPI, project: any) => {
      console.log('YourPluginName: Project closed', project.name);

      // Project closed handling
      // - Save data
      // - Clean up resources
    }
  },

  activate: async (api: PluginAPI) => {
    console.log('YourPluginName: activate() called');

    // The host invokes onActivate and activate exactly once per runtime activation.
    // Register lifecycle resources in that hook, never call it here.
    void api;
  },

  deactivate: async () => {
    console.log('YourPluginName: deactivate() called');

    // Main deactivation handling
    // Note: The API is not accessible here
  }
};

// Helper functions

/**
 * Register commands
 */
async function registerCommands(api: PluginAPI): Promise<void> {
  // Register a sample command
  api.ui.registerCommand('your-plugin-name.hello', () => {
    api.ui.showNotification('Hello from YourPluginName!', 'info');
  });

  api.ui.registerCommand('your-plugin-name.openSettings', () => {
    // Open the settings dialog
    console.log('Opening plugin settings...');
  });
}

/**
 * Register event listeners
 */
async function registerEventListeners(api: PluginAPI): Promise<void> {
  // Monitor project events
  const unsubscribeProject = api.events.on('project-opened', (project: unknown) => {
    console.log('Project opened in YourPluginName:', project);
  });

  // Monitor table events
  const unsubscribeTable = api.events.on('table-updated', (table: unknown) => {
    console.log('Table updated in YourPluginName:', table);
  });

  // Save cleanup functions
  (api as any)._yourPluginNameCleanup = () => {
    unsubscribeProject();
    unsubscribeTable();
  };
}

/**
 * Clean up resources
 */
async function cleanupResources(api: PluginAPI): Promise<void> {
  // Clean up event listeners
  if ((api as any)._yourPluginNameCleanup) {
    (api as any)._yourPluginNameCleanup();
    delete (api as any)._yourPluginNameCleanup;
  }
}

export default YourPluginName;
