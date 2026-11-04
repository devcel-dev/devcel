// Integration checks for the production redesign components and lifecycle coordinator.
// Native IPC, CSS extraction, and geometry are controlled boundaries. This does
// not claim browser layout/paint, OS window behavior, or backend persistence QA.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileImportUrl } = require("./file-import-url.cjs");
const { spawnSync } = require("node:child_process");
const scenario = process.argv[2];
if (!scenario) {
  let failed = false;
  for (const name of ["lifecycle", "row-label", "checkbox", "plugin-menu", "welcome-identity"]) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "devcel-redesign-check-"));
    try {
      const result = spawnSync(process.execPath, [__filename, name], {
        stdio: "inherit",
        env: { ...process.env, DEVCEL_REDESIGN_CHECK_TMP: work },
        timeout: 3e4
      });
      if (result.status !== 0) {
        failed = true;
        console.error(`FAIL ${name}`, result.error || result.status);
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  process.exit(failed ? 1 : 0);
}
if (scenario === "lifecycle") {
  const path2 = require("node:path");
  const assert = require("node:assert/strict");
  const studio = path2.resolve(__dirname, "..");
  const esbuild = require(path2.join(studio, "node_modules/esbuild"));
  (async () => {
    const listeners = /* @__PURE__ */ new Map();
    let project = { sessionId: "session-A", path: "/project", name: "Project" };
    global.__listen = async (event, handler) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    };
    global.__invoke = async (name) => {
      if (name === "get_plugin_projects") return project ? [project] : [];
      if (name === "get_table_list") return [];
      throw Error(name);
    };
    await esbuild.build({ absWorkingDir: studio, stdin: { contents: "export {PluginLifecycle} from './src/app/services/PluginLifecycle';", resolveDir: studio }, outfile: path2.join(process.env.DEVCEL_REDESIGN_CHECK_TMP, "lifecycle.cjs"), bundle: true, platform: "node", format: "cjs", plugins: [{ name: "native-boundary", setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, ({ path: path3 }) => ({ path: path3, namespace: "native" }));
      b.onLoad({ filter: /.*/, namespace: "native" }, ({ path: path3 }) => ({ contents: path3.endsWith("/core") ? "export const invoke=(...args)=>global.__invoke(...args);" : "export const listen=(...args)=>global.__listen(...args);" }));
    } }] });
    const { PluginLifecycle } = require(path2.join(process.env.DEVCEL_REDESIGN_CHECK_TMP, "lifecycle.cjs"));
    const calls = [];
    const manager = { setHasProject() {
    }, setActiveTable() {
    }, getAPI() {
      return { app: { getState: () => ({}) } };
    }, async dispatchLifecycle(hook, event, payload) {
      calls.push({ hook, event, sessionId: payload.sessionId });
    } };
    const life = new PluginLifecycle(manager);
    await life.start();
    listeners.get("project-opened")({ payload: { path: "/project" } });
    await life.refresh();
    assert.equal(calls.filter((c) => c.event === "project-opened").length, 1);
    assert.equal(calls.filter((c) => c.event === "project-closed").length, 0);
    listeners.get("project-closed")({ payload: {} });
    await life.refresh();
    assert.equal(calls.length, 1);
    project = { ...project, sessionId: "session-B" };
    listeners.get("project-opened")({ payload: { path: "/project" } });
    await life.refresh();
    assert.deepEqual(calls.map((c) => [c.event, c.sessionId]), [["project-opened", "session-A"], ["project-closed", "session-A"], ["project-opened", "session-B"]]);
    project = null;
    listeners.get("project-closed")({ payload: {} });
    await life.refresh();
    assert.equal(calls.at(-1).event, "project-closed");
    assert.equal(calls.at(-1).sessionId, "session-B");
    console.log("PASS same-session duplicate open/close; real A\u2192B; real close");
    life.stop();
  })();
}
if (scenario === "row-label") {
  const path2 = require("node:path");
  const assert = require("node:assert/strict");
  const studio = path2.resolve(__dirname, "..");
  const esbuild = require(path2.join(studio, "node_modules/esbuild"));
  (async () => {
    const { Window } = await import(fileImportUrl(path2.join(studio, "node_modules/happy-dom/lib/index.js")));
    const window = new Window({ url: "http://review.invalid" });
    for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "CSS", "localStorage", "Element", "DocumentFragment", "HTMLButtonElement", "NodeFilter", "PointerEvent", "FocusEvent"]) Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? window : window[name] });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.getComputedStyle = window.getComputedStyle.bind(window);
    globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
    globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    await esbuild.build({ absWorkingDir: studio, stdin: { contents: "export { InlineEditDialog } from './src/app/pages/main_window/project_view/table_view/components/DataGridInlineDialogs'; export * as React from 'react'; export {createRoot} from 'react-dom/client';", resolveDir: studio, loader: "tsx" }, outfile: path2.join(process.env.DEVCEL_REDESIGN_CHECK_TMP, "inline.cjs"), bundle: true, platform: "node", format: "cjs", jsx: "automatic", alias: { "@": path2.join(studio, "src") }, plugins: [{ name: "i18n", setup(b) {
      b.onResolve({ filter: /^@\/app\/i18n$/ }, () => ({ path: "i18n", namespace: "mock" }));
      b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export const t=k=>k;export const useI18n=()=>({t});export const localizeError=e=>String(e);" }));
    } }] });
    const { InlineEditDialog, React, createRoot } = require(path2.join(process.env.DEVCEL_REDESIGN_CHECK_TMP, "inline.cjs"));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let navigated = 0, saves = 0, fail = false, resolveSave;
    let open;
    function Harness() {
      const [shown, setOpen] = React.useState(true);
      open = setOpen;
      return React.createElement("div", null, React.createElement("button", { id: "external", onClick() {
        navigated++;
        setOpen(false);
      } }, "Navigate"), shown && React.createElement(InlineEditDialog, { isOpen: true, initialValue: "Original", position: { x: 0, y: 0 }, onSave: async () => {
        saves++;
        if (fail) throw Error("save rejected");
        await new Promise((r) => resolveSave = r);
        setOpen(false);
      }, onCancel: () => setOpen(false) }));
    }
    const act = React.act;
    const tick = () => act(async () => new Promise((r) => setTimeout(r, 20)));
    await act(async () => root.render(React.createElement(Harness)));
    await tick();
    const input = () => document.querySelector("[role=dialog] input");
    const dialog = () => document.querySelector("[role=dialog]");
    const edit = async () => act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input(), "Dirty");
      input().dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const confirm = () => document.body.textContent.includes("grid.saveRowLabelQuestion");
    const overlay = () => document.querySelector("[data-state=open].fixed.inset-0");
    const outside = async () => {
      assert(overlay());
      await act(async () => {
        const target = overlay();
        target.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
        target.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
        target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await tick();
    };
    const press = async (key) => act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    const button = (label) => [...dialog().querySelectorAll("button")].find((x) => x.textContent === label);
    const tap = async (label) => act(async () => button(label).click());
    assert.equal(document.body.style.pointerEvents, "none", "Radix blocks background pointer hits");
    await edit();
    await outside();
    assert(confirm());
    assert.equal(navigated, 0);
    assert(dialog());
    await press("Escape");
    assert(!confirm());
    assert.equal(input().value, "Dirty");
    await outside();
    await tap("common.cancel");
    assert(!confirm());
    assert.equal(input().value, "Dirty");
    await outside();
    await tap("grid.discardRowLabel");
    assert(!dialog());
    assert.equal(saves, 0);
    assert.equal(navigated, 0);
    await act(async () => open(true));
    await tick();
    await edit();
    fail = true;
    await tap("common.save");
    assert(dialog());
    assert.equal(input().value, "Dirty");
    assert(document.querySelector("[role=alert]").textContent.includes("save rejected"));
    fail = false;
    await tap("common.save");
    await outside();
    assert(dialog());
    assert.equal(saves, 2);
    assert(input().disabled);
    await act(async () => resolveSave());
    assert(!dialog());
    console.log("PASS Radix background pointer blockade; outside opens dirty confirm; Esc/Cancel keep draft; Discard closes without write; failed save preserves draft; pending save refuses outside dismissal; success closes. Synthetic DOM, not native hit-testing.");
    await act(async () => root.unmount());
    await window.happyDOM.close();
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
if (scenario === "checkbox") {
  const path2 = require("node:path");
  const assert = require("node:assert/strict");
  const studio = path2.resolve(__dirname, "..");
  const esbuild = require(path2.join(studio, "node_modules/esbuild"));
  (async () => {
    const { Window } = await import(fileImportUrl(path2.join(studio, "node_modules/happy-dom/lib/index.js")));
    const window = new Window({ url: "http://review.invalid", width: 1e3, height: 800 });
    for (const n of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLDivElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "CSS", "localStorage", "sessionStorage", "DOMRect", "NodeFilter", "DocumentFragment", "HTMLButtonElement"]) Object.defineProperty(globalThis, n, { configurable: true, value: n === "window" ? window : window[n] });
    for (const n of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) globalThis[n] = window[n].bind(window);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.ResizeObserver = globalThis.ResizeObserver = class {
      observe() {
      }
      unobserve() {
      }
      disconnect() {
      }
    };
    Object.defineProperties(window.HTMLElement.prototype, { clientWidth: { configurable: true, get() {
      return this.classList.contains("rdg") ? 440 : 900;
    } }, clientHeight: { configurable: true, get() {
      return this.classList.contains("rdg") ? parseFloat(this.style.height) || 140 : 500;
    } }, offsetWidth: { configurable: true, get() {
      return this.clientWidth;
    } }, offsetHeight: { configurable: true, get() {
      return this.clientHeight;
    } } });
    window.HTMLElement.prototype.getBoundingClientRect = function() {
      return new window.DOMRect(0, 0, this.clientWidth, this.clientHeight);
    };
    const nativeListeners = /* @__PURE__ */ new Map();
    global.__listen = async (e, h) => {
      if (!nativeListeners.has(e)) nativeListeners.set(e, /* @__PURE__ */ new Set());
      nativeListeners.get(e).add(h);
      return () => nativeListeners.get(e).delete(h);
    };
    const col = (uuid, type, width) => ({ min_version: 0, uuid, display_name: uuid, data_name: uuid, data_type: type, style: { width, color: "#ffffff", font_size: 12 }, read_only: false, default_value: "", tooltip: "", memo_text: "", tags: [] });
    let snapshot = { table: { uuid: "table", display_name: "Table", metadata: { interface_order: [],  initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, data_name: "Table"  }, schema: { columns: [col("bool", "Boolean", 60), col("text", "String", 180), col("num", "I32", 100)] }, records: [{ uuid: "row", label: "Row", values: { bool: "false", text: "Sample", num: "=1+41" }, interface_values: {}, min_version: 0 }], interface_implementations: {}, }, presentation: { table_uuid: "table", revision: "r0", cells: { row: { bool: { raw_value: "false", display_value: "false", style: {}, issues: [] }, text: { raw_value: "Sample", display_value: "Sample", style: { background_color: "#123456" }, issues: [] }, num: { raw_value: "=1+41", display_value: "42", style: {}, issues: [] } } }, definition_issues: [], issue_count: 1 } };
    let releaseMutation, releaseRefresh;
    let refreshGate = false, failNextRead = false;
    const calls = [];
    global.__invoke = async (name, args) => {
      calls.push(name);
      if (name === "get_interfaces") return "[]";
      if (name === "prepare_table_rule_snapshot") return "redesign-evaluation";
      if (name === "cancel_table_rule_snapshot") return false;
      if (name === "get_table_rule_snapshot") {
        if (failNextRead) {
          failNextRead = false;
          throw Error("snapshot read failed");
        }
        const response = args.knownSnapshotToken === snapshot.presentation.revision
          ? { kind: "unchanged", snapshot_token: args.knownSnapshotToken, retained_bytes: 1024 }
          : { kind: "snapshot", snapshot_token: snapshot.presentation.revision, retained_bytes: 1024, ...snapshot };
        if (refreshGate) {
          await new Promise((r) => releaseRefresh = r);
        }
        return response;
      }
      if (name === "apply_table_mutation") {
        await new Promise((r) => releaseMutation = r);
        snapshot = structuredClone(snapshot);
        snapshot.table.records[0].values.bool = "true";
        snapshot.presentation.revision = "r1";
        snapshot.presentation.cells.row.bool = { ...snapshot.presentation.cells.row.bool, raw_value: "true", display_value: "true" };
        return snapshot;
      }
      throw Error(name);
    };
    const mocks = {
      "@/app/settings": `export const getSettingsSnapshot=()=>({appVersion:"0.1.0",bundle:{values:{color32Display:"srgb",colorFloatDisplay:"linear"}},warning:null});export const refreshAppSettings=async()=>getSettingsSnapshot();export const subscribeSettings=()=>()=>{};export const useAppSettings=getSettingsSnapshot;`,
      "@/app/i18n": `export { getLocaleName, translatePluginMessage, appErrorException } from ${JSON.stringify(path2.join(studio, "src/app/i18n/index.ts"))}; export const t=k=>k;export const useI18n=()=>({t,locale:'ja'});export const localizeError=e=>String(e);export const resolveMessage=v=>v.key;export const message=(key,values)=>({key,values});export const localizedError=e=>new Error(e.key);export const formatNumber=v=>String(v);export const getLocaleDirection=()=> 'ltr';`,
      "@tauri-apps/api/core": `export const isTauri=()=>false;export const invoke=(...a)=>global.__invoke(...a);`,
      "@tauri-apps/api/event": `export const listen=(...a)=>global.__listen(...a);export const emitTo=async()=>{};`,
      "@/app/components/column-editor/ColumnEditor": `export const ColumnEditor=()=>null;`,
      "./DataGridContextMenu": `export const DataGridContextMenu=()=>null;`,
      "./ReferenceCell": `export const ReferenceCellRenderer=()=>null;export const ReferenceCellEditor=()=>null;`,
      "./TableRefCell": `export const TableRefCellRenderer=()=>null;export const TableRefCellEditor=()=>null;`,
      "./CurveCell": `export const CurveCellRenderer=()=>null;export const CurveCellEditor=()=>null;`,
      "@/app/components/interface/InterfaceDialog": `export const InterfaceDialog=()=>null;`,
      "@/app/utils/bulk_row_dialog": `export const showBulkRowDialog=async()=>null;`,
      "@/app/utils/table_rule_dialogs": `export const confirmInputWarnings=async()=>false;`,
      "@linaria/core": `export const css=()=> 'synthetic';`
    };
    await esbuild.build({ absWorkingDir: studio, stdin: { contents: "export {default as Grid} from './src/app/pages/main_window/project_view/table_view/components/DataGridView';export * as React from 'react';export {createRoot} from 'react-dom/client';", resolveDir: studio }, outfile: path2.join(process.env.DEVCEL_REDESIGN_CHECK_TMP, "grid.cjs"), bundle: true, platform: "node", format: "cjs", jsx: "automatic", define: { "import.meta.env.DEV": "false" }, alias: { "@": path2.join(studio, "src") }, plugins: [{ name: "boundaries", setup(b) {
      b.onResolve({ filter: /.*/ }, ({ path: path3, resolveDir }) => {
        // Relative imports reach the same controlled settings boundary as its alias.
        if (path3.startsWith('.') && path2.resolve(resolveDir, path3).replace(/\\/g, '/').replace(/\/index(?:\.ts)?$/, '') === path2.join(studio, 'src/app/settings').replace(/\\/g, '/'))
          return { path: '@/app/settings', namespace: 'mock' };
        if (mocks[path3]) return { path: path3, namespace: "mock" };
        if (path3.endsWith(".css")) return { path: path3, namespace: "css" };
      });
      b.onLoad({ filter: /.*/, namespace: "mock" }, ({ path: path3 }) => ({ contents: mocks[path3], resolveDir: studio }));
      b.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "" }));
    } }] });
    const { Grid, React, createRoot } = require(path2.join(process.env.DEVCEL_REDESIGN_CHECK_TMP, "grid.cjs"));
    const act = React.act;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let frames = [];
    const inspect = () => ({ tracks: host.querySelector(".rdg")?.style.gridTemplateColumns, height: host.querySelector(".rdg")?.style.height, num: host.querySelector('[data-column-index="3"][data-row-index="0"]')?.textContent, color: host.querySelector('[data-column-index="2"][data-row-index="0"]')?.style.backgroundColor, warning: host.textContent.includes("grid.inputIssueCount"), checked: host.querySelector("input[type=checkbox]")?.checked, disabled: host.querySelector("input[type=checkbox]")?.disabled });
    let switchWorld;
    function Harness() {
      const [table, setTable] = React.useState(snapshot.table);
      const [session, setSession] = React.useState("session-A");
      switchWorld = (next2, nextSession) => {
        snapshot = next2;
        setSession(nextSession);
        setTable(next2.table);
      };
      return React.createElement(React.Profiler, { id: "probe", onRender() {
        frames.push(inspect());
      } }, React.createElement(Grid, { projectSessionId: session, tableData: table, tableName: "Table", onDataChange: setTable }));
    }
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    const baseline = inspect();
    assert.equal(baseline.num, "42");
    assert.equal(baseline.warning, true);
    assert.equal(baseline.disabled, false);
    frames = [];
    const checkbox = host.querySelector("input[type=checkbox]");
    await act(async () => checkbox.click());
    assert.equal(inspect().disabled, true);
    assert.equal(inspect().tracks, baseline.tracks);
    await act(async () => {
      for (const h of nativeListeners.get("p2p-data-changed") || []) h({ payload: { project_session: "session-A", table_uuid: "table" } });
    });
    refreshGate = true;
    await act(async () => releaseMutation());
    const pending = inspect();
    assert.equal(pending.disabled, true, "stale presentation must not become editable");
    assert.equal(pending.num, baseline.num, "retain evaluated formula while refreshing");
    assert.equal(pending.color, baseline.color, "retain conditional color");
    assert.equal(pending.warning, true, "retain layout-affecting warning");
    assert.equal(pending.tracks, baseline.tracks);
    assert.equal(pending.height, baseline.height);
    assert.equal(checkbox, host.querySelector("input[type=checkbox]"), "checkbox DOM identity stays stable");
    const writes = calls.filter((name) => name === "apply_table_mutation").length;
    await act(async () => checkbox.click());
    assert.equal(calls.filter((name) => name === "apply_table_mutation").length, writes, "disabled checkbox cannot write against stale revision");
    await act(async () => releaseRefresh());
    const complete = inspect();
    assert.equal(complete.checked, true);
    assert.equal(complete.disabled, false);
    for (const frame of frames) {
      assert.equal(frame.tracks, baseline.tracks);
      assert.equal(frame.height, baseline.height);
      assert.equal(frame.num, baseline.num);
      assert.equal(frame.color, baseline.color);
      assert.equal(frame.warning, true);
    }
    console.log("PASS checkbox mutation/P2P refresh retains grid tracks, formula result, conditional styling, validation banner, DOM identity; write gate stays closed until fresh revision");
    refreshGate = false;
    failNextRead = true;
    await act(async () => {
      for (const listener of nativeListeners.get("p2p-data-changed") || []) listener({ payload: { project_session: "session-A", table_uuid: "table" } });
    });
    assert.equal(inspect().num, "42");
    assert.equal(inspect().warning, true);
    assert.equal(inspect().disabled, true);
    assert(host.querySelector("[role=alert]"), "read failure remains visible");
    await act(async () => {
      for (const listener of nativeListeners.get("p2p-data-changed") || []) listener({ payload: { project_session: "session-A", table_uuid: "table" } });
    });
    assert.equal(inspect().disabled, false, "only successful retry restores edit token");
    refreshGate = true;
    await act(async () => {
      for (const listener of nativeListeners.get("p2p-data-changed") || []) listener({ payload: { project_session: "session-A", table_uuid: "table" } });
    });
    const releaseOldSession = releaseRefresh;
    const next = structuredClone(snapshot);
    next.table.uuid = "table-B";
    next.presentation.table_uuid = "table-B";
    next.presentation.revision = "rB";
    next.table.records[0].values.num = "=2+82";
    next.presentation.cells.row.num.display_value = "84";
    next.presentation.cells.row.text.style.background_color = "#654321";
    await act(async () => switchWorld(next, "session-B"));
    assert.equal(inspect().disabled, true);
    assert.notEqual(inspect().num, "42", "previous session presentation must not leak");
    refreshGate = false;
    await act(async () => releaseOldSession());
    assert.equal(inspect().num, "84");
    assert.equal(inspect().color, "#654321");
    assert.equal(inspect().disabled, false);
    console.log("PASS failed refresh preserves display but blocks writes; successful retry restores readiness; late old-session null cannot restore an obsolete presentation");
    await act(async () => root.unmount());
    await window.happyDOM.close();
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
if (scenario === "plugin-menu") {
  const assert = require("node:assert/strict");
  const studio = path.resolve(__dirname, "..");
  const esbuild = require(path.join(studio, "node_modules/esbuild"));
  (async () => {
    const emitted = [], invoked = [];
    global.window = { dispatchEvent: (event) => emitted.push(event.detail) };
    global.CustomEvent = class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    };
    const output = path.join(process.env.DEVCEL_REDESIGN_CHECK_TMP, "menus.cjs");
    await esbuild.build({
      absWorkingDir: studio,
      stdin: { contents: "export { getPluginMenuGroup } from './src/app/config/pluginMenus';", resolveDir: studio },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: output,
      plugins: [{ name: "ui-boundaries", setup(builder) {
        builder.onResolve({ filter: /^@\/app\/(i18n|components\/plugins\/PluginExtensions)$/ }, ({ path: module }) => ({ path: module, namespace: "boundary" }));
        builder.onLoad({ filter: /.*/, namespace: "boundary" }, ({ path: module }) => ({ contents: module.endsWith("/i18n") ? "export const t = key => key;" : "export const pluginPredicate = predicate => predicate ? predicate() : true;" }));
      } }]
    });
    const { getPluginMenuGroup } = require(output);
    const contributions = { toolbarButtons: [], dialogs: [], themes: [], importers: [], dataProcessors: [] };
    const activePlugins = /* @__PURE__ */ new Map(), menus = /* @__PURE__ */ new Map();
    let enabled = true;
    for (const id of ["owner", "owner:second"]) {
      const extensions = { menus: { tools: { groups: [] } }, toolbarButtons: [
        { id: "button" },
        { id: "hidden" },
        { id: "disabled" }
      ] };
      for (const key of ["dialogs", "themes", "importers", "dataProcessors"]) {
        extensions[key] = [{ id: key }];
        contributions[key].push({ id: `${id}:${key}`, name: `${id}:${key}`, title: `${id}:${key}` });
      }
      contributions.toolbarButtons.push(
        { id: `${id}:button`, label: `${id}:button`, isEnabled: () => enabled, onClick: () => invoked.push(`${id}:button`) },
        { id: `${id}:hidden`, label: `${id}:hidden`, isVisible: () => false, onClick: () => assert.fail("hidden action ran") },
        { id: `${id}:disabled`, label: `${id}:disabled`, isEnabled: () => false, onClick: () => assert.fail("disabled action ran") }
      );
      activePlugins.set(id, { status: "active", plugin: { metadata: { name: id }, extensions } });
      menus.set(`${id}:tools`, { groups: [{ id: "group", label: id, actions: [{ label: `${id}:menu`, onClick: () => invoked.push(`${id}:menu`) }] }] });
    }
    activePlugins.set("inactive", { status: "inactive", plugin: { metadata: { name: "inactive" }, extensions: {} } });
    const result = getPluginMenuGroup(activePlugins, menus, "Plugins", (action) => action(), contributions);
    assert.deepEqual(result.submenus.map((menu) => menu.id), ["owner", "owner:second"]);
    for (const menu of result.submenus) {
      const actions = menu.groups.flatMap((group) => group.actions);
      const action = (label) => actions.find((item) => item.label === label);
      assert(!action(`${menu.id}:hidden`));
      assert(action(`${menu.id}:disabled`).disabled);
      await action(`${menu.id}:menu`).onClick();
      await action(`${menu.id}:button`).onClick();
      enabled = false;
      await action(`${menu.id}:button`).onClick();
      enabled = true;
      await action(`${menu.id}:disabled`).onClick();
      for (const key of ["dialogs", "importers", "dataProcessors"]) await action(`${menu.id}:${key}`).onClick();
      assert(!action(`${menu.id}:themes`));
      assert(!action("plugin.extensions.defaultTheme"));
    }
    assert.deepEqual(invoked, ["owner:menu", "owner:button", "owner:second:menu", "owner:second:button"]);
    assert.deepEqual(emitted, ["owner", "owner:second"].flatMap((id) => [
      { kind: "page", id: `${id}:dialogs` },
      { kind: "import", id: `${id}:importers` },
      { kind: "process", id: `${id}:dataProcessors` }
    ]));
    console.log("PASS plugin menu retains owner-scoped menu/button/page/dialog/import/processor actions without separate theme selection; inactive/hidden/disabled actions stay gated");
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

if (scenario === "welcome-identity") {
  const assert = require("node:assert/strict");
  const studio = path.resolve(__dirname, "..");
  const { build } = require(path.join(studio, "node_modules/esbuild"));
  const { Window } = require(path.join(studio, "node_modules/happy-dom"));
  const window = new Window();
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node"])
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : window[key] });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__welcomeMounts = 0; globalThis.__welcomeUnmounts = 0;
  globalThis.__welcomeLocale = "en"; globalThis.__welcomeLocaleListeners = new Set();
  globalThis.__welcomeActions = [];
  (async () => {
    const outfile = path.join(process.env.DEVCEL_REDESIGN_CHECK_TMP, "welcome.cjs");
    await build({ stdin: { contents: `export {default as WelcomeView} from './src/app/pages/main_window/welcome_view/WelcomeView';export * as React from 'react';export {createRoot} from 'react-dom/client';`, resolveDir: studio },
      outfile, bundle: true, format: "cjs", platform: "node", jsx: "automatic", define: { "import.meta.env.DEV": "false" }, alias: { "@": path.join(studio, "src") }, plugins: [{ name: "welcome-boundaries", setup(b) {
        const mocks = {
          "@/app/i18n": `import {useSyncExternalStore} from 'react';export const t=key=>key+':'+globalThis.__welcomeLocale;export const useI18n=()=>useSyncExternalStore(cb=>{globalThis.__welcomeLocaleListeners.add(cb);return()=>globalThis.__welcomeLocaleListeners.delete(cb)},()=>globalThis.__welcomeLocale);`,
          "@/app/pages/main_window/MainWindow": `export const handleOpenProject=props=>globalThis.__welcomeActions.push(['open',props.projectName]);export const handleCreateProject=props=>globalThis.__welcomeActions.push(['create',props.projectName]);`,
          "@/components/ui/button": `import React from 'react';export const Button=props=>React.createElement('button',props);`,
          "lucide-react": `export const FolderPlus=()=>null,FolderOpen=()=>null;`,
          "./backgrounds": `import React,{useEffect} from 'react';export default function Background(){useEffect(()=>{globalThis.__welcomeMounts++;return()=>globalThis.__welcomeUnmounts++},[]);return React.createElement('canvas',{'data-background':true})}`,
        };
        b.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: "mock" } : undefined);
        b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: mocks[args.path], resolveDir: studio }));
      }}] });
    const { WelcomeView, React, createRoot } = require(outfile);
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const render = props => React.act(async () => root.render(React.createElement(WelcomeView, props)));
    await render({ isOpenWizard: false, projectName: "initial" });
    const canvas = host.querySelector("canvas");
    // Permission polling/settings refreshes rerender the parent without navigation.
    for (let i = 0; i < 15; i++) await render({ isOpenWizard: false, projectName: `refresh-${i}` });
    await React.act(async () => { globalThis.__welcomeLocale = "ja"; for (const callback of globalThis.__welcomeLocaleListeners) callback(); });
    assert.equal(globalThis.__welcomeMounts, 1); assert.equal(globalThis.__welcomeUnmounts, 0);
    assert.equal(host.querySelector("canvas"), canvas, "unchanged welcome keeps its renderer identity");
    assert(host.textContent.includes("menu.openProject:ja"), "locale updates still render");
    await React.act(async () => host.querySelectorAll("button")[1].click());
    assert.deepEqual(globalThis.__welcomeActions, [["open", "refresh-14"]], "handlers use current props");
    await render({ isOpenWizard: true });
    assert.equal(host.textContent, ""); assert.equal(host.querySelector("canvas"), null);
    assert.equal(globalThis.__welcomeUnmounts, 1);
    await render({ isOpenWizard: false });
    assert(host.textContent.includes("menu.openProject:ja")); assert(host.querySelector("canvas"));
    assert.equal(globalThis.__welcomeMounts, 2, "cancel recreates only the deliberately hidden background");
    await React.act(async () => root.unmount()); await window.happyDOM.abort();
    console.log("PASS welcome preserves background identity across 15 parent refreshes and locale changes; picker hide/cancel restore works. Canvas boundary is controlled, not native WebGL QA.");
    process.exit(0);
  })().catch(error => { console.error(error); process.exit(1); });
}
