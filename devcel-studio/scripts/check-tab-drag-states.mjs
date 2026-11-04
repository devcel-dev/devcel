// Real TableTabView and tab items; synthetic DOM and react-dnd monitor boundaries.
// Run: node scripts/check-tab-drag-states.mjs [report.json]
// TAB_DRAG_BEFORE may point to an earlier TableTabView.tsx for a negative control.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.tab-drag-check-'));
const window = new Window({ url: 'http://tab-drag.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const reports = [];
const moves = [];
const subscriptions = new Set();
const dragSpecs = new Map();
const dropSpecs = new Map();
const boundary = globalThis.__tabDragStateCheck = {
  version: 0,
  dragging: null,
  over: null,
  subscribe(listener) { subscriptions.add(listener); return () => subscriptions.delete(listener); },
  snapshot: () => boundary.version,
  connect(kind, element, specification) {
    if (element) (kind === 'drag' ? dragSpecs : dropSpecs).set(element, specification);
  },
};
const mocks = {
  'react-dnd': `
    import { useCallback, useRef, useSyncExternalStore } from 'react';
    const b = globalThis.__tabDragStateCheck;
    function useMonitor(kind, specification) {
      const element = useRef(null);
      const latest = useRef(specification);
      latest.current = specification;
      useSyncExternalStore(b.subscribe, b.snapshot, b.snapshot);
      const connect = useCallback(node => {
        element.current = node;
        b.connect(kind, node, latest);
      }, [kind]);
      const monitor = {
        isDragging: () => element.current !== null && b.dragging === element.current,
        isOver: () => element.current !== null && b.over === element.current,
      };
      return [specification.collect(monitor), connect, connect];
    }
    export const useDrag = specification => useMonitor('drag', specification);
    export const useDrop = specification => useMonitor('drop', specification);
  `,
  '@/app/i18n': `export const t = key => key; export const useI18n = () => ({ t }); export const localizeError = String; export const appErrorException = value => value instanceof Error ? value : new Error(String(value)); export const localizedError = String; export const message = (key, values) => ({ key, values }); export const toAppError = value => ({ kind: 'text', text: String(value) });`,
  '@tauri-apps/api/core': `export const isTauri = () => false; export const invoke = async command => { throw Error('Unexpected IPC: ' + command); };`,
  '@tauri-apps/api/event': `export const listen = async () => () => {};`,
  '@tauri-apps/plugin-dialog': `export const message = async () => { throw Error('Unexpected dialog'); };`,
  '@/app/services/appDialogs': `export const message = async () => { throw Error('Unexpected dialog'); };export const ask=async()=>false;export const appAlert=message;export const appConfirm=ask;export const appPrompt=async(...args)=>globalThis.prompt?.(...args)??null;`,
  '@/app/commands/tableCommands': `export const loadTable = async () => { throw Error('Unexpected table load'); }; export const isTableLoadingSessionCurrent = () => true;`,
  '@/app/utils/string_editor_window': `export const requestCloseStringEditor = async () => true;`,
  '@/app/utils/markdownSaveLifecycle': `export const flushMarkdownEdits = async () => {};`,
  '@/app/services/PluginManager': `export class PluginManager { static getInstance() { return { setActiveTable() {} }; } }`,
  './components/FileHeader': `import React from 'react'; export const getDisplayTitle = item => item.name; export const FileHeader = ({ currentItem }) => React.createElement('h2', { 'data-displayed-file': currentItem.id }, currentItem.name);`,
  './components/FileViewRegistry': `export const FileViewRenderer = () => null;`,
};

let root;
let React;
try {
  const result = await build({
    absWorkingDir: project,
    entryPoints: ['src/app/pages/main_window/project_view/table_view/TableTabView.tsx'],
    bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false,
    alias: { '@': resolve(project, 'src') },
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [{ name: 'tab-drag-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path)
        ? { path: args.path, namespace: 'boundary' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: mocks[args.path], loader: 'js', resolveDir: project }));
      if (process.env.TAB_DRAG_BEFORE) builder.onLoad({ filter: /TableTabView\.tsx$/ }, async () => ({
        contents: await readFile(process.env.TAB_DRAG_BEFORE, 'utf8'), loader: 'tsx',
      }));
    } }],
  });
  const modulePath = resolve(temporary, 'app.mjs');
  await writeFile(modulePath, result.outputFiles[0].text);
  const { default: TableTabView } = await import(pathToFileURL(modulePath));
  React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const files = ['first.md', 'second.md'].map(name => ({ id: name, path: name, name, type: 'markdown' }));
  await React.act(async () => root.render(React.createElement(TableTabView, {
    projectSession: { id: 'drag-session', path: '/fixtures/main.devcel' }, selectedItems: files,
    onTabMove: (from, to) => moves.push([from, to]),
  })));
  const tabs = [...host.querySelectorAll('.border-b-2')];
  assert.equal(tabs.length, 2, 'both real tab items rendered');
  const [active, inactive] = tabs;
  const updateMonitor = async (dragging = null, over = null) => {
    await React.act(async () => {
      boundary.dragging = dragging;
      boundary.over = over;
      boundary.version += 1;
      for (const listener of subscriptions) listener();
    });
    const currentTabs = [...host.querySelectorAll('.border-b-2')];
    assert.equal(currentTabs.length, tabs.length);
    currentTabs.forEach((tab, index) => assert.equal(tab, tabs[index], 'monitor changes keep the same tab nodes'));
  };
  const opacity = (tab, expected) => assert.equal(tab.classList.contains('opacity-50'), expected, `${tab.textContent}: drag opacity`);
  const underline = (tab, expected) => assert.equal(tab.classList.contains('border-primary'), expected, `${tab.textContent}: primary underline`);
  const check = async (name, action) => { await action(); reports.push(name); console.log('PASS', name); };

  await check('Idle tabs are fully opaque, with only the active tab underlined', () => {
    assert.equal(host.querySelector('[data-displayed-file]')?.getAttribute('data-displayed-file'), files[0].id);
    assert.equal(dragSpecs.size, 2); assert.equal(dropSpecs.size, 2);
    opacity(active, false); opacity(inactive, false);
    underline(active, true); underline(inactive, false);
  });
  await check('Dragging dims only the drag source without adding an inactive underline', async () => {
    await updateMonitor(inactive);
    opacity(active, false); opacity(inactive, true);
    underline(active, true); underline(inactive, false);
  });
  await check('Hover highlights only the drop target and preserves the active underline', async () => {
    await updateMonitor(active, inactive);
    opacity(active, true); opacity(inactive, false);
    underline(active, true); underline(inactive, true);
  });
  await check('Hover reorders once per target through the real tab callback', async () => {
    const item = { ...dragSpecs.get(active).current.item };
    assert.equal(dragSpecs.get(active).current.type, 'TAB');
    assert.equal(dropSpecs.get(inactive).current.accept, 'TAB');
    await React.act(async () => {
      dropSpecs.get(inactive).current.hover(item);
      dropSpecs.get(inactive).current.hover(item);
    });
    assert.deepEqual(moves, [[0, 1]]);
    assert.equal(item.index, 1);
  });
  await check('Leaving the drop target clears its underline while dragging continues', async () => {
    await updateMonitor(active);
    opacity(active, true); opacity(inactive, false);
    underline(active, true); underline(inactive, false);
  });
  await check('Ending or cancelling a drag clears transient styles without clearing selection', async () => {
    await React.act(async () => dragSpecs.get(active).current.end({ index: 0 }, {}));
    await updateMonitor();
    opacity(active, false); opacity(inactive, false);
    underline(active, true); underline(inactive, false);
  });
  await check('Repeated hover and release never leave stale opacity or highlighting', async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await updateMonitor(inactive, inactive);
      opacity(active, false); opacity(inactive, true);
      underline(active, true); underline(inactive, true);
      await updateMonitor();
      opacity(active, false); opacity(inactive, false);
      underline(active, true); underline(inactive, false);
    }
  });
  await check('Tab activation still moves the selection underline after drag release', async () => {
    await React.act(async () => inactive.click());
    assert.equal(host.querySelector('[data-displayed-file]')?.getAttribute('data-displayed-file'), files[1].id);
    opacity(active, false); opacity(inactive, false);
    underline(active, false); underline(inactive, true);
  });
  const report = {
    passed: reports.length, checks: reports,
    scope: 'Real TableTabView and TableTabItem; synthetic DOM and mocked react-dnd monitors, native IPC/dialog/editor boundaries. Native pointer drag and computed theme contrast require separate UI QA.',
  };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (root) await React.act(() => root.unmount());
  await window.happyDOM.close();
  await rm(temporary, { recursive: true, force: true });
  delete globalThis.__tabDragStateCheck;
}
