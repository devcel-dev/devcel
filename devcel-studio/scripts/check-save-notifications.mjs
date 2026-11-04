// Production toast store/host and save orchestration; IPC is a deterministic boundary fixture.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(project, '.save-notification-check-'));
const browser = new Window();
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'DocumentFragment', 'NodeFilter', 'HTMLInputElement', 'CustomEvent']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? browser : browser[name] });
globalThis.getComputedStyle=browser.getComputedStyle.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const timers = new Map(); let timerId = 0;
const realTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, delay, ...args) => {
  if (delay < 4000) return realTimeout(fn, delay, ...args);
  const id = ++timerId; timers.set(id, fn); return id;
};
globalThis.clearTimeout = id => { if (!timers.delete(id)) realClearTimeout(id); };
let session = 'A', saveFailure = null, pending = null, saves = [];
const dictionary = JSON.parse(await readFile(resolve(project, 'src/app/i18n/generated/catalog.json'), 'utf8')).messages;
let locale = 'en';
const localize = value => {
  if (typeof value === 'string') return value;
  if (value.kind === 'text') return value.text;
  let text = dictionary[locale][value.key]; assert.ok(text, value.key);
  for (const [key, item] of Object.entries(value.values ?? {})) text = text.replace(`{${key}}`, localize(item));
  return text;
};
globalThis.__saveNotificationTest = {
  getProjectSession: async () => session ? { id: session } : null,
  saveProject: async expected => { saves.push(expected); const next = pending; pending = null; if (next) await next; if (saveFailure) throw saveFailure; },
  localize,
};
let root;
try {
  const mocks = {
    '@/app/commands/projectCommands': `const b=globalThis.__saveNotificationTest; export const getProjectSession=b.getProjectSession,saveProject=b.saveProject;`,
    '@/app/i18n': `export const message=(key,values)=>({key,values});export const toAppError=error=>({kind:'text',text:String(error)});export const localizeError=globalThis.__saveNotificationTest.localize;export const t=key=>localizeError(message(key));export const useI18n=()=>({t});`,
  };
  const result = await build({absWorkingDir:project,stdin:{contents:`export * from './src/components/ui/use-toast';export * from './src/components/ui/toaster';export * from './src/app/utils/saveProjectNotification';export {Dialog,DialogContent,DialogTitle} from './src/components/ui/dialog';`,resolveDir:project,loader:'ts'},bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',write:false,alias:{'@':resolve(project,'src')},plugins:[{name:'boundary',setup(builder){builder.onResolve({filter:/.*/},args=>mocks[args.path]?{path:args.path,namespace:'mock'}:undefined);builder.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'js'}));}}]});
  const bundle = resolve(temporary,'bundle.mjs'); await writeFile(bundle,result.outputFiles[0].text);
  const { Toaster, toast, dismiss, saveProjectWithNotification, Dialog, DialogContent, DialogTitle } = await import(pathToFileURL(bundle));
  const React = await import('react'); const { act } = React; const { createRoot } = await import('react-dom/client');
  document.body.innerHTML = '<input id="editor"><div id="root"></div>';
  const editor = document.getElementById('editor'); editor.focus();
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(React.StrictMode,null,React.createElement(Toaster))));
  // With no notifications, grid DOM churn must not scan for modal owners.
  const originalQuery = document.querySelectorAll.bind(document); let modalScans = 0;
  document.querySelectorAll = selector => { if (selector.includes('[role="dialog"]')) modalScans++; return originalQuery(selector); };
  await act(async()=>{for(let i=0;i<100;i++) { const row=document.createElement('div');document.body.append(row);row.remove(); } await new Promise(resolve=>realTimeout(resolve,0));});
  assert.equal(modalScans,0,'no modal observer/query while notification store is empty');
  await act(saveProjectWithNotification);
  assert.ok(modalScans>0,'modal owner is resolved when first toast appears');
  assert.deepEqual(saves,['A']); assert.equal(document.querySelector('[role=status]').textContent,'Saved'); assert.equal(document.activeElement,editor); assert.equal(timers.size,1);
  const oldTimer = [...timers.values()][0];
  await act(saveProjectWithNotification);
  assert.equal(document.querySelectorAll('[role=status]').length,1); assert.equal(timers.size,1);
  await act(async () => oldTimer()); assert.ok(document.querySelector('[role=status]'),'stale timeout cannot dismiss replacement');
  await act(async () => [...timers.values()][0]()); assert.equal(document.querySelector('[role=status]'),null); assert.equal(timers.size,0); assert.equal(document.activeElement,editor);
  await act(async()=>{root.render(React.createElement(React.Fragment,null,React.createElement(Toaster),React.createElement(Dialog,{open:true},React.createElement(DialogContent,{'aria-describedby':undefined},React.createElement(DialogTitle,null,'Interface dialog')))));await new Promise(resolve=>realTimeout(resolve,0));});
  const modal=document.querySelector('[role="dialog"]'); assert.ok(modal);
  await act(async()=>toast({title:'Modal message',variant:'destructive'}));
  assert.ok(modal.querySelector('[data-notification-host]'),'toast host stays within actual Radix modal focus/aria boundary');
  assert.equal(modal.querySelector('[data-notification-host]').closest('[aria-hidden="true"]'),null);
  const modalDismiss=modal.querySelector('[data-notification-host] button'); modalDismiss.focus(); assert.equal(document.activeElement,modalDismiss);
  await act(async()=>modalDismiss.click()); assert.equal(modal.querySelector('[role=alert]'),null);
  await act(async()=>{root.render(React.createElement(Toaster));await new Promise(resolve=>realTimeout(resolve,0));});
  assert.ok(document.getElementById('root').querySelector('[data-notification-host]'),'host returns after modal closes');
  const scansAfterDismiss=modalScans;
  await act(async()=>{for(let i=0;i<100;i++) { const row=document.createElement('div');document.body.append(row);row.remove(); } await new Promise(resolve=>realTimeout(resolve,0));});
  assert.equal(modalScans,scansAfterDismiss,'last dismissal disconnects modal observer');
  saveFailure = new Error('Disk write failed: '+ 'long-path/'.repeat(100));
  await act(saveProjectWithNotification);
  assert.ok(document.querySelector('[role=alert]').textContent.includes('Disk write failed')); assert.equal(timers.size,0); assert.equal(document.querySelector('[role=alert] p[tabindex="0"]')?.className.includes('overflow-y-auto'),true);
  const close = document.querySelector('[aria-label="Dismiss notification"]'); close.focus();
  await act(async () => close.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.equal(document.querySelector('[role=alert]'),null);
  saveFailure=null; locale='ja';
  await act(saveProjectWithNotification); assert.equal(document.querySelector('[role=status]').textContent,'保存しました'); assert.ok(document.querySelector('[aria-label="通知を閉じる"]'));
  await act(async()=>dismiss());
  let release; pending = new Promise(resolve=>{release=resolve;}); let older;
  await act(async()=>{older=saveProjectWithNotification(); await Promise.resolve(); await Promise.resolve();});
  session='B'; await act(saveProjectWithNotification); assert.equal(document.querySelectorAll('[role=status]').length,1);
  const before=document.querySelector('[role=status]');
  await act(async()=>{release();await older;}); assert.equal(document.querySelector('[role=status]'),before,'older request cannot replace newer completion');
  await act(async()=>dismiss());
  pending = new Promise(resolve=>{release=resolve;});
  await act(async()=>{older=saveProjectWithNotification();await Promise.resolve();await Promise.resolve();});
  session='C'; await act(async()=>{release();await older;}); assert.equal(document.querySelector('[role=status]'),null,'switched project suppresses obsolete success');
  session=null; const count=saves.length; await act(saveProjectWithNotification); assert.equal(saves.length,count,'no session must not save a newly opened project'); assert.ok(document.querySelector('[role=alert]'));
  await act(async()=>{dismiss();toast({title:'cleanup'});}); assert.equal(timers.size,1);
  await act(async()=>root.unmount()); root=null; assert.equal(timers.size,0,'host teardown clears timer');
  const menus=await readFile(resolve(project,'src/app/config/menuConfigs.ts'),'utf8'); assert.equal((menus.match(/onClick: saveProjectWithNotification/g)??[]).length,2); assert.ok(!menus.includes("message(t('project.saved')"));
  const main=await readFile(resolve(project,'src/app/pages/main_window/MainWindow.tsx'),'utf8'); assert.ok(main.includes("useEffect(() => { dismissToast('project-save'); }, [projectSession?.id])"));
  console.log('PASS save notifications: modal ownership, project-switch cleanup, success, failure, repeat/reset, stale timeout, focus, keyboard dismiss, EN/JA, long errors, session/request races, cleanup, both menu modes');
} finally {
  if(root){const {act}=await import('react');await act(async()=>root.unmount());}
  globalThis.setTimeout=realTimeout;globalThis.clearTimeout=realClearTimeout;
  await browser.happyDOM.close(); await rm(temporary,{recursive:true,force:true});
}
