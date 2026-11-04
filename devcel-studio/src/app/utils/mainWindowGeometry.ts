import { version as appVersion } from '../../../src-tauri/tauri.conf.json';
import { versionedStorageKey } from '../settings/storageKey';
import { getCurrentWindow, currentMonitor, primaryMonitor } from '@tauri-apps/api/window';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';

type Mode = 'welcome' | 'project';
type Geometry = { width: number; height: number; maximized?: boolean };
const storageKey = versionedStorageKey('devcel-main-window-geometry-v1', appVersion);
export const defaults: Record<Mode, Geometry> = { welcome: { width: 800, height: 600 }, project: { width: 1280, height: 800 } };
export function preferredGeometry(mode: Mode, saved: Partial<Record<Mode, Geometry>>): Geometry {
  const value = saved[mode];
  return value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0
    ? value : defaults[mode];
}
export function fitLogicalSize(size: Geometry, area: { width: number; height: number }, scale: number) {
  return { width: Math.max(1, Math.min(size.width, area.width / scale)), height: Math.max(1, Math.min(size.height, area.height / scale)) };
}
let active: Mode | undefined;
let saved: Partial<Record<Mode, Geometry>> = {};
let loaded = false;
let changing = false;
let epoch = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastApplied: { width: number; height: number } | undefined;
let queue = Promise.resolve();
function persist() { localStorage.setItem(storageKey, JSON.stringify(saved)); }
async function capture(mode: Mode) {
  const window = getCurrentWindow();
  if (await window.isMinimized()) return;
  const maximized = await window.isMaximized();
  if (maximized) { saved[mode] = { ...preferredGeometry(mode, saved), maximized: true }; }
  else {
    const size = (await window.innerSize()).toLogical(await window.scaleFactor());
    // Do not replace the user's preferred size with a work-area clamp.
    if (!lastApplied || Math.abs(size.width - lastApplied.width) > 1 || Math.abs(size.height - lastApplied.height) > 1)
      saved[mode] = { width: size.width, height: size.height, maximized: false };
    else if (saved[mode]) saved[mode] = { ...saved[mode]!, maximized: false };
  }
  persist();
}
async function change(mode: Mode) {
  if (active === mode) return;
  const window = getCurrentWindow();
  if (!loaded) {
    const raw = localStorage.getItem(storageKey);
    if (raw) { try { saved = JSON.parse(raw) ?? {}; } catch (error) { console.error('Invalid saved window geometry', error); } }
    await window.onResized(() => {
      if (changing || !active) return;
      const generation = epoch, owner = active;
      clearTimeout(timer);
      timer = setTimeout(() => {
        queue = queue.then(async () => { if (generation === epoch && !changing) await capture(owner); }).catch(error => console.error('Unable to save window dimensions', error));
      }, 200);
    });
    loaded = true;
  }
  clearTimeout(timer);
  changing = true;
  ++epoch;
  try {
    if (active) await capture(active);
    const preferred = preferredGeometry(mode, saved);
    const monitor = await currentMonitor() ?? await primaryMonitor();
    await window.unmaximize();
    const outerBefore = await window.outerSize(), innerBefore = await window.innerSize();
    const available = monitor ? { width: Math.max(1, monitor.workArea.size.width - Math.max(0, outerBefore.width - innerBefore.width)),
      height: Math.max(1, monitor.workArea.size.height - Math.max(0, outerBefore.height - innerBefore.height)) } : undefined;
    const fitted = monitor && available ? fitLogicalSize(preferred, available, monitor.scaleFactor) : preferred;
    await window.setSize(new LogicalSize(fitted.width, fitted.height));
    lastApplied = fitted;
    if (monitor) {
      const area = monitor.workArea, outer = await window.outerSize(), position = await window.outerPosition();
      await window.setPosition(new PhysicalPosition(
        Math.max(area.position.x, Math.min(position.x, area.position.x + Math.max(0, area.size.width - outer.width))),
        Math.max(area.position.y, Math.min(position.y, area.position.y + Math.max(0, area.size.height - outer.height)))));
    }
    if (preferred.maximized) await window.maximize();
    active = mode;
  } finally { changing = false; }
}
/** Serialize rapid open/close transitions so late native resize replies cannot swap modes. */
export function setMainWindowMode(hasProject: boolean): Promise<void> {
  const task = queue.then(() => change(hasProject ? 'project' : 'welcome'));
  queue = task.catch(() => {});
  return task;
}
