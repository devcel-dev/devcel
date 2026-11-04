// Exercise the actual grid/editor in React StrictMode, including passive-effect
// focus transfers. Geometry and Linaria CSS are fixtures; this is not browser QA.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = process.env.GRID_EDITOR_RUNTIME_PROJECT
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(project, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('esbuild')));
const { Window } = await import(pathToFileURL(require.resolve('happy-dom')));
const temporary = await mkdtemp(resolve(project, '.grid-editor-runtime-'));
// Optional repository snapshot used to prove that the regression tests fail
// against the previous implementation, without changing the working source.
const before = process.env.GRID_EDITOR_RUNTIME_BEFORE;
const window = new Window({ url: 'http://localhost/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'HTMLDivElement', 'Element', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'FocusEvent',
  'KeyboardEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener', 'removeEventListener']) {
  globalThis[name] = window[name].bind(window);
}
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
Object.defineProperties(window.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 900 }, clientHeight: { configurable: true, get: () => 600 },
  offsetWidth: { configurable: true, get: () => 900 }, offsetHeight: { configurable: true, get: () => 600 }
});
window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 900, 600);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const diagnostics = [], failures = [], passed = [];
const originalConsole = { error: console.error, warn: console.warn };
for (const level of ['error', 'warn']) console[level] = (...args) => {
  diagnostics.push({ level, text: args.map(String).join(' ') });
  originalConsole[level](...args);
};
let root;
try {
  const result = await build({ absWorkingDir: project,
    stdin: { contents: `export { DataGrid } from './src/lib/react-data-grid/DataGrid';
      export { default as textEditor } from './src/lib/react-data-grid/editors/textEditor';`,
      resolveDir: project, loader: 'tsx' },
    bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false,
    alias: { '@': resolve(project, 'src') }, plugins: [{ name: 'grid-editor-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@linaria\/core$/ }, () => ({ path: 'linaria', namespace: 'boundary' }));
      builder.onResolve({ filter: /^@\/app\/i18n$/ }, () => ({ path: 'i18n', namespace: 'boundary' }));
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ loader: 'js', contents: args.path === 'linaria'
        ? `let next=0; export const css=()=> 'test-style-'+next++;`
        : `export const t=key=>key; export const useI18n=()=>({t,locale:'ja'}); export const formatNumber=String; export const localizeError=String; export const message=(key,values)=>({key,values}); export const localizedError=descriptor=>Object.assign(new Error(descriptor.key),descriptor);` }));
      builder.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'css' }));
      builder.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ loader: 'js', contents: '' }));
      if (before) builder.onLoad({ filter: /[/\\](DataGrid|EditCell)\.tsx$/ }, async args => ({
        contents: await readFile(resolve(before, 'devcel-studio', args.path.slice(project.length + 1)), 'utf8'), loader: 'tsx'
      }));
    }}]
  });
  const modulePath = resolve(temporary, 'fixture.mjs');
  await writeFile(modulePath, result.outputFiles[0].text);
  const fixture = await import(pathToFileURL(modulePath));
  const React = await import(pathToFileURL(require.resolve('react')));
  const { createRoot } = await import(pathToFileURL(require.resolve('react-dom/client')));
  const { act, createElement: element } = React;
  const mount = document.createElement('section'); document.body.append(mount); root = createRoot(mount);
  const render = async component => { await act(async () => root.render(component)); };
  const check = async (name, action) => {
    try { await action(); passed.push(name); console.log('PASS', name); }
    catch (error) { failures.push({ name, error: error.stack }); console.log('FAIL', name, error.message); }
  };

  let gridRef, onCommit, rowsAtRender, commits, mountId = 0, externalUpdate, openFocus, outsideSaw, columns;
  function FocusTransfer() {
    const ref = React.useRef(null);
    React.useEffect(() => { ref.current.focus(); }, []);
    return element('input', { ref, id: 'focus-transfer' });
  }
  function Harness() {
    const [rows, setRows] = React.useState([{ id: 'a', value: 'A' }, { id: 'b', value: 'B' }]);
    const [showFocus, setShowFocus] = React.useState(false);
    rowsAtRender = rows; externalUpdate = setRows; openFocus = () => setShowFocus(true);
    return element('section', null,
      element(fixture.DataGrid, { ref: gridRef, rows, columns, rowKeyGetter: row => row.id, enableVirtualization: false,
        onRowsChange: nextRows => { commits.push(nextRows); onCommit?.(); setRows(nextRows); }
      }),
      element('button', { id: 'outside', onClick: () => { outsideSaw = rows[0].value; } }, 'Outside'),
      showFocus && element(FocusTransfer)
    );
  }
  const reset = async options => {
    gridRef = React.createRef(); commits = []; onCommit = null; outsideSaw = undefined;
    columns = [{ key: 'value', name: 'Value', width: 150, dataType: 'String', editable: true, ...options }];
    await render(element(React.StrictMode, null, element(Harness, { key: ++mountId })));
  };
  const input = () => mount.querySelector('.rdg-editor-container textarea, .rdg-editor-container input');
  const begin = async (rowIdx = 0) => {
    await act(async () => gridRef.current.selectCell({ rowIdx, idx: 0 }, { enableEditor: true, shouldFocusCell: true }));
    assert(input(), 'editor opens'); return input();
  };
  const type = async value => { await act(async () => {
    const target = input(); Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(target, value);
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
  }); };
  const key = (target, value) => {
    const event = new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
    target.dispatchEvent(event); return event;
  };
  const outside = () => mount.querySelector('#outside');
  const mousedown = target => target.dispatchEvent(new window.MouseEvent('mousedown', {
    bubbles: true, cancelable: true, button: 0, buttons: 1
  }));

  await check('Passive autofocus commits without lifecycle warnings and retains destination focus', async () => {
    await reset(); await begin(); await type('autofocus'); const start = diagnostics.length;
    await act(async () => openFocus());
    assert.equal(commits.length, 1); assert.equal(rowsAtRender[0].value, 'autofocus');
    assert.equal(document.activeElement, mount.querySelector('#focus-transfer'));
    assert.deepEqual(diagnostics.slice(start), [], 'autofocus produces no runtime diagnostics');
  });
  await check('Validated editor also commits on passive autofocus without reclaiming focus', async () => {
    let validations = 0;
    await reset({ validator: () => { validations++; return { isValid: true }; }, validationMode: 'onBlur' });
    await begin(); await type('validated'); const start = diagnostics.length;
    await act(async () => openFocus());
    assert.equal(commits.length, 1); assert.equal(rowsAtRender[0].value, 'validated');
    assert(validations > 0, 'the real validated editor validates the changed draft');
    assert.equal(document.activeElement, mount.querySelector('#focus-transfer'));
    assert.deepEqual(diagnostics.slice(start), []);
  });
  await check('Validated Enter moves down, ShiftEnter up; invalid and composing input stay put', async () => {
    await reset({validator:value=>({isValid:value!=='bad',errorMessage:'Invalid'}),validationMode:'onBlur'});
    await begin();await type('valid');await act(async()=>key(input(),'Enter'));
    assert.equal(commits.length,1);assert.equal(mount.querySelector('[role="row"][aria-rowindex="3"] [role="gridcell"]').getAttribute('aria-selected'),'true');
    await begin(1);await type('second');await act(async()=>input().dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true})));
    assert.equal(commits.length,2);assert.equal(mount.querySelector('[role="row"][aria-rowindex="2"] [role="gridcell"]').getAttribute('aria-selected'),'true');
    await begin();await type('bad');await act(async()=>key(input(),'Enter'));assert(input());assert.equal(commits.length,2);
    await type('valid');await act(async()=>input().dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})));assert(input());assert.equal(commits.length,2);
    await act(async()=>input().dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',altKey:true,bubbles:true,cancelable:true})));assert(input());assert.equal(commits.length,2);
  });
  await check('Blur notifies the row owner immediately, before a microtask can run', async () => {
    await reset(); await begin(); await type('immediate');
    await act(async () => { outside().focus(); assert.equal(commits.length, 1); assert.equal(commits[0][0].value, 'immediate'); });
    assert(!input());
  });
  await check('Blur followed by same-task cell selection commits only once', async () => {
    await reset(); await begin(); await type('once');
    await act(async () => { outside().focus(); gridRef.current.selectCell({ rowIdx: 1, idx: 0 }); });
    assert.equal(commits.length, 1); assert.equal(rowsAtRender[0].value, 'once');
    assert.equal(mount.querySelector('[role="row"][aria-rowindex="3"] [role="gridcell"]').getAttribute('aria-selected'), 'true');
  });
  await check('Outside mousedown flushes the edit before the following parent click', async () => {
    await reset(); await begin(); await type('visible');
    await act(async () => { mousedown(outside()); outside().click(); });
    assert.equal(outsideSaw, 'visible'); assert.equal(commits.length, 1);
  });
  await check('Enter and Tab commit once and close or navigate as expected', async () => {
    await reset(); await begin(); await type('enter');
    await act(async () => key(input(), 'Enter'));
    assert.equal(commits.length, 1); assert(!input()); assert.equal(rowsAtRender[0].value, 'enter');
    await begin(); await type('tab'); await act(async () => key(input(), 'Tab'));
    assert.equal(commits.length, 2); assert(!input()); assert.equal(rowsAtRender[0].value, 'tab');
  });
  await check('Tab from the last cell permits focus to leave and consumes the edit once', async () => {
    await reset(); await begin(1); await type('last');
    await act(async () => {
      assert.equal(key(input(), 'Tab').defaultPrevented, false);
      assert.equal(commits.length, 1, 'Tab commits synchronously');
      outside().focus(); // Happy DOM does not implement the browser's native Tab default action.
    });
    assert.equal(commits.length, 1); assert(!input()); assert.equal(rowsAtRender[1].value, 'last');
    assert.equal(document.activeElement, outside());
  });
  await check('Selecting the same cell consumes its draft and leaves a normal selection', async () => {
    await reset(); await begin(); await type('same');
    await act(async () => gridRef.current.selectCell({ rowIdx: 0, idx: 0 }));
    assert.equal(commits.length, 1); assert(!input()); assert.equal(rowsAtRender[0].value, 'same');
    assert.equal(mount.querySelector('[role="row"][aria-rowindex="2"] [role="gridcell"]').getAttribute('aria-selected'), 'true');
  });
  await check('Escape and reopen of an unchanged cell starts a fresh edit session', async () => {
    await reset(); await begin(); await type('discard'); await act(async () => key(input(), 'Escape'));
    assert.equal(commits.length, 0); assert.equal(rowsAtRender[0].value, 'A');
    await begin(); await type('keep'); await act(async () => key(input(), 'Enter'));
    assert.equal(commits.length, 1); assert.equal(rowsAtRender[0].value, 'keep');
  });
  await check('Owner callback reentrance cannot recommit or overwrite a newer selection', async () => {
    await reset(); await begin(); await type('reentrant');
    onCommit = () => { if (commits.length < 3) gridRef.current.selectCell({ rowIdx: 1, idx: 0 }); };
    await act(async () => outside().focus());
    assert.equal(commits.length, 1);
    assert.equal(mount.querySelector('[role="row"][aria-rowindex="3"] [role="gridcell"]').getAttribute('aria-selected'), 'true');
  });
  await check('External row replacement discards an old draft before subsequent focus transfer', async () => {
    await reset(); await begin(); await type('stale');
    await act(async () => externalUpdate(rows => rows.map(row => row.id === 'a' ? { ...row, value: 'external' } : row)));
    await act(async () => outside().focus());
    assert.equal(commits.length, 0); assert.equal(rowsAtRender[0].value, 'external');
  });
  await check('Callbacks from a canceled editor cannot close, commit, or mutate its replacement', async () => {
    let callbacks;
    await reset({ renderEditCell: props => { callbacks = props; return fixture.textEditor(props); } });
    await begin(); await type('old'); const stale = callbacks;
    await act(async () => key(input(), 'Escape')); await begin(); await type('fresh');
    await act(async () => {
      stale.onRowChange({ ...stale.row, value: 'stale draft' });
      stale.onRowChange({ ...stale.row, value: 'stale commit' }, true);
      stale.onClose(false, false); stale.onClose(true, false);
    });
    assert.equal(input()?.value, 'fresh'); assert.equal(commits.length, 0);
    await act(async () => key(input(), 'Enter'));
    assert.equal(commits.length, 1); assert.equal(rowsAtRender[0].value, 'fresh');
  });
  await check('Callbacks from an unmounted grid cannot notify its former row owner', async () => {
    let callbacks;
    await reset({ renderEditCell: props => { callbacks = props; return fixture.textEditor(props); } });
    await begin(); await type('unmounted'); const stale = callbacks;
    await reset();
    await act(async () => stale.onClose(true, false));
    assert.equal(commits.length, 0); assert.equal(rowsAtRender[0].value, 'A');
  });

  await act(async () => root.unmount()); root = undefined;
  if (diagnostics.length) failures.push({ name: 'Runtime console remains clean', diagnostics });
  console.log(JSON.stringify({ passed: passed.length, failures }, null, 2));
  assert.equal(failures.length, 0, 'grid editor runtime regressions');
} finally {
  try {
    if (root) {
      const { act } = await import(pathToFileURL(require.resolve('react')));
      await act(async () => root.unmount());
    }
    await window.happyDOM.close();
    assert.equal(diagnostics.length, 0, 'grid editor runtime regressions: no console diagnostics during cleanup');
  } finally {
    for (const level of ['error', 'warn']) console[level] = originalConsole[level];
    await rm(temporary, { recursive: true, force: true });
  }
}

// Keep the settings activation regression in the existing CI editor-runtime gate.
// A separate process avoids sharing React/DOM state between the two harnesses.
const settingsCheck = spawnSync(process.execPath, [
  resolve(dirname(fileURLToPath(import.meta.url)), 'check-grid-settings-activation.mjs')
], { cwd: project, stdio: 'inherit' });
if (settingsCheck.error) throw settingsCheck.error;
assert.equal(settingsCheck.signal, null, 'settings activation regression was interrupted');
assert.equal(settingsCheck.status, 0, 'settings activation regressions');
