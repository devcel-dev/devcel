// Real React hooks and effect cleanup; native file reads and events are boundary fixtures.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(studio, '.frontend-hook-check-'));
const window = new Window({ url: 'http://frontend-hooks.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'sessionStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const host = document.createElement('div'); document.body.append(host);
const root = createRoot(host);
const reports = [];
const check = async (name, body) => { await body(); reports.push(name); console.log('PASS', name); };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const files = [
  { id: 'folder', name: 'folder', path: 'folder', type: 'folder', children: [
    { id: 'folder/zeta', name: 'zeta', path: 'folder/zeta', type: 'table', modified: 2 },
    { id: 'folder/alpha', name: 'alpha', path: 'folder/alpha', type: 'table', modified: 1 },
  ] },
  { id: 'beta', name: 'beta', path: 'beta', type: 'table', modified: 3 },
];
const originalFiles = JSON.stringify(files);
const entries = [
  { path: 'folder', entry_type: 'Directory' },
  { path: 'folder/alpha', entry_type: 'Table' },
  { path: 'folder/zeta', entry_type: 'Table' },
  { path: 'beta', entry_type: 'Table' },
];
let pending;
const listeners = new Set();
globalThis.__frontendHookCheck = {
  getEntries: async () => pending ? pending.promise : entries,
  listen: async (_event, callback) => { listeners.add(callback); return () => listeners.delete(callback); },
};
let current;
try {
  const bundled = await build({ absWorkingDir: studio, stdin: {
    contents: `export { useSort } from './src/app/pages/main_window/project_view/file_browser_view/hooks/useSort';
      export { useSearch } from './src/app/pages/main_window/project_view/file_browser_view/hooks/useSearch';
      export { useFileTree } from './src/app/pages/main_window/project_view/file_browser_view/hooks/useFileTree';`,
    resolveDir: studio, loader: 'ts',
  }, bundle: true, format: 'esm', platform: 'node', packages: 'external', write: false,
  alias: { '@': path.join(studio, 'src') }, plugins: [{ name: 'native-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(?:@\/app\/commands\/projectCommands|@tauri-apps\/api\/event)$/ }, args => ({ path: args.path, namespace: 'boundary' }));
    builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ loader: 'js', contents: args.path.includes('projectCommands')
      ? 'export const getProjectEntries=(...args)=>globalThis.__frontendHookCheck.getEntries(...args);'
      : 'export const listen=(...args)=>globalThis.__frontendHookCheck.listen(...args);' }));
  } }] });
  const modulePath = path.join(temporary, 'hooks.mjs'); await writeFile(modulePath, bundled.outputFiles[0].text);
  const hooks = await import(pathToFileURL(modulePath));
  function Harness({ input = files, session = 'session-A' }) {
    const search = hooks.useSearch(input);
    const sort = hooks.useSort(search.filteredFiles);
    const tree = hooks.useFileTree('project-path', session);
    current = { search, sort, tree };
    return null;
  }
  const render = async props => React.act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(Harness, props))); await tick(); });
  await render({});
  await check('Sort/search memoization stays stable on unrelated renders and never mutates the source tree', async () => {
    const sorted = current.sort.sortedFiles;
    const searched = current.search.filteredFiles;
    await render({});
    assert.equal(current.sort.sortedFiles, sorted);
    assert.equal(current.search.filteredFiles, searched);
    assert.deepEqual(sorted[0].children.map(node => node.name), ['alpha', 'zeta']);
    assert.equal(JSON.stringify(files), originalFiles);
    await React.act(async () => current.sort.toggleSortOrder());
    assert.deepEqual(current.sort.sortedFiles[0].children.map(node => node.name), ['zeta', 'alpha']);
    await React.act(async () => { current.sort.setSortType('modified'); current.sort.setSortOrder('asc'); });
    assert.deepEqual(current.sort.sortedFiles[0].children.map(node => node.name), ['alpha', 'zeta']);
    assert.equal(JSON.stringify(files), originalFiles);
  });
  await check('Search responds to query, regex, type and new file input without stale closures', async () => {
    await React.act(async () => current.search.setSearchQuery('^alpha$'));
    assert.deepEqual(current.search.filteredFiles, []);
    await React.act(async () => current.search.setUseRegex(true));
    assert.deepEqual(current.search.filteredFiles[0].children.map(node => node.name), ['alpha']);
    await React.act(async () => current.search.setSearchQuery('['));
    assert.deepEqual(current.search.filteredFiles, []);
    await React.act(async () => { current.search.setSearchQuery(''); current.search.setFilterType('folder'); });
    assert.deepEqual(current.search.filteredFiles.map(node => node.type), ['folder']);
    await React.act(async () => current.search.setFilterType('all'));
    const replacement = [{ id: 'new', path: 'new', name: 'new', type: 'table' }];
    await render({ input: replacement });
    assert.equal(current.search.filteredFiles, replacement);
    await render({});
  });
  await check('File selection callbacks remain stable until their real tree/range dependencies change', async () => {
    await React.act(async () => { await current.tree.refreshProjectEntries(); });
    const find = current.tree.findNodeByIdInAllTrees;
    const select = current.tree.handleItemSelect;
    await render({});
    assert.equal(current.tree.findNodeByIdInAllTrees, find);
    assert.equal(current.tree.handleItemSelect, select);
    await React.act(async () => current.tree.setExpandedFolders(new Set(['folder'])));
    await React.act(async () => current.tree.handleItemSelect('folder/alpha', false, false));
    await React.act(async () => current.tree.handleItemSelect('beta', false, true, current.tree.files));
    assert.deepEqual([...current.tree.selectedItems], ['folder/alpha', 'folder/zeta', 'beta']);
    await React.act(async () => current.tree.setExpandedFolders(new Set()));
    await React.act(async () => current.tree.handleItemSelect('beta', false, true, current.tree.files));
    assert.deepEqual([...current.tree.selectedItems], ['beta'], 'A collapsed tree must not retain an obsolete visible range.');
  });
  await check('An old session read cannot commit after effect teardown and listeners are cleaned up', async () => {
    pending = deferred(); let result;
    await React.act(async () => { result = current.tree.refreshProjectEntries(); });
    const previous = current.tree.files;
    await render({ session: 'session-B' });
    await React.act(async () => { pending.resolve([{ path: 'stale', entry_type: 'Table' }]); await result; });
    assert.equal(await result, false);
    assert.equal(current.tree.files, previous);
    pending = undefined;
    await React.act(async () => root.unmount());
    await tick();
    assert.equal(listeners.size, 0);
  });
  console.log(JSON.stringify({ passed: reports.length, checks: reports, scope: 'Production React hooks and StrictMode effects; native reads/events mocked, not native UI validation.' }, null, 2));
} finally {
  delete globalThis.__frontendHookCheck;
  window.happyDOM.abort();
  await rm(temporary, { recursive: true, force: true });
}
