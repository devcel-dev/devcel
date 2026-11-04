// Production mode, provider and menus; controlled native/plugin boundaries.
// This validates isolation before mount, not native subprocess or P2P behavior.
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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-mode-check-'));
const window = new Window({ url: 'http://mode.invalid/' });
for (const key of ['window','document','navigator','Event','CustomEvent','Node','HTMLElement','localStorage']) Object.defineProperty(globalThis,key,{ configurable:true,value:key==='window'?window:window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__mode = 'settings-editor';
globalThis.__calls = [];
globalThis.__approve = false;
try {
 const out = path.join(temporary,'mode.cjs');
 await build({ absWorkingDir:studio, stdin:{resolveDir:studio,loader:'tsx',contents:`
 export * from './src/app/applicationMode';
 export {PluginProvider,usePlugins} from './src/app/contexts/PluginContext';
 export {getWelcomeMenuConfig,getProjectMenuConfig} from './src/app/config/menuConfigs';
 export {getPluginMenuGroup} from './src/app/config/pluginMenus';
 export * as React from 'react'; export {createRoot} from 'react-dom/client';
 `},outfile:out,bundle:true,format:'cjs',platform:'node',jsx:'automatic',alias:{'@':path.join(studio,'src')},plugins:[{name:'boundaries',setup(b){
 const mocks = {
  '@/app/i18n': `export const t=k=>k; export const useI18n=()=>({locale:'en'}); export const message=k=>k; export const localizeError=String; export const localizedError=e=>new Error(e); export const appErrorException=e=>e; export const toAppError=e=>e;`,
  '@/app/services/PluginManager': `export const PluginManager={getInstance(){globalThis.__calls.push('manager');throw Error('Unexpected plugin manager')}};`,
  '@/app/services/PluginBridge': `export const PluginBridge={getInstance(){globalThis.__calls.push('bridge');throw Error('Unexpected plugin bridge')}};`,
  '@/app/pages/main_window/MainWindow': `export const handleCreateProject=()=>{globalThis.__calls.push('new')}; export const handleOpenProject=()=>{globalThis.__calls.push('open')};export const handleCloseProject=()=>{globalThis.__calls.push('close-project')};`,
  '@/app/settings': `export const resetSettingsProject=async()=>{globalThis.__calls.push('reset')};`,
  '@/app/commands/projectCommands': `export const getProjectSession=async()=>({id:'settings-session'}); export const saveProject=async()=>{globalThis.__calls.push('save')};`,
  '@/app/utils/project_edit_dialog': `export const showProjectEditDialog=()=>{};`,
  '@/app/utils/updater': `export const showAppUpdater=()=>{};`,
  '@/app/utils/options': `export const showOptions=()=>{};`,
  '@/app/utils/plugin_manager': `export const showPluginManager=()=>{};`,
  '@/app/utils/development': `export const isDevelopmentMode=()=>false;`,
  '@/app/utils/debugCommands': `export const reloadWindow=()=>{},openDevTools=()=>{},clearConsole=()=>{},logWindowState=()=>{},logProjectState=()=>{},logEnvironment=()=>{},toggleDebugMode=()=>{},generateSystemReport=()=>{};`,
  '@/app/components/plugins/PluginExtensions': `export const pluginPredicate=(predicate)=>predicate?predicate():true;`,
  '@tauri-apps/api/core': `export const isTauri=()=>true;export const invoke=async name=>{globalThis.__calls.push(name);return globalThis.__mode};`,
  '@tauri-apps/api/window': `export const getCurrentWindow=()=>({close:async()=>{globalThis.__calls.push('close-window')}});`,
  '@tauri-apps/plugin-dialog': `export const ask=async()=>globalThis.__approve;export const message=async()=>{};`,
  '@/app/services/appDialogs': `export const ask=async()=>globalThis.__approve;export const message=async()=>{};export const appAlert=message;export const appConfirm=ask;export const appPrompt=async(...args)=>globalThis.prompt?.(...args)??null;`,
  '@tauri-apps/plugin-shell': `export const open=async()=>{};`,
 };
 b.onResolve({filter:/.*/},args=>Object.hasOwn(mocks,args.path)?{path:args.path,namespace:'mock'}:undefined);
 b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path]}));
 }}]});
 const fresh = () => { delete require.cache[out]; return require(out); };
 const api=fresh();
 const pending=api.initializeApplicationMode(); assert.equal(pending,api.initializeApplicationMode()); await pending;
 assert.equal(api.getApplicationMode(),'settings-editor'); assert.equal(api.isSettingsEditor(),true);
 assert.deepEqual(globalThis.__calls,['get_application_mode']);
 for(const route of ['/','/bulk_row_dialog','/table_rule_dialog']) assert.equal(api.isApplicationRouteAllowed(route),true);
 for(const route of ['/color_picker','/string_editor','/column_type_dialog','/plugin_manager','/plugin_packages','/export_dialog','/project_create_wizard','/project_edit_dialog','/app_updater','/options']) assert.equal(api.isApplicationRouteAllowed(route),false);
 console.log('PASS native mode is initialized once; settings editor allows only table editing routes');
 let context;
 function Probe(){context=api.usePlugins();return api.React.createElement('span',null,'ready');}
 const host=document.createElement('div');document.body.append(host);const root=api.createRoot(host);
 await api.React.act(async()=>root.render(api.React.createElement(api.PluginProvider,null,api.React.createElement(Probe))));
 assert.equal(host.textContent,'ready');assert.equal(context.plugins.size,0);assert.equal(context.activePlugins.size,0);assert.equal(context.themes.length,0);assert.equal(context.isLoading,false);
 assert.equal(context.activatePlugin,undefined);assert.equal(context.updatePluginSettings,undefined);assert.equal(await context.loadPackage('plugin'),false);
 assert.equal(globalThis.__calls.includes('manager'),false);assert.equal(globalThis.__calls.includes('bridge'),false);
 await api.React.act(async()=>root.unmount());
 console.log('PASS settings PluginProvider mounts children with empty context and never creates plugin services');
 const props={hasProject:true};
 for(const menu of [api.getProjectMenuConfig(props),api.getWelcomeMenuConfig(props)]){
  assert.deepEqual(menu.groups.map(g=>g.id),['file','edit','view']);
  assert.deepEqual(menu.groups.flatMap(g=>g.actions.map(a=>a.label)),['menu.saveProject','common.close','menu.undo','menu.redo','menu.fileBrowser','menu.properties']);
 }
 const menu=api.getProjectMenuConfig(props);await menu.groups[0].actions[0].onClick();await menu.groups[0].actions[1].onClick();assert.ok(globalThis.__calls.includes('save'));assert.ok(globalThis.__calls.includes('close-window'));
 let undo=0;window.addEventListener('devcel-undo',()=>undo++);await menu.groups[1].actions[0].onClick();assert.equal(undo,1);
 console.log('PASS restricted menus retain Save, Close Window, Undo/Redo and table view controls');
 globalThis.__mode='standard';const standard=fresh();await standard.initializeApplicationMode();assert.equal(standard.isSettingsEditor(),false);assert.equal(standard.isApplicationRouteAllowed('/plugin_manager'),true);
 const reset=standard.getProjectMenuConfig(props).groups.find(g=>g.id==='view').actions.find(a=>a.label==='settings.resetProject');assert.ok(reset);
 await reset.onClick();assert.equal(globalThis.__calls.includes('reset'),false);globalThis.__approve=true;await reset.onClick();assert.equal(globalThis.__calls.filter(c=>c==='reset').length,1);
 const plugin={status:'active',plugin:{metadata:{name:'Plugin'},extensions:{themes:[{id:'theme',name:'Theme'}],dialogs:[{id:'dialog',title:'Dialog'}]}}};
 const pluginMenu=standard.getPluginMenuGroup(new Map([['p',plugin]]),new Map(),'Plugins',()=>{}, {toolbarButtons:[],dialogs:[{id:'p:dialog',title:'Dialog'}],themes:[{id:'p:theme',name:'Theme'}],importers:[],dataProcessors:[]});
 assert.deepEqual(pluginMenu.submenus[0].groups.flatMap(g=>g.actions.map(a=>a.label)),['Dialog']);
 console.log('PASS standard menus keep confirmed whole-project reset and plugin actions without separate theme selection');
 globalThis.__mode='invalid';const invalid=fresh();await assert.rejects(invalid.initializeApplicationMode(),/error\.invalidApplicationMode/);
 const entry=fs.readFileSync(path.join(studio,'src/app/main.tsx'),'utf8');assert.ok(entry.indexOf('await initializeApplicationMode()')<entry.indexOf('ReactDOM.createRoot'));assert.ok(entry.includes('isApplicationRouteAllowed(window.location.pathname)'));
 for(const file of ['pages/main_window/MainWindow.tsx','pages/main_window/project_view/table_view/TableTabView.tsx']){
  const source=fs.readFileSync(path.join(studio,'src/app',file),'utf8');
  for(const line of source.split('\n').filter(line=>line.includes('PluginManager.getInstance()')))assert.ok(line.includes('if (!isSettingsEditor())'),file);
 }
 console.log('PASS invalid mode fails closed; bootstrap and project/table plugin calls enforce the mode boundary');
} finally {window.happyDOM.abort();fs.rmSync(temporary,{recursive:true,force:true});}
process.exit(0);
