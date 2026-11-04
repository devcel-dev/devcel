// Actual plugin preference/permission UI with controlled native I/O (not native WebKit QA).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
const require = createRequire(import.meta.url);
const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-plugin-settings-ui-'));
const window = new Window({ url: 'http://plugin-settings.invalid/' });
for (const key of ['window','document','navigator','Event','CustomEvent','Node','HTMLElement','HTMLInputElement','MutationObserver','ResizeObserver','getComputedStyle','localStorage','requestAnimationFrame','cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : typeof window[key] === 'function' && ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(key) ? window[key].bind(window) : window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const calls = [];
globalThis.__calls = calls;
globalThis.__settings = { appVersion: '0.1.0', bundle: { values: { pluginCatalogUrl: 'https://catalog.example/plugins.json' }, pluginStates: { 'package-one': false } } };
globalThis.__packages = [{ metadata: { id: 'package-one', name: 'Package One', version: '1.0.0', apiVersion: '2.0.0', author: 'Author', description: 'Package', dependencies: {} }, digest: 'digest-one', permissions: ['full-app-access'], approved: true, enabled: true, canRollback: true, rollbackDigest: 'digest-old' }];
globalThis.__removed = [{ ...globalThis.__packages[0], metadata: { ...globalThis.__packages[0].metadata, id: 'removed-one', name: 'Removed One' }, digest: 'removed-digest', canRollback: false, rollbackDigest: null }];
globalThis.__ask = async () => false;
globalThis.__request = async (method,args) => { calls.push([method,args]); if(method==='packageRollback') return {metadata:{id:args.id,version:'0.9.0'}}; };
globalThis.__invoke = async (name, args) => {
  calls.push([name, args]);
  if (name === 'list_installed_plugin_packages') return structuredClone(globalThis.__packages);
  if (name === 'list_removed_plugin_packages') return structuredClone(globalThis.__removed);
  if (name === 'fetch_plugin_catalog') return { formatVersion: 1, plugins: [] };
  if (name === 'validate_plugin_catalog') return JSON.parse(args.json);
  throw Error('Unexpected invocation ' + name);
};
try {
  const out = path.join(temporary, 'ui.cjs');
  await build({ absWorkingDir: studio, stdin: { resolveDir: studio, loader: 'tsx', contents: `
export {PluginCatalogView} from './src/app/pages/plugin_manager/components/PluginCatalogView';
export {PluginDetailsView} from './src/app/pages/plugin_manager/components/PluginDetailsView';
export {PluginPackagePage} from './src/app/pages/plugin_packages/PluginPackagePage';
export * as React from 'react';export {createRoot} from 'react-dom/client';
` }, outfile: out, bundle: true, format: 'cjs', platform: 'node', jsx: 'automatic', alias: { '@': path.join(studio, 'src') }, plugins: [{ name: 'boundaries', setup(b) {
    const mocks = {
      '@/app/i18n': `export const t=k=>k;export const useI18n=()=>({locale:'en'});export const localizeError=String;export const toAppError=String;export const message=key=>({key});export const resolveMessage=m=>typeof m==='string'?m:m.key;export const formatNumber=String;export const formatDateTime=String;`,
      '@/app/settings': `export const useAppSettings=()=>globalThis.__settings;`,
      '@/app/utils/options': `export const showOptions=async()=>{globalThis.__calls.push(['open-settings']);};`,
      '@/app/utils/plugin_packages': `export const showPluginPackages=async()=>{};`,
      '@/app/services/PluginBridge': `export const PluginBridge={getInstance:()=>({subscribe:()=>()=>{}}),request:(...args)=>globalThis.__request(...args)};`,
      '@tauri-apps/api/core': `export const invoke=(...args)=>globalThis.__invoke(...args);`,
      '@tauri-apps/api/webviewWindow': `export const getCurrentWebviewWindow=()=>({onCloseRequested:async()=>()=>{}});`,
      '@tauri-apps/plugin-dialog': `export const open=async()=>null,save=async()=>null,ask=(...args)=>globalThis.__ask(...args);`,
      '@/app/services/appDialogs': `export const open=async()=>null,save=async()=>null,ask=(...args)=>globalThis.__ask(...args);export const message=async()=>{};export const appAlert=message;export const appConfirm=ask;export const appPrompt=async(...args)=>globalThis.prompt?.(...args)??null;`,
      '@tauri-apps/plugin-shell': `export const open=async()=>{};`,
      '@tauri-apps/plugin-fs': `export const readTextFile=async()=>'';`,
    };
    b.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mock' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path] }));
  }}] });
  const api = require(out), host = document.createElement('div'); document.body.append(host);
  let root = api.createRoot(host);
  const render = async component => api.React.act(async () => { root.render(component); await new Promise(resolve => setTimeout(resolve, 0)); });
  const click = async button => { assert(button); await api.React.act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const button = text => [...host.querySelectorAll('button')].find(item => item.textContent === text);
  localStorage.setItem('other-app.catalog-url', 'https://unrelated.example/ignored');
  await render(api.React.createElement(api.PluginCatalogView));
  assert.equal(host.querySelector('input[type=url]'), null);
  assert(host.textContent.includes('https://catalog.example/plugins.json'));
  assert(!host.textContent.includes('unrelated.example'));
  assert(!button('plugin.catalog.removeUrl'));
  await click(button('plugin.settings.openProject'));
  await click(button('plugin.catalog.fetch'));
  assert.deepEqual(calls.find(item => item[0] === 'fetch_plugin_catalog')[1], { url: 'https://catalog.example/plugins.json' });
  assert.equal(localStorage.getItem('other-app.catalog-url'), 'https://unrelated.example/ignored', 'unrelated preference is not read or mutated');
  await api.React.act(async () => root.unmount()); root = api.createRoot(host);
  let opened = 0;
  await render(api.React.createElement(api.PluginDetailsView, { plugin: { plugin: { metadata: globalThis.__packages[0].metadata, extensions: {} }, settings: { enabled: false }, status: 'inactive', loadTime: 0 }, onOpenSettings: async () => { opened++; }, onUninstall: async () => {} }));
  assert(![...host.querySelectorAll('[role=tab]')].some(tab => tab.textContent === 'plugin.details.settings'));
  assert(!button('plugin.activate')); assert(!button('plugin.deactivate'));
  await click(button('plugin.settings.openProject')); assert.equal(opened, 1);
  await api.React.act(async () => root.unmount()); root = api.createRoot(host);
  await render(api.React.createElement(api.PluginPackagePage));
  await click([...host.querySelectorAll('button')].find(item => item.textContent.includes('Package One')));
  assert(host.textContent.includes('plugin.package.executionAllowed'));
  assert(host.textContent.includes('plugin.disabled'), 'table false is shown independently of execution permission');
  assert(button('plugin.package.revokeExecution')); assert(button('plugin.settings.openProject'));
  await click(button('plugin.settings.openProject'));
  assert.equal(globalThis.__settings.bundle.pluginStates['package-one'], false);
  // Confirmation carries the displayed content and restore identities even if another process updates during ask.
  globalThis.__ask = async () => { globalThis.__packages[0].digest = 'new-during-confirmation'; return true; };
  await click(button('plugin.package.restorePrevious'));
  assert.deepEqual(calls.find(item => item[0] === 'packageRollback')[1], { id:'package-one', expectedDigest:'digest-one', expectedRestoreDigest:'digest-old' });
  globalThis.__ask = async () => { globalThis.__packages[0].digest = 'new-during-remove'; return true; };
  await click(button('plugin.package.remove'));
  assert.deepEqual(calls.find(item => item[0] === 'packageRemove')[1], { id:'package-one', expectedDigest:'new-during-confirmation' });
  globalThis.__ask = async () => true;
  await click(button('plugin.package.restoreDisabled'));
  assert.deepEqual(calls.filter(item => item[0] === 'packageRollback').at(-1)[1], { id:'removed-one', expectedDigest:null, expectedRestoreDigest:'removed-digest' });

  await api.React.act(async () => root.unmount());
  console.log('PASS: actual plugin UI has table entry points instead of preference forms; catalog uses project URL; package execution permission is separate from table selection. Synthetic DOM only.');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); await window.happyDOM.abort(); }

// Radix animation timers outlive the synthetic DOM. All assertions above completed.
process.exit(0);
