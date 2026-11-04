const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const filters = require("./test-file-filters.cjs");
const { fileImportUrl } = require("./file-import-url.cjs");

async function main() {
  const drive = String.raw`D:\a\devcel\space #日本語%\fixture.mjs`;
  assert.equal(fileImportUrl(drive, { windows: true }), "file:///D:/a/devcel/space%20%23%E6%97%A5%E6%9C%AC%E8%AA%9E%25/fixture.mjs");
  assert.equal(fileImportUrl(String.raw`\\server\share\space #日本語%\fixture.mjs`, { windows: true }), "file://server/share/space%20%23%E6%97%A5%E6%9C%AC%E8%AA%9E%25/fixture.mjs");
  assert.equal(fileImportUrl("/tmp/space #日本語%/fixture.mjs", { windows: false }), "file:///tmp/space%20%23%E6%97%A5%E6%9C%AC%E8%AA%9E%25/fixture.mjs");
  await assert.rejects(import(drive), { code: "ERR_UNSUPPORTED_ESM_URL_SCHEME" });
  console.log("PASS Windows drive/UNC and POSIX file URLs preserve escaped path characters; raw drive import is rejected");

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "devcel-esm-url-"));
  try {
    const filename = path.join(temporary, "module #日本語%.mjs");
    await fs.writeFile(filename, "export const marker = 'actual file import';\n");
    const loaded = await import(fileImportUrl(filename));
    assert.equal(loaded.marker, "actual file import");
    console.log("PASS actual filesystem module imports through its file URL");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }

  // Exercise the same RegExp objects used by esbuild, not a duplicate normalizer.
  const cases = [
    [filters.wizardSettingsImporter, ["settings/AppTheme.tsx", "settings/dialogTheme.ts"], ["other/AppTheme.tsx", "settings/index.ts", "settings/AppTheme.tsx.bak"]],
    [filters.gridSelectionSource, ["react-data-grid/DataGrid.tsx"], ["other/DataGrid.tsx", "react-data-grid/TreeDataGrid.tsx", "react-data-grid/DataGrid.tsx.bak"]],
    [filters.formulaRepairSource, ["editors/textEditor.tsx", "editors/validatedTextEditor.tsx"], ["other/textEditor.tsx", "editors/numberEditor.tsx", "editors/textEditor.tsx.bak"]],
  ];
  for (const [filter, accepted, rejected] of cases) {
    for (const [prefix, separator] of [["/tmp/space #日本語%/", "/"], [String.raw`D:\a\space #日本語%` + "\\", "\\"], [String.raw`\\server\share\space #日本語%` + "\\", "\\"]]) {
      for (const [names, expected] of [[accepted, true], [rejected, false]]) {
        for (const name of names) assert.equal(filter.test(prefix + name.replaceAll("/", separator)), expected, `${filter}: ${prefix}${name}`);
      }
    }
  }
  for (const [filename, key, invocation] of [
    ["check-project-defaults.mjs", "wizardSettingsImporter", "wizardSettingsImporter.test(args.importer)"],
    ["check-grid-selection-identity.mjs", "gridSelectionSource", "filter: gridSelectionSource"],
    ["check-formula-repair.mjs", "formulaRepairSource", "filter: formulaRepairSource"],
  ]) {
    const source = await fs.readFile(path.join(__dirname, filename), "utf8");
    assert(source.includes(`import { ${key} } from './test-file-filters.cjs';`), `${filename}: actual shared filter import`);
    assert(source.includes(invocation), `${filename}: actual boundary uses the checked filter`);
  }
  console.log("PASS actual wizard/grid/formula filesystem filters match POSIX, Windows drive and UNC paths, rejecting unrelated files");

  // Evaluate the real generated-module templates with hostile-but-valid checkout
  // characters, then parse with the same esbuild compiler the harness uses.
  for (const [filename, key] of [
    ["check-filename-rename.mjs", "'./hooks/useFileOperations':"],
    ["check-filename-rename.mjs", "'@/app/i18n':"],
    ["check-filtered-reference-navigation.mjs", "'@/app/i18n':"],
    ["check-filtered-reference-navigation.mjs", "'./DataGridAdvancedCells':"],
  ]) {
    const source = await fs.readFile(path.join(__dirname, filename), "utf8");
    const lines = source.split(/\r?\n/).filter(line => line.trimStart().startsWith(key));
    assert.equal(lines.length, 1, `${filename}: exact generated-module template`);
    const line = lines[0], template = line.slice(line.indexOf("`"), line.lastIndexOf("`") + 1);
    for (const filename of ["/tmp/space ' #日本語%/index.ts", String.raw`D:\a\space ' #日本語%\index.ts`, String.raw`\\server\share\space ' #日本語%\index.ts`]) {
      const generated = vm.runInNewContext(template, { resolve: () => filename, project: "unused" });
      const compiled = transformSync(generated, { loader: "js", format: "esm" }).code;
      const specifiers = [...compiled.matchAll(/\bfrom ("(?:\\.|[^"\\])*")/g)].map(match => JSON.parse(match[1]));
      assert(specifiers.includes(filename), `${key}: generated import preserves the exact filesystem path`);
    }
  }
  console.log("PASS all four real generated import templates preserve Windows/UNC/POSIX paths and quotes through esbuild");

  // Check the real callers too: a helper-only test must not hide a reintroduced
  // raw path in the lifecycle or redesign test harness.
  for (const [name, count] of [["check-settings-lifecycle.cjs", 1], ["check-ui-redesign.cjs", 2]]) {
    const filename = path.join(__dirname, name);
    const source = await fs.readFile(filename, "utf8");
    const imports = [...source.matchAll(/\bimport\s*\(/g)];
    const converted = [...source.matchAll(/\bimport\s*\(\s*fileImportUrl\s*\(/g)];
    assert.equal(imports.length, count, `${name}: expected dynamic-import coverage`);
    assert.equal(converted.length, count, `${name}: dynamic filesystem imports must use fileImportUrl`);
  }
  console.log("PASS all three affected production-test call sites use the shared URL conversion");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
