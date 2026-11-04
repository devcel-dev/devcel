import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const window = new Window({ url: 'http://formula-completion.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'InputEvent', 'CompositionEvent', 'MutationObserver', 'DOMRect']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[name] = window[name].bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let invalidation, pending, accepted = [], parentKeys = 0;
const table = { uuid: 'table', data_name: 'Items', columns: [{ uuid: 'hp', data_name: 'hp', data_type: 'Number' },
  { uuid: 'enemy', data_name: 'enemy', data_type: 'Reference', reference_config: { target_table_uuid: 'enemies' } }] };
globalThis.__formulaUI = {
  catalog: () => [{ uuid: 'table', data_name: 'Items', display_name: 'Items' }, { uuid: 'enemies', data_name: 'Enemies' }],
  invalidate: callback => { invalidation = callback; return { ready: Promise.resolve(), release() {} }; },
  invoke: async (name, args) => {
    assert.equal(name, 'get_formula_completion_schema'); assert.equal(args.expectedProjectSession, 'session');
    if (pending) await pending;
    return { functions: ['SUM', 'SEQUENCE', 'SAME'], table: args.uuid === 'enemies' ? { uuid: 'enemies', data_name: 'Enemies', columns: [{ uuid: 'hp', data_name: 'hp', data_type: 'Number' }] } : table };
  },
  accepted: value => accepted.push(value)
};
const temp = await mkdtemp(resolve('.formula-ui-'));
let root;
try {
  const mocks = {
    // CSS extraction is build-time only; editor/event implementations stay real.
    '@linaria/core': 'export const css=()=> "synthetic-css";',
    '@tauri-apps/api/core': 'export const invoke=(...a)=>globalThis.__formulaUI.invoke(...a);',
    '@/app/commands/tableCommands': 'export const getTableCatalog=async()=>globalThis.__formulaUI.catalog();',
    '@/app/services/tableSnapshotInvalidation': 'export const retainTableSnapshotInvalidation=(s,c)=>globalThis.__formulaUI.invalidate(c);',
    '@/app/i18n': 'export const useI18n=()=>({t:k=>k});'
  };
  const result = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import React, {useState,useRef} from 'react';
    import {FormulaCompletionProvider} from './src/app/components/formula/FormulaCompletionProvider';
    import {FormulaInput} from './src/app/components/formula/FormulaInput';
    import {FormulaSuggestions} from './src/app/components/formula/FormulaSuggestions';
    import textEditor from './src/lib/react-data-grid/editors/textEditor';
    export function Harness({initial}) { const [value,setValue]=useState(initial);return <FormulaCompletionProvider session="session" tableUuid="table"><FormulaInput id="formula" value={value} onChange={v=>{setValue(v);globalThis.__formulaUI.accepted(v)}} /></FormulaCompletionProvider>; }
    export function CellHarness({initial}) { const [row,setRow]=useState({hp:initial});return <FormulaCompletionProvider session="session" tableUuid="table">{textEditor({row,column:{key:'hp',dataType:'String'},onRowChange:r=>{setRow(r);globalThis.__formulaUI.accepted(r.hp)},onClose:()=>globalThis.__formulaUI.accepted('CLOSED')})}</FormulaCompletionProvider>; }
    export function RaceHarness() { const ref=useRef(null);return <FormulaCompletionProvider session="session" tableUuid="table"><input ref={ref} defaultValue="=SU"/><FormulaSuggestions inputRef={ref} onAccept={(...args)=>globalThis.__formulaUI.accepted(args)}/></FormulaCompletionProvider>; }
    export function ControlledHarness({value}) { return <FormulaCompletionProvider session="session" tableUuid="table"><FormulaInput id="controlled" value={value} onChange={globalThis.__formulaUI.accepted}/></FormulaCompletionProvider>; }
  `, loader: 'tsx' }, bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic', write: false, alias: { '@': resolve('src') }, plugins: [{ name: 'native-boundary', setup(b) {
    b.onResolve({ filter: /.*/ }, a => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'mock' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: mocks[a.path], loader: 'js' }));
  } }] });
  const file = resolve(temp, 'ui.mjs'); await writeFile(file, result.outputFiles[0].text);
  const { Harness, CellHarness, RaceHarness, ControlledHarness } = await import(pathToFileURL(file));
  const React = await import('react'); const { act } = React; const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const tick = async () => { await new Promise(r => setTimeout(r, 15)); };
  const mount = async value => { accepted = []; await act(async () => { root.render(React.createElement(Harness, { key: Math.random(), initial: value })); await tick(); }); const input = host.querySelector('input'); await act(async () => { input.focus(); input.setSelectionRange(value.length, value.length); input.dispatchEvent(new Event('click', { bubbles: true })); await tick(); }); return input; };
  const press = async (input, key, extra = {}) => { let event; await act(async () => { event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...extra }); input.dispatchEvent(event); await tick(); }); return event; };
  host.addEventListener('keydown', () => parentKeys++);
  let input = await mount('=SU');
  assert(document.querySelector('[role=listbox]'), 'native provider + actual popup opens');
  const before = parentKeys;
  await press(input, 'Enter');
  assert.equal(input.value, '=SUM()'); assert.equal(input.selectionStart, 5); assert.equal(parentKeys, before, 'completion does not commit parent editor');
  input = await mount('=SU'); await press(input, 'ArrowLeft');
  await act(async () => { input.setSelectionRange(1, 1); document.dispatchEvent(new Event('selectionchange')); });
  await press(input, 'Enter'); assert.equal(accepted.length, 0, 'caret movement cannot accept stale token');
  input = await mount('=SU');
  await act(async () => { input.setSelectionRange(1, 3); document.dispatchEvent(new Event('selectionchange')); });
  await press(input, 'Tab'); assert.equal(accepted.length, 0, 'selection cannot accept stale token');
  input = await mount('=SU'); await press(input, 'Escape');
  assert(!document.querySelector('[role=listbox]')); assert.equal(accepted.length, 0);
  input = await mount('=SU');
  await press(input, 'Enter', { isComposing: true }); await press(input, 'Enter', { keyCode: 229 });
  assert.equal(accepted.length, 0);
  await act(async () => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await press(input, 'Enter'); assert.equal(accepted.length, 0); assert(!document.querySelector('[role=listbox]'));
  await act(async () => { input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await tick(); });
  assert(document.querySelector('[role=listbox]'));
  await act(async () => document.querySelector('[role=listbox]').dispatchEvent(new Event('scroll')));
  assert(document.querySelector('[role=listbox]'), 'scrolling candidates does not dismiss them');
  input = await mount('=MAP(TABLE("Enemies"),r=>r.h)');
  await act(async () => { input.setSelectionRange(input.value.length - 1, input.value.length - 1); input.dispatchEvent(new Event('click', { bubbles: true })); await tick(); });
  assert(document.querySelector('[role=option]')?.textContent.includes('hp'), 'lazy TABLE schema resolves callback member');
  await act(async () => { input.scrollLeft = 160; input.dispatchEvent(new Event('scroll')); });
  assert(document.querySelector('[role=listbox]'), 'native input caret auto-scroll must retain its completion');
  await press(input, 'Tab');
  assert(input.value.includes('r.`hp`'), 'member remains acceptable after input auto-scroll');
  input = await mount('=SU');
  await act(async () => window.dispatchEvent(new Event('scroll')));
  assert(!document.querySelector('[role=listbox]'), 'outer scrolling still retires detached popup geometry');
  input = await mount('plain'); assert(!document.querySelector('[role=listbox]'));
  for (const action of ['Enter', 'Tab', 'mouse']) {
    accepted = [];
    await act(async () => { root.render(React.createElement(RaceHarness, { key: action })); await tick(); });
    input = host.querySelector('input');
    await act(async () => { input.focus(); input.setSelectionRange(3, 3); input.dispatchEvent(new Event('click', { bubbles: true })); await tick(); });
    const oldOption = document.querySelector('[role=option]'); assert(oldOption);
    await act(async () => {
      input.value = '=SU+1'; input.setSelectionRange(5, 5);
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      // Before either the metadata microtask or React render runs, the visible
      // old option must already be unusable by every acceptance route.
      if (action === 'mouse') oldOption.click();
      else input.dispatchEvent(new KeyboardEvent('keydown', { key: action, bubbles: true, cancelable: true }));
      assert.equal(accepted.length, 0, action + ' cannot combine old candidate with new snapshot');
      await tick();
    });
    assert.equal(input.value, '=SU+1');
  }
  for (const action of ['Enter', 'Tab', 'mouse']) {
    accepted = [];
    await act(async () => { root.render(React.createElement(RaceHarness, { key: 'delayed-' + action })); await tick(); });
    input = host.querySelector('input');
    await act(async () => { input.focus(); input.setSelectionRange(3, 3); input.dispatchEvent(new Event('click', { bubbles: true })); await tick(); });
    const oldOption = document.querySelector('[role=option]'); assert(oldOption);
    let resolveSchema; pending = new Promise(r => { resolveSchema = r; });
    await act(async () => { input.value = '=SU+enemy.h'; input.setSelectionRange(11, 11); input.dispatchEvent(new InputEvent('input', { bubbles: true })); await tick(); });
    await act(async () => {
      if (action === 'mouse') oldOption.click();
      else input.dispatchEvent(new KeyboardEvent('keydown', { key: action, bubbles: true, cancelable: true }));
      assert.equal(accepted.length, 0, action + ' rejects stale candidate throughout delayed schema fetch');
      resolveSchema(); pending = null; await tick();
    });
    assert.equal(input.value, '=SU+enemy.h');
  }
  let release; pending = new Promise(r => { release = r; });
  input = await mount('=SU');
  await act(async () => { input.setSelectionRange(1, 1); document.dispatchEvent(new Event('selectionchange')); release(); pending = null; await tick(); });
  assert(!document.querySelector('[role=listbox]'), 'late response cannot restore stale caret candidates');
  input = await mount('=hp');
  await act(async () => { table.columns = [{ uuid: 'hp', data_name: 'health', data_type: 'Number' }]; invalidation(); await tick(); });
  assert(!document.querySelector('[role=listbox]'), 'rename invalidates old candidates');
  accepted = [];
  await act(async () => { root.render(React.createElement(CellHarness, { initial: '=SU\r\n+1' })); await tick(); });
  const textarea = host.querySelector('textarea');
  await act(async () => { textarea.focus(); textarea.setSelectionRange(3, 3); textarea.dispatchEvent(new Event('click', { bubbles: true })); await tick(); });
  await press(textarea, 'Tab');
  assert.equal(accepted.at(-1), '=SUM()\r\n+1', 'real cell editor preserves raw CRLF outside replacement');
  assert(!accepted.includes('CLOSED'), 'completion Tab does not close the actual cell editor');
  await act(async () => {
    textarea.value = '=SU\n+1';
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'historyUndo' }));
    await tick();
  });
  assert.equal(accepted.at(-1), '=SU\r\n+1', 'completion participates in the raw edit undo journal');
  // Production popup geometry in a compact transformed dialog: the header is
  // above y=350 and the content/footer boundary is y=470.
  await act(async () => { root.render(React.createElement(Harness, {key:'geometry',initial:'=SU'})); await tick(); });
  const modal = document.createElement('div'); modal.setAttribute('role','dialog');
  document.body.append(modal); modal.append(host);
  modal.getBoundingClientRect = () => ({left:100,top:300,right:660,bottom:480,width:560,height:180});
  Object.defineProperty(modal,'offsetWidth',{configurable:true,value:560});
  const geometryInput = host.querySelector('input');
  geometryInput.getBoundingClientRect = () => ({left:112,top:350,right:648,bottom:468,width:536,height:118});
  for (const scrollTop of [0,40,1000]) {
    geometryInput.scrollTop = scrollTop;
    await act(async () => { geometryInput.focus(); geometryInput.setSelectionRange(3,3); geometryInput.dispatchEvent(new Event('click',{bubbles:true})); await tick(); });
    const list = document.querySelector('[role=listbox]'); assert(list);
    const y = parseFloat(list.style.top)+300, height=parseFloat(list.style.maxHeight);
    assert(y>=353,'popup cannot cover modal title/header');
    assert(y+height<=472,'popup stays above content/footer boundary');
  }
  await act(async () => window.dispatchEvent(new Event('resize')));
  assert(!document.querySelector('[role=listbox]'),'resize retires old geometry');
  document.body.append(host); modal.remove();
  // Use real native inputs/provider/highlight, replacing only unavailable DOM
  // geometry. No keyboard, raw-input or completion listeners are mocked.
  const highlightStyle=document.createElement('style'); highlightStyle.textContent=await readFile(resolve('src/styles/formula-highlight.css'),'utf8');document.head.append(highlightStyle);
  const paintTick=async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await tick();};
  input=await mount('=SUM(1,"x")+enemy.hp');
  input.style.cssText='font:14px monospace;padding:3px;border:1px solid;width:120px;height:28px';
  input.getBoundingClientRect=()=>({left:50,top:100,right:170,bottom:128,width:120,height:28});
  Object.defineProperties(input,{offsetWidth:{configurable:true,value:120},offsetHeight:{configurable:true,value:28},clientWidth:{configurable:true,value:118},clientHeight:{configurable:true,value:26}});
  await act(async()=>{input.dispatchEvent(new Event('focus'));await paintTick();});
  let mirror=document.querySelector('.formula-highlight');assert(mirror);assert.equal(mirror.textContent,input.value);assert.equal(mirror.getAttribute('aria-hidden'),'true');assert.equal(mirror.style.pointerEvents,'none');assert.equal(input.getAttribute('data-formula-highlighted'),'true');
  assert(mirror.querySelector('.formula-token-function'));assert(mirror.querySelector('.formula-token-number'));assert(mirror.querySelector('.formula-token-string'));assert(mirror.querySelector('.formula-token-reference'));
  const rawFormula=input.value;
  await act(async()=>{input.scrollLeft=90;input.dispatchEvent(new Event('scroll'));await paintTick();});
  mirror=document.querySelector('.formula-highlight');assert.equal(mirror.textContent,rawFormula);assert(mirror.innerHTML.includes('-90px'));assert.equal(input.value,rawFormula);
  await act(async()=>{input.setSelectionRange(1,4);document.dispatchEvent(new Event('selectionchange'));await paintTick();});
  assert(!input.hasAttribute('data-formula-highlighted'),'native selection paint remains readable');assert.equal(input.selectionStart,1);assert.equal(input.selectionEnd,4);
  const copyEvent=new Event('copy',{bubbles:true,cancelable:true});input.dispatchEvent(copyEvent);assert(!copyEvent.defaultPrevented,'coloring never intercepts native copy');
  await act(async()=>{input.setSelectionRange(rawFormula.length,rawFormula.length);document.dispatchEvent(new Event('selectionchange'));await paintTick();});
  assert(input.hasAttribute('data-formula-highlighted'));
  await act(async()=>{input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));await tick();});
  assert(!input.hasAttribute('data-formula-highlighted'),'IME owns its original text/underline');
  assert.equal(input.value,rawFormula);
  await act(async()=>{input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));await paintTick();});
  assert(input.hasAttribute('data-formula-highlighted'));
  await press(input,'Enter',{keyCode:229});assert(!input.hasAttribute('data-formula-highlighted'),'229 fallback does not mask native conversion');
  await act(async()=>{input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));await paintTick();});
  await act(async()=>{input.readOnly=true;await paintTick();});assert(!input.hasAttribute('data-formula-highlighted'));
  await act(async()=>{input.readOnly=false;await paintTick();});assert(input.hasAttribute('data-formula-highlighted'));
  await act(async()=>{input.blur();await paintTick();});assert(!input.hasAttribute('data-formula-highlighted'));assert(!document.querySelector('.formula-highlight'));
  await act(async()=>{root.render(React.createElement(ControlledHarness,{value:'=SUM(1)'}));await tick();});
  input=host.querySelector('input');input.getBoundingClientRect=()=>({left:50,top:100,right:170,bottom:128,width:120,height:28});
  await act(async()=>{input.focus();input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('focus'));await paintTick();});
  assert.equal(document.querySelector('.formula-highlight').textContent,'=SUM(1)');
  await press(input,'Enter',{keyCode:229});
  await act(async()=>{root.render(React.createElement(ControlledHarness,{value:'=SUM(1)'}));await tick();});
  assert(!input.hasAttribute('data-formula-highlighted'),'parent rerender cannot revive paint suspended by IME');
  await act(async()=>{input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));await paintTick();});
  const nativeRAF=window.requestAnimationFrame,nativeCAF=window.cancelAnimationFrame,queuedFrames=new Map();let frameId=0;
  window.requestAnimationFrame=callback=>{queuedFrames.set(++frameId,callback);return frameId;};window.cancelAnimationFrame=id=>queuedFrames.delete(id);
  try {
    await act(async()=>{input.scrollLeft=55;input.dispatchEvent(new Event('scroll'));root.render(React.createElement(ControlledHarness,{value:'=SUM(1)'}));});
    assert(!input.hasAttribute('data-formula-highlighted'),'parent rerender cannot revive old scroll geometry before a fresh frame');
  } finally {window.requestAnimationFrame=nativeRAF;window.cancelAnimationFrame=nativeCAF;}
  await act(async()=>{for(const callback of queuedFrames.values())callback(performance.now());await paintTick();});assert(input.hasAttribute('data-formula-highlighted'));
  await act(async()=>{root.render(React.createElement(ControlledHarness,{value:'=SUM(22)'}));await paintTick();});
  assert.equal(document.querySelector('.formula-highlight').textContent,input.value,'controlled prop refresh cannot retain stale painted text');
  await act(async()=>{root.render(React.createElement(CellHarness,{initial:'=SUM(1,\r\n2)'}));await tick();});
  const highlightedArea=host.querySelector('textarea'),cellHost=highlightedArea.parentElement;
  highlightedArea.style.cssText='font:14px/20px monospace;padding:8px;border:1px solid';highlightedArea.wrap='soft';
  highlightedArea.getBoundingClientRect=()=>({left:20,top:50,right:420,bottom:150,width:400,height:100});
  cellHost.getBoundingClientRect=()=>({left:20,top:50,right:420,bottom:100,width:400,height:50});cellHost.style.overflow='hidden';
  Object.defineProperties(highlightedArea,{offsetWidth:{configurable:true,value:400},offsetHeight:{configurable:true,value:100},clientWidth:{configurable:true,value:384},clientHeight:{configurable:true,value:98}});
  Object.defineProperty(cellHost,'offsetWidth',{configurable:true,value:400});
  await act(async()=>{highlightedArea.focus();highlightedArea.setSelectionRange(highlightedArea.value.length,highlightedArea.value.length);highlightedArea.scrollTop=20;highlightedArea.dispatchEvent(new Event('scroll'));await paintTick();});
  mirror=document.querySelector('.formula-highlight');assert(mirror);assert.equal(mirror.parentElement,cellHost,'mirror stays inside native cell stacking context');
  assert.equal(mirror.textContent,highlightedArea.value,'multiline native display and CRLF adapter remain authoritative');assert.equal(parseFloat(mirror.style.height),50,'scroll viewport clips painted text');
  assert.equal(mirror.firstElementChild.style.borderRightWidth,'15px','native scrollbar width remains excluded from wrapping');assert(mirror.innerHTML.includes('-20px'));
  highlightStyle.remove();
  console.log('PASS real highlight mirror: lossless text, native selection/copy/IME/229, scroll alignment, read-only and blur cleanup');
  console.log('PASS actual completion provider/input/popup: acceptance, caret races, selection, IME, scroll, text and rename invalidation');
} finally {
  if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
  await rm(temp, { recursive: true, force: true }); window.happyDOM.abort();
}
