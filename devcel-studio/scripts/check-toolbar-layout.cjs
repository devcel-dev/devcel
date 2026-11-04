#!/usr/bin/env node
'use strict';

// Local toolbar regression checks. Verify actual CSS layout and WebKit rendering separately on a device.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const studioRoot = path.resolve(__dirname, '..');
const studioRequire = createRequire(path.join(studioRoot, 'package.json'));
const { compileModule } = require('./compile-module.cjs');
const React = studioRequire('react');
// Resolve the Japanese catalog generated from the current DB with the real ICU implementation.
// Only useI18n is a hook-free boundary mock here. Actual subscriptions are covered by runtime regressions.
const { IntlMessageFormat } = studioRequire('intl-messageformat');
const jaMessages = JSON.parse(fs.readFileSync(path.join(studioRoot, 'src/app/i18n/generated/catalog.json'), 'utf8')).messages.ja;
const messageFormats = new Map();
function t(key, values) {
  assert.ok(Object.prototype.hasOwnProperty.call(jaMessages, key), `Missing Japanese message: ${key}`);
  if (!messageFormats.has(key)) messageFormats.set(key, new IntlMessageFormat(jaMessages[key], 'ja', undefined, { ignoreTag: true }));
  return String(messageFormats.get(key).format(values));
}
const i18n = { t, useI18n: () => ({ locale: 'ja', t }), formatNumber: (value, options) => new Intl.NumberFormat('ja', options).format(value) };
const fileName = path.join(studioRoot, 'src/app/pages/main_window/project_view/table_view/components/DataGridToolbar.tsx');
const source = fs.readFileSync(fileName, 'utf8');
const compiled = compileModule(source, fileName, 'transform');

function TableSearchBarStub() { return null; }
function VersionViewControlsStub() { return null; }
const iconsFile = path.join(path.dirname(fileName), 'TableActionIcons.tsx');
const iconsModule = { exports: {} };
new Function('require', 'module', 'exports', compileModule(fs.readFileSync(iconsFile, 'utf8'), iconsFile, 'transform'))(studioRequire, iconsModule, iconsModule.exports);
const icons = iconsModule.exports;
const toolbarModule = { exports: {} };
new Function('require', 'module', 'exports', compiled)(specifier => {
  if (specifier === './DataGridToolbar.css') return {};
  if (specifier === 'react') return React;
  if (specifier === './TableActionIcons') return icons;
  if (specifier === '@/components/ui/context-menu') return Object.fromEntries(['ContextMenu', 'ContextMenuTrigger', 'ContextMenuContent', 'ContextMenuItem'].map(name => [name, name]));
  if (specifier === '@/app/i18n') return i18n;
  if (specifier === './TableSearchBar') return { TableSearchBar: TableSearchBarStub };
  if (specifier === './VersionControls') return { VersionViewControls: VersionViewControlsStub };
  throw new Error(`Unexpected dependency: ${specifier}`);
}, toolbarModule, toolbarModule.exports);
const { DataGridToolbar } = toolbarModule.exports;

