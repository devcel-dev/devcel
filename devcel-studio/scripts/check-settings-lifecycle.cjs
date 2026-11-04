// Real React/Radix lifecycle regressions. Native IPC and window destruction are explicit boundaries.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { fileImportUrl } = require("./file-import-url.cjs");
const root = path.resolve(__dirname, "..");
const dep = Module.createRequire(path.join(root, "package.json"));
const { compileModule } = dep("./scripts/compile-module.cjs");
const i18n = { t: (key) => key, useI18n: () => ({ t: (key) => key }), localizeError: (e) => String(e || ""), message: (key) => key, resolveMessage: (value) => value, formatNumber: String };
const formulaModules = new Map();
function formulaModule(relative) {
  if (!formulaModules.has(relative)) formulaModules.set(relative, load(relative, {
    '@tauri-apps/api/core': { invoke: async () => ({ functions: ['SUM'], table: null }) },
    '@/app/commands/tableCommands': { getTableCatalog: async () => [] },
    '@/app/services/tableSnapshotInvalidation': { retainTableSnapshotInvalidation: () => ({ ready: Promise.resolve(), release() {} }) }
  }));
  return formulaModules.get(relative);
}
function load(relative, mocks = {}) {
  const filename = path.join(root, relative);
  const mod = new Module(filename);
  mod.paths = Module._nodeModulePaths(root);
  mod.require = (id) => Object.hasOwn(mocks, id) ? mocks[id] :
    id.startsWith('@/app/components/formula/') || id.startsWith('@/app/utils/formula') ? formulaModule(id.replace('@/', 'src/') + (id.includes('/components/') ? '.tsx' : '.ts')) :
    relative.includes('/formula/') && id.startsWith('./') ? formulaModule(path.posix.join(path.posix.dirname(relative), id + '.tsx')) :
    id === './formulaTokens' ? formulaModule('src/app/utils/formulaTokens.ts') :  id === "@/app/utils/useSettingsCloseGuard" ? load("src/app/utils/useSettingsCloseGuard.ts") : id === "./previewDisplayLabels" ? load("src/app/components/column-editor/previewDisplayLabels.ts") : id === "@/app/types/tableTypes" ? load("src/app/types/tableTypes.ts") : id === "@/app/utils/errorRecovery" ? load("src/app/utils/errorRecovery.ts") : id === "@/app/i18n" ? i18n : id === "@/app/config/brand" ? { DEFAULT_PROJECT_HEADER_COLOR: "#242A30" } : id.endsWith(".css") ? {} : id.startsWith("@/") ? {} : dep(id);
  mod._compile(compileModule(fs.readFileSync(filename, "utf8"), filename), filename);
  return mod.exports;
}
(async () => {
  const { Window } = await import(fileImportUrl(dep.resolve("happy-dom")));
  const win = new Window({ url: "http://review.invalid" });
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "DOMRect", "CustomEvent", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "CompositionEvent", "MutationObserver"]) Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? win : win[name] });
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const consoleErrors = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => consoleErrors.push(args.join(" "));
  console.warn = (...args) => consoleErrors.push(args.join(" "));
  const React = dep("react");
  const { createRoot } = dep("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  let mounted;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const render = async (component) => React.act(async () => {
    if (!mounted) mounted = createRoot(host);
    mounted.render(React.createElement(React.StrictMode, null, component));
    await tick();
  });
  const unmount = async () => React.act(async () => {
    mounted.unmount();
    mounted = null;
    await tick();
  });
  const click = async (element) => React.act(async () => {
    assert(element);
    element.click();
    await tick();
  });
  const button = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent === text);
  const input = async (element, value) => React.act(async () => {
    const proto = element instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
  });
  const Button = ({ variant, ...props }) => React.createElement("button", props);
  const Input = (props) => React.createElement("input", props);
  const Label = (props) => React.createElement("label", props);
  let session = "A", failLoad = false, failSave = false, projectWrites = 0, destroyed = 0, nativeClose;
  const projectValues = [];
  const events = /* @__PURE__ */ new Map();
  const project = load("src/app/pages/project_edit_dialog/ProjectEditDialog.tsx", { "@/app/components/tags/ProjectTagPresets": { ProjectTagPresets: () => null }, "@/app/components/color/ColorField": { ColorField: ({ value, onChange, disabled }) => React.createElement("input", { "data-project-color": true, defaultValue: value, disabled, onBlur: event => onChange(event.target.value) }) }, "@/components/ui/button": { Button }, "@/components/ui/input": { Input }, "@/components/ui/label": { Label }, "@/app/commands/projectCommands": { getProjectInfo: async () => {
    if (failLoad) throw Error("load failed");
    return { name: "Example", description: "", headerColor: "#242A30", path: "/p", sessionId: "A" };
  }, getProjectSession: async () => ({ id: session }), updateProjectInfo: async (description, headerColor, sessionId) => {
    projectValues.push({ description, headerColor, sessionId });
    projectWrites++;
    if (failSave) throw Error("write rejected");
  } }, "@tauri-apps/api/webviewWindow": { getCurrentWebviewWindow: () => ({ onCloseRequested: async (cb) => {
    nativeClose = cb;
    return () => {
    };
  }, destroy: async () => {
    destroyed++;
  } }) }, "@tauri-apps/api/event": { listen: async (name, cb) => {
    events.set(name, cb);
    return () => {
    };
  }, emit: async () => {
  } } });
  const interaction = load("src/app/services/tableInteractionScope.ts");
  let closed = 0, ipc = [], rejectPreview = false;
  const nativeGuards = /* @__PURE__ */ new Map();
  const registerNative = (fn, priority = 0) => {
    nativeGuards.set(fn, priority);
    return () => nativeGuards.delete(fn);
  };
  const nativeAllow = async () => {
    for (const [fn] of [...nativeGuards].sort((a, b) => b[1] - a[1])) if (!await fn()) return false;
    return true;
  };
  const ruleDialog = load("src/app/components/column-editor/RuleEditorDialog.tsx", { "@/app/services/tableInteractionScope": interaction, "@/app/utils/string_editor_window": { registerMainWindowCloseBlocker: registerNative } });
  const inputRules = load("src/app/components/column-editor/InputValidationEditor.tsx", { "./RuleEditorDialog": ruleDialog });
  const formatting = load("src/app/components/column-editor/ConditionalFormattingEditor.tsx", { "./RuleEditorDialog": ruleDialog });
  const original = { uuid: "column", data_name: "attack", display_name: "attack", data_type: "I32", read_only: false, input_validation: { mode: "reject", message: "", hint: "", rules: [{ kind: "pattern", pattern: "old" }] } };
  const store = /* @__PURE__ */ new Map();
  const editor = load("src/app/components/column-editor/ColumnEditor.tsx", { "@/app/utils/validation": load("src/app/utils/validation.ts"), "@/app/settings/displayLabels": { settingsDisplayLabel: (_id, name) => name }, "@/components/ui/switch": { Switch: () => null }, "@/app/components/tags/TagSelector": { TagSelector: () => null }, "./ColumnColorSwatches": { ColumnColorSwatches: () => null }, "@/app/components/color/ColorField": { ColorField: () => null }, "@/app/components/color/colorDisplay": { isColorType: () => false }, "@/app/services/tableInteractionScope": interaction, "@/app/utils/string_editor_window": { registerMainWindowCloseBlocker: registerNative }, "@/app/utils/columnDraftLifecycle": { columnDraftStore: { read: (key) => store.get(key) ?? null, write: (key, value) => store.set(key, value), remove: (key) => store.delete(key) } }, "@/app/utils/table_rule_dialogs": { confirmInputWarnings: async () => true }, "@/app/types/tableRules": { inputValidationReport: () => null }, "@tauri-apps/api/core": { invoke: async (command, args) => {
    ipc.push({ command, args });
    if (command === "load_column_editor") return { target: args.target, column: original, name: "Example", revision: "1", interface_owned: false };
    if (command === "preview_column_editor") return { errors: rejectPreview ? ["invalid rule"] : [], error_count: rejectPreview ? 1 : 0, input_reports: [], samples: [], total_values: 0, changed_count: 0, empty_count: 0 };
    if (command === "save_column_editor") { assert.equal(args.request.draft.min_version, "0", "omitted column version restores zero"); return { column_uuid: "column" }; }
    throw Error(command);
  } }, "@tauri-apps/api/event": { emit: async () => {
  } }, "@tauri-apps/api/webviewWindow": { getCurrentWebviewWindow: () => ({ close: async () => {
  } }) }, "./ColumnTypePicker": { ColumnTypePicker: React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({ cancel: () => false }));
    return null;
  }) }, "./InputValidationEditor": inputRules, "./ConditionalFormattingEditor": formatting, "./RulePreview": { RulePreview: () => null } });
  let allowed;
  async function mountColumn(mode = "table", columnUuid = "column") {
    closed = 0;
    ipc = [];
    store.clear();
    await render(React.createElement(editor.ColumnEditor, { target: { mode, target_uuid: mode, column_uuid: columnUuid }, expectedProjectSession: "project", onClose: () => closed++ }));
  }
  async function editExistingRule() {
    await click(button("column.inputRules"));
    await click(document.querySelector(".input-rule-row .rule-summary-button"));
    await input(document.querySelector('input[id$="-pattern"]'), "new pattern");
  }
  await mountColumn();
  await editExistingRule();
  await React.act(async () => {
    allowed = await nativeAllow();
    await tick();
  });
  assert.equal(allowed, true);
  assert.equal(closed, 1);
  assert.equal(ipc.filter((c) => c.command === "save_column_editor").length, 0);
  console.log("PASS native close discards parent and child column drafts without persistence");
  await unmount();
  await mountColumn();
  await editExistingRule();
  await React.act(async () => {
    allowed = await interaction.tableEditorsAllowNavigation();
    await tick();
  });
  assert.equal(allowed, true);
  assert.equal(closed, 1);
  assert.equal(ipc.filter((c) => c.command === "save_column_editor").length, 0);
  console.log("PASS navigation discards parent and child column drafts without persistence");
  await unmount();
  await mountColumn();
  await editExistingRule();
  await React.act(async () => {
    const results = await Promise.all([nativeAllow(), interaction.tableEditorsAllowNavigation()]);
    assert.deepEqual(results, [true, true]);
    await tick();
  });
  assert.equal(closed, 1);
  assert.equal(ipc.filter((c) => c.command === "save_column_editor").length, 0);
  console.log("PASS simultaneous native close/navigation discards only once without saving");
  await unmount();
  await mountColumn();
  await editExistingRule();
  await click(button("common.close")); // Commit the child only to the parent draft.
  assert.equal(ipc.filter((c) => c.command === "save_column_editor").length, 0);
  rejectPreview = true;
  await click(button("common.save"));
  assert.equal(closed, 0);
  assert.equal(ipc.filter((c) => c.command === "save_column_editor").length, 0);
  assert(document.querySelector("[role=alert]"));
  assert.equal(JSON.parse([...store.values()][0]).draft.input_validation.rules[0].pattern, "new pattern");
  rejectPreview = false;
  await click(button("common.save"));
  assert.equal(closed, 1);
  assert.equal(ipc.filter((c) => c.command === "save_column_editor").length, 1);
  assert.equal(ipc.find((c) => c.command === "save_column_editor").args.request.draft.input_validation.rules[0].pattern, "new pattern");
  console.log("PASS rejected child rule remains in parent draft and a later explicit retry saves it");
  await unmount();
  await mountColumn();
  await click(button("column.inputRules"));
  await React.act(async () => {
    const select = document.querySelector('select[id$="-rule-kind"]');
    select.value = "pattern";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
  });
  await click(button("rules.add"));
  await input(document.querySelector('input[id$="-pattern"]'), "new unsaved rule");
  await click([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === "common.cancel"));
  assert.equal(Boolean(document.querySelector("[role=dialog]")), false, "child Cancel closes the child dialog");
  assert.equal(document.querySelectorAll(".input-rule-row").length, 1);
  assert.equal(ipc.filter((c) => c.command === "save_column_editor").length, 0);
  console.log("PASS new-rule Cancel never adds the draft to its owner");
  await unmount();
  let applied = 0, cancelled = 0;
  await render(React.createElement(ruleDialog.RuleEditorDialog, { title: "Rule", applyOnClose: true, busy: true, disabled: true, onApply: () => applied++, onClose: () => cancelled++ }, React.createElement("input", { defaultValue: "draft" })));
  await click(button("common.close"));
  await React.act(async () => {
    assert.equal(await nativeAllow(), false);
    assert.equal(await interaction.tableEditorsAllowNavigation(), false);
  });
  assert.equal(applied, 0);
  assert.equal(cancelled, 0);
  console.log("PASS busy existing rule cannot be silently cancelled");
  await unmount();
  session = "A";
  failLoad = false;
  destroyed = 0;
  await render(React.createElement(project.ProjectEditDialog));
  session = "B";
  await React.act(async () => {
    events.get("project-opened")();
    await tick();
  });
  await click(button("common.close"));
  assert.equal(destroyed, 1);
  await React.act(async () => {
    nativeClose({ preventDefault() {
    } });
    await tick();
  });
  assert.equal(destroyed, 2);
  console.log("PASS stale unchanged project closes by button/native X");
  await unmount();
  session = "A";
  failLoad = true;
  destroyed = 0;
  await render(React.createElement(project.ProjectEditDialog));
  await click(button("common.close"));
  assert.equal(destroyed, 1);
  await React.act(async () => {
    nativeClose({ preventDefault() {
    } });
    await tick();
  });
  assert.equal(destroyed, 2);
  console.log("PASS failed project load can close by button/native X");
  await unmount();
  session = "A";
  failLoad = false;
  destroyed = 0;
  await render(React.createElement(project.ProjectEditDialog));
  await input(document.querySelector("textarea"), "keep me");
  session = "B";
  await React.act(async () => {
    events.get("project-opened")();
    await tick();
  });
  await click(button("common.close"));
  assert.equal(destroyed, 0);
  assert.equal(document.querySelector("textarea").value, "keep me");
  await click(button("column.discardAndClose"));
  assert.equal(destroyed, 1);
  console.log("PASS stale changed project remains visible until explicit discard");
  await unmount();
  session = "A";
  failLoad = false;
  failSave = true;
  projectWrites = 0;
  destroyed = 0;
  await render(React.createElement(project.ProjectEditDialog));
  await input(document.querySelector("textarea"), "retain rejected project edit");
  await click(button("common.close"));
  assert.equal(projectWrites, 1);
  assert.equal(destroyed, 0);
  assert.equal(document.querySelector("textarea").value, "retain rejected project edit");
  assert(document.querySelector("[role=alert]"));
  failSave = false;
  await click(button("common.close"));
  assert.equal(projectWrites, 2);
  assert.equal(destroyed, 1);
  console.log("PASS failed project save retains its draft and Close retries explicitly");
  await unmount();
  await mountColumn("interface");
  await input(document.querySelector('input[id$="-name"]'), "changed interface field");
  await React.act(async () => {
    allowed = await interaction.tableEditorsAllowNavigation();
    await tick();
  });
  assert.equal(allowed, true);
  assert.equal(closed, 1);
  assert.equal(ipc.filter((c) => c.command === "save_column_editor").length, 0);
  console.log("PASS interface navigation discards dirty field without saving");
  await unmount();
  const dialogUi = load("src/components/ui/dialog.tsx", { "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") } });
  const settingsDraft = load("src/app/utils/settingsDraftLifecycle.ts");
  const tableSettings = load("src/app/pages/main_window/project_view/table_view/components/TableEditSettingsDialog.tsx", {
    "@/components/ui/dialog": dialogUi,
    "@/components/ui/switch": { Switch: ({ checked, onCheckedChange, ...props }) => React.createElement("input", { ...props, type: "checkbox", checked, onChange: event => onCheckedChange(event.target.checked) }) },
    "@/app/settings/displayLabels": { settingsDisplayLabel: (_id, name) => name },
    "@/app/utils/settingsDraftLifecycle": settingsDraft,
    "@/app/services/tableInteractionScope": interaction,
    "@/app/utils/string_editor_window": { registerMainWindowCloseBlocker: registerNative },
  });
  let tableClosed = 0, interfacesOpened = 0, tableSaves = 0, finishTableSave;
  const tableSave = new Promise(resolve => { finishTableSave = resolve; });
  const tableOwner = { revision: "1", table: { description: "", uuid: "table", display_name: "Example", metadata: { interface_order: [],  initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }  } } };
  function TableHarness() {
    const [visible, setVisible] = React.useState(true);
    return visible ? React.createElement(tableSettings.TableEditSettingsDialog, {
      owner: tableOwner, busy: false, error: "",
      onClose: () => { tableClosed++; setVisible(false); },
      onSave: async () => { tableSaves++; await tableSave; return true; },
      onOpenInterfaces: () => { interfacesOpened++; },
    }) : null;
  }
  await render(React.createElement(TableHarness));
  await input(document.querySelector("input:not([type=radio])"), "apply before closing");
  await click(document.querySelector('button[title="grid.interfaceActions"]'));
  await click(button("common.close"));
  assert.equal(tableSaves, 1);
  assert.equal(tableClosed, 0);
  await React.act(async () => { finishTableSave(); await tick(); });
  assert.equal(tableClosed, 1);
  assert.equal(interfacesOpened, 0);
  assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
  console.log("PASS X supersedes pending Interfaces save without reopening its child");
  await unmount();

  const formattingEvents = [];
  let setFormattingBusy;
  function FormattingHarness() {
    const [busy, setBusy] = React.useState(false); setFormattingBusy = setBusy;
    return React.createElement(formatting.ConditionalFormattingEditor, {
      value: null, baseValue: { rules: [] }, inherited: true, canOverride: true, disabled: busy,
      onNewRule: async () => undefined, onChange: value => formattingEvents.push(["apply", value]),
      onOpenOrigin: () => formattingEvents.push(["origin"]),
    });
  }
  await render(React.createElement(FormattingHarness));
  await click(document.querySelector(".rule-settings-row"));
  await React.act(async () => { const select = document.querySelector('select[id$="-source"]'); select.value = "off"; select.dispatchEvent(new Event("change", { bubbles: true })); await tick(); });
  await click(button("column.viewOrigin"));
  assert.deepEqual(formattingEvents, [["apply", { rules: [] }], ["origin"]]);
  assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
  console.log("PASS formatting origin navigation applies its edited scope before leaving");
  await click(document.querySelector(".rule-settings-row"));
  await React.act(async () => { setFormattingBusy(true); await tick(); });
  assert.equal(button("column.viewOrigin").disabled, true);
  assert.equal(button("common.close").disabled, true);
  assert.equal(await nativeAllow(), false);
  assert(document.querySelector('[role="dialog"]'));
  assert.equal(formattingEvents.length, 2);
  console.log("PASS busy formatting settings cannot discard draft through origin or close");
  await unmount();

  const beginComposition = async (element, partial) => {
    await React.act(async () => {
      element.focus();
      element.dispatchEvent(new win.CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    });
    await input(element, partial);
  };
  const finishComposition = async (element, value, afterInput = () => {}) => React.act(async () => {
    element.dispatchEvent(new win.CompositionEvent("compositionend", { bubbles: true, data: value }));
    const proto = element instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    // Close in the same event turn, before React has published the final input.
    afterInput();
    await tick(); await tick();
  });
  const escape = async element => React.act(async () => {
    element.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape", isComposing: false }));
    await tick();
  });
  const outside = async selector => React.act(async () => {
    const overlay = document.querySelector(selector); assert(overlay);
    overlay.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", button: 0 }));
    await tick();
  });
  const tableValues = [];
  tableClosed = 0;
  await render(React.createElement(tableSettings.TableEditSettingsDialog, {
    owner: tableOwner, busy: false, error: "", onClose: () => { tableClosed++; },
    onSave: async value => { tableValues.push(value); return true; },
  }));
  const tableText = document.querySelector("input:not([type=radio])");
  await beginComposition(tableText, "にほ");
  await escape(tableText);
  await outside(".fixed.inset-0");
  await click(document.querySelector('[role="dialog"] > button'));
  await React.act(async () => {
    assert.equal(await nativeAllow(), false);
    assert.equal(await interaction.tableEditorsAllowNavigation(), false);
  });
  assert.equal(tableClosed, 0); assert.equal(tableValues.length, 0);
  assert.equal(tableText.value, "にほ");
  await finishComposition(tableText, "日本語の説明", () => button("common.close").click());
  assert.equal(tableClosed, 1); assert.equal(tableValues.length, 1);
  assert.equal(tableValues[0].display_name, "日本語の説明");
  console.log("PASS table IME blocks Escape/outside/X/native/navigation close and commits final Japanese input");
  await unmount();

  session = "A"; failLoad = false; failSave = false; projectWrites = 0; destroyed = 0;
  await render(React.createElement(project.ProjectEditDialog));
  const projectText = document.querySelector("textarea");
  await beginComposition(projectText, "ぷろ");
  await escape(projectText);
  await click(button("common.close"));
  await React.act(async () => { nativeClose({ preventDefault() {} }); await tick(); });
  assert.equal(projectWrites, 0); assert.equal(destroyed, 0);
  await finishComposition(projectText, "プロジェクト説明", () => nativeClose({ preventDefault() {} }));
  assert.equal(projectWrites, 1); assert.equal(destroyed, 1);
  assert.equal(projectValues.at(-1).description, "プロジェクト説明");
  console.log("PASS project IME blocks button/native close and persists the final composition value");
  await unmount();

  await mountColumn();
  const columnName = document.querySelector('input[id$="-display-label"]');
  await beginComposition(columnName, "こう");
  await escape(columnName);
  await click(document.querySelector('button[aria-label="column.closeSettings"]'));
  await React.act(async () => {
    assert.equal(await nativeAllow(), false);
    assert.equal(await interaction.tableEditorsAllowNavigation(), false);
  });
  assert.equal(closed, 0); assert.equal(ipc.filter(value => value.command === "save_column_editor").length, 0);
  await finishComposition(columnName, "攻撃力", () => button("common.save").click());
  assert.equal(closed, 1);
  assert.equal(ipc.find(value => value.command === "save_column_editor").args.request.draft.display_name, "攻撃力");
  console.log("PASS existing-column IME blocks Escape/X/native/navigation close until its final value is current");
  await unmount();

  await mountColumn("table", null);
  await input(document.querySelector('input[id$="-name"]'), "new_column");
  const newColumnName = document.querySelector('input[id$="-display-label"]');
  await beginComposition(newColumnName, "しん");
  await escape(newColumnName);
  await click(button("common.add")); await click(button("common.cancel"));
  await React.act(async () => {
    assert.equal(await nativeAllow(), false);
    assert.equal(await interaction.tableEditorsAllowNavigation(), false);
  });
  assert.equal(closed, 0); assert.equal(ipc.filter(value => value.command === "save_column_editor").length, 0);
  assert.equal(button("column.discardAndClose"), undefined);
  await finishComposition(newColumnName, "新しい列", () => button("common.add").click());
  assert.equal(closed, 1);
  assert.equal(ipc.find(value => value.command === "save_column_editor").args.request.draft.display_name, "新しい列");
  console.log("PASS new-column Add/Cancel retain active IME and Add commits its completed value");
  await unmount();

  await mountColumn(); await click(button("column.inputRules"));
  await click(document.querySelector(".input-rule-row .rule-summary-button"));
  const ruleText = document.querySelector('input[id$="-pattern"]');
  await beginComposition(ruleText, "かな");
  await escape(ruleText);
  await outside(".rule-dialog-overlay");
  await click(document.querySelector('.rule-editor-dialog button[aria-label="common.close"]'));
  await React.act(async () => {
    assert.equal(await nativeAllow(), false);
    assert.equal(await interaction.tableEditorsAllowNavigation(), false);
  });
  assert(document.querySelector('[role="dialog"]'));
  assert.equal(closed, 0); assert.equal(ipc.filter(value => value.command === "save_column_editor").length, 0);
  await finishComposition(ruleText, "仮名.*", () => { void nativeAllow(); });
  await React.act(async () => { await tick(); await tick(); });
  assert.equal(closed, 1);
  assert.equal(ipc.filter(value => value.command === "save_column_editor").length, 0);
  assert.equal(original.input_validation.rules[0].pattern, "old");
  console.log("PASS nested rule IME survives active composition and native close discards without persistence");
  await unmount();

  await mountColumn(); await click(button("column.inputRules"));
  await React.act(async () => { const select = document.querySelector('select[id$="-rule-kind"]'); select.value = "pattern"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click(button("rules.add"));
  const newRuleText = document.querySelector('input[id$="-pattern"]');
  await beginComposition(newRuleText, "にゅ");
  await escape(newRuleText);
  await click(button("common.apply")); await click(button("common.cancel"));
  assert(document.querySelector('[role="dialog"]'));
  assert.equal(document.querySelectorAll(".input-rule-row").length, 1);
  await finishComposition(newRuleText, "入力.*", () => button("common.apply").click());
  assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
  assert.equal(document.querySelectorAll(".input-rule-row").length, 2);
  assert.equal(JSON.parse([...store.values()][0]).draft.input_validation.rules[1].pattern, "入力.*");
  assert.equal(ipc.filter(value => value.command === "save_column_editor").length, 0);
  console.log("PASS new-rule Apply/Cancel cannot discard IME; Apply only updates the completed parent draft");
  await unmount();

  session = "A"; projectWrites = 0; destroyed = 0;
  await render(React.createElement(project.ProjectEditDialog));
  const blurColor = document.querySelector("[data-project-color]");
  await React.act(async () => {
    blurColor.focus();
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(blurColor, "#123456");
    nativeClose({ preventDefault() {} });
    await tick(); await tick();
  });
  assert.equal(destroyed, 1); assert.equal(projectWrites, 1);
  assert.equal(projectValues.at(-1).headerColor, "#123456");
  console.log("PASS native project close flushes a blur-owned field before taking the save snapshot");
  await unmount();

  const originalMatchMedia = win.matchMedia;
  let mediaChanged;
  const media = { matches: false, addEventListener: (_name, callback) => { mediaChanged = callback; }, removeEventListener() {} };
  win.matchMedia = () => media;
  let themes = [];
  let themeSettings = { revision: "same", bundle: { values: { theme: "system", pluginTheme: "" }, themes: [] } };
  let inheritedTheme = { dark: false, id: "light", revision: "same", variables: { "--background": "0 0% 100%" } };
  const theme = load("src/app/settings/AppTheme.tsx", {
    "@/app/contexts/PluginContext": { useThemes: () => themes },
    "@/app/config/brand": { themeCssVariables: value => value.variables },
    "./index": { useAppSettings: () => themeSettings },
    "./dialogTheme": { readDialogTheme: () => inheritedTheme },
  });
  await render(React.createElement(theme.AppTheme));
  await React.act(async () => { media.matches = true; mediaChanged(); });
  assert(document.documentElement.classList.contains("dark"));
  assert.equal(document.documentElement.style.getPropertyValue("--background"), "");
  console.log("PASS inherited built-in dialog snapshot does not freeze live system theme");
  await unmount();
  themeSettings = { revision: "same", bundle: { values: { theme: "system", pluginTheme: "plugin:custom" }, themes: [] } };
  inheritedTheme = { dark: true, id: "plugin:custom", revision: "same", variables: { "--background": "0 0% 10%" } };
  await render(React.createElement(theme.AppTheme));
  assert(document.documentElement.classList.contains("dark"));
  assert.equal(document.documentElement.style.getPropertyValue("--background"), "0 0% 10%");
  themes = [{ id: "plugin:custom", type: "light", variables: { "--background": "0 0% 90%" } }];
  await render(React.createElement(theme.AppTheme));
  assert(!document.documentElement.classList.contains("dark"));
  assert.equal(document.documentElement.style.getPropertyValue("--background"), "0 0% 90%");
  console.log("PASS unresolved plugin snapshot yields to the actual loaded theme");
  await unmount();
  win.matchMedia = originalMatchMedia;
  assert.deepEqual(consoleErrors, [], "Runtime warnings/errors fail the lifecycle checks");
  console.error = originalError;
  console.warn = originalWarn;
  await win.happyDOM.abort();
})().catch((e) => {
  process.stderr.write(`${e.stack || e}\n`);
  process.exitCode = 1;
});
