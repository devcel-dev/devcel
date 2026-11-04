// Deterministic frame-budget/lifecycle and production manager regressions.
// WebGL appearance and native GPU timing are verified separately, not mocked here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const require = createRequire(import.meta.url);
const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(studio, 'src/app/pages/main_window/welcome_view/backgrounds');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-backgrounds-'));
const window = new Window({ url: 'http://backgrounds.invalid/' });
for (const name of ['window', 'document', 'navigator', 'Event', 'KeyboardEvent', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Keep React's native CommonJS module boundary. Bundling its dynamic
// module.require fallback creates unclosed MessageChannels for every async act.
const nativeReact = {
  name: 'native-react', setup(builder) {
    builder.onResolve({ filter: /^(react|react-dom)(\/|$)/ }, args => ({ path: require.resolve(args.path), external: true }));
  },
};

try {
  const runtime = path.join(temporary, 'runtime.cjs');
  await build({ entryPoints: [path.join(directory, 'backgroundRuntime.ts')], outfile: runtime, bundle: true, platform: 'node', format: 'cjs' });
  const { backgroundDpr, createBackgroundScheduler, BACKGROUND_PIXEL_BUDGET } = require(runtime);
  for (const [width, height, deviceDpr] of [[1280, 800, 1], [1920, 1080, 2], [3840, 2160, 3], [480, 640, 2]]) {
    const dpr = backgroundDpr(width, height, deviceDpr);
    assert.ok(dpr <= 1.5 && dpr <= deviceDpr);
    assert.ok(width * height * dpr * dpr <= BACKGROUND_PIXEL_BUDGET + 1);
  }
  const pending = new Map(), draws = [];
  let id = 0;
  const scheduler = createBackgroundScheduler({
    draw: elapsed => draws.push(elapsed),
    request: callback => { pending.set(++id, callback); return id; },
    cancel: id => pending.delete(id),
  });
  function tick(time) {
    const callbacks = [...pending.values()]; pending.clear();
    for (const callback of callbacks) callback(time);
  }
  scheduler.configure(true, false);
  assert.equal(draws.length, 1);
  for (let frame = 0; frame <= 120; frame++) tick(frame * 1000 / 60);
  assert.ok(draws.length >= 60 && draws.length <= 62, `Expected ~30fps, got ${draws.length} draws in 2s`);
  assert.ok(Math.abs(draws.at(-1) - 2) < .035);
  const beforePause = draws.at(-1);
  scheduler.configure(false, false);
  assert.equal(pending.size, 0);
  tick(100_000);
  scheduler.configure(true, false);
  tick(100_000); tick(100_034);
  assert.ok(draws.at(-1) - beforePause < .05, 'Hidden time must not advance the animation');
  scheduler.configure(true, true);
  const reducedCount = draws.length;
  assert.equal(pending.size, 0);
  tick(110_000);
  assert.equal(draws.length, reducedCount);
  scheduler.repaint();
  assert.equal(draws.length, reducedCount + 1);
  assert.equal(draws.at(-1), draws.at(-2));
  scheduler.configure(true, false);
  assert.equal(pending.size, 1);
  scheduler.dispose();
  assert.equal(pending.size, 0);
  scheduler.configure(true, false); scheduler.repaint();
  assert.equal(pending.size, 0);
  console.log('PASS: 30fps clock, 2M-pixel ceiling, hidden pause/resume, static reduced motion, repaint and disposal');

  const manager = fs.readFileSync(path.join(directory, 'AnimatedBackgroundManager.tsx'), 'utf8');
  const names = [...manager.matchAll(/component: (\w+Background),/g)].map(match => match[1]);
  assert.equal(names.length, 23);
  assert.equal(new Set(names).size, 23);
  for (const name of names) {
    const source = fs.readFileSync(path.join(directory, `${name}.tsx`), 'utf8');
    assert.match(source, /BackgroundCanvas/);
    assert.doesNotMatch(source, /import\s*\{[^}]*\bCanvas\b[^}]*\}\s*from\s*['"]@react-three\/fiber/);
    assert.doesNotMatch(source, /fixed inset-0 -z-10/);
  }
  const output = path.join(temporary, 'manager.cjs');
  await build({ absWorkingDir: studio, stdin: { resolveDir: studio, loader: 'tsx', contents: `
    export { AnimatedBackgroundManager } from './src/app/pages/main_window/welcome_view/backgrounds/AnimatedBackgroundManager';
    export * as React from 'react'; export { createRoot } from 'react-dom/client';` },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
    plugins: [nativeReact, { name: 'scene-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path === '@/app/i18n') return { path: args.path, namespace: 'mock-i18n' };
        if (names.some(name => args.path === `./${name}`)) return { path: args.path.slice(2), namespace: 'mock-scene' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'mock-i18n' }, () => ({ contents: 'export const t=(key,args)=>args?.name??key; export const useI18n=()=>null;' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock-scene' }, args => ({ resolveDir: studio, loader: 'tsx', contents: `export function ${args.path}({className}) { return <div className={className} data-scene="${args.path}"/>; }` }));
    } }],
  });
  const { React, createRoot, AnimatedBackgroundManager } = require(output);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const render = debugMode => React.act(async () => root.render(React.createElement(AnimatedBackgroundManager, { debugMode, className: 'test-background' })));
  const scene = () => host.querySelector('[data-scene]').dataset.scene;
  const key = async (value, target = window, extra = {}) => React.act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra })));
  const originalRandom = Math.random;
  Math.random = () => 0;
  await render(false);
  assert.equal(scene(), names[0], 'production samples the full scene list on mount');
  Math.random = () => 1 - Number.EPSILON;
  await render(false);
  await key('ArrowRight'); await key('r');
  assert.equal(scene(), names[0], 'parent rerenders and production keys must not change the chosen scene');
  await render(true);
  assert.equal(scene(), names[0], 'changing debug controls must not remount the scene');
  Math.random = originalRandom;
  const start = scene(), seen = new Set();
  for (let i = 0; i < 46; i++) { seen.add(scene()); await key('ArrowRight'); }
  assert.equal(seen.size, 23); assert.equal(scene(), start);
  await key('ArrowLeft'); await key('ArrowRight'); assert.equal(scene(), start);
  const input = document.createElement('input'); host.append(input);
  await key('ArrowRight', input); await key('r', input); assert.equal(scene(), start);
  await key('ArrowRight', window, { ctrlKey: true }); assert.equal(scene(), start);
  assert.equal(host.querySelector('[data-scene]').className, 'test-background');
  await React.act(async () => root.unmount());
  await key('ArrowRight');
  assert.equal(host.querySelector('[data-scene]'), null);
  try {
    for (let index = 0; index < names.length; index++) {
      const mount = createRoot(host);
      Math.random = () => (index + .5) / names.length;
      await React.act(async () => mount.render(React.createElement(AnimatedBackgroundManager)));
      assert.equal(scene(), names[index], `production mount can choose scene ${index}`);
      Math.random = () => ((index + 1) % names.length + .5) / names.length;
      await React.act(async () => mount.render(React.createElement(AnimatedBackgroundManager, { className: 'rerender' })));
      assert.equal(scene(), names[index], 'a rerender must retain the mounted random choice');
      await React.act(async () => mount.unmount());
    }
  } finally {
    Math.random = originalRandom;
  }
  console.log('PASS: all 23 production mount choices use shared budgets and remain stable on rerender; 46 debug switches, wrap/back, editable/modified key guards and unmount');

  // Exercise the real wrapper/driver with a small R3F boundary double. It models
  // drawing-buffer invalidation on DPR changes, not WebGL appearance or timing.
  const canvasOutput = path.join(temporary, 'canvas.cjs');
  await build({
    absWorkingDir: studio,
    stdin: {
      resolveDir: studio, loader: 'tsx', contents: `
        export { BackgroundCanvas } from './src/app/pages/main_window/welcome_view/backgrounds/BackgroundCanvas';
        export { canvasState } from '@react-three/fiber';
        export * as React from 'react'; export { createRoot } from 'react-dom/client';`,
    },
    outfile: canvasOutput, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
    plugins: [nativeReact, {
      name: 'canvas-boundary', setup(builder) {
        builder.onResolve({ filter: /^@react-three\/fiber$/ }, () => ({ path: 'fiber', namespace: 'mock-canvas' }));
        builder.onLoad({ filter: /.*/, namespace: 'mock-canvas' }, () => ({
          resolveDir: studio, loader: 'tsx', contents: `
            export const canvasState = {
              size: { width: 3840, height: 2160 }, viewport: { dpr: 1 },
              gl: { domElement: document.createElement('canvas') },
              draws: [], props: null, painted: false, fail: false,
              get: () => canvasState,
              advance: time => { canvasState.draws.push(time); canvasState.painted = true; },
            };
            export const useThree = select => select(canvasState);
            export function Canvas(props) {
              if (canvasState.fail) throw new Error('Simulated WebGL initialization failure');
              canvasState.props = props;
              if (canvasState.viewport.dpr !== props.dpr) canvasState.painted = false;
              canvasState.viewport.dpr = props.dpr;
              return <div data-canvas>{props.children}</div>;
            }`,
        }));
      },
    }],
  });
  const { BackgroundCanvas, canvasState, React: CanvasReact, createRoot: createCanvasRoot } = require(canvasOutput);
  const resizeObservers = [], intersectionObservers = [], canvasFrames = new Map();
  let frameId = 0, hidden = false;
  const media = new window.EventTarget();
  media.matches = true;
  const resolutionMedia = [];
  window.matchMedia = query => {
    if (query.includes('prefers-reduced-motion')) return media;
    const resolution = new window.EventTarget();
    resolutionMedia.push(resolution);
    return resolution;
  };
  window.requestAnimationFrame = callback => { canvasFrames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = id => canvasFrames.delete(id);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2, writable: true });
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; resizeObservers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; intersectionObservers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  const originalBounds = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    ...canvasState.size, x: 0, y: 0, top: 0, left: 0,
    right: canvasState.size.width, bottom: canvasState.size.height,
  });
  const canvasHost = document.createElement('div'); document.body.append(canvasHost);
  const caught = [];
  const canvasRoot = createCanvasRoot(canvasHost, { onCaughtError: error => caught.push(error) });
  const renderCanvas = title => CanvasReact.act(async () => canvasRoot.render(CanvasReact.createElement(BackgroundCanvas, { title })));
  const resizeCanvas = (width, height, dpr) => CanvasReact.act(async () => {
    canvasState.size = { width, height };
    window.devicePixelRatio = dpr;
    resizeObservers.filter(observer => !observer.disconnected).forEach(observer => observer.callback([]));
    window.dispatchEvent(new Event('resize'));
  });
  try {
    await renderCanvas('first');
    const budgetDpr = Math.sqrt(BACKGROUND_PIXEL_BUDGET / (3840 * 2160));
    assert.equal(canvasState.props.dpr, budgetDpr);
    assert.equal(canvasState.props.frameloop, 'never');
    assert.equal(canvasFrames.size, 0, 'Reduced motion must not schedule RAF');
    assert.equal(canvasState.painted, true);
    await renderCanvas('unchanged-size-parent-rerender');
    assert.equal(canvasState.props.dpr, budgetDpr, 'Parent rerenders must retain the 4K pixel cap');
    assert.ok(3840 * 2160 * canvasState.props.dpr ** 2 <= BACKGROUND_PIXEL_BUDGET + 1);
    await resizeCanvas(800, 600, 1);
    assert.equal(canvasState.props.dpr, 1);
    assert.equal(canvasState.painted, true);
    await resizeCanvas(800, 600, 2);
    assert.equal(canvasState.props.dpr, 1.5);
    assert.equal(canvasState.painted, true, 'DPR-only changes must repaint the reduced-motion frame after buffer resize');
    assert.equal(canvasFrames.size, 0);
    await CanvasReact.act(async () => {
      window.devicePixelRatio = 1;
      resolutionMedia.at(-1).dispatchEvent(new Event('change'));
    });
    assert.equal(canvasState.props.dpr, 1, 'Display resolution changes must not require a window resize');
    assert.equal(canvasState.painted, true);
    assert.equal(canvasFrames.size, 0);

    await CanvasReact.act(async () => { media.matches = false; media.dispatchEvent(new Event('change')); });
    assert.equal(canvasFrames.size, 1);
    await CanvasReact.act(async () => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(canvasFrames.size, 0);
    await CanvasReact.act(async () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(canvasFrames.size, 1);
    await CanvasReact.act(async () => intersectionObservers.at(-1).callback([{ isIntersecting: false }]));
    assert.equal(canvasFrames.size, 0);
    await CanvasReact.act(async () => intersectionObservers.at(-1).callback([{ isIntersecting: true }]));
    assert.equal(canvasFrames.size, 1);
    await CanvasReact.act(async () => canvasState.gl.domElement.dispatchEvent(new Event('webglcontextlost')));
    assert.equal(canvasFrames.size, 0);
    await CanvasReact.act(async () => canvasState.gl.domElement.dispatchEvent(new Event('webglcontextrestored')));
    assert.equal(canvasFrames.size, 1);

    canvasState.fail = true;
    await renderCanvas('failed');
    assert.equal(caught.length, 1);
    assert.equal(canvasHost.querySelector('[data-canvas]'), null);
    assert.ok(canvasHost.firstElementChild.classList.contains('welcome-background'));
    const fallbackCss = fs.readFileSync(path.join(directory, '../welcome.css'), 'utf8');
    assert.match(fallbackCss, /\.welcome-background\s*\{[^}]*background:\s*radial-gradient/);
    assert.match(fallbackCss, /\.dark \.welcome-background\s*\{[^}]*background:\s*radial-gradient/);
    assert.equal(canvasFrames.size, 0, 'Canvas failure must dispose the driver');
    await CanvasReact.act(async () => canvasRoot.unmount());
    const disposedDraws = canvasState.draws.length;
    await CanvasReact.act(async () => {
      window.dispatchEvent(new Event('resize'));
      document.dispatchEvent(new Event('visibilitychange'));
      media.dispatchEvent(new Event('change'));
      resolutionMedia.forEach(resolution => resolution.dispatchEvent(new Event('change')));
    });
    assert.equal(canvasState.draws.length, disposedDraws);
    assert.equal(canvasFrames.size, 0);
    assert.ok(resizeObservers.every(observer => observer.disconnected));
    assert.ok(intersectionObservers.every(observer => observer.disconnected));
    console.log('PASS: 4K DPR survives parent rerenders; reduced-motion DPR repaint; visibility/intersection/context lifecycle; fallback and listener cleanup');
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = originalBounds;
    await CanvasReact.act(async () => canvasRoot.unmount());
  }
} finally {
  window.happyDOM.abort();
  fs.rmSync(temporary, { recursive: true, force: true });
}
