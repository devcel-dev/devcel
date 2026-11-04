// Shared tooltip behavior in a synthetic DOM; native geometry is checked separately.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.grid-tooltip-check-'));
const window = new Window({ url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'Element', 'Node',
  'Event', 'MouseEvent', 'FocusEvent', 'KeyboardEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
const reports = [];
try {
  const result = await build({ absWorkingDir: project, stdin: {
    contents: `export { createGridSharedTooltipController } from './src/lib/react-data-grid/gridSharedTooltipController';
      import React from 'react';
      import Cell from './src/lib/react-data-grid/Cell';
      import { useGridSharedTooltip, GridSharedTooltipPortal } from './src/lib/react-data-grid/GridSharedTooltip';
      const b=globalThis.__gridTooltipCheck;
      function StatefulValue(props) {
        React.useEffect(()=>{b.mounts++;return()=>{b.unmounts++;};},[]);
        return <div className="h-full" data-value onClick={()=>b.trace.push('value-click')}
          onMouseEnter={()=>b.trace.push('value-enter')} onMouseLeave={()=>b.trace.push('value-leave')}>
          {props.row.value}<button data-mutate onClick={event=>{event.stopPropagation();props.onRowChange({...props.row,value:'changed'});}}>mutate</button>
        </div>;
      }
      const renderCell=props=><StatefulValue {...props}/>;
      export function MemoFixture({selected=0,table='A',modal=false}) {
        const rootRef=React.useRef(null);
        const rows=React.useMemo(()=>[{id:table+'a',value:'A'},{id:table+'b',value:'B'}],[table]);
        const columns=React.useMemo(()=>[{key:'c',idx:0,name:'Column',frozen:false,renderCell:props=><span>{props.row.value}</span>,memoText:row=>row.value+' '.repeat(2)+'long memo '.repeat(500)}],[]);
        const controller=useGridSharedTooltip({rootRef,rows,columns,rowKeyGetter:row=>row.id,selectedPosition:{rowIdx:selected,idx:0}});
        return <><div ref={rootRef} role="grid"><GridSharedTooltipPortal controller={controller}/>
          {rows.map((row,rowIdx)=><Cell key={row.id} column={columns[0]} row={row} rowIdx={rowIdx} sharedTooltip={controller}
            isCellSelected={selected===rowIdx} isDraggedOver={false} onRowChange={()=>{}} selectCell={()=>{}} />)}
        </div>{modal&&<div data-modal-overlay style={{position:'fixed',inset:0,zIndex:50}} onClick={()=>b.modalClicks++}/>}</>;
      }
      export function Fixture({row,lock=false}) {
        const rootRef=React.useRef(null);
        const column=React.useMemo(()=>({key:'c',idx:0,name:'Column',frozen:false,editable:true,renderCell,
          renderEditCell:()=>null,tooltip:'tip',memoText:'memo',tooltipPlacement:'top',
          cellDescription:row=>({title:row.hint||undefined,description:row.hint||undefined,invalid:row.invalid||undefined})}),[]);
        const columns=React.useMemo(()=>[column],[column]);
        const rowKeyGetter=React.useCallback(row=>row.id,[]);
        const controller=useGridSharedTooltip({rootRef,rows:[row],columns,rowKeyGetter});
        const wrapped=React.useRef(false);
        if(!wrapped.current){wrapped.current=true;const enter=controller.onMouseEnter,leave=controller.onMouseLeave;
          controller.onMouseEnter=event=>{b.trace.push('tooltip-enter');enter(event);};
          controller.onMouseLeave=event=>{b.trace.push('tooltip-leave');leave(event);};}
        b.controller=controller;
        return <div ref={rootRef} role="grid" onClick={()=>b.trace.push('ancestor-click')}>
          <GridSharedTooltipPortal controller={controller}/>
          <Cell column={column} row={row} rowIdx={0} colSpan={undefined} sharedTooltip={controller}
            transientLock={lock} isDraggedOver={false} isCellSelected={true}
            onClick={()=>b.trace.push('cell-click')} onMouseEnter={()=>b.trace.push('cell-enter')}
            onMouseLeave={event=>{b.trace.push('cell-leave');if(b.stopLeave)event.stopPropagation();}}
            onRowChange={(_column,row)=>b.changes.push(row)} selectCell={(position,options)=>b.selections.push({position,options})}/>
        </div>;
      }`, resolveDir: project, loader: 'tsx'
  }, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false,
    alias: { '@': resolve(project, 'src') }, plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@linaria\/core$/ }, () => ({ path: 'linaria', namespace: 'boundary' }));
      builder.onResolve({ filter: /^@\/app\/i18n$/ }, () => ({ path: 'i18n', namespace: 'boundary' }));
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ loader: 'js', contents: args.path === 'linaria'
        ? `export const css=()=> 'test-style';` : `export const t=key=>key;export const useI18n=()=>({t,locale:'ja'});export const formatNumber=String;export const localizeError=String;export const message=(key,params)=>({key,params});export const localizedError=value=>new Error(value.key||String(value));` }));
      builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'css' }));
      builder.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ loader: 'js', contents: '' }));
    }}]
  });
  const modulePath = resolve(temporary, 'fixture.mjs');
  await writeFile(modulePath, result.outputFiles[0].text);
  const boundary = globalThis.__gridTooltipCheck = { mounts: 0, unmounts: 0, trace: [], changes: [], selections: [], stopLeave: false };
  const { createGridSharedTooltipController, Fixture, MemoFixture } = await import(pathToFileURL(modulePath));
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const check = async (name, action) => { await action(); reports.push(name); console.log('PASS', name); };

  // Deterministic timers exercise actual controller state and DOM lifetime guards.
  let now = 0, timerId = 0;
  const timers = new Map();
  const setTimer = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; };
  const clearTimer = id => timers.delete(id);
  const advance = milliseconds => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = end;
  };
  const grid = document.createElement('div'); grid.setAttribute('role', 'grid'); document.body.append(grid);
  const host = document.createElement('div'); grid.append(host);
  host.setAttribute('aria-describedby', 'existing-description');
  host.getBoundingClientRect = () => new window.DOMRect(100, 200, 50, 30);
  let identity = { rowKey: 'row-A', columnKey: 'col-A', tooltip: 'tip', memoText: 'memo', placement: 'top' };
  const controller = createGridSharedTooltipController({ id: 'shared-description', getRoot: () => grid,
    resolveCell: target => target === host ? identity : undefined, setTimer, clearTimer });
  const event = { currentTarget: host, relatedTarget: null };
  const click = stopped => ({ ...event, isPropagationStopped: () => stopped, stopPropagation() { this.stopped = true; } });

  await check('hover 500ms and memo 2000ms, exclusive portal and fresh position', async () => {
    controller.onMouseEnter(event); advance(499); assert.equal(controller.getSnapshot(), null);
    advance(1); assert.equal(controller.getSnapshot().mode, 'tooltip'); assert.equal(controller.getSnapshot().top, 192);
    assert.equal(host.getAttribute('aria-describedby'), 'existing-description shared-description');
    advance(1499); assert.equal(controller.getSnapshot().mode, 'tooltip');
    advance(1); assert.equal(controller.getSnapshot().mode, 'memo');
    controller.onMouseLeave(event); assert.equal(controller.getSnapshot().mode, 'memo');
    controller.onPortalLeave(event); assert.equal(controller.getSnapshot().mode, 'memo');
    controller.onSelection({rowKey:'other',columnKey:'col-A'}); assert.equal(controller.getSnapshot(), null);
    assert.equal(timers.size, 0); assert.equal(host.getAttribute('aria-describedby'), 'existing-description');
  });
  await check('click runs after child and stops ancestor only on first memo click', async () => {
    const stopped = click(true); controller.onClick(stopped); assert.equal(controller.getSnapshot(), null);
    const first = click(false); controller.onClick(first); assert.equal(first.stopped, true);
    assert.equal(controller.getSnapshot().mode, 'memo'); assert.equal(timers.size, 0);
    const second = click(false); controller.onClick(second); assert.equal(second.stopped, undefined);
    controller.dismiss();
  });
  await check('focus, descendant focus, blur and Escape preserve keyboard access', async () => {
    controller.onFocus(event); advance(500); assert.equal(controller.getSnapshot().mode, 'tooltip');
    const child = document.createElement('button'); host.append(child);
    controller.onBlur({ ...event, relatedTarget: child }); assert(controller.getSnapshot());
    controller.onEscape(new window.KeyboardEvent('keydown', { key: 'Escape' })); assert.equal(controller.getSnapshot(), null);
    controller.onFocus(event); controller.onBlur(event); advance(2000); assert.equal(controller.getSnapshot(), null);
  });
  await check('virtual row reuse, changed column key, detach and late timers cancel', async () => {
    controller.onMouseEnter(event); const queued = [...timers.values()].map(timer => timer.callback);
    identity = { ...identity, rowKey: 'row-B' }; controller.reconcile(); advance(2000); assert.equal(controller.getSnapshot(), null);
    controller.onMouseEnter(event); queued.forEach(callback => callback()); assert.equal(controller.getSnapshot(), null);
    identity = { ...identity, columnKey: 'col-B' }; controller.reconcile(); assert.equal(timers.size, 0);
    controller.onMouseEnter(event); host.remove(); grid.append(host);
    await new Promise(resolve => setImmediate(resolve)); advance(2000); assert.equal(controller.getSnapshot(), null);
  });
  await check('ancestor scroll closes; unrelated scroll does not; metadata stays current', async () => {
    controller.onMouseEnter(event); advance(500);
    identity = { ...identity, tooltip: 'new tip' }; controller.reconcile(); assert.equal(controller.getSnapshot().text, 'new tip');
    const unrelated = document.createElement('div'); document.body.append(unrelated);
    controller.onScroll({ target: unrelated }); assert(controller.getSnapshot());
    controller.onScroll({ target: document.body }); assert.equal(controller.getSnapshot(), null);
    unrelated.remove();
  });
  await check('X suppresses same-cell hover/click until selection changes', async () => {
    controller.onClick(click(false)); assert.equal(controller.getSnapshot().mode,'memo');
    controller.closeMemo(); controller.onMouseEnter(event); controller.onClick(click(false)); advance(3000);
    assert.equal(controller.getSnapshot(),null);
    controller.onSelection({rowKey:'another',columnKey:'col-A'});
    controller.onClick(click(false)); assert.equal(controller.getSnapshot().mode,'memo');
    controller.onSelection(identity); controller.onMouseLeave(event); assert.equal(controller.getSnapshot().mode,'memo');
    controller.onScroll({target:grid}); assert.equal(controller.getSnapshot().mode,'memo');
  });
  await check('A virtualized host cannot replace a pinned memo with another cell', async () => {
    assert.equal(controller.getSnapshot().mode,'memo');
    host.remove(); grid.append(host); identity={...identity,rowKey:'recycled-row',memoText:'WRONG MEMO'};
    await new Promise(resolve=>setImmediate(resolve)); controller.reconcile();
    assert.equal(controller.getSnapshot().text,'memo');
    controller.onMouseEnter(event); assert.equal(controller.getSnapshot().text,'memo');
    controller.onSelection(identity); assert.equal(controller.getSnapshot(),null);
  });
  controller.dismiss(); grid.remove();

  const mount = document.createElement('section'); document.body.append(mount); root = createRoot(mount);
  const render = async (row, lock = false, key = 'session-A:table-A') => {
    await act(async () => root.render(React.createElement(Fixture, { row, lock, key })));
  };
  await render({ id: 'r1', value: 'value', hint: '' });
  const cell = () => mount.querySelector('[role="gridcell"]');
  const value = () => mount.querySelector('[data-value]');
  const fire = async (target, type, options = {}) => { await act(async () => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, ...options }))); };

  await check('real Cell enter order, child-first click and React ancestor stopPropagation', async () => {
    boundary.trace.length = 0; await fire(value(), 'mouseover');
    assert.deepEqual(boundary.trace, ['tooltip-enter', 'cell-enter', 'value-enter']);
    boundary.trace.length = 0; await fire(value(), 'click');
    assert.deepEqual(boundary.trace, ['value-click', 'cell-click']);
    assert(document.querySelector('[data-grid-tooltip-id]')); assert(cell().getAttribute('aria-describedby'));
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert(document.querySelector('[data-grid-tooltip-id]'), 'Escape does not discard selected cell memo');
    await act(async()=>boundary.controller.closeMemo());
    assert.equal(document.querySelector('[data-grid-tooltip-id]'), null);
  });
  await check('hint toggles preserve Stateful renderer, value readout and full-height topology', async () => {
    const before = value(); const mounts = boundary.mounts;
    await render({ id: 'r1', value: 'value', hint: 'hint and error', invalid: true });
    assert.equal(value(), before); assert.equal(boundary.mounts, mounts); assert.equal(cell().children.length, 1);
    assert(value().classList.contains('h-full')); assert.equal(cell().getAttribute('title'), 'hint and error');
    assert.equal(cell().getAttribute('aria-description'), 'hint and error'); assert.equal(cell().getAttribute('aria-invalid'), 'true');
    assert.equal(cell().getAttribute('aria-label'), null); assert(cell().textContent.includes('value'));
    await render({ id: 'r1', value: 'value', hint: '' });
    assert.equal(value(), before); assert.equal(cell().getAttribute('title'), null); assert.equal(cell().getAttribute('aria-invalid'), null);
  });
  await check('transient lock preserves readonly meaning and blocks widget callback mutation', async () => {
    await render({ id: 'r1', value: 'value', hint: '' }, true);
    assert.equal(cell().getAttribute('aria-readonly'), 'true'); await fire(mount.querySelector('[data-mutate]'), 'click');
    assert.equal(boundary.changes.length, 0); await fire(cell(), 'dblclick');
    assert.equal(boundary.selections.at(-1).options.enableEditor, false);
    await render({ id: 'r1', value: 'value', hint: '' }, false);
    assert.equal(cell().getAttribute('aria-readonly'), null); await fire(mount.querySelector('[data-mutate]'), 'click');
    assert.equal(boundary.changes.length, 1);
  });
  await check('real leave stopPropagation and table/session unmount remove portal and timers', async () => {
    boundary.controller.onSelection(undefined);
    await fire(value(), 'mouseover'); boundary.trace.length = 0; boundary.stopLeave = true;
    await fire(value(), 'mouseout', { relatedTarget: document.body });
    assert(boundary.trace.includes('cell-leave')); assert(!boundary.trace.includes('tooltip-leave'));
    boundary.stopLeave = false; await fire(value(), 'click'); assert(document.querySelector('[data-grid-tooltip-id]'));
    await render({ id: 'r1', value: 'other table', hint: '' }, false, 'session-B:table-B');
    assert.equal(document.querySelector('[data-grid-tooltip-id]'), null);
    await fire(value(), 'click'); assert(document.querySelector('[data-grid-tooltip-id]'));
    await act(async () => root.unmount()); root = null;
    assert.equal(document.querySelector('[data-grid-tooltip-id]'), null);
  });
  root=createRoot(mount);
  const renderMemo=async props=>act(async()=>root.render(React.createElement(MemoFixture,props)));
  await check('production Cell selection: X then B hover then A hover stays closed until selection/table change',async()=>{
    await renderMemo({selected:0});
    const cells=()=>mount.querySelectorAll('[role="gridcell"]');
    await fire(cells()[0],'click');
    assert(document.querySelector('[data-grid-tooltip-id]'));
    await fire(document.querySelector('[data-grid-tooltip-id] button'),'click');
    await fire(cells()[0],'mouseout',{relatedTarget:cells()[1]});
    await fire(cells()[1],'mouseover',{relatedTarget:cells()[0]});
    await fire(cells()[1],'mouseout',{relatedTarget:cells()[0]});
    await fire(cells()[0],'mouseover',{relatedTarget:cells()[1]});
    await act(async()=>new Promise(resolve=>setTimeout(resolve,2100)));
    assert.equal(document.querySelector('[data-grid-tooltip-id]'),null);
    await renderMemo({selected:1}); await renderMemo({selected:0});
    await fire(cells()[0],'click'); assert(document.querySelector('[data-grid-tooltip-id]'));
    await renderMemo({selected:0,table:'B'});
    assert.equal(document.querySelector('[data-grid-tooltip-id]'),null);
  });
  await check('memo text scrolls separately from SVG close control; modal layer covers without dismissing memo',async()=>{
    const a=mount.querySelector('[role="gridcell"]'); await fire(a,'click');
    const portal=document.querySelector('[data-grid-tooltip-id]');
    const text=portal.querySelector('[data-grid-memo-content]'), close=portal.querySelector('button');
    assert.equal(text.style.paddingRight,'28px'); assert.equal(text.style.overflowY,'auto');
    assert.equal(portal.style.overflow,'hidden'); assert.equal(close.parentElement,portal);
    assert(!text.contains(close)); assert.equal(close.querySelector('svg').getAttribute('width'),'16');
    assert.equal(close.getAttribute('aria-label'),'common.close'); assert(close.className.includes('focus-visible'));
    await renderMemo({selected:0,table:'B',modal:true});
    assert.equal(document.querySelector('[data-grid-tooltip-id]'),portal);
    const overlay=mount.querySelector('[data-modal-overlay]');
    assert(Number(portal.style.zIndex)<Number(overlay.style.zIndex));
    boundary.modalClicks=0; await fire(overlay,'click'); assert.equal(boundary.modalClicks,1);
    assert.equal(document.querySelector('[data-grid-tooltip-id]'),portal);
    await renderMemo({selected:0,table:'B',modal:false});
    assert.equal(document.querySelector('[data-grid-tooltip-id]'),portal);
    await fire(close,'click'); assert.equal(document.querySelector('[data-grid-tooltip-id]'),null);
    // This headless DOM verifies stacking contract/state, not physical browser hit testing.
    const dialog=await readFile(resolve(project,'src/components/ui/dialog.tsx'),'utf8');
    assert(dialog.includes('fixed inset-0 z-50'));
  });
  const source = await readFile(resolve(project, 'src/lib/react-data-grid/Cell.tsx'), 'utf8');
  assert(source.includes('const tooltipText = sharedTooltip ? undefined'));
  console.log(`${reports.length} focused shared-tooltip checks passed`);
} finally {
  if (root) { const React = await import('react'); await React.act(async () => root.unmount()); }
  await window.happyDOM.abort();
  await rm(temporary, { recursive: true, force: true });
  delete globalThis.__gridTooltipCheck;
}
