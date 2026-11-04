import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const window = new Window();
for (const name of ['document', 'HTMLElement', 'Element', 'Node']) globalThis[name] = window[name];
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
const temp = await mkdtemp(resolve('.shortcut-routing-'));
try {
  const result = await build({ stdin: { contents: `export * from './src/app/utils/selectAllRouting'; export * from './src/app/utils/shortcutGuards'; export * from './src/app/pages/main_window/project_view/table_view/navigationQueue';`, resolveDir: process.cwd() }, bundle: true, format: 'esm', write: false });
  const path = resolve(temp, 'routing.mjs'); await writeFile(path, result.outputFiles[0].text);
  const { registerSelectAll, isMarkdownSaveKey, createNavigationQueue } = await import(pathToFileURL(path));
  document.body.innerHTML = '<section id="tree" tabindex="0"><button>Tree</button><input></section><section id="grid" tabindex="0"><button>Header</button><div tabindex="0">Cell</div></section><button id="neutral">Menu</button>';
  const tree = document.querySelector('#tree'), grid = document.querySelector('#grid'), neutral = document.querySelector('#neutral');
  let trees = 0, grids = 0, bubbled = 0;
  document.addEventListener('keydown', () => bubbled++);
  const removeTree = registerSelectAll(tree, () => trees++), removeGrid = registerSelectAll(grid, () => grids++);
  const press = (target, options = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event); return event;
  };
  assert.equal(press(neutral).defaultPrevented, false, 'no guessed owner before interaction');
  grid.querySelector('button').focus();
  assert.equal(press(grid.querySelector('button')).defaultPrevented, true);
  assert.equal(grids, 1);
  neutral.focus(); const before = bubbled;
  press(neutral); assert.equal(grids, 2); assert.equal(bubbled, before, 'one routing action, no downstream grid handler');
  tree.focus(); press(tree); assert.equal(trees, 1);
  tree.querySelector('input').focus(); assert.equal(press(tree.querySelector('input')).defaultPrevented, false);
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { shiftKey: true }]) {
    assert.equal(press(grid, options).defaultPrevented, false);
  }
  const modal = document.createElement('div'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal);
  assert.equal(press(grid).defaultPrevented, false, 'modal blocks background even before focus transfer');
  assert.equal(press(modal).defaultPrevented, false);
  modal.remove();
  const listbox = document.createElement('div'); listbox.setAttribute('role', 'listbox'); listbox.tabIndex = 0; document.body.append(listbox); listbox.focus();
  assert.equal(press(listbox).defaultPrevented, false); assert.equal(document.activeElement, listbox);
  assert.equal(press(grid).defaultPrevented, false, 'open listbox protects background during focus handoff'); listbox.remove();
  press(grid, { ctrlKey: false, metaKey: true }); assert.equal(grids, 3);
  press(grid, { repeat: true }); assert.equal(grids, 3, 'repeat consumed without duplicate work');
  removeTree(); removeGrid(); assert.equal(press(neutral).defaultPrevented, false, 'unmount removes listeners and remembered owner');
  const save = options => isMarkdownSaveKey(new window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, ...options }));
  assert.equal(save({}), true);
  for (const options of [{ shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }]) assert.equal(save(options), false);
  assert.equal(save({ ctrlKey: false, metaKey: true }), true);
  const queue = createNavigationQueue();
  let release; const held = new Promise(resolve => { release = resolve; }); const order = [];
  const first = queue.enqueue(async () => { order.push('first'); await held; return true; });
  const stale = queue.enqueue(async () => { order.push('stale'); return true; });
  await Promise.resolve(); queue.cancel();
  await queue.enqueue(async () => { order.push('new'); return true; });
  assert.deepEqual(order, ['first', 'new'], 'cancelled lookup cannot block a new history context');
  release(); await first; await stale; assert.deepEqual(order, ['first', 'new']);
  const failure = queue.enqueue(async () => false);
  const discarded = queue.enqueue(async () => { order.push('discarded'); return true; });
  await failure; await discarded; assert.deepEqual(order, ['first', 'new'], 'failed step discards queued intents');
  console.log('PASS shortcut context routing, text/modal ownership, modifiers, composition, cleanup, Markdown save collision');
} finally { await rm(temp, { recursive: true, force: true }); window.happyDOM.abort(); }
