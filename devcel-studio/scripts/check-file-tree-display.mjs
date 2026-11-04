import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const w = new Window();
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) Object.defineProperty(globalThis, name, { configurable: true, value: w[name] });
globalThis.window = w;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w);
globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
const temp = await mkdtemp(resolve('.file-tree-display-'));
let root;
try {
  const mocks = {
    '@/app/i18n': `export const t=k=>k; export const useI18n=()=>({t}); export const formatDateTime=(d,o)=>new Intl.DateTimeFormat('ja-JP',o).format(d);`,
    'react-dnd': `export const useDrag=()=>[{},x=>x]; export const useDrop=()=>[{},x=>x];`,
    '@tauri-apps/api/core': `export const invoke=()=>{throw Error('Unexpected native mutation')};`,
    '@/components/ui/context-menu': `import React from 'react'; export const ContextMenu=({children})=><>{children}</>; export const ContextMenuTrigger=ContextMenu; export const ContextMenuContent=()=>null; export const ContextMenuItem=()=>null; export const ContextMenuSeparator=()=>null;`
  };
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `import React from 'react'; import {useSort} from './src/app/pages/main_window/project_view/file_browser_view/hooks/useSort'; export {FileTree} from './src/app/pages/main_window/project_view/file_browser_view/components/FileTree'; export function Sort({files}) {globalThis.sort = useSort(files); return null;}` }, bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic', write: false, alias: {'@':resolve('src')}, plugins: [{name:'boundaries',setup(b){ b.onResolve({filter:/.*/},a=>mocks[a.path]?{path:a.path,namespace:'mock'}:undefined); b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'tsx',resolveDir:process.cwd()})); }}] });
  const file = resolve(temp, 'fixture.mjs'); await writeFile(file, result.outputFiles[0].text);
  const {FileTree,Sort} = await import(pathToFileURL(file));
  const React = await import('react'); const {act} = React;
  const {createRoot} = await import('react-dom/client');
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const files = ['b','a','c','unknown'].map((id,i)=>({id,path:id+'.table.toml',name:id+'.table.toml',type:'table',modified:i===3?undefined:Date.UTC(2026,10,1,10,i===2?1:0)}));
  await act(async()=>root.render(React.createElement(Sort,{files})));
  await act(async()=>sort.setSortType('modified'));
  assert.deepEqual(sort.sortedFiles.map(x=>x.id), ['a','b','c','unknown']);
  await act(async()=>sort.setSortOrder('desc'));
  assert.deepEqual(sort.sortedFiles.map(x=>x.id), ['c','a','b','unknown']);
  const changed = files.map(f=>f.id==='b'?{...f,modified:Date.UTC(2026,10,2)}:f);
  await act(async()=>root.render(React.createElement(Sort,{files:changed})));
  assert.equal(sort.sortedFiles[0].id,'b','new metadata changes order');
  const props = {nodes:files,showModified:true,projectPath:'fixture',selectedItems:new Set(['a']),expandedFolders:new Set(),loadedTables:new Map(files.map(x=>[x.path,x.id])),handleItemSelect(){},toggleFolder(){},onDelete(){},onRename(){},onCreateTable(){},onCreateFolder(){},onMove(){}};
  const render = async extra=>act(async()=>root.render(React.createElement(FileTree,{...props,...extra})));
  await render({});
  assert.equal(document.querySelectorAll('time').length,4);
  assert.equal(document.querySelector('[data-file-id="b"] time').dateTime,new Date(files[0].modified).toISOString());
  assert.match(document.querySelector('[data-file-id="unknown"] time').textContent,/unknownDate/);
  assert.equal(document.querySelector('[role="tree"]').style.height,'176px');
  const label = id=>document.querySelector(`[data-file-id="${id}"] span[title="${id}.table.toml"]`);
  assert(label('a').classList.contains('text-secondary-foreground'));
  assert(label('b').classList.contains('text-foreground'),'loaded but unselected stays neutral');
  await render({selectedItems:new Set(['b']),nodes:changed});
  assert(label('a').classList.contains('text-foreground'),'previous selection loses highlight');
  assert(label('b').classList.contains('text-secondary-foreground'));
  assert.equal(document.querySelector('[data-file-id="b"] time').dateTime,new Date(changed[0].modified).toISOString());
  await render({showModified:false,selectedItems:new Set(['c']),loadedTables:new Map()});
  assert.equal(document.querySelectorAll('time').length,0);
  assert.equal(document.querySelector('[role="tree"]').style.height,'112px');
  assert(label('a').classList.contains('text-foreground'));
  assert(label('b').classList.contains('text-foreground'));
  console.log('PASS actual tree rows: selection moves, loaded/closed tables stay neutral, modification date/unknown/refresh, row geometry, ascending/descending stable ties. Native layout tested separately.');
} finally {
  if(root){const {act}=await import('react');await act(async()=>root.unmount());}
  await rm(temp,{recursive:true,force:true}); w.happyDOM.abort();
}
