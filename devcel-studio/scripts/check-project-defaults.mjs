// Real wizard steps, shared controls and theme owner; native create/pickers are fixtures.
// Class/token and synthetic DOM checks are not native window paint or clipping proof.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { wizardSettingsImporter } from './test-file-filters.cjs';
import { Window } from 'happy-dom';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(studio, '.project-defaults-'));
const win = new Window({ url: 'http://project-defaults.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? win : win[name] });
}
globalThis.getComputedStyle = win.getComputedStyle.bind(win);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const host = document.createElement('div'); document.body.append(host);
const root = createRoot(host);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const errors = [], previousError = console.error, previousWarn = console.warn;
console.error = (...args) => errors.push(args.join(' '));
console.warn = (...args) => errors.push(args.join(' '));
globalThis.__projectCreates = [];
globalThis.__projectColorDraws = 0;
globalThis.__projectWindowCloses = 0;
globalThis.__projectFolder = null;
globalThis.__projectThemes = [];
globalThis.__projectSettings = { revision: 'same', bundle: { values: { theme: 'dark', pluginTheme: '' }, themes: [] } };
const mediaListeners = new Set();
const media = { matches: false, addEventListener: (_, cb) => mediaListeners.add(cb), removeEventListener: (_, cb) => mediaListeners.delete(cb) };
win.matchMedia = () => media;

try {
  const result = await build({
    absWorkingDir: studio,
    stdin: { contents: `
      export {ProjectCreateWizard} from './src/app/pages/project_create_wizard/ProjectCreateWizard';
      export {AppTheme} from './src/app/settings/AppTheme';
      export {readDialogTheme} from './src/app/settings/dialogTheme';
      export {showProjectCreateWizard} from './src/app/utils/project_create_wizard';
      export {randomProjectHeaderColor, THEME_COLOR_TOKENS} from './src/app/config/brand';
    `, resolveDir: studio, loader: 'tsx' },
    bundle: true, format: 'esm', platform: 'node', packages: 'external', write: false,
    alias: { '@': path.join(studio, 'src') },
    plugins: [{ name: 'boundaries', setup(builder) {
      const mocks = {
        '@/app/config/brand': `export {THEME_COLOR_TOKENS, themeCssVariables} from ${JSON.stringify(path.join(studio, 'src/app/config/brand.ts'))}; export const randomProjectHeaderColor=()=>{globalThis.__projectColorDraws++;return '#A895DB';};`,
        '@/app/i18n': `export const t=k=>k;export const useI18n=()=>({t});export const localizeError=String;`,
        '@/app/utils/validation': `export const validateDataName=name=>({isValid:/^[A-Za-z][A-Za-z0-9_]*$/.test(name)});`,
        '@/app/components/color/ColorField': `import React from 'react';export const ColorField=({value,onChange})=>React.createElement('button',{'data-color':value,onClick:()=>onChange('#123456')},'choose-color');`,
        '@/app/commands/projectCommands': `export const createProject=async details=>{globalThis.__projectCreates.push({...details});await globalThis.__projectCreateAction?.();};`,
        '@/app/contexts/PluginContext': `export const useThemes=()=>globalThis.__projectThemes;`,
        'settings-fixture': `export const useAppSettings=()=>globalThis.__projectSettings;export const getSettingsSnapshot=useAppSettings;`,
        '@tauri-apps/plugin-dialog': `export const open=async()=>globalThis.__projectFolder;`,
        '@tauri-apps/api/webviewWindow': `export class WebviewWindow {
          constructor(label,options){globalThis.__projectWindow={label,options};}
          async once(name,cb){if(name==='tauri://created')queueMicrotask(cb);return()=>{};}
          async onCloseRequested(cb){globalThis.__projectNativeClose=cb;return()=>{};}
          async close(){globalThis.__projectWindowCloses++;}
          static async getByLabel(){return{isClosable:async()=>true,close:async()=>{globalThis.__projectWindowCloses++;}};}
        }`,
      };
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path === './index' && wizardSettingsImporter.test(args.importer)) {
          return { path: 'settings-fixture', namespace: 'boundary' };
        }
        return Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'boundary' } : undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: mocks[args.path], loader: 'js', resolveDir: studio }));
    } }],
  });
  const file = path.join(temporary, 'wizard.mjs');
  await writeFile(file, result.outputFiles[0].text);
  const api = await import(pathToFileURL(file));
  const render = async element => React.act(async () => { root.render(element); await tick(); });
  const button = text => {
    const found = [...host.querySelectorAll('button')].find(el => el.textContent === text);
    assert(found, `button ${text}`); return found;
  };
  const click = async text => React.act(async () => { button(text).click(); await tick(); });
  const setName = async value => React.act(async () => {
    const input = host.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); await tick();
  });
  const themedWizard = () => React.createElement(React.Fragment, null, React.createElement(api.AppTheme), React.createElement(api.ProjectCreateWizard));
  const palette = new Set(Array.from({ length: 8 }, (_, index) => api.randomProjectHeaderColor(() => index / 8)));
  assert.equal(palette.size, 8);
  for (const color of palette) {
    assert.match(color, /^#[0-9A-F]{6}$/);
    const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
    assert(Math.min(...channels) > 0.3 && Math.max(...channels) > 0.7, 'initial colors remain reasonably bright');
  }

  await render(themedWizard());
  assert(document.documentElement.classList.contains('dark'));
  assert.equal(document.documentElement.style.colorScheme, 'dark');
  assert(host.firstElementChild.classList.contains('bg-muted'));
  assert(host.firstElementChild.classList.contains('text-foreground'));
  assert.equal(globalThis.__projectColorDraws, 1);
  await click('common.browse');
  assert.equal(host.querySelector('input').value, '');
  assert(button('common.next').disabled, 'cancelled folder picker cannot advance or create');
  assert.equal(globalThis.__projectCreates.length, 0);
  globalThis.__projectFolder = '/qa/new-project';
  await click('common.browse'); await click('common.next');
  const initial = host.querySelector('[data-color]').dataset.color;
  await setName('BrightProject');
  assert.equal(host.querySelector('textarea').value, '');
  assert.equal(button('common.next').disabled, false, 'description is optional');
  for (const field of host.querySelectorAll('input,textarea')) {
    assert(field.classList.contains('bg-background') && field.classList.contains('text-foreground'), 'fields pair semantic surface and text');
  }
  await click('common.next');
  assert(host.textContent.includes('/qa/new-project/BrightProject'));
  assert(host.textContent.includes(initial));
  const back = button('common.back'), create = button('project.create');
  assert(back.classList.contains('bg-secondary') && back.classList.contains('text-secondary-foreground'), 'confirmation Back pairs secondary tokens');
  assert(create.classList.contains('bg-primary') && create.classList.contains('text-primary-foreground'), 'Create uses the shared primary theme');
  for (const control of [back, create]) {
    assert(!control.classList.contains('text-white'));
    assert(control.classList.contains('whitespace-normal') && control.classList.contains('h-auto'), 'translated actions may wrap');
  }
  await click('common.back');
  assert.equal(host.querySelector('[data-color]').dataset.color, initial);
  await click('choose-color'); await click('common.next');
  assert(host.textContent.includes('#123456'));
  await click('common.back');
  assert.equal(host.querySelector('[data-color]').dataset.color, '#123456');
  await click('common.next');
  let releaseCreate;
  globalThis.__projectCreateAction = () => new Promise(resolve => { releaseCreate = resolve; });
  await click('project.create');
  assert(button('common.back').disabled && button('project.create').disabled);
  await click('project.create');
  assert.equal(globalThis.__projectCreates.length, 1, 'disabled repeated create does not duplicate the request');
  assert.equal(globalThis.__projectCreates[0].description, '');
  assert.equal(globalThis.__projectCreates[0].headerColor, '#123456');
  await React.act(async () => { releaseCreate(); await tick(); });
  assert.equal(globalThis.__projectWindowCloses, 1);
  assert.equal(globalThis.__projectColorDraws, 1, 'rerenders do not reroll the project color');
  await render(null);
  console.log('PASS real wizard dark surface, paired controls, picker cancellation, optional description, randomized color stability, Back/Next and creation payload');

  // Verify the production native launcher carries presentation, not project data.
  const parentVariables = Object.fromEntries(api.THEME_COLOR_TOKENS.map(key => [`--${key}`, key === 'background' ? '213 16% 11%' : '210 13% 94%']));
  for (const [key, value] of Object.entries(parentVariables)) document.documentElement.style.setProperty(key, value);
  document.documentElement.classList.add('dark'); document.documentElement.dataset.devcelTheme = 'dark';
  const launch = api.showProjectCreateWizard(); await tick();
  assert.equal(globalThis.__projectWindow.label, 'wizard');
  const destination = new URL(globalThis.__projectWindow.options.url, win.location.href);
  assert.equal(destination.pathname, '/project_create_wizard');
  const inherited = api.readDialogTheme(destination.search);
  assert.equal(inherited.dark, true); assert.equal(inherited.id, 'dark'); assert.equal(inherited.revision, 'same');
  assert.deepEqual(inherited.variables, parentVariables);
  assert.deepEqual([...destination.searchParams.keys()], ['dialogTheme']);
  globalThis.__projectNativeClose(); await launch;
  assert.equal(globalThis.__projectCreates.length, 1, 'native cancellation never creates a project');
  for (const key of Object.keys(parentVariables)) document.documentElement.style.removeProperty(key);

  // The actual shared theme owner bridges startup, then yields to authoritative settings.
  win.location.search = destination.search;
  globalThis.__projectSettings = { revision: '', bundle: { values: { theme: 'light', pluginTheme: '' }, themes: [] } };
  await render(themedWizard());
  assert(document.documentElement.classList.contains('dark'), 'pending settings retain the dark opener');
  assert.equal(document.documentElement.style.colorScheme, 'dark');
  assert.equal(document.documentElement.dataset.devcelTheme, 'dark');
  assert.equal(document.documentElement.style.getPropertyValue('--background'), parentVariables['--background']);
  globalThis.__projectSettings = { revision: 'loaded', bundle: { values: { theme: 'system', pluginTheme: '' }, themes: [] } };
  await render(themedWizard());
  assert(!document.documentElement.classList.contains('dark'), 'resolved built-in settings release the inherited dark snapshot');
  assert.equal(document.documentElement.style.colorScheme, 'light');
  assert.equal(document.documentElement.style.getPropertyValue('--background'), '');
  await React.act(async () => { media.matches = true; for (const listener of mediaListeners) listener(); await tick(); });
  assert(document.documentElement.classList.contains('dark'), 'live system theme continues after inherited startup');
  await render(null);
  console.log('PASS detached launch theme capture, cancellation, pending-settings inheritance and live built-in/system changes');

  const pluginSnapshot = { ...inherited, id: 'plugin:custom' };
  win.location.search = `?dialogTheme=${encodeURIComponent(JSON.stringify(pluginSnapshot))}`;
  globalThis.__projectSettings = { revision: '', bundle: { values: { theme: 'light', pluginTheme: '' }, themes: [] } };
  await render(React.createElement(api.AppTheme));
  assert(document.documentElement.classList.contains('dark'));
  globalThis.__projectSettings = { revision: 'same', bundle: { values: { theme: 'light', pluginTheme: 'plugin:custom' }, themes: [] } };
  await render(React.createElement(api.AppTheme));
  assert.equal(document.documentElement.style.getPropertyValue('--background'), parentVariables['--background']);
  const colors = Object.fromEntries(api.THEME_COLOR_TOKENS.map(key => [key, '0 0% 90%']));
  globalThis.__projectThemes = [{ id: 'plugin:custom', type: 'light', colors }];
  await render(React.createElement(api.AppTheme));
  assert(!document.documentElement.classList.contains('dark'));
  assert.equal(document.documentElement.style.getPropertyValue('--background'), '0 0% 90%');
  globalThis.__projectThemes = [];
  for (const [revision, pluginTheme] of [['newer', 'plugin:custom'], ['same', 'plugin:other'], ['same', '']]) {
    globalThis.__projectSettings = { revision, bundle: { values: { theme: 'light', pluginTheme }, themes: [] } };
    await render(React.createElement(api.AppTheme));
    assert(!document.documentElement.classList.contains('dark'), 'stale or disabled plugin snapshot cannot override live theme');
    assert.equal(document.documentElement.style.getPropertyValue('--background'), '');
  }
  await render(null);
  console.log('PASS plugin startup bridge, resolved-plugin precedence and stale revision/identity rejection');

  // Contrast is calculated from production light/dark tokens, not screenshots.
  const css = await readFile(path.join(studio, 'src/app/settings/generated/themes.css'), 'utf8');
  const rgb = (h, s, l) => { s /= 100; l /= 100; const a = s * Math.min(l, 1 - l); const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); }; return [f(0), f(8), f(4)]; };
  const luminance = c => c.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  for (const mode of [':root[data-devcel-theme="light"]', ':root[data-devcel-theme="dark"]']) {
    assert(css.includes(mode), `generated theme selector exists: ${mode}`);
    const block = css.slice(css.indexOf(mode)).split('}')[0];
    const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g)].map(m => [m[1], rgb(...m.slice(2).map(Number))]));
    for (const [fg, bg] of [['secondary-foreground', 'secondary'], ['primary-foreground', 'primary'], ['foreground', 'background']]) {
      const a = luminance(tokens[fg]), b = luminance(tokens[bg]);
      assert((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${mode} ${fg}/${bg} contrast`);
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS wizard Back/Create/field token contrast in light and dark themes');
} finally {
  await React.act(async () => root.unmount());
  console.error = previousError; console.warn = previousWarn;
  await rm(temporary, { recursive: true, force: true });
  await win.happyDOM.abort();
}
