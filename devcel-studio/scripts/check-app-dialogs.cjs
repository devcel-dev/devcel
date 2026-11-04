// Production in-app dialog and FileBrowser hook behavior in a synthetic DOM.
// IPC is mocked. This is not a substitute for native viewport/layout QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { compileModule } = require('./compile-module.cjs');
const root = path.resolve(__dirname, '..');
const reports = [];
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/app/i18n/generated/catalog.json'))).messages.ja;
const { IntlMessageFormat } = require('intl-messageformat');
const t = (key, values) => String(new IntlMessageFormat(catalog[key] || key, 'ja', undefined, { ignoreTag: true }).format(values));
const cache = new Map();
const boundaries = new Map();
function load(relative) {
  const filename = path.join(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = new Module(filename); cache.set(filename, mod);
  mod.paths = Module._nodeModulePaths(root);
  mod.require = id => {
    if (boundaries.has(id)) return boundaries.get(id);
    if (id === '@/app/i18n') return { t, useI18n: () => ({ t, locale: 'ja' }), localizeError: String };
    if (id.startsWith('@/')) {
      const base = `src/${id.slice(2)}`;
      const file = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(file => fs.existsSync(path.join(root, file)));
      return load(file);
    }
    return require(id);
  };
  mod._compile(compileModule(fs.readFileSync(filename, 'utf8'), filename), filename);
  return mod.exports;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
(async () => {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://app-dialog-check.invalid' });
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'FocusEvent', 'MutationObserver']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
  for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) globalThis[name] = window[name].bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Observe the real listener registrations without substituting dismissal logic.
  // A mounted nested layer is not pointer-ready until Radix's deferred effect runs.
  const pointerDownListeners = new Set();
  const addDocumentListener = document.addEventListener.bind(document);
  const removeDocumentListener = document.removeEventListener.bind(document);
  document.addEventListener = (name, listener, ...options) => {
    if (name === 'pointerdown') pointerDownListeners.add(listener);
    return addDocumentListener(name, listener, ...options);
  };
  document.removeEventListener = (name, listener, ...options) => {
    if (name === 'pointerdown') pointerDownListeners.delete(listener);
    return removeDocumentListener(name, listener, ...options);
  };
  const React = require('react'); const { createRoot } = require('react-dom/client');
  const dialogs = load('src/app/services/appDialogs.ts');
  const { AppDialogHost } = load('src/app/components/AppDialogHost.tsx');
  const { Dialog, DialogContent, DialogTitle } = load('src/components/ui/dialog.tsx');
  const { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogCancel, AlertDialogAction } = load('src/components/ui/alert-dialog.tsx');
  const host = document.createElement('div'); document.body.append(host); const mounted = createRoot(host);
  const act = React.act;
  const outsidePointerReady = async expectedLayers => {
    // This task must run after the opening act has committed. A tick inside that
    // act precedes the final layer effect, especially when a child masks its parent.
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)); });
    assert.equal(document.querySelectorAll('[data-state="open"][role="dialog"], [data-state="open"][role="alertdialog"]').length, expectedLayers);
    assert.equal(pointerDownListeners.size, expectedLayers, 'Every open modal has installed its real outside-pointer listener');
  };
  const click = async element => act(async () => { assert(element, 'Expected a control'); element.click(); await tick(); });
  const button = text => [...document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')].find(button => button.textContent === text);
  async function check(name, fn) { let timeout; try { await Promise.race([fn(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error(`Timed out: ${name}`)), 4000); })]); reports.push(name); console.log(`PASS ${name}`); } finally { clearTimeout(timeout); } }
  await act(async () => { mounted.render(React.createElement(AppDialogHost)); });
  await check('Awaited prompt caller focus survives modal close autofocus', async () => {
    const opener = document.createElement('button'); opener.textContent = 'Link toolbar'; document.body.append(opener);
    const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.tabIndex = 0; editor.textContent = 'A link and caret'; document.body.append(editor);
    let pending;
    await act(async () => {
      opener.focus();
      pending = dialogs.appPrompt('Link URL', 'https://example.com').then(value => {
        editor.focus();
        const range = document.createRange(); range.setStart(editor.firstChild, 6); range.collapse(true);
        document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
        return value;
      });
      await tick();
    });
    await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick(); });
    assert.equal(await pending, 'https://example.com');
    await act(async () => { await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 20))); });
    assert(document.activeElement === editor, 'Closing the prompt must not take focus back from its awaited caller');
    assert(document.getSelection().anchorNode === editor.firstChild); assert.equal(document.getSelection().anchorOffset, 6);
    opener.remove(); editor.remove();
  });
  const settleFocus = async () => act(async () => { await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 20))); });
  const makeFocusTarget = (label, tag = 'button') => {
    const element = document.createElement(tag); element.textContent = label; element.tabIndex = 0;
    document.body.append(element); return element;
  };
  // Radix releases its focus scope in a zero-delay unmount callback. Hold that
  // callback, not the component or its DOM, to exercise late-cleanup races.
  const holdCloseCleanup = finish => {
    const callbacks = []; const original = globalThis.setTimeout;
    try {
      globalThis.setTimeout = (fn, delay, ...args) => delay === 0
        ? (callbacks.push(() => fn(...args)), -callbacks.length) : original(fn, delay, ...args);
      act(finish);
    } finally { globalThis.setTimeout = original; }
    assert(callbacks.length > 0, 'Captured the actual Radix close cleanup');
    return async () => act(async () => { for (const callback of callbacks) callback(); await tick(); });
  };
  await check('Prompt Cancel and confirm accept/cancel preserve focus chosen by awaited callers', async () => {
    const opener = makeFocusTarget('Original toolbar'); const target = makeFocusTarget('Caller input', 'input');
    for (const route of ['prompt-cancel', 'confirm-accept', 'confirm-cancel']) {
      let pending;
      await act(async () => {
        opener.focus();
        pending = (route === 'prompt-cancel' ? dialogs.appPrompt('URL') : dialogs.appConfirm('Continue?'))
          .then(value => { target.focus(); return value; });
        await tick();
      });
      await click(button(t(route === 'confirm-accept' ? 'common.confirm' : 'common.cancel')));
      assert.equal(await pending, route === 'prompt-cancel' ? null : route === 'confirm-accept');
      await settleFocus(); assert(document.activeElement === target, `${route} keeps caller focus`);
    }
    opener.remove(); target.remove();
  });
  await check('Queued prompts retain the newer modal focus and final caller focus', async () => {
    const opener = makeFocusTarget('Queue origin'); const firstTarget = makeFocusTarget('First editor', 'input');
    const lastTarget = makeFocusTarget('Final editor', 'input'); let first, second;
    await act(async () => { opener.focus(); first = dialogs.appPrompt('First URL', 'first').then(value => { firstTarget.focus(); return value; }); await tick(); });
    await act(async () => { second = dialogs.appPrompt('Second URL', 'second').then(value => { lastTarget.focus(); return value; }); await tick(); });
    await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick(); });
    assert.equal(await first, 'first'); await settleFocus();
    assert.equal(dialogs.getAppDialog().message, 'Second URL');
    assert(document.activeElement === document.querySelector('[data-app-dialog] input'), 'First continuation cannot steal focus from the queued prompt');
    await click(button(t('common.cancel'))); assert.equal(await second, null); await settleFocus();
    assert(document.activeElement === lastTarget, 'Final continuation retains its focus after every close callback');
    opener.remove(); firstTarget.remove(); lastTarget.remove();
  });
  await check('A queued prompt inherits its external opener rather than a removed dialog input', async () => {
    const opener = makeFocusTarget('Inherited queue origin'); let first, second;
    await act(async () => { opener.focus(); first = dialogs.appPrompt('First queued'); await tick(); });
    await act(async () => { second = dialogs.appPrompt('Last queued'); await tick(); });
    await click(button(t('common.cancel'))); assert.equal(await first, null);
    assert(dialogs.getAppDialog().opener === opener);
    await click(button(t('common.cancel'))); assert.equal(await second, null); await settleFocus();
    assert(document.activeElement === opener); opener.remove();
  });
  await check('Nested prompts settle after releasing their scope and retain the parent editor focus', async () => {
    let parentDismissals = 0;
    await act(async () => { mounted.render(React.createElement(React.Fragment, null,
      React.createElement(Dialog, { open: true, onOpenChange: next => { if (!next) parentDismissals++; } },
        React.createElement(DialogContent, { 'aria-describedby': undefined }, React.createElement(DialogTitle, null, 'Parent editor'),
          React.createElement('button', { 'data-nested-origin': true }, 'Link control'),
          React.createElement('div', { 'data-nested-editor': true, contentEditable: true, suppressContentEditableWarning: true, tabIndex: 0 }, 'Nested link'))),
      React.createElement(AppDialogHost))); await tick(); });
    const opener = document.querySelector('[data-nested-origin]'); const editor = document.querySelector('[data-nested-editor]');
    for (const accept of [true, false]) {
      let pending;
      await act(async () => { opener.focus(); pending = dialogs.appPrompt('Nested URL', 'nested').then(value => { editor.focus(); return value; }); await tick(); });
      if (accept) await act(async () => { document.querySelector('[data-app-dialog] form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick(); });
      else await click(button(t('common.cancel')));
      assert.equal(await pending, accept ? 'nested' : null); await settleFocus(); assert(document.activeElement === editor);
    }
    assert.equal(parentDismissals, 0);
    await act(async () => { mounted.render(React.createElement(AppDialogHost)); await tick(); }); await settleFocus();
  });
  await check('Removed openers do not block settlement or steal focus from a caller or replacement', async () => {
    const opener = makeFocusTarget('Removed origin'); const target = makeFocusTarget('Live caller', 'input'); let pending;
    await act(async () => { opener.focus(); pending = dialogs.appConfirm('Continue after removal?').then(value => { target.focus(); return value; }); await tick(); });
    opener.remove(); const replacement = makeFocusTarget('Replacement origin');
    await click(button(t('common.confirm'))); assert.equal(await pending, true); await settleFocus();
    assert(document.activeElement === target); assert(document.activeElement !== replacement);
    target.remove(); replacement.remove();
  });
  await check('Delayed close cleanup preserves a newer explicit focus and settles only after cleanup', async () => {
    const opener = makeFocusTarget('Old toolbar'); const newer = makeFocusTarget('New UI field', 'input'); let pending, settled = false;
    await act(async () => { opener.focus(); pending = dialogs.appConfirm('Old decision').then(value => { settled = true; return value; }); await tick(); });
    const release = holdCloseCleanup(() => dialogs.getAppDialog().finish(null));
    await Promise.resolve(); assert.equal(settled, false, 'Caller cannot run while the old focus scope is closing');
    newer.focus(); assert(document.activeElement === newer);
    await release(); assert.equal(await pending, false); await settleFocus(); assert(document.activeElement === newer);
    opener.remove(); newer.remove();
  });
  await check('A late older cleanup cannot reclaim focus after a newer dialog has finished', async () => {
    const oldOrigin = makeFocusTarget('Old dialog origin'); const newOrigin = makeFocusTarget('New dialog origin'); let old, newer;
    await act(async () => { oldOrigin.focus(); old = dialogs.appConfirm('Older'); await tick(); });
    const releaseOld = holdCloseCleanup(() => dialogs.getAppDialog().finish(false));
    await act(async () => { newOrigin.focus(); newer = dialogs.appConfirm('Newer'); await tick(); });
    await click(button(t('common.cancel'))); assert.equal(await newer, false); await settleFocus();
    assert(document.activeElement === newOrigin); newOrigin.remove();
    await releaseOld(); assert.equal(await old, false); await settleFocus();
    assert(document.activeElement !== oldOrigin, 'Older dialog lost focus ownership even when the newer origin is removed');
    oldOrigin.remove();
  });
  await check('StrictMode synthetic cleanup cannot settle an open prompt or reclaim caller focus', async () => {
    await act(async () => { mounted.render(React.createElement(React.StrictMode, null, React.createElement(AppDialogHost))); await tick(); });
    const opener = makeFocusTarget('Strict origin'); const target = makeFocusTarget('Strict caller', 'input'); let pending, settled = false;
    await act(async () => { opener.focus(); pending = dialogs.appPrompt('Strict URL', 'strict').then(value => { settled = true; target.focus(); return value; }); await tick(); });
    await settleFocus(); assert.equal(settled, false); assert.equal(dialogs.getAppDialog().message, 'Strict URL');
    await click(button(t('common.cancel'))); assert.equal(await pending, null); await settleFocus(); assert(document.activeElement === target);
    await act(async () => { mounted.render(React.createElement(AppDialogHost)); await tick(); }); await settleFocus();
    opener.remove(); target.remove();
  });
  await check('Confirm is awaitable, defaults focus to Cancel, and X cancels', async () => {
    let resolved = false; let pending;
    await act(async () => { pending = dialogs.appConfirm('Delete a file?', { destructive: true }).then(value => { resolved = true; return value; }); await tick(); });
    assert.equal(resolved, false); assert.equal(document.activeElement.textContent, t('common.cancel'));
    await click(button(t('common.close'))); assert.equal(await pending, false);
  });
  await check('Escape cancels; only the positive action approves', async () => {
    let pending; await act(async () => { pending = dialogs.appConfirm('Delete?'); await tick(); });
    await act(async () => { document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(); });
    assert.equal(await pending, false);
    await act(async () => { pending = dialogs.appConfirm('Delete?'); await tick(); });
    await click(button(t('common.confirm'))); assert.equal(await pending, true);
  });
  await check('Outside pointer dismissal cancels instead of approving', async () => {
    let pending; await act(async () => { pending = dialogs.appConfirm('Delete?'); await tick(); });
    await outsidePointerReady(1);
    const overlay = document.querySelector('[data-state="open"].bg-black\\/40'); assert(overlay);
    await act(async () => { overlay.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })); overlay.click(); await tick(); });
    assert.equal(await pending, false);
  });
  await check('Queued requests settle once in order and prompt Cancel returns null', async () => {
    let first, second; await act(async () => { first = dialogs.appConfirm('First'); second = dialogs.appPrompt('Second', 'new_folder'); await tick(); });
    const firstRequest = dialogs.getAppDialog(); assert.equal(firstRequest.message, 'First');
    await click(button(t('common.confirm'))); assert.equal(await first, true); assert.equal(dialogs.getAppDialog().message, 'Second');
    await act(async () => { firstRequest.finish(false); }); assert.equal(dialogs.getAppDialog().message, 'Second');
    await click(button(t('common.cancel'))); assert.equal(await second, null); assert.equal(dialogs.getAppDialog(), null);
  });
  await check('Prompt validation retains its draft until valid explicit submission', async () => {
    let pending; await act(async () => { pending = dialogs.appPrompt('Folder name', 'bad name', { validate: value => value.includes(' ') ? 'Invalid folder name' : undefined }); await tick(); });
    await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick(); });
    assert.equal(document.querySelector('[role="alert"]').textContent, 'Invalid folder name'); assert.equal(document.querySelector('input').value, 'bad name');
    await click(button(t('common.close'))); assert.equal(await pending, null);
  });
  await check('Nested confirmation stays above its parent and leaves parent open on Cancel, Escape and outside', async () => {
    let parentDismissals = 0;
    await act(async () => { mounted.render(React.createElement(React.Fragment, null,
      React.createElement(Dialog, { open: true, onOpenChange: next => { if (!next) parentDismissals++; } }, React.createElement(DialogContent, { 'aria-describedby': undefined }, React.createElement(DialogTitle, null, 'Parent'), React.createElement('button', null, 'Parent action'))), React.createElement(AppDialogHost))); await tick(); });
    let pending; await act(async () => { pending = dialogs.appConfirm('Nested'); await tick(); });
    assert(document.querySelector('[role="alertdialog"]').classList.contains('z-[1001]'));
    assert.equal(document.activeElement.textContent, t('common.cancel'));
    await click(button(t('common.cancel'))); assert.equal(await pending, false); assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    await act(async () => { pending = dialogs.appConfirm('Nested Escape'); await tick(); });
    await act(async () => { document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(); });
    assert.equal(await pending, false);
    await act(async () => { pending = dialogs.appConfirm('Nested outside'); await tick(); });
    await outsidePointerReady(2);
    const topOverlay = [...document.querySelectorAll('[data-state="open"].bg-black\\/40')].at(-1);
    await act(async () => { topOverlay.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })); topOverlay.click(); await tick(); });
    assert.equal(await pending, false); assert.equal(parentDismissals, 0);
    await act(async () => { mounted.render(React.createElement(AppDialogHost)); await tick(); });
  });

  await check('Shared destructive AlertDialog X and overlay only cancel', async () => {
    let approvals = 0, dismissals = 0;
    function Example() {
      const [open, setOpen] = React.useState(true);
      return React.createElement(AlertDialog, { open, onOpenChange: next => { if (!next) dismissals++; setOpen(next); } },
        React.createElement(AlertDialogContent, { 'aria-describedby': undefined }, React.createElement(AlertDialogTitle, null, 'Delete item'),
          React.createElement(AlertDialogCancel, null, t('common.cancel')), React.createElement(AlertDialogAction, { onClick: () => approvals++ }, t('common.delete'))));
    }
    await act(async () => { mounted.render(React.createElement(Example, { key: 'close' })); await tick(); });
    await click(document.querySelector(`button[aria-label="${t('common.close')}"]`));
    assert.equal(approvals, 0); assert.equal(dismissals, 1);
    await act(async () => { mounted.render(React.createElement(Example, { key: 'outside' })); await tick(); });
    await outsidePointerReady(1);
    const overlay = document.querySelector('[data-state="open"].bg-black\\/40');
    await act(async () => { overlay.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })); await tick(); });
    assert.equal(approvals, 0); assert.equal(dismissals, 2);
  });

  let ops, active = true, session = 'A', selection = new Set(), flushFailure = false, calls = [], flushed = [];
  const nodes = [{ id: 'one.md', path: 'one.md', name: 'one.md', type: 'markdown' }, { id: 'two.md', path: 'two.md', name: 'two.md', type: 'markdown' }, { id: 'folder', path: 'folder', name: 'folder', type: 'folder' }, { id: 'folder/child.md', path: 'folder/child.md', name: 'child.md', type: 'markdown' }];
  boundaries.set('@tauri-apps/api/core', { invoke: async () => { throw Error('unexpected invoke'); } });
  boundaries.set('@/app/commands/projectCommands', { getProjectEntries: async () => [] });
  boundaries.set('@/app/commands/tableCommands', { invalidateTableCatalog: () => {}, getLoadedTables: async () => [], loadTable: async () => 'ok' });
  boundaries.set('@/app/utils/DemandTableLoader', { normalizeTablePath: path => path });
  boundaries.set('@/app/utils/markdownSaveLifecycle', { flushMarkdownEdits: async (owner, path) => { flushed.push({ owner, path }); if (flushFailure && path === 'two.md') throw Error('unsaved draft'); } });
  boundaries.set('@/api/fileOperation', { fileOperation: async (operation, owner) => { calls.push({ operation, owner }); return { path: operation.path, file_type: operation.file_type }; } });
  const { useFileOperations } = load('src/app/pages/main_window/project_view/file_browser_view/hooks/useFileOperations.ts');
  function Harness() {
    ops = useFileOperations(nodes, selection, id => nodes.find(node => node.id === id) || null,
      async () => true, () => nodes, () => {}, () => {}, () => {}, () => {}, { id: session, path: '/project' }, () => active, () => 0);
    return React.createElement(AppDialogHost);
  }
  const render = async () => act(async () => { mounted.render(React.createElement(Harness)); await tick(); });
  await render();
  await check('Repeated Delete is gated and confirmation uses the original selection snapshot', async () => {
    calls = []; const ids = new Set(['one.md']); let pending;
    await act(async () => { pending = ops.handleBulkDelete(ids); void ops.handleBulkDelete(ids); ids.clear(); ids.add('two.md'); await tick(); });
    await click(button(t('common.delete'))); await pending;
    assert.equal(calls.length, 1); assert.equal(calls[0].operation.path, 'one.md'); assert.equal(dialogs.getAppDialog(), null);
  });
  await check('Dirty-draft flush failure prevents every selected deletion', async () => {
    calls = []; flushed = []; flushFailure = true; let pending;
    await act(async () => { pending = ops.handleBulkDelete(new Set(['one.md', 'two.md'])); await tick(); });
    await click(button(t('common.delete'))); assert.equal(calls.length, 0); assert.equal(flushed.length, 2); assert.equal(dialogs.getAppDialog().kind, 'alert');
    await click(button(t('common.confirm'))); await pending; flushFailure = false;
  });
  await check('A project-session change while confirmation is open blocks stale deletion', async () => {
    calls = []; let pending;
    await act(async () => { pending = ops.handleBulkDelete(new Set(['one.md'])); await tick(); });
    session = 'B'; await render(); await click(button(t('common.delete'))); await pending; assert.equal(calls.length, 0);
  });
  await check('Parent and child selection deletes only the parent after preflight', async () => {
    calls = []; let pending;
    await act(async () => { pending = ops.handleBulkDelete(new Set(['folder', 'folder/child.md'])); await tick(); });
    await click(button(t('common.delete'))); await pending; assert.equal(calls.length, 1); assert.equal(calls[0].operation.path, 'folder'); assert.equal(calls[0].owner, 'B');
  });
  await check('Single-item context deletion cannot bypass confirmation', async () => {
    calls = []; let pending; await act(async () => { pending = ops.handleDelete(nodes[0]); await tick(); });
    assert.equal(calls.length, 0); await click(button(t('common.cancel'))); await pending; assert.equal(calls.length, 0);
  });
  await check('Folder creation snapshots its parent and Cancel never creates', async () => {
    calls = []; selection = new Set(['folder']); await render(); let pending;
    await act(async () => { pending = ops.handleAddFolder(); await tick(); });
    await click(button(t('common.cancel'))); await pending; assert.equal(calls.length, 0);
    await act(async () => { pending = ops.handleAddFolder(); selection.clear(); await tick(); });
    await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick(); });
    await pending; assert.equal(calls.length, 1); assert.equal(calls[0].operation.path, 'folder/new_folder');
  });
  await check('Actual Add file modal opens, cancels and reopens without creation; valid submit creates once', async () => {
    globalThis.ResizeObserver = window.ResizeObserver;
    globalThis.HTMLFormElement = window.HTMLFormElement;
    const { FileTypeDialog } = load('src/app/pages/main_window/project_view/file_browser_view/components/FileTypeDialog.tsx');
    const created = []; let setOpen;
    function FileHarness() {
      const [open, update] = React.useState(false); setOpen = update;
      return React.createElement(FileTypeDialog, { open, onOpenChange: update, onConfirm: async (type, name) => { created.push({type,name}); return true; } });
    }
    await act(async () => { mounted.render(React.createElement(FileHarness)); });
    for (let i=0;i<3;i++) {
      await act(async () => { setOpen(true); });
      assert(document.querySelector('[role="dialog"] input#name'), 'Actual creation form mounted');
      await click(button(t('common.cancel')));
      assert(!document.querySelector('[role="dialog"]')); assert.equal(created.length,0);
    }
    await act(async () => { setOpen(true); });
    await click(button(t('common.create'))); assert.equal(created.length,0); assert(document.querySelector('[role="alert"]'));
    await act(async () => {
      const input=document.querySelector('input#name');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'Characters');
      input.dispatchEvent(new window.Event('input',{bubbles:true}));
    });
    await click(button(t('common.create')));
    assert.deepEqual(created,[{type:'table',name:'Characters'}]); assert(!document.querySelector('[role="dialog"]'));
    await act(async () => { setOpen(true); });
    assert.equal(document.querySelector('input#name').value,'');
    await click(button(t('common.cancel')));
  });
  for (const name of ['dialog', 'alert-dialog']) {
    const source = fs.readFileSync(path.join(root, `src/components/ui/${name}.tsx`), 'utf8');
    assert(source.includes('max-h-[calc(100dvh-2rem)]')); assert(source.includes('overflow-y-auto'));
    assert(!/slide-(?:in|out)|zoom-(?:in|out)/.test(source));
  }
  reports.push('Shared primitives enforce viewport scrolling and fade-only entrance (source contract, not visual proof)');
  await act(async () => { mounted.unmount(); });
  document.addEventListener = addDocumentListener;
  document.removeEventListener = removeDocumentListener;
  console.log(`PASS ${reports.at(-1)}\n${reports.length} dialog checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
