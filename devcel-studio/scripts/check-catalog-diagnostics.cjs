#!/usr/bin/env node
'use strict';

// The same native descriptors must rerender after a locale change without
// translating user values, plugin text, filesystem paths, or parser details.
// Run after regenerating the catalog: node scripts/check-catalog-diagnostics.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IntlMessageFormat } = require('intl-messageformat');
const { compileModule } = require('./compile-module.cjs');
const root = path.resolve(__dirname, '..');
const runtimeFile = path.join(root, 'src/app/i18n/index.ts');
const catalog = require(path.join(root, 'src/app/i18n/generated/catalog.json'));
const code = (code, params = {}) => ({ kind: 'code', code, params });
const literal = text => ({ kind: 'text', text });
const opaque = '利用者の値 {not_a_key}';
const file = '/資料/存在しない {not_a_key}.zip';
const detail = 'OS_EACCES / ParserError {offset: 17}';
const fixtures = [
  code('settings.schema.singleton', { table: 'UserSettings', count: 2 }),
  code('settings.schema.missingColumn', { table: 'Messages', column: 'source_message' }),
  code('settings.schema.columnType', { table: 'UserSettings', column: 'locale', expected: 'Select', actual: 'String' }),
  code('settings.schema.referenceMissing', { record: literal(opaque), recordId: 'opaque-id', column: 'theme_ref', target: 'Themes', value: opaque }),
  code('settings.localization.messageError', { key: 'common.save', locale: 'ja', error: { kind: 'diagnostics', diagnostics: [code('settings.localization.icuSyntax', { details: detail })] } }),
  code('plugin.package.error.formatVersion', { actual: 7, supported: 1 }),
  code('plugin.package.error.apiVersion', { required: '1.0.0', actual: '2.0.0' }),
  code('plugin.package.error.dependencyMissing', { id: 'user-plugin', required: '^1.0.0' }),
  code('plugin.package.error.dependencyDisabled', { id: 'user-plugin' }),
  code('plugin.package.error.pathCause', { path: file, error: code('plugin.package.error.readFailed', { details: detail }) }),
  code('plugin.catalog.error.status', { status: 403 }),
  code('plugin.catalog.error.encoding'),
  code('plugin.catalog.error.size', { max: 1048576 }),
  code('error.projectPathRequired'),
  code('error.projectAlreadyExists', { path: file }),
  code('error.projectMissing', { path: file }),
];
const original = JSON.stringify(fixtures);
const moduleBoundary = { exports: {} };
const compiled = compileModule(fs.readFileSync(runtimeFile, 'utf8').replace(/\bimport\.meta\.env\.DEV\b/g, 'true'), runtimeFile);
vm.runInNewContext(compiled, {
  module: moduleBoundary, exports: moduleBoundary.exports,
  require(name) {
    if (name === 'react') return { useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() };
    if (name === 'intl-messageformat') return { IntlMessageFormat };
    if (name === '@tauri-apps/api/core') return { isTauri: () => false };
    if (name === '@tauri-apps/api/window') return { getCurrentWindow: () => ({ setTitle: async () => {} }) };
    if (name === '@/app/settings/generated/catalog.json') return require(path.join(root, 'src/app/settings/generated/catalog.json'));
      if (name === './generated/catalog.json') return catalog;
    throw new Error(`Unexpected runtime dependency: ${name}`);
  },
  window: { location: { pathname: '/' } }, document: { documentElement: {}, title: '' },
  navigator: { languages: ['ja-JP'] }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  console, Intl, Date, Error, Map, Set, Promise, JSON, Object, String, Number, Boolean, setTimeout, clearTimeout, queueMicrotask,
}, { filename: runtimeFile });

(async () => {
  const api = moduleBoundary.exports;
  await api.initializeI18n();
  const outputs = new Map();
  for (const locale of ['ja', 'en', 'en-XA', 'ja']) {
    api.applyRuntimeLocalization(catalog, { locale, preference: locale, revision: `test:${locale}`, availableLocales: ['ja', 'en', 'en-XA'] });
    const rendered = fixtures.map(error => api.localizeError(error));
    for (const text of rendered) {
      assert.ok(text.length > 0);
      assert.ok(!/Validation error:|\[object Object\]|\[(?:settings\.|plugin\.)/.test(text), text);
      assert.ok(!text.includes('"kind":"code"'), text);
    }
    assert.ok(rendered[3].includes(opaque));
    assert.ok(rendered[4].includes(detail));
    assert.ok(rendered[9].includes(file));
    assert.ok(rendered[9].includes(detail));
    const previewIssues = { kind: 'diagnostics', diagnostics: fixtures.slice(5, 9) };
    assert.equal(api.localizeError(previewIssues), rendered.slice(5, 9).join('\n'));
    for (const text of ['Invalid plugin ID', 'Name cannot be empty.', opaque, file, detail]) {
      assert.equal(api.localizeError(literal(text)), text);
      assert.equal(api.localizeError(text), text); // legacy preview arrays remain literal
    }
    if (outputs.has(locale)) assert.deepEqual(rendered, outputs.get(locale));
    outputs.set(locale, rendered);
    assert.equal(JSON.stringify(fixtures), original);
  }
  for (let i = 0; i < fixtures.length; i++) {
    assert.notEqual(outputs.get('ja')[i], outputs.get('en')[i], fixtures[i].code);
    assert.notEqual(outputs.get('en')[i], outputs.get('en-XA')[i], fixtures[i].code);
  }
  console.log(`PASS ${fixtures.length} catalog/package diagnostics: ja -> en -> pseudo -> ja, nested causes, paths and literal boundaries`);
})().catch(error => { console.error(error); process.exitCode = 1; });
