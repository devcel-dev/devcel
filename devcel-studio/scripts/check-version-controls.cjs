#!/usr/bin/env node
'use strict';
// Production controls + real Radix popover. Native WebKit paint/layout is tested separately.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const reports = [];
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
(async () => {
  const { Window } = await import('happy-dom');
  const window = new Window({ url: 'http://version-controls.invalid' });
  for (const name of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLButtonElement','Element','Node','Event','FocusEvent','MouseEvent','KeyboardEvent','PointerEvent','CustomEvent','MutationObserver','ResizeObserver','NodeFilter','DocumentFragment','DOMRect','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) {
    const value = name === 'window' ? window : ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(name) ? window[name].bind(window) : window[name];
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react'); const { createRoot } = require('react-dom/client');
  const result = await esbuild.build({ absWorkingDir: root, entryPoints: ['src/app/pages/main_window/project_view/table_view/components/VersionControls.tsx'], bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false, loader: { '.css': 'empty' }, tsconfig: path.join(root, 'tsconfig.json') });
  const compiled = new Module(path.join(root, 'version-controls-test.cjs')); compiled.paths = Module._nodeModulePaths(root); compiled._compile(result.outputFiles[0].text, path.join(root, 'version-controls-test.cjs'));
  const { VersionBadge, VersionViewControls } = compiled.exports;
  const host = document.createElement('div'); document.body.append(host);
  const outside = document.createElement('button'); outside.textContent = 'outside'; document.body.append(outside);
  let mountedRoot;
  const render = async element => React.act(async () => { if (!mountedRoot) mountedRoot = createRoot(host); mountedRoot.render(element); await tick(); });
  const unmount = async () => React.act(async () => { mountedRoot?.unmount(); mountedRoot = null; await tick(); });
  const click = async element => React.act(async () => { assert(element, 'Expected clickable element'); element.click(); await tick(); });
  const key = async (element, value, options = {}) => React.act(async () => { assert(element, 'Expected keyboard target'); element.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })); await tick(); });
  const input = async (element, value) => React.act(async () => { assert(element, 'Expected input'); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new window.Event('input', { bubbles: true })); await tick(); });
  const blur = async element => React.act(async () => { element.blur(); await tick(); });
  const badgeButton = () => host.querySelector('.version-badge'); const badgeInput = () => host.querySelector('.version-badge-input input');
  const check = async (name, fn) => { try { await fn(); reports.push(name); console.log(`PASS ${name}`); } finally { await unmount(); } };
  const messages = { invalid: 'Invalid version', saveFailed: 'Save failed' };
  let commits, props;
  const badge = overrides => { commits = []; props = { value: 0, label: 'Row version', messages, onCommit: async value => { commits.push(value); return true; }, ...overrides }; return React.createElement(VersionBadge, props); };

  await check('Both axes show v0 and focus/select one direct numeric input on click', async () => {
    for (const label of ['Row version', 'Column version']) {
      await render(badge({ label })); assert.equal(badgeButton().textContent, 'v0'); await click(badgeButton());
      assert.equal(badgeInput().getAttribute('aria-label'), label); assert.equal(document.activeElement, badgeInput());
      assert.equal(badgeInput().selectionStart, 0); assert.equal(badgeInput().selectionEnd, 1); assert.equal(host.querySelector('select,input[type=range]'), null); await unmount();
    }
  });
  await check('Escape blurs before removing input, never commits and returns focus', async () => {
    await render(badge()); await click(badgeButton()); await input(badgeInput(), '3'); const field = badgeInput(); const nativeBlur = field.blur.bind(field); let connected = false;
    field.blur = () => { connected = field.isConnected; nativeBlur(); }; await key(field, 'Escape');
    assert(connected); assert.equal(badgeInput(), null); assert.deepEqual(commits, []); assert.equal(badgeButton().textContent, 'v0'); assert.equal(document.activeElement, badgeButton());
  });
  await check('Enter commits once, canonicalizes zeros and returns keyboard focus', async () => {
    await render(badge()); await click(badgeButton()); await input(badgeInput(), '002'); await key(badgeInput(), 'Enter');
    assert.deepEqual(commits, [2]); assert.equal(badgeInput(), null); assert.equal(document.activeElement, badgeButton());
  });
  await check('Unchanged valid draft closes without a write', async () => {
    await render(badge({ value: 2 })); await click(badgeButton()); await input(badgeInput(), '02'); await key(badgeInput(), 'Enter'); assert.deepEqual(commits, []); assert.equal(badgeInput(), null);
  });
  await check('Invalid and overflow drafts stay open; uint32 maximum is accepted', async () => {
    await render(badge()); await click(badgeButton());
    for (const invalid of ['', '-1', '1.5', '+1', '1e2', ' 2 ', '4294967296', '999999999999999999999']) {
      await input(badgeInput(), invalid); await key(badgeInput(), 'Enter'); assert.equal(badgeInput().value, invalid); assert.equal(badgeInput().getAttribute('aria-invalid'), 'true'); assert.equal(host.querySelector('[role=alert]').textContent, messages.invalid); assert.deepEqual(commits, []);
    }
    await input(badgeInput(), '4294967295'); assert.equal(host.querySelector('[role=alert]'), null); await key(badgeInput(), 'Enter'); assert.deepEqual(commits, [4294967295]);
  });
  await check('Blur commits valid input without taking focus from another control', async () => {
    await render(badge()); await click(badgeButton()); await input(badgeInput(), '4'); await React.act(async () => { outside.focus(); await tick(); });
    assert.deepEqual(commits, [4]); assert.equal(badgeInput(), null); assert.equal(document.activeElement, outside);
  });
  await check('Invalid blur keeps draft and error without writing', async () => {
    await render(badge()); await click(badgeButton()); await input(badgeInput(), ''); await blur(badgeInput()); assert.equal(badgeInput().value, ''); assert.deepEqual(commits, []); assert.equal(badgeInput().getAttribute('aria-invalid'), 'true');
  });
  await check('Repeated Enter/blur cannot duplicate a pending write; pending Escape cannot imply cancellation', async () => {
    const pending = deferred(); await render(badge({ onCommit: value => { commits.push(value); return pending.promise; } }));
    await click(badgeButton()); await input(badgeInput(), '5'); await key(badgeInput(), 'Enter'); assert(badgeInput().readOnly); assert.equal(badgeInput().getAttribute('aria-busy'), 'true');
    await key(badgeInput(), 'Enter'); await blur(badgeInput()); await key(badgeInput(), 'Escape'); assert.deepEqual(commits, [5]); await React.act(async () => pending.resolve(true)); assert.equal(badgeInput(), null);
  });
  await check('False/rejected writes retain draft and localized error, and support retry', async () => {
    for (const reject of [false, true]) {
      let attempts = 0; await render(badge({ onCommit: async value => { commits.push(value); if (++attempts === 1) { if (reject) throw Error('offline'); return false; } return true; } }));
      await click(badgeButton()); await input(badgeInput(), '7'); await key(badgeInput(), 'Enter'); assert.equal(badgeInput().value, '7'); assert.equal(badgeInput().readOnly, false); assert.equal(host.querySelector('[role=alert]').textContent, messages.saveFailed);
      await key(badgeInput(), 'Enter'); assert.deepEqual(commits, [7, 7]); assert.equal(badgeInput(), null); await unmount();
    }
  });
  await check('Failed blur keeps editor open without stealing outside focus', async () => {
    const pending = deferred(); await render(badge({ onCommit: () => pending.promise })); await click(badgeButton()); await input(badgeInput(), '8'); await React.act(async () => outside.focus()); await React.act(async () => pending.resolve(false)); assert.equal(badgeInput().value, '8'); assert.equal(document.activeElement, outside);
  });
  await check('Parent value echoes before async completion retain keyboard focus on the updated badge', async () => {
    const pending = deferred(); await render(badge({ contextKey: 'target', onCommit: value => { commits.push(value); return pending.promise; } }));
    await click(badgeButton()); await input(badgeInput(), '4'); await key(badgeInput(), 'Enter');
    await render(React.createElement(VersionBadge, { ...props, value: 4 })); assert.equal(badgeButton().textContent, 'v4'); assert.equal(document.activeElement, badgeButton());
    await React.act(async () => pending.resolve(true)); assert.equal(document.activeElement, badgeButton()); assert.deepEqual(commits, [4]);
  });
  await check('External value changes discard unsaved drafts without a blur write', async () => {
    await render(badge()); await click(badgeButton()); await input(badgeInput(), '4'); await render(React.createElement(VersionBadge, { ...props, value: 9 })); assert.equal(badgeButton().textContent, 'v9'); assert.deepEqual(commits, []);
  });
  await check('Context changes invalidate pending results and protect a newer edit at the same value', async () => {
    const pending = deferred(); await render(badge({ contextKey: 'first', onCommit: value => { commits.push(value); return pending.promise; } })); await click(badgeButton()); await input(badgeInput(), '4'); await key(badgeInput(), 'Enter');
    await render(React.createElement(VersionBadge, { ...props, contextKey: 'second' })); await click(badgeButton()); await input(badgeInput(), '8'); await React.act(async () => pending.resolve(false)); assert.equal(badgeInput().value, '8'); assert.equal(host.querySelector('[role=alert]'), null); assert.deepEqual(commits, [4]);
  });
  await check('Unmount safely consumes late rejections', async () => {
    const pending = deferred(); await render(badge({ onCommit: () => pending.promise })); await click(badgeButton()); await input(badgeInput(), '4'); await key(badgeInput(), 'Enter'); await unmount(); await React.act(async () => pending.reject(Error('gone'))); assert.equal(host.textContent, '');
  });
  await check('IME Enter/Escape do not save or cancel', async () => {
    await render(badge()); await click(badgeButton()); await input(badgeInput(), '3'); await key(badgeInput(), 'Enter', { isComposing: true }); await key(badgeInput(), 'Escape', { isComposing: true }); assert.equal(badgeInput().value, '3'); assert.deepEqual(commits, []);
  });
  await check('Inherited badge opens owner with reason tooltip and never creates local input', async () => {
    let requested = 0; await render(badge({ value: 3, sourceReason: 'Owned by interface', onRequestSource: () => requested++ })); assert.equal(badgeButton().title, 'Owned by interface'); await click(badgeButton()); assert.equal(requested, 1); assert.equal(badgeInput(), null); assert.deepEqual(commits, []);
    await render(React.createElement(VersionBadge, { ...props, onRequestSource: undefined })); assert(badgeButton().disabled);
  });
  await check('Disabled badges stay visible and cannot edit or route to owner', async () => {
    let requested = 0; await render(badge({ disabled: true, onRequestSource: () => requested++ })); assert.equal(badgeButton().textContent, 'v0'); await click(badgeButton()); assert.equal(requested, 0); assert.equal(badgeInput(), null);
  });
  await check('Busy rerenders retain pending write and failure draft', async () => {
    const pending = deferred(); await render(badge({ onCommit: () => pending.promise })); await click(badgeButton()); await input(badgeInput(), '4'); await key(badgeInput(), 'Enter'); await render(React.createElement(VersionBadge, { ...props, disabled: true })); assert.equal(badgeInput().value, '4'); await React.act(async () => pending.resolve(false)); assert.equal(badgeInput().value, '4'); await render(React.createElement(VersionBadge, props)); assert.equal(badgeInput().readOnly, false);
  });
  await check('Badge events are isolated; unrelated header actions still work', async () => {
    const events = []; const handlers = Object.fromEntries(['PointerDown','PointerUp','MouseDown','MouseUp','Click','DoubleClick','AuxClick','ContextMenu','DragStart','DragEnd','DragOver','Drop','KeyDown','KeyUp'].map(name => [`on${name}`, () => events.push(name)]));
    await render(React.createElement('div', handlers, badge(), React.createElement('button', { className: 'header-action' }, 'header')));
    await React.act(async () => { for (const type of ['pointerdown','pointerup','mousedown','mouseup','dblclick','auxclick','contextmenu','dragstart','dragend','dragover','drop','keydown','keyup']) host.querySelector('[data-version-badge]').dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true })); });
    await click(badgeButton()); assert.deepEqual(events, []); await click(host.querySelector('.header-action')); assert.deepEqual(events, ['Click']);
  });

  const labels = { view: 'View', viewSettings: 'View settings', zoom: 'Zoom', adjustZoom: 'Adjust zoom', versionEdit: 'Version edit', exitVersionEdit: 'Exit version edit', preview: 'Preview', releaseVersion: 'Release version', invalidVersion: 'Invalid release version' };
  let viewCalls, viewState;
  const previewButton = () => [...host.querySelectorAll('button')].find(button => button.textContent === labels.preview);
  const release = () => host.querySelector('input[aria-label="Release version"]');
  const menuButton = () => document.querySelector('.version-menu-item'); const viewButton = () => host.querySelector('[aria-label="View settings"]');
  function ViewHarness({ initial = {} }) {
    const [state, setState] = React.useState({ edit: false, preview: false, releaseVersion: 2, zoomLevel: 100, disabled: false, ...initial }); viewState = state;
    const update = (name, value) => { viewCalls.push([name, value]); setState(previous => ({ ...previous, [name]: value })); };
    return React.createElement(React.Fragment, null, React.createElement(VersionViewControls, { ...state, labels, onEditChange: value => update('edit', value), onPreviewChange: value => update('preview', value), onReleaseVersionChange: value => update('releaseVersion', value), setZoomLevel: value => update('zoomLevel', value) }), state.edit && React.createElement(VersionBadge, { value: 0, label: 'Mounted in edit', messages, onCommit: async () => true }));
  }
  const controls = initial => { viewCalls = []; return React.createElement(ViewHarness, { initial }); };
  await check('View popover contains zoom and edit only; preview is nested in edit', async () => {
    await render(controls()); assert.equal(previewButton(), undefined); assert.equal(release(), null); await click(viewButton()); assert(document.querySelector('[aria-label="Adjust zoom"]')); assert.equal(document.querySelectorAll('.version-menu-item').length, 1); assert.equal(menuButton().textContent, labels.versionEdit); assert(!document.querySelector('.version-view-popover').textContent.includes(labels.preview)); await click(menuButton()); assert.equal(viewState.edit, true); assert(previewButton()); assert.equal(release(), null); assert.equal(document.querySelector('.version-view-popover'), null);
  });
  await check('Preview toggles retain mounted badges and place release input adjacent', async () => {
    await render(controls({ edit: true })); const originalBadge = badgeButton(); await click(previewButton()); assert.equal(viewState.preview, true); assert.equal(badgeButton(), originalBadge); assert(release()); assert.equal(previewButton().nextElementSibling, release().parentElement); await click(previewButton()); assert.equal(viewState.edit, true); assert.equal(viewState.preview, false); assert.equal(badgeButton(), originalBadge); assert.equal(release(), null);
  });
  await check('Exit edit requests preview off first, also from the View menu', async () => {
    for (const fromMenu of [false, true]) {
      await render(controls({ edit: true, preview: true })); if (fromMenu) { await click(viewButton()); await click(menuButton()); } else await click(host.querySelector('[aria-label="Exit version edit"]'));
      assert.deepEqual(viewCalls, [['preview', false], ['edit', false]]); assert.equal(release(), null); assert.equal(badgeButton(), null); await unmount();
    }
  });
  await check('Invalid release input retains last valid target; blank never becomes zero', async () => {
    await render(controls({ edit: true, preview: true }));
    for (const invalid of ['', '-1', '1.5', '+1', '1e2', '4294967296']) { await input(release(), invalid); assert.equal(viewState.releaseVersion, 2); assert.equal(release().value, invalid); assert.equal(release().getAttribute('aria-invalid'), 'true'); await key(release(), 'Enter'); assert.equal(release().value, invalid); }
    assert.deepEqual(viewCalls, []); await key(release(), 'Escape'); assert.equal(release().value, '2'); assert.equal(release().getAttribute('aria-invalid'), 'false'); await input(release(), ''); await React.act(async () => release().focus()); await blur(release()); assert.equal(release().value, '2'); assert.deepEqual(viewCalls, []);
  });
  await check('Valid release values update immediately, allow uint32 limits and suppress duplicates', async () => {
    await render(controls({ edit: true, preview: true })); await input(release(), '3'); await input(release(), '03'); await input(release(), '4294967295'); await input(release(), '0'); assert.deepEqual(viewCalls, [['releaseVersion', 3], ['releaseVersion', 4294967295], ['releaseVersion', 0]]); await key(release(), 'Enter'); assert.equal(release().value, '0');
  });
  await check('Release input expands for all ten uint32 digits while staying compact for short values', async () => {
    await render(controls({ edit: true, preview: true })); assert.equal(release().style.width, '62px');
    await input(release(), '4294967295'); assert.equal(release().style.width, '100px'); assert.equal(release().value, '4294967295');
    await input(release(), '999999999999999999'); assert.equal(release().style.width, '100px'); assert.equal(viewState.releaseVersion, 4294967295);
    await input(release(), '3'); assert.equal(release().style.width, '62px'); assert.equal(viewState.releaseVersion, 3);
  });
  await check('Preview off/on discards invalid draft and preserves last valid target', async () => {
    await render(controls({ edit: true, preview: true })); await input(release(), '7'); await input(release(), ''); await click(previewButton()); await click(previewButton()); assert.equal(release().value, '7'); assert.equal(viewState.releaseVersion, 7);
  });
  await check('Zoom stays controlled through View popover', async () => {
    await render(controls()); await click(viewButton()); await input(document.querySelector('[aria-label="Adjust zoom"]'), '70'); assert.equal(viewState.zoomLevel, 70); assert.deepEqual(viewCalls, [['zoomLevel', 70]]);
  });
  await check('Disabled version controls cannot change edit, preview or release', async () => {
    await render(controls({ edit: true, preview: true, disabled: true })); assert(previewButton().disabled); assert(release().disabled); await click(previewButton()); await click(host.querySelector('[aria-label="Exit version edit"]')); await click(viewButton()); assert(menuButton().disabled); await click(menuButton()); assert.deepEqual(viewCalls, []);
  });
  await check('External props sync release; stale preview=true outside edit stays hidden', async () => {
    const base = { edit: false, preview: true, releaseVersion: 2, zoomLevel: 100, labels, onEditChange: () => {}, onPreviewChange: () => {}, onReleaseVersionChange: () => {}, setZoomLevel: () => {} };
    await render(React.createElement(VersionViewControls, base)); assert.equal(previewButton(), undefined); assert.equal(release(), null); await render(React.createElement(VersionViewControls, { ...base, edit: true })); await input(release(), ''); await render(React.createElement(VersionViewControls, { ...base, edit: true, releaseVersion: 9 })); assert.equal(release().value, '9'); assert.equal(release().getAttribute('aria-invalid'), 'false');
  });
  const report = { passed: reports.length, checks: reports, scope: 'Production React controls and real Radix in happy-dom; native IPC, WebKit paint and application layout not asserted.' };
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); await window.happyDOM.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
