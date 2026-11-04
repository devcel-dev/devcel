import { MenuConfiguration } from './menuTypes';
import { ReactNode, ComponentType } from 'react';
import type { TableData } from './tableTypes';

// Plugin metadata
export interface PluginMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  apiVersion: '2.0.0'; // plugin API version
  devcelVersion?: string; // Supported Devcel version
}

// Plugin settings
export interface PluginSettings {
  enabled: boolean;
}

// Extension points a plugin can provide
export interface PluginExtensions {
  // Menu extensions
  menus?: {
    [menuId: string]: MenuConfiguration;
  };

  // Toolbar extensions
  toolbarButtons?: ToolbarButton[];

  // Context menu extensions
  contextMenus?: {
    [contextId: string]: ContextMenuItem[];
  };

  // Side panel extensions
  sidePanels?: SidePanel[];

  // Dialog extensions
  dialogs?: Dialog[];

  // Data processing extensions
  dataProcessors?: DataProcessor[];

  // Exporter extensions
  exporters?: DataExporter[];

  // Importer extensions
  importers?: DataImporter[];

  // Theme extensions
  themes?: Theme[];

}

// Toolbar button definition
export interface ToolbarButton {
  id: string;
  label: string;
  icon?: ReactNode;
  tooltip?: string;
  onClick: () => void | Promise<void>;
  isVisible?: () => boolean;
  isEnabled?: () => boolean;
  position?: 'left' | 'center' | 'right';
  order?: number;
}

// Context menu item
export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick: (context: any) => void | Promise<void>;
  isVisible?: (context: any) => boolean;
  isEnabled?: (context: any) => boolean;
  separator?: boolean;
}

// Side panel
export interface SidePanel {
  id: string;
  title: string;
  icon?: ReactNode;
  component: ReactNode;
  position?: 'left' | 'right';
  defaultWidth?: number;
  isVisible?: () => boolean;
  order?: number;
}

// Dialog
export interface Dialog {
  id: string;
  title: string;
  component: ReactNode;
  width?: number;
  height?: number;
  resizable?: boolean;
  modal?: boolean;
}

// Data processor
export interface DataProcessor {
  id: string;
  name: string;
  description: string;
  supportedTypes: string[];
  process: (data: any, options?: any) => Promise<any>;
}

// Data exporter
export interface DataExporter {
  id: string;
  name: string;
  description: string;
  fileExtension: string;
  mimeType: string;
  export: (data: TableData, options?: any) => Promise<Blob | string>;
  getOptions?: () => any[];
}

// Data importer
export interface DataImporter {
  id: string;
  name: string;
  description: string;
  supportedExtensions: string[];
  supportedMimeTypes: string[];
  import: (file: File, options?: any) => Promise<any>;
  getOptions?: () => any[];
}

/** Complete semantic color tokens supplied by every plugin theme. */
export type ThemeColorToken =
  | 'accent'
  | 'accent-foreground'
  | 'background'
  | 'border'
  | 'card'
  | 'card-foreground'
  | 'destructive'
  | 'destructive-foreground'
  | 'foreground'
  | 'input'
  | 'muted'
  | 'muted-foreground'
  | 'popover'
  | 'popover-foreground'
  | 'primary'
  | 'primary-foreground'
  | 'primary-ink'
  | 'ring'
  | 'secondary'
  | 'secondary-foreground';

// Theme
export interface Theme {
  id: string;
  name: string;
  description: string;
  type: 'light' | 'dark' | 'auto';
  colors: Record<ThemeColorToken, string>;
  cssVariables?: Record<`--${string}`, string>;
}

/** Singleton table cells use native scalar values; 64-bit integers stay strings. */
export type PluginSettingValue = string | number | boolean | null;
/** Keys are local tableId.columnName pairs, never another plugin's owner ID. */
export type PluginSettingValues = Record<string, PluginSettingValue>;
export interface PluginSettingRow<T extends Record<string, PluginSettingValue> = Record<string, PluginSettingValue>> { readonly id: string; readonly values: Readonly<T> }

/** A project open-instance, captured before reading or editing its tables. */
export interface PluginProject {
  sessionId: string;
  path: string;
  name: string;
  description: string;
  headerColor: string;
}

// Plugin API available to plugins
export interface PluginAPI {
  /** Resources and subscriptions are scoped to this plugin ID. */
  i18n: {
    getLocale: () => string;
    subscribe: (callback: (locale: string) => void) => () => void;
    registerMessages: (messages: Record<string, Record<string, string>>) => () => void;
    t: (key: string, values?: Record<string, string | number | Date>, fallback?: string) => string;
  };
  // Application information
  app: {
    version: string;
    name: string;
    getState: () => { hasProject: boolean; activeTable: { uuid: string; projectSession: string } | null };
  };