let passed = 0;
let failed = 0;
function check(name, body) {
  try {
    body();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}

function children(element) {
  const value = element.props.children;
  return (Array.isArray(value) ? value.flat(Infinity) : [value]).filter(React.isValidElement);
}
function descendants(element) {
  return [element, ...children(element).flatMap(descendants)];
}
function classes(element) {
  return (element.props.className || '').trim().split(/\s+/).filter(Boolean).sort();
}
function hasClass(element, value) { return classes(element).includes(value); }
function findOne(root, predicate, label) {
  const results = descendants(root).filter(predicate);
  assert.equal(results.length, 1, `identify exactly one ${label}`);
  return results[0];
}
function parentOf(root, target) {
  return findOne(root, element => children(element).includes(target), 'parent element');
}

function fixture(overrides = {}) {
  const calls = [];
  const props = {
    searchQuery: 'a',
    setSearchQuery: value => calls.push(['setSearchQuery', value]),
    onSearch: value => calls.push(['onSearch', value]),
    onClear: () => calls.push(['onClear']),
    isSearching: false,
    filteredRowCount: 2,
    undo: () => calls.push(['undo']),
    redo: () => calls.push(['redo']),
    addRow: () => calls.push(['addRow']),
    addRows: () => calls.push(['addRows']),
    addColumn: () => calls.push(['addColumn']),
    addRowsAllowed: true,
    addColumnsAllowed: true,
    isUpdating: false,
    isSaving: false,
    pendingChangesCount: 0,
    rowCount: 83,
    columnCount: 17,
    zoomLevel: 100,
    setZoomLevel: value => calls.push(['setZoomLevel', value]),
    versionEditMode: false,
    versionPreview: false,
    releaseVersion: 2,
    versionControlsDisabled: false,
    onVersionEditModeChange: value => calls.push(['onVersionEditModeChange', value]),
    onVersionPreviewChange: value => calls.push(['onVersionPreviewChange', value]),
    onReleaseVersionChange: value => calls.push(['onReleaseVersionChange', value]),
    onOpenTableSettings: () => calls.push(['onOpenTableSettings']),
    addRows: () => calls.push(['addRows']),
    ...overrides
  };
  const root = DataGridToolbar(props);
  const saveText = findOne(root, element => element.type === 'span' && element.props.children === '保存中...', 'save text');
  const saveBadge = parentOf(root, saveText);
  const spinner = findOne(saveBadge, element => element.type === 'div' && element !== saveBadge, 'save spinner');
  return { root, props, calls, saveText, saveBadge, spinner };
}

const idle = fixture();
const busy = fixture({ isUpdating: true, isSaving: true, pendingChangesCount: 1, rowCount: 84 });

check('save badge has the same parent and position in both idle and busy states', () => {
  const idleParent = parentOf(idle.root, idle.saveBadge);
  const busyParent = parentOf(busy.root, busy.saveBadge);
  assert.deepEqual(classes(idleParent), classes(busyParent));
  assert.equal(children(idleParent).length, children(busyParent).length);
  assert.equal(children(idleParent).indexOf(idle.saveBadge), children(busyParent).indexOf(busy.saveBadge));
  assert.deepEqual(children(idleParent).map(element => element.type), children(busyParent).map(element => element.type));
});

check('save badge classes differ only by visible/invisible, with identical dimension classes', () => {
  const geometryClasses = element => classes(element).filter(value => !['visible', 'invisible'].includes(value));
  assert.deepEqual(geometryClasses(idle.saveBadge), geometryClasses(busy.saveBadge));
  for (const state of [idle, busy]) {
    for (const token of ['flex', 'shrink-0', 'items-center', 'gap-2', 'whitespace-nowrap', 'px-3', 'py-1.5']) {
      assert.ok(hasClass(state.saveBadge, token), token);
    }
    assert.equal(state.saveBadge.props.style, undefined, 'no state-dependent inline dimension changes');
    assert.equal(state.saveBadge.props.hidden, undefined, 'no hidden attribute causing display:none');
    assert.ok(!hasClass(state.saveBadge, 'hidden'));
  }
});

check('idle save display is invisible and aria-hidden; busy is visible and aria-hidden=false', () => {
  assert.ok(hasClass(idle.saveBadge, 'invisible'));
  assert.ok(!hasClass(idle.saveBadge, 'visible'));
  assert.equal(idle.saveBadge.props['aria-hidden'], true);
  assert.ok(hasClass(busy.saveBadge, 'visible'));
  assert.ok(!hasClass(busy.saveBadge, 'invisible'));
  assert.equal(busy.saveBadge.props['aria-hidden'], false);
});

check('spinner stops when idle and rotates only when busy, with unchanged dimensions', () => {
  assert.ok(!hasClass(idle.spinner, 'animate-spin'));
  assert.ok(hasClass(busy.spinner, 'animate-spin'));
  assert.deepEqual(classes(idle.spinner), classes(busy.spinner).filter(value => value !== 'animate-spin'));
  for (const state of [idle, busy]) {
    assert.ok(hasClass(state.spinner, 'w-3.5'));
    assert.ok(hasClass(state.spinner, 'h-3.5'));
  }
  assert.equal(idle.saveText.props.children, busy.saveText.props.children);
  assert.deepEqual(classes(idle.saveText), classes(busy.saveText));
});

check('search result badge shows the latest visible/total counts without changes during save transitions', () => {
  for (const state of [idle, busy]) {
    const expectedText = t('grid.filterSort.resultCount', {
      count: i18n.formatNumber(state.props.filteredRowCount),
      total: i18n.formatNumber(state.props.rowCount)
    });
    const badgeText = findOne(state.root, element => element.type === 'span'
      && (Array.isArray(element.props.children) ? element.props.children.join('') : element.props.children) === expectedText, 'search result text');
    const badge = parentOf(state.root, badgeText);
    assert.ok(hasClass(badge, 'whitespace-nowrap'));
    assert.ok(hasClass(badge, 'shrink-0'));
  }
});

for (const [stateName, state] of [['idle', idle], ['busy', busy]]) {
  check(`${stateName}: standalone Interface and Add rows buttons are absent`, () => {
    assert(!descendants(state.root).some(element => element.type === 'button' && element.props.title === t('grid.interfaceActions')));
    assert(!descendants(state.root).some(element => element.type === 'button' && element.props.onClick === state.props.addRows));
    const item = findOne(state.root, element => element.type === 'ContextMenuItem', 'bulk row menu item');
    assert.equal(item.props.disabled, state.props.isUpdating);
    assert.equal(item.props.children, t('grid.bulk.add'));
  });

  for (const action of ['addRow', 'addColumn']) {
    check(`${stateName}: ${action} preserves padding, SVG dimensions, native disabled, and a border`, () => {
      const button = findOne(state.root, element => element.type === 'button' && element.props.onClick === state.props[action], action);
      assert.equal(button.props.disabled, state.props.isUpdating);
      assert.ok(hasClass(button, 'p-2'));
      assert.ok(hasClass(button, 'border'));
      assert.ok(!classes(button).some(token => /^border-(?:0|2|4|8)$/.test(token)));
      assert.ok(hasClass(button, state.props.isUpdating ? 'border-transparent' : 'border-border'));
      const svg = findOne(button, element => element.type === (action === 'addRow' ? icons.AddRowIcon : icons.AddColumnIcon), `${action} SVG`);
      assert.ok(hasClass(svg, 'w-5'));
      assert.ok(hasClass(svg, 'h-5'));
    });
  }

  check(`${stateName}: toolbar handlers connect directly to the original callbacks`, () => {
    for (const [action, title] of [['undo', '元に戻す (Ctrl+Z)'], ['redo', 'やり直し (Ctrl+Shift+Z)']]) {
      const button = findOne(state.root, element => element.type === 'button' && element.props.title === title, action);
      assert.equal(button.props.onClick, state.props[action]);
    }
    const search = findOne(state.root, element => element.type === TableSearchBarStub, 'TableSearchBar');
    assert.equal(search.props.searchQuery, state.props.searchQuery);
    for (const key of ['setSearchQuery', 'onSearch', 'onClear']) assert.equal(search.props[key], state.props[key]);
  });
}

check('enabled addRow/addColumn, Undo/Redo, and Table Settings handlers each invoke exactly once', () => {
  const state = fixture();
  for (const action of ['addRow', 'addColumn', 'undo', 'redo', 'onOpenTableSettings']) {
    if (action === 'onOpenTableSettings') { const control=findOne(state.root, element=>element.props.onOpen===state.props[action], action); control.props.onOpen(); }
    else { const button = findOne(state.root, element => element.type === 'button' && element.props.onClick === state.props[action], action); button.props.onClick(); }
  }
  assert.deepEqual(state.calls, [['addRow'], ['addColumn'], ['undo'], ['redo'], ['onOpenTableSettings']]);
});

check('bulk rows stay in the row context menu and respect permissions', () => {
  for (const overrides of [{}, { isUpdating: true }, { addRowsAllowed: false }]) {
    const state = fixture(overrides);
    const item = findOne(state.root, element => element.type === 'ContextMenuItem', 'bulk rows');
    const disabled = state.props.isUpdating || !state.props.addRowsAllowed;
    assert.equal(item.props.disabled, disabled);
    item.props.onSelect();
    assert.deepEqual(state.calls, disabled ? [] : [['addRows']]);
    const trigger = findOne(state.root, element => element.type === 'ContextMenuTrigger', 'row context trigger');
    assert.equal(trigger.props.disabled, disabled);
  }
});
check('Menu and Shift+F10 open the row context menu without adding a row', () => {
  global.MouseEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
  for (const key of ['ContextMenu', 'F10']) {
    const state = fixture(); let prevented = 0; const events = [];
    const button = findOne(state.root, element => element.type === 'button' && element.props.onClick === state.props.addRow, 'add row');
    button.props.onKeyDown({ key, shiftKey: key === 'F10', preventDefault: () => prevented++, currentTarget: { getBoundingClientRect: () => ({ left: 12, bottom: 24 }), dispatchEvent: event => events.push(event) } });
    assert.equal(prevented, 1); assert.equal(events[0].type, 'contextmenu'); assert.equal(events[0].clientY, 24); assert.deepEqual(state.calls, []);
  }
});

check('zoom and version controlled props pass directly to shared display controls', () => {
  const state = fixture({ versionEditMode: true, versionPreview: true, releaseVersion: 3, versionControlsDisabled: true });
  const controls = findOne(state.root, element => element.type === VersionViewControlsStub, 'shared View controls');
  assert.equal(controls.props.zoomLevel, 100);
  assert.equal(controls.props.setZoomLevel, state.props.setZoomLevel);
  assert.equal(controls.props.edit, true);
  assert.equal(controls.props.preview, true);
  assert.equal(controls.props.releaseVersion, 3);
  assert.equal(controls.props.disabled, true);
  for (const [callback, source] of [['onEditChange', 'onVersionEditModeChange'], ['onPreviewChange', 'onVersionPreviewChange'], ['onReleaseVersionChange', 'onReleaseVersionChange']]) assert.equal(controls.props[callback], state.props[source]);
  assert.equal(controls.props.labels.view, t('menu.view'));
  assert.equal(controls.props.labels.invalidVersion, t('grid.version.invalid'));
  controls.props.setZoomLevel(50);
  assert.deepEqual(state.calls, [['setZoomLevel', 50]]);
  // Numeric input handling is exercised on the real component by check-version-controls.
});

check('save area retains idle dimensions during isUpdating-only operations such as column changes', () => {
  const state = fixture({ isUpdating: true, isSaving: false });
  assert.deepEqual(classes(state.saveBadge), classes(idle.saveBadge));
  assert.equal(state.saveBadge.props['aria-hidden'], true);
  for (const action of ['addRow', 'addColumn']) {
    const button = findOne(state.root, element => element.type === 'button' && element.props.onClick === state.props[action], action);
    assert.equal(button.props.disabled, true);
    assert.ok(hasClass(button, 'border'));
  }
});

check('toolbar fits available width without the old 860px floor', () => {
  for (const state of [idle, busy]) {
    assert.ok(hasClass(state.root, 'w-full'));
    assert.ok(hasClass(state.root, 'min-w-fit'));
    assert.ok(hasClass(state.root, 'items-center'));
  }
  const grid = fs.readFileSync(path.join(path.dirname(fileName), 'DataGridView.tsx'), 'utf8');
  assert(!grid.includes('min-w-[860px]'));
  assert(grid.includes('shrink-0 min-w-0 overflow-x-auto'));
});
check('Table Settings has a decorative icon and the original accessible text', () => {
  const button = findOne(idle.root, e => e.props.onOpen === idle.props.onOpenTableSettings, 'settings');
  const markup=studioRequire('react-dom/server').renderToStaticMarkup(button);
  const icon = findOne(button, e => e.type === icons.TableSettingsIcon, 'settings icon');
  assert.ok(hasClass(icon, 'h-5'));
  assert.ok(markup.includes('h-[38px]'));
  assert.ok(markup.includes('items-center'));
  assert.ok(markup.startsWith('<button'));
  assert(children(button).some(e => e.type === 'span' && e.props.children === t('table.edit.settings')));
});
check('View controls remain at the trailing edge beyond the stable save slot', () => {
  const view = findOne(idle.root, e => e.type === VersionViewControlsStub, 'view');
  const parent = parentOf(idle.root, view);
  assert.equal(children(parent).at(-1), view);
  assert.ok(hasClass(parent, 'ms-auto'), 'logical spacing supports RTL');
  assert.equal(parentOf(idle.root, idle.saveBadge), parent);
});
check('search can shrink and grow within a bounded readable width', () => {
  const search = fs.readFileSync(path.join(path.dirname(fileName), 'TableSearchBar.tsx'), 'utf8');
  assert(search.includes('min-w-40 max-w-xs flex-1'));
  assert(search.includes('h-[38px]'));
});

check('narrow save slot compacts on viewport width, never on saving state', () => {
  const css = fs.readFileSync(path.join(path.dirname(fileName), 'DataGridToolbar.css'), 'utf8');
  assert(css.includes('container-type: inline-size'));
  assert(css.includes('@container (max-width: 850px)'));
  assert(css.includes('width: 24px'));
  assert(css.includes('.grid-save-status .grid-save-label'));
  assert(!css.includes('.visible') && !css.includes('.invisible'));
  for (const state of [idle, busy]) {
    assert.equal(state.saveBadge.props['aria-label'], t('grid.saving'));
    assert.equal(state.saveBadge.props.title, t('grid.saving'));
    assert.ok(hasClass(state.saveBadge, 'grid-save-status'));
  }
});


check('approved icons follow visible axes without changing command identity', () => {
  const normal = DataGridToolbar(idle.props);
  const transposed = DataGridToolbar({ ...idle.props, transposed: true });
  for (const [tree, rowType, columnType] of [[normal, icons.AddRowIcon, icons.AddColumnIcon], [transposed, icons.AddColumnIcon, icons.AddRowIcon]]) {
    const row = findOne(tree, e => e.type === 'button' && e.props.onClick === idle.props.addRow, 'add row');
    const column = findOne(tree, e => e.type === 'button' && e.props.onClick === idle.props.addColumn, 'add column');
    assert(children(row).some(e => e.type === rowType));
    assert(children(column).some(e => e.type === columnType));
  }
});
check('SVG instances use unique masks, currentColor, transparent backgrounds and 20px size', () => {
  const { renderToStaticMarkup } = studioRequire('react-dom/server');
  const markup = renderToStaticMarkup(React.createElement('div', null,
    ...[icons.AddRowIcon, icons.AddColumnIcon, icons.TableSettingsIcon, icons.AddRowIcon, icons.TableSettingsIcon].map((type, key) => React.createElement(type, { key }))));
  const ids = [...markup.matchAll(/<mask id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  for (const id of ids) assert(markup.includes('url(#' + id + ')'));
  assert.equal((markup.match(/width="20" height="20"/g) || []).length, 5);
  assert.equal((markup.match(/aria-hidden="true"/g) || []).length, 5);
  assert.equal((markup.match(/stroke="currentColor"/g) || []).length, 5);
  assert(!markup.includes('background'));
  assert.equal((markup.match(/stroke-width="1"/g) || []).length, 5);
  assert(markup.includes('r="6.5"') && markup.includes('r="8.25"'));
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
console.log('LIMITATION: Local React element/handler and dimension-class checks only. Actual CSS dimensions, scrollbars, WebKit hit-testing, native disabled event dispatch, saving/Undo, and blue text selection require device verification.');
console.log('NOTE: The save slot stays mounted and compacts to 24px below 850px of toolbar viewport width. Save transitions never change its geometry.');
process.exitCode = failed ? 1 : 0;

