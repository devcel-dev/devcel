const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compileModule } = require('./compile-module.cjs');
const root = path.resolve(__dirname, '..');
function load(file, mocks, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(compileModule(fs.readFileSync(path.join(root, file), 'utf8'), file), {
    module, exports: module.exports, require: id => mocks[id] ?? require(id), console, setTimeout, clearTimeout, ...globals
  });
  return module.exports;
}
(async () => {
  let scale = 1, size = { width: 800, height: 600 }, maximized = false, listener;
  let area = { width: 1920, height: 1040 };
  const values = new Map(); const applied = [];
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const physical = value => ({ ...value, toLogical: factor => ({ width: value.width / factor, height: value.height / factor }) });
  const win = {
    onResized: async callback => { listener = callback; return () => {}; },
    isMinimized: async () => false, isMaximized: async () => maximized,
    innerSize: async () => physical({ width: size.width * scale, height: size.height * scale }),
    outerSize: async () => ({ width: size.width * scale, height: size.height * scale }),
    outerPosition: async () => ({ x: 4000, y: -100 }), scaleFactor: async () => scale,
    unmaximize: async () => { maximized = false; }, maximize: async () => { maximized = true; },
    setSize: async next => { size = { width: next.width, height: next.height }; applied.push({ ...size }); listener(); },
    setPosition: async next => { assert(next.x >= 0 && next.y >= 0); assert(next.x + size.width * scale <= area.width); assert(next.y + size.height * scale <= area.height); }
  };
  class Size { constructor(width, height) { this.width = width; this.height = height; } }
  class Position { constructor(x, y) { this.x = x; this.y = y; } }
  const packageInfo = require('../package.json');
  const storageKeys = load('src/app/settings/storageKey.ts', {});
  const geometry = load('src/app/utils/mainWindowGeometry.ts', {
    '../../../package.json': packageInfo, '../settings/storageKey': storageKeys,
    '@tauri-apps/api/window': { getCurrentWindow: () => win, currentMonitor: async () => ({ workArea: { position: { x: 0, y: 0 }, size: area }, scaleFactor: scale }), primaryMonitor: async () => null },
    '@tauri-apps/api/dpi': { LogicalSize: Size, PhysicalPosition: Position }
  }, { localStorage: storage });
  await geometry.setMainWindowMode(false); assert.equal(size.width, 800);
  await geometry.setMainWindowMode(true); assert.equal(size.width, 1280); assert.equal(size.height, 800);
  size = { width: 1110, height: 750 };
  await geometry.setMainWindowMode(false); assert.equal(size.width, 800);
  await geometry.setMainWindowMode(true); assert.equal(size.width, 1110);
  scale = 2; area = { width: 1600, height: 1000 };
  await geometry.setMainWindowMode(false); assert.equal(size.width, 800); assert.equal(size.height, 500);
  await geometry.setMainWindowMode(true); assert.equal(size.width, 800); assert.equal(size.height, 500);
  await geometry.setMainWindowMode(false);
  scale = 1; area = { width: 1920, height: 1040 };
  await geometry.setMainWindowMode(true); assert.equal(size.width, 1110); assert.equal(size.height, 750);
  await Promise.all([geometry.setMainWindowMode(false), geometry.setMainWindowMode(true)]);
  assert.equal(size.width, 1110);
  const persisted = JSON.parse(values.get(storageKeys.versionedStorageKey('devcel-main-window-geometry-v1', packageInfo.version)));
  assert.equal(persisted.project.width, 1110); assert.equal(persisted.welcome, undefined, 'clamped default is not saved as a user override');
  assert.equal(values.has('devcel-main-window-geometry-v1'), false, 'Unversioned preferences are not written');
  let seenFont;
  const widths = load('src/app/pages/main_window/project_view/table_view/components/initialHeaderWidth.ts', {}, {
    document: { createElement: () => ({ getContext: () => ({ set font(value) { seenFont = value; }, measureText: text => ({ width: text === '譌･譛ｬ隱槭ち繧､繝医Ν' ? 156 : text.length * 7 }) }) }), querySelector: () => ({}) },
    getComputedStyle: () => ({ font: '700 13px TestFont' })
  });
  assert.equal(widths.initialHeaderWidth('譌･譛ｬ隱槭ち繧､繝医Ν', 100), 204);
  assert.equal(seenFont, '700 13px TestFont');
  assert.equal(widths.initialHeaderWidth('x'.repeat(2000), 100), 420);
  assert.equal(widths.initialHeaderWidth('ID', 100), 100);
  console.log('PASS window defaults, separate saved modes, rapid transitions, DPI clamp, offscreen positions, unclamped preference preservation, actual-font title measurement and bounded long labels');
})().catch(error => { console.error(error); process.exitCode = 1; });
