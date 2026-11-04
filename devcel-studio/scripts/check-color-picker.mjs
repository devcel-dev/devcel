// Production color picker integration: IPC and GPU allocation are fixtures; React and UI logic are real.
// Real Rust validation, dialog layout and monitor luminance are verified separately.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(project, '.color-picker-check-'));
const browser = new Window({ url: 'http://color.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'DocumentFragment', 'NodeFilter', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'InputEvent', 'MutationObserver', 'ResizeObserver', 'DOMRect', 'localStorage']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? browser : browser[name] });
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[name] = browser[name].bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let current = 'main', createPending = false, createFailure = false, failListen = false, dropInit = false;
let userSwatches = {revision:'0',swatches:[]}, swatchRevision=0, slowSwatchSave=null, slowSwatchApply=null, swatchReadError=null, swatchCommitWarning=null, swatchWriteError=null;
const swatchListeners=new Set();
const refreshSwatches=async()=>{for(const listener of [...swatchListeners])listener({payload:{revision:userSwatches.revision}});};
let slowPreview = null, hdrCandidate = false, hdrCreated = 0, hdrDisposed = 0;
const hdrCallbacks = new Set(), hdrDraws = [];
const nativeWindows = new Map(), listeners = new Set(), created = [], commands = [], emitted = [];
const timers = new Set();
const realTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, delay, ...args) => {
  if (delay !== 15_000) return realTimeout(fn, delay, ...args);
  const timer = { fn }; timers.add(timer); return timer;
};
globalThis.clearTimeout = timer => { if (!timers.delete(timer)) realClearTimeout(timer); };
const tick = () => new Promise(resolve => realTimeout(resolve, 0));
async function emit(target, event, payload) {
  emitted.push({target, event, payload});
  if (dropInit && event === 'color-picker-init') return;
  for (const listener of [...listeners]) if (listener.label === target && listener.event === event) listener.callback({payload});
}
function listen(label, event, callback) {
  if (failListen) { failListen = false; return Promise.reject(Error('listener failed')); }
  const listener = {label, event, callback}; listeners.add(listener); return Promise.resolve(() => listeners.delete(listener));
}
function native(label, options) {
  const win = { label, options, destroyed: false, local: new Map(), focused: 0,
    listen: (event, callback) => listen(label, event, callback),
    once: async (event, callback) => {
      if (event === 'tauri://created' || event === 'tauri://error') { win.local.set(event, callback); return () => win.local.delete(event); }
      let off; off = await listen(label, event, payload => { off?.(); callback(payload); }); return off;
    },
    emitTo: emit,
    setFocus: async () => { win.focused++; }, setTitle: async () => {},
    close: async () => win.destroy(),
    destroy: async () => { if (win.destroyed) return; win.destroyed = true; await emit(label, 'tauri://destroyed'); },
  };
  nativeWindows.set(label, win); return win;
}
native('main');
function response(args) {
  // Only an IPC fixture. Production values are parsed and canonicalized by the Rust command.
  let channels;
  if (!args.input.trim()) channels = args.colorType === 'ColorFloat' ? [1,1,1,1] : [255,255,255,255];
  else if (args.input.startsWith('#')) {
    if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(args.input)) throw {kind:'text', text:'invalid HEX'};
    channels = args.input.slice(1).match(/../g).map(value => parseInt(value,16)); if (channels.length === 3) channels.push(255);
  } else { try { channels = JSON.parse(args.input); } catch { throw {kind:'text',text:'invalid RGBA'}; } }
  if (!Array.isArray(channels) || channels.length !== 4 || !channels.every(Number.isFinite)) throw {kind:'text',text:'invalid RGBA'};
  const float = args.colorType === 'ColorFloat';
  if (float ? channels[3] < 0 || channels[3] > 1 || channels.some(value => !Number.isFinite(Math.fround(value))) : channels.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw {kind:'text',text:'out of range'};
  if (float) channels = channels.map(Math.fround);
  if (args.colorType === 'UiColor' && channels[3] !== 255) throw {kind:'text',text:'opaque only'};
  const hex = float ? null : '#' + channels.map(value => value.toString(16).padStart(2,'0')).join('').toUpperCase();
  const canonical = args.colorType === 'UiColor' ? (args.input.length === 7 && args.input.startsWith('#') ? args.input : hex.slice(0,7)) : JSON.stringify(channels);
  return {canonical, channels, preview_css:'rgba(128,64,32,0.5)', hex: args.colorType === 'UiColor' ? canonical : hex};
}
let settingsSnapshot;
globalThis.__colorHarness = {
  isNative: false,
  getCurrent: () => nativeWindows.get(current), emit,
  listenGlobal: async (event, callback) => { if(event==='user-color-swatches-changed'){swatchListeners.add(callback);return()=>swatchListeners.delete(callback);}return()=>{}; },
  createHdr: async (_canvas, onStatus) => { if (!hdrCandidate) { onStatus('unavailable'); return null; } hdrCreated++; hdrCallbacks.add(onStatus); onStatus('candidate'); let active=true; return {draw: value=>hdrDraws.push([...value]),dispose:()=>{if(active){active=false;hdrDisposed++;hdrCallbacks.delete(onStatus);}}}; },
  create: (label, options) => {
    if (createFailure) throw Error('creation failed');
    const instance = native(label, options); created.push(instance);
    if (!createPending) queueMicrotask(() => instance.local.get('tauri://created')?.({payload:null}));
    return instance;
  },
  invoke: async (command, args) => {
    commands.push({command,args});
    if(command==='get_app_settings')return settingsSnapshot;
    if(command==='get_user_color_swatches'){if(swatchReadError)throw swatchReadError;return structuredClone(userSwatches);}
    if(command==='apply_color_swatch'){
      if(slowSwatchApply)await slowSwatchApply;
      const {swatch,targetType}=args,canonical=response({colorType:swatch.data_type,input:swatch.value});
      if(targetType==='UiColor'){if(swatch.data_type!=='Color32'||canonical.channels[3]!==255)throw {kind:'text',text:'incompatible swatch'};return canonical.hex.slice(0,7);}
      if(swatch.data_type!==targetType)throw {kind:'text',text:'incompatible swatch'};return canonical.canonical;
    }

    if(command==='set_user_color_swatches'){
      if(swatchWriteError)throw swatchWriteError;
      if(slowSwatchSave)await slowSwatchSave;
      if(args.expectedRevision!==userSwatches.revision)throw {kind:'code',code:'color.swatches.stale',params:{}};
      userSwatches={revision:String(++swatchRevision),swatches:args.swatches.map(item=>({...item,name:item.name.trim(),value:response({colorType:item.data_type,input:item.value}).canonical})),warning:null,writable:true};
      await refreshSwatches();return structuredClone(swatchCommitWarning ? {...userSwatches,revision:'',warning:swatchCommitWarning,writable:false} : userSwatches);
    }
    assert.equal(command,'preview_color'); const delay = slowPreview; if (delay) await delay; return response(args);
  },
};
const tauri = {
  '@/app/utils/hdrColorPreview': 'export const createHdrColorPreview=(...args)=>globalThis.__colorHarness.createHdr(...args);',
  '@tauri-apps/api/webviewWindow': 'export const getCurrentWebviewWindow=()=>globalThis.__colorHarness.getCurrent(); export class WebviewWindow {constructor(label,options){return globalThis.__colorHarness.create(label,options)}}',
  '@tauri-apps/api/window': 'export const currentMonitor=async()=>({scaleFactor:2,workArea:{size:{width:1280,height:1024}}}); export const getCurrentWindow=()=>globalThis.__colorHarness.getCurrent();',
  '@tauri-apps/api/core': 'export const invoke=(...args)=>globalThis.__colorHarness.invoke(...args); export const isTauri=()=>globalThis.__colorHarness.isNative;',
  '@tauri-apps/api/event': 'export const listen=(...args)=>globalThis.__colorHarness.listenGlobal(...args);',
};
try {
  const bundled = await build({absWorkingDir:project,stdin:{contents:`export * from './src/app/utils/color_picker_window';export * from './src/app/components/color/colorDisplay';export {ColorPickerPanel} from './src/app/components/color/ColorPickerPanel';export {ColorField} from './src/app/components/color/ColorField';export {ColorCell} from './src/app/pages/main_window/project_view/table_view/components/ColorCell';export {ColorPickerDialogHost} from './src/app/components/color/ColorPickerDialogHost';export {t,localizeError,applyRuntimeLocalization} from './src/app/i18n';export * as settings from './src/app/settings';`,resolveDir:project,loader:'ts'},bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',write:false,loader:{'.css':'empty'},alias:{'@':resolve(project,'src')},plugins:[{name:'native-fixture',setup(plugin){plugin.onResolve({filter:/^(?:@tauri-apps\/api\/|@\/app\/utils\/hdrColorPreview$)/},args=>tauri[args.path]?{path:args.path,namespace:'fixture'}:undefined);plugin.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:tauri[args.path],loader:'js'}));}}]});
  const modulePath=resolve(temporary,'check.mjs');await writeFile(modulePath,bundled.outputFiles[0].text);
  const ui=await import(pathToFileURL(modulePath));
  const React=await import('react');const {createRoot}=await import('react-dom/client');
  const mountTarget=document.createElement('div');document.body.append(mountTarget);let host=mountTarget,root,opening,child;const draftResults=[];
  const reports=[];const check=async(name,body)=>{await body();reports.push(name);};
  await check('Picker middle-grey surfaces and small text keep achromatic 4.5:1 contrast', async()=>{
    const css=await readFile(resolve(project,'src/app/components/color/color-picker.css'),'utf8');
    const scope=css.match(/\.color-picker-panel \{([^}]+)\}/)[1];
    const tokens=Object.fromEntries([...scope.matchAll(/--([a-z-]+): 0 0% ([\d.]+)%/g)].map(([,key,value])=>[key,Number(value)/100]));
    const luminance=value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4;
    const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
    assert(Math.abs(tokens.background-128/255)<.000001);
    for(const surface of ['background','muted','accent'])for(const ink of ['foreground','muted-foreground'])
      assert(contrast(tokens[surface],tokens[ink])>=4.5,`${ink} on ${surface} contrast`);
    assert(contrast(tokens.primary,tokens['primary-foreground'])>=4.5);
    assert(contrast(tokens.background,tokens.ring)>=3);
    assert(contrast(tokens.background,tokens.input)>=3);
    assert.match(css,/\.color-picker-panel input:not\(\[type="range"\]\),/);
    assert.match(css,/\.color-picker-tooltip \{ background: hsl\(0 0% 58%\); color: #000;/);
    assert(contrast(.58,0)>=4.5);
    assert.match(scope,/color-scheme: light/);
  });

  const settle=async()=>React.act(async()=>{await new Promise(resolve=>realTimeout(resolve,120));});
  const mount=async(element)=>{await React.act(async()=>{root??=createRoot(mountTarget);root.render(element);});await settle();host=document.querySelector('.color-picker-dialog')??mountTarget;};
  const unmount=async()=>{if(root)await React.act(async()=>{root.unmount();root=null;host=mountTarget;});};
  let settingsRevision = 0;
  // Deliver the same native compiled snapshot as every app window; never use removed frontend setters.
  const applyDisplay=async(type,interpretation)=>{
    const current=ui.settings.getSettingsSnapshot(),bundle=structuredClone(current.bundle);
    bundle.values[type==='Color32'?'color32Display':'colorFloatDisplay']=interpretation;
    settingsSnapshot={...current,bundle,revision:`picker:${++settingsRevision}`,generation:`picker:${settingsRevision}`,source:'project',warning:null,resolvedLocale:'ja'};
    globalThis.__colorHarness.isNative=true;
    try{await React.act(async()=>ui.settings.refreshAppSettings());}finally{globalThis.__colorHarness.isNative=false;}
    await settle();
  };
  const click=async(button)=>{assert(button,'button exists');await React.act(async()=>{button.click();});await settle();};
  const inputNow=async(element,value)=>{assert(element);await React.act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});};
  const input=async(element,value)=>{await inputNow(element,value);await settle();};
  const select=async(element,value)=>{await React.act(async()=>{element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));});await settle();};
  const tab=async mode=>{const element=[...host.querySelectorAll('[role=tab]')].find(item=>item.textContent===mode);assert(element);await React.act(async()=>{element.focus();element.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true}));});await settle();};
  const button=text=>[...host.querySelectorAll('button')].find(item=>item.textContent===text||item.getAttribute('aria-label')===text);
  const manage=async()=>{const trigger=button(ui.t('color.swatches.manage'));assert(trigger);if(trigger.getAttribute('aria-pressed')!=='true')await click(trigger);};
  const editSwatch=async name=>{await manage();const item=userSwatches.swatches.find(swatch=>swatch.name===name);assert(item);await select(host.querySelector('[data-swatch-target]'),item.id);};
  const rect = (element, size) => { element.getBoundingClientRect=()=>({left:0,top:0,width:size,height:size,right:size,bottom:size,x:0,y:0,toJSON:()=>({})}); };
  const capture = element => { const held=new Set();element.setPointerCapture=id=>held.add(id);element.releasePointerCapture=id=>held.delete(id);return held; };
  const pointer=async(element,type,x,y,options={})=>React.act(async()=>element.dispatchEvent(new PointerEvent(type,{pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1,clientX:x,clientY:y,bubbles:true,cancelable:true,...options})));
  const wheel=()=>{const hue=host.querySelector('[data-color-wheel=hue]'),sv=host.querySelector('[data-color-wheel=sv]');rect(hue,200);rect(sv,100);return{hue,sv,hueCapture:capture(hue),svCapture:capture(sv)};};
  const readRgba=()=>['R','G','B','A'].map(channel=>Number(host.querySelector(`#color-${channel}`).value));
  const request={type:'ColorFloat',value:'[2,0.5,-0.25,1]',label:'row / color'};
  const start=async(overrides={},controller=new AbortController())=>{
    await React.act(async()=>{opening=ui.showColorPicker({...request,...overrides},controller.signal).then(value=>{if(value!==null)draftResults.push(value);return value;});});
    const entry=ui.getColorPickerSession();child={get destroyed(){return ui.getColorPickerSession()!==entry;},close:async()=>React.act(async()=>entry?.finish(null))};return controller;
  };
  const mountPage=async()=>{await mount(React.createElement(ui.ColorPickerDialogHost));};
  await check('Picker opens inside the existing document without native windows, URLs or initialization transport',async()=>{
    const url=window.location.href;await start();await mountPage();assert(document.querySelector('[role=dialog]'));assert(host.textContent.includes(ui.t('color.title')));assert.equal(created.length,0);assert.equal(window.location.href,url);assert.equal(timers.size,0);await click(button(ui.t('common.cancel')));assert.equal(await opening,null);assert(child.destroyed);await unmount();
  });
  await check('Compact dialog retains a nonshrinking footer and bounded scrollable body',async()=>{
    await start();await mountPage();const form=host.querySelector('form'),footer=host.querySelector('footer');
    assert(host.classList.contains('color-picker-dialog'));assert(form.classList.contains('h-full')&&form.classList.contains('min-h-0'));
    assert(footer.classList.contains('shrink-0'));assert([...form.children].some(child=>child.classList.contains('flex-1')&&child.classList.contains('min-h-0')&&child.classList.contains('overflow-auto')));
    await child.close();await opening;await unmount();
  });
  await check('Cancel, Escape and window close never return a draft or invoke mutation',async()=>{for(const action of ['cancel','escape','close']){await start();await mountPage();await input(host.querySelector('#color-R'),'3.5');if(action==='cancel')await click(button(ui.t('common.cancel')));else if(action==='escape')await React.act(async()=>host.querySelector('form').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));else await child.close();assert.equal(await opening,null);await unmount();}assert(commands.every(call=>['preview_color','get_user_color_swatches'].includes(call.command)));});
  await check('Apply returns one canonical draft, preserving negative RGB and HDR values',async()=>{await start();await mountPage();await input(host.querySelector('#color-R'),'4.25');const apply=button(ui.t('color.apply'));assert(!apply.disabled);await click(apply);assert.deepEqual(JSON.parse(await opening),[4.25,0.5,-0.25,1]);assert.equal(draftResults.length,1);await unmount();});
  await check('Settings-project interpretation updates live without dirtying values; reopening uses the same snapshot and resets EV',async()=>{
    await start();await mountPage();const before=readRgba(),control=host.querySelector('#color-R');
    assert.equal(host.querySelector('select'),null,'the picker no longer owns an app-setting selector');
    await applyDisplay('ColorFloat','srgb');
    assert.equal(host.querySelector('#color-R'),control);assert.deepEqual(readRgba(),before);
    assert(!button(ui.t('color.apply')).disabled);assert.equal(ui.getColorInterpretation('ColorFloat'),'srgb');
    assert(host.querySelector('[data-color-details]').textContent.includes(ui.t('color.asSrgb')));
    assert.equal(commands.filter(item=>item.command==='preview_color').at(-1).args.interpretation,'srgb');
    await input(host.querySelector('#color-exposure'),'2');assert(!button(ui.t('color.apply')).disabled);
    await click(button(ui.t('common.cancel')));await opening;await unmount();
    await start();await mountPage();assert(host.querySelector('[data-color-details]').textContent.includes(ui.t('color.asSrgb')));
    assert.equal(host.querySelector('#color-exposure').value,'0');assert.deepEqual(readRgba(),before);
    await click(button(ui.t('common.cancel')));await opening;await unmount();
  });
  await check('Formula and version previews have no Apply action and never replace formula text',async()=>{await start({readonly:true,formula:true});await mountPage();assert(host.textContent.includes(ui.t('color.formulaLabel'))&&host.textContent.includes(ui.t('color.readonly')));assert.equal(button(ui.t('color.apply')),undefined);assert(host.querySelector('#color-R').closest('fieldset').disabled);await click(button(ui.t('common.close')));assert.equal(await opening,null);await unmount();});
  await check('Escape closes readonly and pending-preview dialogs while composing Escape is ignored',async()=>{
    for(const loading of [false,true]){
      let release;if(loading)slowPreview=new Promise(resolve=>release=resolve);await start({readonly:true,formula:true});await mountPage();
      await React.act(async()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true})));assert(!child.destroyed);
      await React.act(async()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));assert.equal(await opening,null);assert(child.destroyed);
      await unmount();slowPreview=null;if(release)await React.act(async()=>release());
    }
  });
  await check('Rust invalid-input response disables Apply while exact numeric draft remains editable',async()=>{await start({type:'Color32',value:'[255,0,0,255]'});await mountPage();await input(host.querySelector('#color-R'),'256');assert(host.querySelector('[role=alert]'));assert.equal(host.querySelector('#color-R').value,'256');assert(button(ui.t('color.apply')).disabled);await input(host.querySelector('#color-R'),'128');assert(!host.querySelector('[role=alert]'));await click(button(ui.t('color.apply')));assert.deepEqual(JSON.parse(await opening),[128,0,0,255]);await unmount();});
  await check('Six-digit HEX keeps hidden RGB and the independent alpha channel',async()=>{await start({type:'Color32',value:'[10,20,30,0]'});await mountPage();const hex=host.querySelector('#color-hex');assert.equal(hex.value,'#0A141E');await input(hex,'#3366AA');assert.equal(host.querySelector('#color-A').value,'0');await click(button(ui.t('color.apply')));assert.deepEqual(JSON.parse(await opening),[51,102,170,0]);await unmount();});
  await check('UI color mode preserves custom values, offers free input, and never creates HDR canvas',async()=>{await start({type:'UiColor',value:'#1a2b3c'});await mountPage();assert.equal(host.querySelectorAll('canvas').length,1);assert(host.querySelector('[data-color-wheel=sv] canvas'));assert.equal(host.querySelector('select'),null);assert(host.querySelector('#color-A').disabled);assert(!button(ui.t('color.apply')).disabled);await input(host.querySelector('#color-B'),'70');await click(button(ui.t('color.apply')));assert.equal(await opening,'#1A2B46');await unmount();});
  await check('No-GPU environment explicitly reports SDR fallback rather than HDR',async()=>{await start();await mountPage();assert(host.textContent.includes(ui.t('color.sdrBadge')));assert(!host.textContent.includes(ui.t('color.hdrBadge')));await child.close();await opening;await unmount();});
  await check('Abort, host teardown and replacement discard stale results without creating windows',async()=>{
    const aborted=new AbortController();aborted.abort();assert.equal(await ui.showColorPicker(request,aborted.signal),null);
    const controller=await start();await mountPage();await React.act(async()=>controller.abort());assert.equal(await opening,null);assert(child.destroyed);await unmount();
    await start();await mountPage();const oldResult=opening,old=ui.getColorPickerSession();await start({value:'[4,3,2,1]'});assert.equal(await oldResult,null);old.finish('[9,9,9,1]');assert.equal(ui.getColorPickerSession().request.value,'[4,3,2,1]');await unmount();assert.equal(await opening,null);assert.equal(created.length,0);
  });
  await check('Unchanged initial color applies, double Apply settles once, and StrictMode preserves the active draft',async()=>{
    const before=draftResults.length;await start({type:'Color32',value:'[1,2,3,255]'});await mount(React.createElement(React.StrictMode,null,React.createElement(ui.ColorPickerDialogHost)));const entry=ui.getColorPickerSession();assert(entry);assert(!button(ui.t('color.apply')).disabled);await click(button(ui.t('color.apply')));entry.finish('[8,8,8,255]');assert.equal(await opening,'[1,2,3,255]');assert.equal(draftResults.length,before+1);await unmount();
  });
  await check('Form changes made while the picker is open survive Apply through the latest callback',async()=>{
    let received;const form=description=>React.createElement(React.Fragment,null,React.createElement(ui.ColorField,{type:'UiColor',value:'#123456',label:'Project color',onChange:color=>{received={description,color};}}),React.createElement(ui.ColorPickerDialogHost));
    await mount(form('old description'));await click(host.querySelector('button'));await mount(form('new description'));
    await React.act(async()=>ui.getColorPickerSession().finish('#ABCDEF'));await settle();assert.deepEqual(received,{description:'new description',color:'#ABCDEF'});await unmount();
  });
  await check('Mouse swatch dismissal restores its exact opener, allowing Ctrl+Enter to reopen without another click',async()=>{
    const r={rowId:'row',rowLabel:'Row',rowIndex:0,color:'[1,2,3,255]'},c={uuid:'color',data_type:'Color32',display_name:'Color',read_only: false, default_value:''};
    let result;const open=()=>{result=ui.showColorPicker({type:'Color32',value:r.color,label:'Row / Color'},new AbortController().signal);};
    await mount(React.createElement(React.Fragment,null,
      React.createElement('button',{'data-unrelated-focus':true},'Outside'),
      React.createElement('div',{role:'grid',onKeyDown:event=>{if(event.key==='Enter'&&event.ctrlKey){event.preventDefault();open();}}},React.createElement(ui.ColorCell,{row:r,column:c,onOpen:open})),
      React.createElement(ui.ColorPickerDialogHost)));
    const outside=mountTarget.querySelector('[data-unrelated-focus]'),swatch=mountTarget.querySelector('[role=grid] button');outside.focus();assert.equal(document.activeElement,outside);
    await React.act(async()=>{swatch.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true}));swatch.click();});await settle();host=document.querySelector('.color-picker-dialog');assert(host);assert.equal(ui.getColorPickerSession().opener,swatch);
    await React.act(async()=>host.querySelector('form').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));assert.equal(await result,null);await settle();assert.equal(document.activeElement,swatch);
    await React.act(async()=>swatch.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true})));await settle();host=document.querySelector('.color-picker-dialog');assert(host);await click(button(ui.t('common.cancel')));assert.equal(await result,null);await settle();assert.equal(document.activeElement,swatch);await unmount();
  });
  await check('Stale asynchronous preview responses cannot replace newer valid input',async()=>{
    await start();await mountPage();let release;slowPreview=new Promise(resolve=>{release=resolve;});
    await input(host.querySelector('#color-R'),'7');slowPreview=null;
    await input(host.querySelector('#color-R'),'8');await React.act(async()=>release());await settle();
    assert.equal(host.querySelector('#color-R').value,'8');await click(button(ui.t('color.apply')));
    assert.equal(JSON.parse(await opening)[0],8);await unmount();
  });
  await check('The hue ring retains a latent hue on white and black, then SV chooses the requested color',async()=>{
    for(const value of ['[255,255,255,255]','[0,0,0,255]']) {
      await start({type:'Color32',value});await mountPage();const {hue,sv}=wheel();
      await pointer(hue,'pointerdown',13.3974596216,150);await pointer(hue,'pointerup',13.3974596216,150);await settle();
      assert.equal(hue.getAttribute('aria-valuenow'),'240');await tab('HSV');await tab('RGB');assert.equal(hue.getAttribute('aria-valuenow'),'240');assert.deepEqual(readRgba(),JSON.parse(value));
      await pointer(sv,'pointerdown',100,0);assert.deepEqual(readRgba(),[0,0,255,255]);
      await pointer(sv,'pointerup',100,0);await settle();await click(button(ui.t('color.apply')));
      assert.deepEqual(JSON.parse(await opening),[0,0,255,255]);await unmount();
    }
  });
  await check('Negative/HDR values stay untouched on open, then an explicit wheel gesture keeps HDR brightness and latest alpha',async()=>{
    await start({value:'[8,1,-0.5,0.25]'});await mountPage();const {hue,sv}=wheel();
    assert.deepEqual(readRgba(),[8,1,-0.5,0.25]);assert(!button(ui.t('color.apply')).disabled);
    assert(host.textContent.includes(ui.t('color.nonnegativeSelection')));assert.equal(hue.getAttribute('aria-disabled'),'false');
    // Alpha changes before the asynchronous Rust response; the next gesture must use that draft.
    await React.act(async()=>{const element=host.querySelector('#color-A');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,'0.75');element.dispatchEvent(new Event('input',{bubbles:true}));});
    await pointer(hue,'pointerdown',13.3974596216,150);await pointer(hue,'pointerup',13.3974596216,150);
    assert.equal(Math.max(...readRgba().slice(0,3)),8);assert.equal(readRgba()[3],0.75);assert(readRgba().slice(0,3).every(value=>value>=0));
    await pointer(sv,'pointerdown',100,50);assert.equal(Math.max(...readRgba().slice(0,3)),4);
    await pointer(sv,'pointermove',100,50);assert.equal(Math.max(...readRgba().slice(0,3)),4);
    await pointer(sv,'pointerup',100,50);await settle();await click(button(ui.t('color.apply')));
    assert.equal(Math.max(...JSON.parse(await opening).slice(0,3)),4);await unmount();
  });
  await check('Pointer capture tracks outside SV, clamps coordinates, and stops after up/cancel/lost capture',async()=>{
    await start({type:'Color32',value:'[255,0,0,128]'});await mountPage();const {sv,svCapture}=wheel();
    await pointer(sv,'pointerdown',50,50,{pointerType:'touch'});assert(svCapture.has(1));
    await pointer(sv,'pointermove',500,-200,{pointerType:'touch'});assert.deepEqual(readRgba(),[255,0,0,128]);
    await pointer(sv,'pointermove',0,100,{pointerId:2,pointerType:'touch',isPrimary:false});assert.deepEqual(readRgba(),[255,0,0,128]);
    await pointer(sv,'pointerup',500,-200,{pointerType:'touch'});assert(!svCapture.has(1));
    await pointer(sv,'pointermove',0,100);assert.deepEqual(readRgba(),[255,0,0,128]);
    for(const ending of ['pointercancel','lostpointercapture']) {
      await pointer(sv,'pointerdown',50,50);const before=readRgba();await pointer(sv,ending,50,50);await pointer(sv,'pointermove',0,100);assert.deepEqual(readRgba(),before);
    }
    await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();
  });
  await check('Capture fallback accepts final outside release, blur cancels dragging, and wheel keyboard supports Shift',async()=>{
    await start({type:'Color32',value:'[255,0,0,255]'});await mountPage();const {sv,hue}=wheel();sv.setPointerCapture=()=>{throw Error('capture unavailable');};
    await pointer(sv,'pointerdown',50,50);await pointer(window,'pointerup',200,-100);assert.deepEqual(readRgba(),[255,0,0,255]);
    await pointer(window,'pointermove',0,100);assert.deepEqual(readRgba(),[255,0,0,255]);
    await pointer(sv,'pointerdown',50,50);await React.act(async()=>window.dispatchEvent(new Event('blur')));const before=readRgba();await pointer(window,'pointermove',0,100);assert.deepEqual(readRgba(),before);
    await React.act(async()=>hue.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true,cancelable:true})));assert.equal(hue.getAttribute('aria-valuenow'),'10');
    await React.act(async()=>sv.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true,cancelable:true})));assert.equal(sv.getAttribute('aria-valuenow'),'60');
    await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();
  });
  await check('Read-only formula wheel ignores pointer and keyboard gestures',async()=>{
    await start({readonly:true,formula:true});await mountPage();const {hue,sv}=wheel();const before=readRgba();
    assert.equal(hue.getAttribute('tabindex'),'-1');await pointer(hue,'pointerdown',200,100);
    await pointer(sv,'pointerdown',100,0);await React.act(async()=>hue.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})));
    assert.deepEqual(readRgba(),before);await click(button(ui.t('common.close')));assert.equal(await opening,null);await unmount();
  });
  await check('A no-op latent hue adjustment never strands a valid dirty draft in pending state',async()=>{
    await start({type:'Color32',value:'[255,0,0,255]'});await mountPage();const {hue}=wheel();await tab('HSV');await input(host.querySelector('#color-S'),'0');assert(!button(ui.t('color.apply')).disabled);
    await pointer(hue,'pointerdown',200,100);await pointer(hue,'pointerup',200,100);await settle();
    assert(!button(ui.t('color.apply')).disabled);await click(button(ui.t('color.apply')));assert.deepEqual(JSON.parse(await opening),[255,255,255,255]);await unmount();
  });
  await check('RGB and HSV tabs preserve untouched, negative/HDR, alpha, latent HSV and exact invalid drafts without submitting',async()=>{
    await start({value:'[8,1,-0.5,0.25]'});await mountPage();const canonical=()=>JSON.stringify(readRgba());
    const resultCount=draftResults.length;const before=canonical();await tab('HSV');assert.equal(host.querySelector('[role=tab][aria-selected=true]').textContent,'HSV');
    assert.equal(host.querySelector('#color-R-slider'),null);assert(host.querySelector('#color-H'));assert.equal(host.querySelectorAll('#color-A-slider').length,1);
    assert.equal(host.querySelector('#color-R'),null);assert.equal(host.querySelector('#color-A').value,'0.25');assert(!button(ui.t('color.apply')).disabled);
    await tab('RGB');assert.equal(canonical(),before);assert.deepEqual(readRgba(),[8,1,-0.5,0.25]);assert(!button(ui.t('color.apply')).disabled);
    await input(host.querySelector('#color-A'),'0.75');assert(!button(ui.t('color.apply')).disabled);await tab('HSV');await tab('RGB');
    assert(!child.destroyed);assert.equal(draftResults.length,resultCount);assert.deepEqual(readRgba(),[8,1,-0.5,0.75]);
    await input(host.querySelector('#color-R'),'-');await tab('HSV');await tab('RGB');assert.equal(host.querySelector('#color-R').value,'-');assert(button(ui.t('color.apply')).disabled);
    await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();
  });
  await check('Read-only RGB/HSV tabs remain keyboard accessible while channel inputs stay disabled',async()=>{
    await start({readonly:true,formula:true});await mountPage();const rgb=host.querySelector('[role=tab][aria-selected=true]');
    await React.act(async()=>{rgb.focus();rgb.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));});await settle();
    assert.equal(host.querySelector('[role=tab][aria-selected=true]').textContent,'HSV');assert(host.querySelector('#color-H').closest('fieldset').disabled);
    assert(host.querySelector('#color-A').closest('fieldset').disabled);assert.equal(button(ui.t('color.apply')),undefined);assert.equal(host.querySelector('#color-R'),null);
    await tab('RGB');assert.deepEqual(readRgba(),[2,0.5,-0.25,1]);await click(button(ui.t('common.close')));assert.equal(await opening,null);await unmount();
  });
  await check('Compact layout places a readable wheel and preview beside channels, with no instructional prose',async()=>{
    await start({type:'Color32',value:'[10,20,30,128]'});await mountPage();
    const details=host.querySelector('[data-color-details]'),tabs=host.querySelector('[role=tablist]'),circle=host.querySelector('[data-color-wheel=hue]');
    const top=host.querySelector('[data-color-top]'),inspector=host.querySelector('[data-color-inspector]'),preview=host.querySelector('[data-color-preview=current]');
    assert.equal(top.children.length,2);assert(top.children[0].contains(circle)&&top.children[0].contains(preview));assert.equal(top.children[1],inspector);assert(inspector.contains(tabs)&&inspector.contains(details));assert(top.classList.contains('items-start'));
    assert(details.contains(host.querySelector('#color-hex')));for(const channel of ['R','G','B','A']){const numeric=host.querySelector(`#color-${channel}`),slider=host.querySelector(`#color-${channel}-slider`);assert.equal(numeric.type,'text');assert.equal(numeric.previousElementSibling,slider);assert.equal(host.querySelectorAll(`#color-${channel}`).length,1);}
    assert.equal(host.querySelector(`[aria-label="${ui.t('color.canonical')}"]`),null);assert.equal(host.querySelectorAll('[data-color-preview]').length,1);assert.equal(host.querySelectorAll('[data-color-preview] canvas').length,1);
    for(const key of ['color.before','color.after','color.wheelKeyboard','color.byteRange','color.floatRange','color.displayOnly','color.sdrHint','color.hdrHint'])assert(!host.textContent.includes(ui.t(key)));
    assert(!host.querySelector('[aria-describedby]'));assert([...host.querySelectorAll('[role=tab]')].every(element=>element.type==='button'));await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();
  });
  await check('RGB, HSV, shared alpha and EV tracks show sampled resulting colors and checkerboard alpha',async()=>{
    await start({value:'[2,0.5,0.25,0.5]'});await mountPage();
    const validate=()=>{const sliders=[...host.querySelectorAll('input[type=range]')];assert.equal(sliders.length,5);for(const slider of sliders){assert(slider.classList.contains('color-value-slider'));assert(slider.style.backgroundImage.includes('linear-gradient'));assert(slider.style.backgroundImage.includes('conic-gradient'));assert(slider.style.backgroundImage.includes('50%'));}};
    validate();const red=host.querySelector('#color-R-slider'),before=red.style.backgroundImage;await input(host.querySelector('#color-G'),'0.8');assert.notEqual(red.style.backgroundImage,before);
    const afterRgb=red.style.backgroundImage;await input(host.querySelector('#color-exposure'),'-2');assert.notEqual(red.style.backgroundImage,afterRgb);
    await tab('HSV');validate();const alpha=host.querySelector('#color-A-slider');await input(alpha,'0.75');await tab('RGB');assert.equal(host.querySelector('#color-A').value,'0.75');
    await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();
  });
  await check('A single HDR preview survives tabs and falls back on device loss without changing the draft',async()=>{
    hdrCandidate=true;const createdBefore=hdrCreated,disposedBefore=hdrDisposed;await start({value:'[2,0.5,0.25,0.5]'});await mountPage();
    const canvas=host.querySelector('[data-color-preview=current] canvas');assert.equal(canvas.style.visibility,'visible');assert(host.textContent.includes(ui.t('color.hdrBadge')));
    assert.equal(hdrCreated-createdBefore,1);const channels=readRgba(),draw=hdrDraws.at(-1);assert.equal(draw[3],0.5);
    await tab('HSV');await tab('RGB');assert.equal(hdrCreated-createdBefore,1);assert.equal(host.querySelector('[data-color-preview=current] canvas'),canvas);assert.deepEqual(readRgba(),channels);
    await React.act(async()=>{for(const callback of hdrCallbacks)callback('lost');});
    assert.equal(canvas.style.visibility,'hidden');assert(host.textContent.includes(ui.t('color.sdrBadge')));assert.deepEqual(readRgba(),channels);assert(!button(ui.t('color.apply')).disabled);
    await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();assert.equal(hdrDisposed-disposedBefore,1);hdrCandidate=false;
  });
  await check('HSV numeric inputs switch with their sliders, preserve HDR and alpha, and validate through Rust',async()=>{
    await start({value:'[2,0.5,0.25,0.4]'});await mountPage();await tab('HSV');
    for(const channel of ['H','S','V']){const numeric=host.querySelector(`#color-${channel}`);assert.equal(numeric.type,'text');assert.equal(numeric.previousElementSibling,host.querySelector(`#color-${channel}-slider`));}
    assert.equal(host.querySelector('#color-R'),null);await input(host.querySelector('#color-H'),'240');await input(host.querySelector('#color-S'),'1');await input(host.querySelector('#color-V'),'4');
    await tab('RGB');assert.deepEqual(readRgba(),[0,0,4,0.4000000059604645]);await tab('HSV');assert.equal(host.querySelector('#color-V').value,'4');
    await input(host.querySelector('#color-V'),'1e39');assert(host.querySelector('[role=alert]'));assert(button(ui.t('color.apply')).disabled);assert.equal(host.querySelector('#color-V').value,'1e39');
    await input(host.querySelector('#color-V'),'3');assert(!button(ui.t('color.apply')).disabled);await click(button(ui.t('color.apply')));assert.deepEqual(JSON.parse(await opening),[0,0,3,0.4000000059604645]);await unmount();
  });
  await check('Incomplete and out-of-range HSV stays raw, never becomes zero, and blocks stale Apply across tabs and alpha',async()=>{
    await start({value:'[2,0.5,0.25,0.5]'});await mountPage();await input(host.querySelector('#color-R'),'3');await tab('HSV');
    for(const text of ['', '-', '.', '1e', 'NaN', 'Infinity', '-1', '361']) {
      const before=commands.length;await input(host.querySelector('#color-H'),text);assert.equal(host.querySelector('#color-H').value,text);assert.equal(commands.length,before);assert(button(ui.t('color.apply')).disabled);
      await tab('RGB');assert.deepEqual(readRgba(),[3,0.5,0.25,0.5]);await tab('HSV');assert.equal(host.querySelector('#color-H').value,text);
    }
    await input(host.querySelector('#color-A'),'0.75');await input(host.querySelector('#color-exposure'),'-1');await applyDisplay('ColorFloat','linear');
    assert.equal(host.querySelector('#color-H').value,'361');assert(button(ui.t('color.apply')).disabled);await input(host.querySelector('#color-H'),'120');assert(!button(ui.t('color.apply')).disabled);
    await input(host.querySelector('#color-S'),'1.01');assert(button(ui.t('color.apply')).disabled);await input(host.querySelector('#color-S'),'1');
    await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();
  });
  await check('A delayed RGB preview cannot overwrite a newer incomplete HSV draft',async()=>{
    await start();await mountPage();let release;slowPreview=new Promise(resolve=>release=resolve);await input(host.querySelector('#color-R'),'7');await tab('HSV');
    await input(host.querySelector('#color-H'),'-');slowPreview=null;await React.act(async()=>release());await settle();assert.equal(host.querySelector('#color-H').value,'-');assert(button(ui.t('color.apply')).disabled);
    await tab('RGB');assert.equal(host.querySelector('#color-R').value,'7');await tab('HSV');assert.equal(host.querySelector('#color-H').value,'-');
    await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();
  });
  await check('HEX is six digits only, retains invalid text across alpha edits, and never saves eight-digit input',async()=>{
    await start({type:'Color32',value:'[10,20,30,64]'});await mountPage();
    for(const text of ['', '#', '#12345', '#12345678']) {
      await input(host.querySelector('#color-hex'),text);assert.equal(host.querySelector('#color-hex').value,text);assert.deepEqual(readRgba(),[10,20,30,64]);assert(button(ui.t('color.apply')).disabled);
    }
    await input(host.querySelector('#color-A'),'128');assert.equal(host.querySelector('#color-hex').value,'#12345678');assert(button(ui.t('color.apply')).disabled);
    await input(host.querySelector('#color-hex'),'#ABCDEF');assert.deepEqual(readRgba(),[171,205,239,128]);assert(!button(ui.t('color.apply')).disabled);
    await input(host.querySelector('#color-A'),'0');assert.equal(host.querySelector('#color-hex').value,'#ABCDEF');await click(button(ui.t('color.apply')));assert.deepEqual(JSON.parse(await opening),[171,205,239,0]);await unmount();
  });
  await check('Invalid alpha does not erase the six-digit HEX derived only from RGB',async()=>{
    await start({type:'Color32',value:'[10,20,30,64]'});await mountPage();const hex=host.querySelector('#color-hex').value;
    for(const value of ['-', '', '256']){await input(host.querySelector('#color-A'),value);assert.equal(host.querySelector('#color-hex').value,hex);assert(button(ui.t('color.apply')).disabled);}
    await input(host.querySelector('#color-A'),'128');assert.equal(host.querySelector('#color-hex').value,hex);await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();
  });
  await check('Fast HEX and alpha edits retain both new RGB and the latest alpha before Rust responds',async()=>{
    await start({type:'Color32',value:'[10,20,30,64]'});await mountPage();await inputNow(host.querySelector('#color-hex'),'#112233');await inputNow(host.querySelector('#color-A'),'192');
    assert.deepEqual(readRgba(),[17,34,51,192]);assert.equal(host.querySelector('#color-hex').value,'#112233');await settle();
    await click(button(ui.t('color.apply')));assert.deepEqual(JSON.parse(await opening),[17,34,51,192]);await unmount();
  });
  await check('User swatches register an unchanged canonical color and support rename, reorder and delete independently of color Cancel',async()=>{
    userSwatches={revision:String(++swatchRevision),swatches:[]};await start({type:'Color32',value:'[10,20,30,128]'});await mountPage();
    assert(!button(ui.t('color.apply')).disabled);assert.equal(host.querySelector('[data-swatch-name]'),null);await click(button(ui.t('color.swatches.add')));const firstName=ui.t('column.swatches.defaultName',{index:'1'});
    assert.equal(userSwatches.swatches.length,1);assert.deepEqual(userSwatches.swatches[0],{id:userSwatches.swatches[0].id,name:firstName,data_type:'Color32',value:'[10,20,30,128]'});
    await click(button(ui.t('color.swatches.add')));const secondName=ui.t('column.swatches.defaultName',{index:'2'}),firstId=userSwatches.swatches[0].id;
    await editSwatch(firstName);await input(host.querySelector('[data-swatch-editor] input'),'Renamed');await click(host.querySelector(`[data-swatch-editor] [aria-label="${ui.t('common.save')}"]`));
    assert.equal(userSwatches.swatches[0].name,'Renamed');await editSwatch('Renamed');
    await click(host.querySelector(`[data-swatch-editor] [aria-label="${ui.t('column.swatches.moveDown',{name:'Renamed'})}"]`));assert.equal(userSwatches.swatches[1].id,firstId);
    await click(host.querySelector(`[data-swatch-editor] [aria-label="${ui.t('column.swatches.remove',{name:'Renamed'})}"]`));assert.deepEqual(userSwatches.swatches.map(item=>item.name),[secondName]);
    assert(!button(ui.t('color.apply')).disabled);await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();assert.equal(swatchListeners.size,0);
    await start({type:'Color32',value:'[1,2,3,255]'});await mountPage();assert(host.querySelector(`[aria-label="${secondName}"]`));await child.close();await opening;await unmount();
  });
  await check('Swatch scopes use init payload only, exact types and complete RGBA, without changing stored swatches on selection',async()=>{
    const byte={id:crypto.randomUUID(),name:'Transparent byte',data_type:'Color32',value:'[51,102,170,0]'};
    const hdr={id:crypto.randomUUID(),name:'HDR sample',data_type:'ColorFloat',value:'[8,1,-0.5,0.25]'};
    userSwatches={revision:String(++swatchRevision),swatches:[byte,hdr]};const before=JSON.stringify(userSwatches);
    await start({value:'[1,1,1,1]',columnSwatches:[hdr,byte],columnContext:{tableUuid:'table-context',columnUuid:'column-context'}});await mountPage();
    assert.equal(button(ui.t('color.swatches.column')).getAttribute('aria-selected'),'true');assert(!window.location.href.includes('HDR')&&!window.location.href.includes('table-context'));assert.deepEqual(ui.getColorPickerSession().request.columnSwatches,[hdr,byte]);
    assert.equal(host.querySelector('[aria-label="Transparent byte"]').getAttribute('aria-disabled'),'true');await tab('HSV');await input(host.querySelector('#color-H'),'-');assert(button(ui.t('color.apply')).disabled);
    await tab(ui.t('color.swatches.column'));assert(!host.querySelector('[data-swatch-name]'));assert.equal(host.querySelector('[aria-label="Transparent byte"]').getAttribute('aria-disabled'),'true');
    await click(host.querySelector('[aria-label="HDR sample"]'));assert.equal(commands.filter(item=>item.command==='apply_color_swatch').at(-1).args.targetType,'ColorFloat');await tab('RGB');assert.deepEqual(readRgba(),[8,1,-0.5,0.25]);assert(!button(ui.t('color.apply')).disabled);assert.equal(JSON.stringify(userSwatches),before);
    await click(button(ui.t('color.apply')));assert.deepEqual(JSON.parse(await opening),[8,1,-0.5,0.25]);await unmount();
  });
  await check('Project swatches expose only user scope and opaque Color32; registration stores canonical RGBA',async()=>{
    const opaque={id:crypto.randomUUID(),name:'Opaque',data_type:'Color32',value:'[17,34,51,255]'};
    userSwatches={revision:String(++swatchRevision),swatches:[...userSwatches.swatches,opaque]};await start({type:'UiColor',value:'#123456',columnSwatches:[opaque]});await mountPage();
    assert.equal(button(ui.t('color.swatches.column')),undefined);assert.equal(host.querySelector('[aria-label="Transparent byte"]').getAttribute('aria-disabled'),'true');assert.equal(host.querySelector('[aria-label="HDR sample"]').getAttribute('aria-disabled'),'true');
    await click(button(ui.t('color.swatches.add')));const saved=userSwatches.swatches.at(-1);assert.equal(saved.data_type,'Color32');assert.equal(saved.value,'[18,52,86,255]');
    await click(host.querySelector('[aria-label=Opaque]'));await click(button(ui.t('color.apply')));assert.equal(await opening,'#112233');await unmount();
  });
  await check('CAS conflicts keep rename drafts, reload explicitly, and never overwrite another window silently',async()=>{
    userSwatches={revision:String(++swatchRevision),swatches:[{id:crypto.randomUUID(),name:'Original',data_type:'Color32',value:'[1,2,3,255]'}]};await start({type:'Color32',value:'[1,2,3,255]'});await mountPage();
    await editSwatch('Original');await input(host.querySelector('[data-swatch-editor] input'),'My name');
    userSwatches={revision:String(++swatchRevision),swatches:userSwatches.swatches.map(item=>({...item,name:'Other window'}))};await React.act(async()=>refreshSwatches());await settle();
    assert.equal(host.querySelector('[data-swatch-editor] input').value,'My name');await click(host.querySelector(`[data-swatch-editor] [aria-label="${ui.t('common.save')}"]`));assert.equal(userSwatches.swatches[0].name,'Other window');assert(host.textContent.includes(ui.t('color.swatches.stale')));
    await click(button(ui.t('color.swatches.reload')));assert.equal(host.querySelector('[data-swatch-editor] input').value,'My name');await click(host.querySelector(`[data-swatch-editor] [aria-label="${ui.t('common.save')}"]`));assert.equal(userSwatches.swatches[0].name,'My name');
    await child.close();await opening;await unmount();
  });
  await check('Swatch registration rejects incomplete drafts and readonly, and repeated registration while saving writes once',async()=>{
    await start({type:'Color32',value:'[1,2,3,255]'});await mountPage();await input(host.querySelector('#color-hex'),'#');assert(button(ui.t('color.swatches.add')).disabled);
    await input(host.querySelector('#color-hex'),'#112233');let release;slowSwatchSave=new Promise(resolve=>release=resolve);const saveCount=commands.filter(item=>item.command==='set_user_color_swatches').length;
    await click(button(ui.t('color.swatches.add')));assert(button(ui.t('color.swatches.add')).disabled);await click(button(ui.t('color.swatches.add')));slowSwatchSave=null;await React.act(async()=>release());await settle();assert.equal(commands.filter(item=>item.command==='set_user_color_swatches').length,saveCount+1);
    await child.close();await opening;await unmount();await start({type:'Color32',value:'[1,2,3,255]',readonly:true});await mountPage();assert(button(ui.t('color.swatches.manage')).disabled);assert.equal(host.querySelector('[data-swatch-name]'),null);assert([...host.querySelectorAll('[data-swatch-id] button')].every(item=>item.getAttribute('aria-disabled')==='true'));await child.close();await opening;await unmount();
  });
  await check('Uncommitted palette I/O errors preserve the rename without suggesting reload',async()=>{
    userSwatches={revision:String(++swatchRevision),swatches:[{id:crypto.randomUUID(),name:'Original IO',data_type:'Color32',value:'[1,2,3,255]'}],warning:null,writable:true};
    await start({type:'Color32',value:'[1,2,3,255]'});await mountPage();
    await editSwatch('Original IO');await input(host.querySelector('[data-swatch-editor] input'),'Retained rename');
    swatchWriteError={kind:'code',code:'error.io',params:{details:'read-only fixture'}};
    try {
      await click(host.querySelector(`[data-swatch-editor] [aria-label="${ui.t('common.save')}"]`));
      assert.equal(userSwatches.swatches[0].name,'Original IO');
      assert.equal(host.querySelector('[data-swatch-editor] input').value,'Retained rename');
      assert(host.querySelector('[role="alert"]').textContent.includes('read-only fixture'));
      const management=host.querySelector('[data-swatch-management]'), alert=host.querySelector('[role="alert"]');
      assert.equal(management.parentElement,alert.parentElement.parentElement,'the editor and error share the same scroll viewport');
      assert(management.parentElement.classList.contains('overflow-y-auto'));
      assert(management.compareDocumentPosition(alert)&window.Node.DOCUMENT_POSITION_FOLLOWING,'the error follows the edit row in normal flow');
      assert.equal(button(ui.t('color.swatches.reload')),undefined);
      await React.act(async()=>window.dispatchEvent(new window.Event('focus')));await settle();
      assert(host.querySelector('[role="alert"]').textContent.includes('read-only fixture'),'focus reload must retain the unresolved save failure');
      await React.act(async()=>refreshSwatches());await settle();
      assert(host.querySelector('[role="alert"]').textContent.includes('read-only fixture'),'settings events must retain the unresolved save failure');
      assert.equal(host.querySelector('[data-swatch-editor] input').value,'Retained rename');
      swatchReadError={kind:'code',code:'error.io',params:{details:'temporary read failure'}};
      await React.act(async()=>window.dispatchEvent(new window.Event('focus')));await settle();
      assert(host.querySelector('[role="alert"]').textContent.includes('temporary read failure'));
      assert(host.querySelector('[role="alert"]').textContent.includes('read-only fixture'));
      swatchReadError=null;
      await React.act(async()=>window.dispatchEvent(new window.Event('focus')));await settle();
      assert(!host.querySelector('[role="alert"]').textContent.includes('temporary read failure'),'a successful background read clears only the read failure');
      assert(host.querySelector('[role="alert"]').textContent.includes('read-only fixture'));
      swatchWriteError=null;
      await click(host.querySelector(`[data-swatch-editor] [aria-label="${ui.t('common.save')}"]`));
      assert.equal(userSwatches.swatches[0].name,'Retained rename');
      assert.equal(host.querySelector('[role="alert"]'),null);
    } finally {swatchWriteError=null;swatchReadError=null;await child.close();await opening;await unmount();}
  });
  await check('Committed swatch warning closes saved drafts, blocks duplicate writes, relocalizes, and recovers through strict reload',async()=>{
    const originalSettings=ui.settings.getSettingsSnapshot();
    await React.act(async()=>ui.applyRuntimeLocalization(originalSettings.bundle.localization,{preference:'en',locale:'en',revision:'warning-en',availableLocales:['ja','en']}));
    userSwatches={revision:String(++swatchRevision),swatches:[{id:crypto.randomUUID(),name:'Before warning',data_type:'Color32',value:'[1,2,3,255]'}],warning:null,writable:true};
    await start({type:'Color32',value:'[1,2,3,255]'});await mountPage();
    await editSwatch('Before warning');await input(host.querySelector('[data-swatch-editor] input'),'Keep Name cannot be empty. exactly');
    const cause={kind:'code',code:'error.settingsSingleton',params:{}};
    const warning={kind:'code',code:'color.swatches.committedReloadRequired',params:{error:cause}};
    const englishWarning=ui.localizeError(warning);
    assert(englishWarning.includes(ui.localizeError(cause)),'the nested cause is localized inside the saved-with-warning summary');
    assert(!englishWarning.includes('[color.swatches.committedReloadRequired]'));
    swatchCommitWarning=warning;swatchReadError=cause;
    const writes=commands.filter(item=>item.command==='set_user_color_swatches').length;
    try {
      await click(host.querySelector(`[data-swatch-editor] [aria-label="${ui.t('common.save')}"]`));
      assert.equal(userSwatches.swatches[0].name,'Keep Name cannot be empty. exactly');
      assert.equal(host.querySelector('[data-swatch-editor]'),null,'successful commit closes the draft despite a verification warning');
      assert.equal(commands.filter(item=>item.command==='set_user_color_swatches').length,writes+1);
      assert(host.textContent.includes(ui.localizeError(warning)));assert(host.textContent.includes(ui.localizeError(cause)));
      assert(button(ui.t('color.swatches.add')).disabled);assert(button(ui.t('color.swatches.manage')).disabled);
      const stored=JSON.stringify(userSwatches),beforeLocale=host.querySelector('[role="alert"]').textContent;
      const settings=ui.settings.getSettingsSnapshot();
      await React.act(async()=>ui.applyRuntimeLocalization(settings.bundle.localization,{preference:'ja',locale:'ja',revision:'warning-ja',availableLocales:['ja','en']}));
      await settle();assert(host.textContent.includes(ui.localizeError(warning)));assert(host.textContent.includes(ui.localizeError(cause)));
      assert.notEqual(ui.localizeError(warning),englishWarning);
      assert(ui.localizeError(warning).includes(ui.localizeError(cause)));
      assert.notEqual(host.querySelector('[role="alert"]').textContent,beforeLocale);assert.equal(JSON.stringify(userSwatches),stored);
      await click(button(ui.t('color.swatches.add')));assert.equal(commands.filter(item=>item.command==='set_user_color_swatches').length,writes+1);
      await click(button(ui.t('color.swatches.reload')));assert(button(ui.t('color.swatches.manage')).disabled);
      swatchReadError=null;swatchCommitWarning=null;
      await click(button(ui.t('color.swatches.reload')));assert(!button(ui.t('color.swatches.manage')).disabled);
      assert.equal(host.querySelector('[role="alert"]'),null);assert.equal(JSON.stringify(userSwatches),stored);
      await click(button(ui.t('color.swatches.add')));assert.equal(commands.filter(item=>item.command==='set_user_color_swatches').length,writes+2);
    } finally {swatchReadError=null;swatchCommitWarning=null;await child.close();await opening;await unmount();}
  });
  await check('External updates cannot be bypassed by reorder or delete, and removed targets keep the unsaved name visible',async()=>{
    const id=crypto.randomUUID();userSwatches={revision:String(++swatchRevision),swatches:[{id,name:'Edit me',data_type:'Color32',value:'[1,2,3,255]'},{id:crypto.randomUUID(),name:'Neighbor',data_type:'Color32',value:'[4,5,6,255]'}]};
    await start({type:'Color32',value:'[1,2,3,255]'});await mountPage();await editSwatch('Edit me');await input(host.querySelector('[data-swatch-editor] input'),'Unsaved name');
    userSwatches={...userSwatches,revision:String(++swatchRevision),swatches:userSwatches.swatches.map(item=>item.id===id?{...item,name:'External name'}:item)};await React.act(async()=>refreshSwatches());await settle();
    await click(host.querySelector(`[data-swatch-editor] [aria-label="${ui.t('column.swatches.moveDown',{name:'External name'})}"]`));assert.equal(userSwatches.swatches[0].id,id);assert(host.textContent.includes(ui.t('color.swatches.stale')));
    await click(host.querySelector(`[data-swatch-editor] [aria-label="${ui.t('column.swatches.remove',{name:'External name'})}"]`));assert.equal(userSwatches.swatches.length,2);assert.equal(host.querySelector('[data-swatch-editor] input').value,'Unsaved name');
    userSwatches={revision:String(++swatchRevision),swatches:userSwatches.swatches.filter(item=>item.id!==id)};await React.act(async()=>refreshSwatches());await settle();assert.equal(host.querySelector('[data-swatch-editor] input').value,'Unsaved name');assert(host.textContent.includes(ui.t('color.swatches.stale')));
    assert(host.querySelector(`[data-swatch-editor] [aria-label="${ui.t('common.save')}"]`).disabled);await child.close();await opening;await unmount();
  });
  await check('Focus reloads user settings and swatch previews follow interpretation and EV without changing values',async()=>{
    userSwatches={revision:String(++swatchRevision),swatches:[{id:crypto.randomUUID(),name:'Preview HDR',data_type:'ColorFloat',value:'[2,0.25,0.5,0.5]'}]};await start();await mountPage();
    const swatch=host.querySelector('[data-swatch-id] button span.absolute');assert(swatch);const before=swatch.getAttribute('style');await input(host.querySelector('#color-exposure'),'-2');assert.notEqual(swatch.getAttribute('style'),before);assert.equal(userSwatches.swatches[0].value,'[2,0.25,0.5,0.5]');
    userSwatches={...userSwatches,revision:String(++swatchRevision),swatches:userSwatches.swatches.map(item=>({...item,name:'Focused reload'}))};await React.act(async()=>window.dispatchEvent(new Event('focus')));await settle();assert(host.querySelector('[aria-label="Focused reload"]'));
    userSwatches={...userSwatches,revision:String(++swatchRevision),swatches:userSwatches.swatches.map(item=>({...item,name:'Ordinary table edit'}))};
    await applyDisplay('ColorFloat','linear');assert(host.querySelector('[aria-label="Ordinary table edit"]'),'settings-project notification refreshes the palette without an unrelated focus or swatch event');
    await child.close();await opening;await unmount();
  });
  await check('Invalid source keeps the last-valid palette selectable but never enables preference writes',async()=>{
    const original=ui.settings.getSettingsSnapshot(),bundle=structuredClone(original.bundle);
    bundle.userSwatches=[{id:crypto.randomUUID(),name:'Last valid palette',data_type:'Color32',value:'[7,8,9,255]'}];
    settingsSnapshot={...original,bundle,revision:'last-valid-palette',source:'lastValid',warning:[{kind:'text',text:'invalid source'}]};
    globalThis.__colorHarness.isNative=true;await React.act(async()=>ui.settings.refreshAppSettings());globalThis.__colorHarness.isNative=false;
    swatchReadError={kind:'text',text:'invalid source'};
    try {
      await start({type:'Color32',value:'[1,2,3,255]'});await mountPage();
      assert(host.querySelector('[aria-label="Last valid palette"]'));assert(button(ui.t('color.swatches.manage')).disabled);assert(host.textContent.includes('invalid source'));
      const writes=commands.filter(item=>item.command==='set_user_color_swatches').length;
      await click(host.querySelector('[aria-label="Last valid palette"]'));assert.deepEqual(readRgba(),[7,8,9,255]);
      assert.equal(commands.filter(item=>item.command==='set_user_color_swatches').length,writes);
      await child.close();await opening;await unmount();
    } finally {swatchReadError=null;settingsSnapshot=original;globalThis.__colorHarness.isNative=true;await React.act(async()=>ui.settings.refreshAppSettings());globalThis.__colorHarness.isNative=false;}
  });
  await check('Delayed strict swatch application locks edits, returns only one request, and discards its result after Cancel',async()=>{
    userSwatches={revision:String(++swatchRevision),swatches:[{id:crypto.randomUUID(),name:'Delayed',data_type:'Color32',value:'[11,22,33,44]'}]};await start({type:'Color32',value:'[1,2,3,255]'});await mountPage();let release;slowSwatchApply=new Promise(resolve=>release=resolve);
    const applyCount=commands.filter(item=>item.command==='apply_color_swatch').length;await click(host.querySelector('[aria-label=Delayed]'));assert(host.querySelector('#color-R').closest('fieldset').disabled);assert(button(ui.t('color.apply')).disabled);
    await inputNow(host.querySelector('#color-R'),'99');assert.equal(host.querySelector('#color-R').value,'1');await click(host.querySelector('[aria-label=Delayed]'));assert.equal(commands.filter(item=>item.command==='apply_color_swatch').length,applyCount+1);
    await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();slowSwatchApply=null;await React.act(async()=>release());await settle();assert.equal(host.children.length,0);
  });
  await check('StrictMode cleans late user-palette listeners instead of duplicating subscriptions',async()=>{
    assert.equal(swatchListeners.size,0);
    await mount(React.createElement(React.StrictMode,null,React.createElement(ui.ColorPickerPanel,{request:{type:'Color32',value:'[1,2,3,255]',label:'Strict palette'},onApply:async()=>{},onCancel:()=>{}})));
    assert.equal(swatchListeners.size,1);await unmount();assert.equal(swatchListeners.size,0);
  });
  await check('One hundred named swatches remain compact squares inside a bounded independent scroll viewport',async()=>{
    userSwatches={revision:String(++swatchRevision),swatches:Array.from({length:100},(_,i)=>({id:crypto.randomUUID(),name:`Long palette name ${i+1} with extra detail`,data_type:'Color32',value:JSON.stringify([i,30,40,i===99?0:255])}))};
    await start({type:'Color32',value:'[255,255,255,255]'});await mountPage();const palette=host.querySelector('[data-color-swatches]'),viewport=host.querySelector('[data-swatch-scroll]'),grid=host.querySelector('[data-swatch-grid]'),controls=host.querySelector('[data-color-controls]');
    assert(palette.classList.contains('min-h-24')&&palette.classList.contains('flex-1'));assert(viewport.classList.contains('overflow-y-auto')&&viewport.classList.contains('h-full')&&viewport.classList.contains('overscroll-contain'));
    assert(controls.classList.contains('shrink-0'));assert.equal(grid.querySelectorAll('[role=listitem]').length,100);assert.equal(host.querySelector('[data-swatch-name]'),null);
    const buttons=[...grid.querySelectorAll('[data-swatch-select]')];for(const button of buttons){assert.equal(button.textContent,'');assert(button.classList.contains('h-6')&&button.classList.contains('w-6'));assert(button.getAttribute('aria-label'));}
    Object.defineProperty(grid,'clientWidth',{configurable:true,value:572});viewport.getBoundingClientRect=()=>({top:0,bottom:76,left:0,right:580,width:580,height:76});buttons.at(-1).getBoundingClientRect=()=>({top:216,bottom:240,left:0,right:24,width:24,height:24});
    assert(grid.classList.contains('grid-cols-[repeat(auto-fill,1.5rem)]'));
    await React.act(async()=>{buttons[0].focus();buttons[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));});
    assert.equal(document.activeElement,buttons[20], '24px tiles plus 4px gap determine the row stride');
    grid.style.direction='rtl';
    await React.act(async()=>{buttons[0].focus();buttons[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));});
    assert.equal(document.activeElement,buttons[1], 'RTL left moves to the next visual tile');
    await React.act(async()=>buttons[1].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})));
    assert.equal(document.activeElement,buttons[0]);grid.style.direction='ltr';
    const body=palette.parentElement;body.scrollTop=0;await React.act(async()=>{buttons[0].focus();buttons[0].dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));});await settle();
    assert.equal(document.activeElement,buttons.at(-1));assert(viewport.scrollTop>0);assert.equal(body.scrollTop,0);await click(buttons.at(-1));assert.deepEqual(readRgba(),[99,30,40,0]);
    await click(button(ui.t('color.apply')));assert.deepEqual(JSON.parse(await opening),[99,30,40,0]);await unmount();
  });
  await check('Names and incompatibility reasons appear on hover or focus in an unclipped portal, including readonly candidates',async()=>{
    const name='A long hidden name on a readonly candidate';userSwatches={revision:String(++swatchRevision),swatches:[{id:crypto.randomUUID(),name,data_type:'ColorFloat',value:'[2,0,0,0.5]'}]};
    await start({type:'Color32',value:'[10,20,30,40]',readonly:true});await mountPage();const candidate=host.querySelector('[data-swatch-select]');assert.equal(candidate.textContent,'');assert.equal(candidate.getAttribute('aria-disabled'),'true');assert(!candidate.disabled);
    await React.act(async()=>candidate.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:10,clientY:10,bubbles:true})));
    await React.act(async()=>new Promise(resolve=>realTimeout(resolve,200)));let tooltip=document.querySelector('[role=tooltip]');assert(tooltip&&tooltip.textContent.includes(name));assert(!host.contains(tooltip));assert(tooltip.textContent.includes(ui.t('color.swatches.typeMismatch')));
    await React.act(async()=>candidate.focus());await settle();tooltip=document.querySelector('[role=tooltip]');assert(tooltip&&tooltip.textContent.includes(name));const before=readRgba();await click(candidate);assert.deepEqual(readRgba(),before);
    await React.act(async()=>candidate.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));assert.equal(await opening,null);await unmount();assert.equal(document.querySelector('[role=tooltip]'),null);
  });
  await check('Segmented scope tabs reset only palette scroll and tooltip, retain values, and support arrow-key focus',async()=>{
    const columns=Array.from({length:100},(_,i)=>({id:crypto.randomUUID(),name:`Column ${i}`,data_type:'Color32',value:JSON.stringify([i,0,0,255])}));
    userSwatches={revision:String(++swatchRevision),swatches:columns.map(item=>({...item,id:crypto.randomUUID(),name:`User ${item.name}`}))};await start({type:'Color32',value:'[10,20,30,40]',columnSwatches:columns});await mountPage();
    const section=host.querySelector('[data-color-swatches]');let viewport=host.querySelector('[data-swatch-scroll]');viewport.scrollTop=220;await React.act(async()=>host.querySelector('[data-swatch-select]').focus());await settle();
    await tab(ui.t('color.swatches.user'));viewport=host.querySelector('[data-swatch-scroll]');assert.equal(viewport.scrollTop,0);let active=section.querySelector('[role=tab][aria-selected=true]');assert.equal(active.textContent,ui.t('color.swatches.user'));assert.equal(document.activeElement,active);assert.equal(document.querySelector('[role=tooltip]'),null);
    assert(active.classList.contains('data-[state=active]:border-border'));assert(section.querySelector('[role=tabpanel]'));viewport.scrollTop=310;
    await React.act(async()=>active.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})));await settle();active=section.querySelector('[role=tab][aria-selected=true]');assert.equal(active.textContent,ui.t('color.swatches.column'));assert.equal(document.activeElement,active);assert.equal(host.querySelector('[data-swatch-scroll]').scrollTop,0);
    assert.deepEqual(readRgba(),[10,20,30,40]);assert(!button(ui.t('color.apply')).disabled);await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();
  });
  await check('Every exact typed RGBA match has a persistent selected border across scopes, tabs and numeric edits',async()=>{
    const make=(name,data_type,value)=>({id:crypto.randomUUID(),name,data_type,value});
    const columns=[make('Match one','Color32','[10,20,30,40]'),make('Match duplicate','Color32','[10,20,30,40]'),make('Other alpha','Color32','[10,20,30,80]'),make('Other type','ColorFloat','[10,20,30,40]')];
    userSwatches={revision:String(++swatchRevision),swatches:[make('User match','Color32','[10,20,30,40]')]};
    await start({type:'Color32',value:'[10,20,30,40]',columnSwatches:columns});await mountPage();
    const pressed=()=>[...host.querySelectorAll('[data-swatch-select][aria-pressed=true]')].map(item=>item.getAttribute('aria-label'));
    assert.deepEqual(pressed(),['Match one','Match duplicate']);assert(host.querySelector('[data-swatch-select]').classList.contains('aria-pressed:ring-2'));assert(!button(ui.t('color.apply')).disabled);
    await tab('HSV');assert.deepEqual(pressed(),['Match one','Match duplicate']);await tab(ui.t('color.swatches.user'));assert.deepEqual(pressed(),['User match']);await tab(ui.t('color.swatches.column'));assert.deepEqual(pressed(),['Match one','Match duplicate']);
    await input(host.querySelector('#color-A'),'80');assert.deepEqual(pressed(),['Other alpha']);await input(host.querySelector('#color-A'),'-');assert.deepEqual(pressed(),[]);
    await input(host.querySelector('#color-A'),'40');assert.deepEqual(pressed(),['Match one','Match duplicate']);await tab('RGB');await input(host.querySelector('#color-R'),'11');assert.deepEqual(pressed(),[]);
    await click(host.querySelector('[data-swatch-select][aria-label="Match duplicate"]'));assert.deepEqual(pressed(),['Match one','Match duplicate']);assert.deepEqual(readRgba(),[10,20,30,40]);
    await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();
  });
  await check('Readonly HDR and project colors retain selected swatches without allowing registration or mutation',async()=>{
    for(const target of [{type:'ColorFloat',value:'[-2,4,0.25,0.5]',data_type:'ColorFloat',saved:'[-2,4,0.25,0.5]'},{type:'UiColor',value:'#112233',data_type:'Color32',saved:'[17,34,51,255]'}]){
      userSwatches={revision:String(++swatchRevision),swatches:[{id:crypto.randomUUID(),name:'Readonly current',data_type:target.data_type,value:target.saved}]};
      await start({type:target.type,value:target.value,readonly:true});await mountPage();const tile=()=>host.querySelector('[data-swatch-select]');
      assert.equal(tile().getAttribute('aria-pressed'),'true');assert.equal(tile().getAttribute('aria-disabled'),'true');assert(button(ui.t('color.swatches.manage')).disabled);
      await tab('HSV');assert.equal(tile().getAttribute('aria-pressed'),'true');await tab('RGB');
      if(target.type==='ColorFloat'){await input(host.querySelector('#color-exposure'),'-2');await applyDisplay('ColorFloat','linear');assert.equal(tile().getAttribute('aria-pressed'),'true');}
      const before=readRgba();await click(tile());assert.deepEqual(readRgba(),before);assert.equal(host.querySelector('[data-swatch-name]'),null);
      await click(button(ui.t('common.close')));assert.equal(await opening,null);await unmount();
    }
  });
  await check('Management is a separate scrollable mode and scope changes preserve unsaved names without selecting a color',async()=>{
    userSwatches={revision:String(++swatchRevision),swatches:[{id:crypto.randomUUID(),name:'Manage separately',data_type:'Color32',value:'[100,101,102,255]'}]};await start({type:'Color32',value:'[1,2,3,4]',columnSwatches:[]});await mountPage();assert(host.querySelector('[data-swatch-grid]'));
    await editSwatch('Manage separately');assert.equal(host.querySelector('[data-swatch-grid]'),null);assert(host.querySelector('[data-swatch-management]').closest('[role="tabpanel"]').classList.contains('overflow-y-auto'));assert.deepEqual(readRgba(),[1,2,3,4]);
    await input(host.querySelector('[data-swatch-editor] input'),'Uncommitted name');await tab(ui.t('color.swatches.column'));await tab(ui.t('color.swatches.user'));assert(host.querySelector('[data-swatch-grid]'));await manage();assert.equal(host.querySelector('[data-swatch-editor] input').value,'Uncommitted name');
    assert.deepEqual(readRgba(),[1,2,3,4]);assert.equal(userSwatches.swatches[0].name,'Manage separately');await click(button(ui.t('common.cancel')));assert.equal(await opening,null);await unmount();
  });
  await check('UI swatch transform preserves reference white, sRGB/linear distinction, alpha and finite HDR preview',async()=>{assert.equal(ui.colorPreviewCss([1,1,1,1],'ColorFloat','linear'),'rgba(255,255,255,1)');assert.equal(ui.colorPreviewCss([0.5,0.5,0.5,0],'ColorFloat','linear'),'rgba(188,188,188,0)');assert.equal(ui.colorPreviewCss([0.5,0.5,0.5,1],'ColorFloat','srgb'),'rgba(128,128,128,1)');assert.equal(ui.colorPreviewCss([-3,4,0,1],'ColorFloat','linear',-2),'rgba(0,255,0,1)');assert.equal(ui.displayChannels('not a color'),null);assert.equal(ui.displayChannels('[1,2,3]'),null);});
  console.log(JSON.stringify({passed:reports.length,checks:reports,scope:'Real picker components/in-app Radix dialog lifecycle with mocked IPC and GPU allocation. No actual display luminance or native Rust authority is claimed.'},null,2));
  await unmount();
} finally {globalThis.setTimeout=realTimeout;globalThis.clearTimeout=realClearTimeout;delete globalThis.__colorHarness;await browser.happyDOM.abort();await rm(temporary,{recursive:true,force:true});}