  // Project operations
  project: {
    getCurrent: () => Promise<PluginProject | null>;
    // Projects open in this window: Zero or one, not project history.
    getAll: () => Promise<PluginProject[]>;
    create: (config: any) => Promise<void>;
    open: (path: string) => Promise<void>;
    save: () => Promise<void>;
    close: () => Promise<void>;
  };

  // UI operations
  ui: {
    showNotification: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
    showDialog: (dialogId: string, props?: any) => Promise<any>;
    showSaveDialog: (options?: any) => Promise<string | null>;
    showModal: <P extends object>(component: ComponentType<P>, props?: Omit<P, 'onClose' | 'onConfirm'> & { title?: string }) => Promise<any>;
    registerCommand: (id: string, handler: Function) => void;
    executeCommand: (id: string, ...args: any[]) => Promise<any>;
  };

  // Data operations
  data: {
    getTable: (tableUuid: string, expectedProjectSession: string) => Promise<TableData>;
    getTableSnapshot: (tableUuid: string, expectedProjectSession: string) => Promise<{ table: TableData; revision: string }>;
    updateTable: (tableUuid: string, data: TableData, expectedProjectSession: string, expectedRevision: string) => Promise<void>;
    createTable: (config: { path: string }, expectedProjectSession: string) => Promise<string>;
    deleteTable: (tableUuid: string, expectedProjectSession: string) => Promise<void>;
  };

  // Settings operations
  settings: {
    /** Read one declared singleton table from this plugin owner only. */
    getTable: <T extends Record<string, PluginSettingValue> = Record<string, PluginSettingValue>>(tableId: string) => Readonly<T>;
    /** Read a declared multirow table, preserving stable row identities. */
    getRows: <T extends Record<string, PluginSettingValue> = Record<string, PluginSettingValue>>(tableId: string) => readonly PluginSettingRow<T>[];
    watchRows: (tableId: string, callback: (value: readonly PluginSettingRow[]) => void) => () => void;
    watchTable: (tableId: string, callback: (value: Readonly<Record<string, PluginSettingValue>>) => void) => () => void;
    get: <K extends keyof PluginSettingValues>(key: K) => PluginSettingValues[K];
    getAll: () => Readonly<Partial<PluginSettingValues>>;
    watch: <K extends keyof PluginSettingValues>(key: K, callback: (value: PluginSettingValues[K]) => void) => () => void;
  };

  // File system operations
  fs: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
    mkdir: (path: string) => Promise<void>;
    readDir: (path: string) => Promise<string[]>;
  };

  // Event system
  events: {
    on: (event: string, handler: Function) => () => void;
    emit: (event: string, ...args: any[]) => void;
    once: (event: string, handler: Function) => void;
  };
}

// Plugin lifecycle hooks
export interface PluginHooks {
  onInstall?: (api: PluginAPI) => Promise<void>;
  onActivate?: (api: PluginAPI) => Promise<void>;
  onDeactivate?: (api: PluginAPI) => Promise<void>;
  onUninstall?: (api: PluginAPI) => Promise<void>;
  onProjectOpen?: (api: PluginAPI, project: any) => Promise<void>;
  onProjectClose?: (api: PluginAPI, project: any) => Promise<void>;
  onTableCreate?: (api: PluginAPI, table: any) => Promise<void>;
  onTableUpdate?: (api: PluginAPI, table: any) => Promise<void>;
  onTableDelete?: (api: PluginAPI, table: any) => Promise<void>;
}

// Main plugin interface
export interface Plugin {
  metadata: PluginMetadata;
  extensions?: PluginExtensions;
  hooks?: PluginHooks;
  activate: (api: PluginAPI) => Promise<void>;
  deactivate: () => Promise<void>;
}

// Plugin loader settings
export interface PluginLoaderConfig {
  autoLoad: boolean;
}

// Plugin state
export type PluginStatus = 'installed' | 'active' | 'inactive' | 'error' | 'loading';

// Plugin registry entry
export interface PluginRegistryEntry {
  plugin: Plugin;
  status: PluginStatus;
  settings: PluginSettings;
  error?: Error;
  loadTime?: number;
}

// Plugin event
export interface PluginEvent {
  type: 'installed' | 'activated' | 'deactivated' | 'uninstalled' | 'error';
  pluginId: string;
  plugin?: Plugin;
  error?: Error;
  timestamp: number;
}
