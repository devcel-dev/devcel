import * as pluginFs from '@tauri-apps/plugin-fs';
// These modules are already eager dependencies. Keep the asynchronous operation
// boundaries below so session and cancellation checks retain their ordering.
import { message, localizedError, toAppError } from '@/app/i18n';
import * as React from 'react';
import * as JSXRuntime from 'react/jsx-runtime';
import { Plugin } from '@/app/types/pluginTypes';

export interface PluginLoadResult {
  success: boolean;
  plugin?: Plugin;
  error?: Error;
  source: 'file' | 'url' | 'inline';
}

export class PluginLoader {
  private static instance: PluginLoader;

  private constructor() {}

  public static getInstance(): PluginLoader {
    if (!PluginLoader.instance) {
      PluginLoader.instance = new PluginLoader();
    }
    return PluginLoader.instance;
  }

  // Load a plugin from a JavaScript file
  public async loadFromFile(filePath: string, trusted = false): Promise<PluginLoadResult> {
    try {
      if (!trusted) throw localizedError(message('plugin.loader.trustRequired'));
      // Read only after trust approval; local file URLs are not executable imports in a Webview.
      const code = await this.readFileContent(filePath);
      const plugin = this.executePluginCode(code, filePath);

      this.validatePlugin(plugin);

      return {
        success: true,
        plugin,
        source: 'file'
      };
    } catch (error) {
      return {
        success: false,
        error: error as Error,
        source: 'file'
      };
    }
  }

  // Load a plugin from a URL
  public async loadFromUrl(url: string, trusted = false): Promise<PluginLoadResult> {
    try {
      if (!trusted) throw localizedError(message('plugin.loader.trustRequired'));
      // Load the script dynamically from the URL
      const response = await fetch(url);
      if (!response.ok) {
        throw localizedError(message('plugin.loader.fetchFailed', { url, status: response.statusText }));
      }

      const code = await response.text();
      const plugin = this.executePluginCode(code, url);

      this.validatePlugin(plugin);

      return {
        success: true,
        plugin,
        source: 'url'
      };
    } catch (error) {
      return {
        success: false,
        error: error as Error,
        source: 'url'
      };
    }
  }

  // Load a plugin from inline code
  public async loadFromCode(code: string, identifier: string, trusted = false): Promise<PluginLoadResult> {
    try {
      if (!trusted) throw localizedError(message('plugin.loader.trustRequired'));
      const plugin = this.executePluginCode(code, identifier);

      this.validatePlugin(plugin);

      return {
        success: true,
        plugin,
        source: 'inline'
      };
    } catch (error) {
      return {
        success: false,
        error: error as Error,
        source: 'inline'
      };
    }
  }

  // Execute the code to get the plugin object
  private executePluginCode(code: string, source: string): Plugin {
    try {
      // new Function is NOT a sandbox. Trusted code has the same global, file,
      // network and Tauri access as the application. Never use this for preview.
      const require = (name: string) => {
        if (name === 'react') return React;
        if (name === 'react/jsx-runtime') return JSXRuntime;
        throw localizedError(message('plugin.loader.bundleDependency', { name }));
      };
      const bindings = { React, require, console, JSON, Date, Math, Object, Array, String, Number,
        Boolean, RegExp, Error, parseInt, parseFloat, isNaN, isFinite };
      const func = new Function(...Object.keys(bindings), `
        'use strict';
        const module = { exports: {} };
        const exports = module.exports;
        // Bundles may declare const React/JSON/etc.; keep host bindings in the outer scope.
        {
          ${code}
          // Resolve exports in the same lexical scope as the plugin declaration.
          if (typeof plugin !== 'undefined') return plugin;
          if (typeof module !== 'undefined' && module.exports) return module.exports;
          throw ${JSON.stringify(toAppError(message('plugin.loader.noExport')))};
        }
      `);

      const result = func(...Object.values(bindings));
      return result?.default || result?.plugin || result;
    } catch (error) {
      throw localizedError(message('plugin.loader.executeFailed', { source, error: toAppError(error) }));
    }
  }

  // Validate the plugin
  private validatePlugin(plugin: Plugin): void {
    if (!plugin) {
      throw localizedError(message('plugin.loader.missingPlugin'));
    }

    if (!plugin.metadata) {
      throw localizedError(message('plugin.loader.metadataRequired'));
    }

    const requiredFields = ['id', 'name', 'version', 'description', 'author'];
    for (const field of requiredFields) {
      if (!plugin.metadata[field as keyof typeof plugin.metadata]) {
        throw localizedError(message('plugin.loader.fieldRequired', { field }));
      }
    }

    if (typeof plugin.activate !== 'function') {
      throw localizedError(message('plugin.loader.activateRequired'));
    }

    if (typeof plugin.deactivate !== 'function') {
      throw localizedError(message('plugin.loader.deactivateRequired'));
    }

    // Validate the version format
    const versionRegex = /^\d+\.\d+\.\d+/;
    if (!versionRegex.test(plugin.metadata.version)) {
      throw localizedError(message('plugin.loader.semanticVersion'));
    }

    // Validate the ID
    const idRegex = /^[a-z0-9\-_.]+$/;
    if (!idRegex.test(plugin.metadata.id)) {
      throw localizedError(message('plugin.loader.validId'));
    }
  }

  // Read the file contents
  private async readFileContent(filePath: string): Promise<string> {
    try {
      const { readTextFile } = await Promise.resolve().then(() => pluginFs);
      return await readTextFile(filePath);
    } catch (error) {
      console.error(`Failed to read file ${filePath}:`, error);
      throw error;
    }
  }

}
