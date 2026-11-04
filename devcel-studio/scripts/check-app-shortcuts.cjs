// Real MainWindow registration and project actions; native dialogs, unrelated views
// and save delivery are boundary fixtures (save orchestration has its own suite).
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');
const {compileModule}=require('./compile-module.cjs');
(async()=>{
 const {Window}=await import('happy-dom');const browser=new Window();
 for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','KeyboardEvent','MutationObserver'])Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?browser:browser[name]});
 globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const React=require('react');const {act}=React;const {createRoot}=require('react-dom/client');
 const project=path.resolve(__dirname,'..');const cache=new Map();let settingsMode=false,saves=0,wizards=0,pickers=0,pendingWizard;
 const none=()=>null;const blank=async()=>{};const session={id:'A',name:'QA',path:'qa.devcelproj.toml'};
 const mocks={
  '@/app/utils/saveProjectNotification':{saveProjectWithNotification:async()=>{saves++;}},
  '@/app/utils/mainWindowGeometry':{setMainWindowMode:blank},
  '@/app/components/SettingsApplyNotice':{SettingsApplyNotice:none},
  '@/components/ui/use-toast':{dismiss:()=>{}},
  '@/app/pages/string_editor/StringEditorHost':{StringEditorHost:none},
  '@/app/settings':{useAppSettings:()=>({})},
  '@/app/applicationMode':{isSettingsEditor:()=>settingsMode},
  '@/app/config/brand':{DEFAULT_PROJECT_HEADER_COLOR:'#000000'},
  '@/app/utils/string_editor_window':{installMainWindowCloseGuard:()=>()=>{},requestCloseStringEditor:async()=>true},
  '@/app/components/MarkdownRecoveryNotice':{MarkdownRecoveryNotice:none},
  '@/app/utils/markdownSaveLifecycle':{flushMarkdownEdits:blank,hasPendingMarkdownEdits:()=>false},
  '@/app/utils/columnDraftLifecycle':{columnDraftStore:{discardSession:()=>{}},confirmColumnDraftDiscard:async()=>true},
  '@/app/i18n':{useI18n:()=>({}),t:key=>key,localizeError:String},
  '@/app/contexts/PluginContext':{usePlugins:()=>({menus:[],activePlugins:[]})},
  '@/app/components/plugins/PluginExtensions':{PluginExtensionHost:none,PluginSidebar:none,runPluginAction:blank},
  '@/app/pages/main_window/project_view/ProjectView':()=>React.createElement('input',{'data-test-editor':true}),
  '@/app/pages/main_window/welcome_view/WelcomeView':none,
  '@tauri-apps/api/event':{listen:async()=>()=>{}},
  '@/app/services/PluginManager':{PluginManager:{getInstance:()=>({setHasProject:()=>{}})}},
  '@/app/commands/projectCommands':{getProjectSession:async()=>session,openProject:blank,closeProject:blank},
  '@/app/components/common/WindowHeader':{WindowHeader:()=>React.createElement('button',{'data-test-header':true},'Header')},
  '@/app/utils/project_create_wizard':{showProjectCreateWizard:async()=>{wizards++;if(pendingWizard)await pendingWizard;}},
  '@/app/services/appDialogs':{message:blank},
  '@tauri-apps/plugin-dialog':{open:async()=>{pickers++;return null;}},
  '@/app/config/menuConfigs':{getWelcomeMenuConfig:()=>({groups:[]}),getProjectMenuConfig:()=>({groups:[]})},
  '@/app/config/pluginMenus':{getPluginMenuGroup:()=>null},
  '@/app/utils/updater':{checkForUpdatesOnStartup:blank},
  '@/app/commands/tableCommands':{cancelTableLoads:()=>{},setTableLoadingSession:()=>{}},
 };
 function load(relative){const filename=path.join(project,relative);if(cache.has(filename))return cache.get(filename).exports;const m=new Module(filename);cache.set(filename,m);m.paths=Module._nodeModulePaths(project);m.require=id=>Object.hasOwn(mocks,id)?mocks[id]:id==='@/app/utils/shortcutGuards'?load('src/app/utils/shortcutGuards.ts'):require(id);m._compile(compileModule(fs.readFileSync(filename,'utf8'),filename),filename);return m.exports;}
 const {MainWindow}=load('src/app/pages/main_window/MainWindow.tsx');const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const settle=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
 await act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(MainWindow))));await settle();
 async function key(value,options={},target=host.querySelector('[data-test-header]')){const event=new browser.KeyboardEvent('keydown',{key:value,ctrlKey:true,bubbles:true,cancelable:true,...options});await act(async()=>target.dispatchEvent(event));await settle();return event;}
 await key('s');assert.equal(saves,1,'StrictMode installs one save listener');
 await key('s',{},host.querySelector('input'));assert.equal(saves,2,'text focus can explicitly save');
 for(const options of [{shiftKey:true},{altKey:true},{repeat:true},{isComposing:true},{keyCode:229}])await key('s',options);assert.equal(saves,2);
 const modal=document.createElement('div');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');document.body.append(modal);await key('s');await key('n');assert.equal(saves,2);assert.equal(wizards,0);modal.remove();
 await key('o');assert.equal(pickers,1);await key('n');assert.equal(wizards,1);
 await key('n',{},host.querySelector('input'));assert.equal(wizards,1,'native input does not start new project');
 let release;pendingWizard=new Promise(resolve=>{release=resolve;});await key('n');await key('n');await key('o');await key('s');assert.equal(wizards,2);assert.equal(pickers,1);assert.equal(saves,2);release();pendingWizard=null;await settle();
 settingsMode=true;await key('n');await key('o');assert.equal(wizards,2);assert.equal(pickers,1);await key('s');assert.equal(saves,3);
 await act(async()=>root.unmount());const event=new browser.KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true});document.body.dispatchEvent(event);assert.equal(saves,3);
 browser.happyDOM.abort();console.log('PASS real MainWindow app shortcuts: single registration, save/text focus, modifiers/IME/modal, N/O, operation lock, settings isolation, unmount cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});
