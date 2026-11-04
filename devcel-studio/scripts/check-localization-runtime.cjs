#!/usr/bin/env node
'use strict';

// Integration regression checks using the actual i18n implementation and generated catalogs.
// Replace only React, Tauri, and browser boundaries; use the real ICU implementation.
// Keep output and type-check fixtures in OS temporary directories and remove them afterward.
// Run: node scripts/check-localization-runtime.cjs
// Optional: DEVCEL_TEST_NODE_MODULES=/path/to/node_modules (an existing happy-dom environment)
// Actual WebKit rendering, OS settings, IPC delivery, and persistence require separate device verification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const studioRequire = createRequire(path.join(root, 'package.json'));
const ts = studioRequire('typescript/unstable/ast');
const { createSourceParser } = require('./typescript-analysis.cjs');
const { compileModule } = require('./compile-module.cjs');
const { execFileSync } = require('node:child_process');
const parser = createSourceParser();
const { IntlMessageFormat } = studioRequire('intl-messageformat');
const { parse } = studioRequire('@formatjs/icu-messageformat-parser');
const runtimeFile = path.join(root, 'src/app/i18n/index.ts');
const keysFile = path.join(root, 'src/app/i18n/generated/keys.ts');
const catalogFile = path.join(root, 'src/app/i18n/generated/catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
const runtimeSource = fs.readFileSync(runtimeFile, 'utf8');
const keySource = fs.readFileSync(keysFile, 'utf8');
const checks = { passed: 0, failed: 0, skipped: 0, formatted: 0 };

async function check(name, body) {
  try {
    await body();
    checks.passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.failed++;
    console.error(`FAIL ${name}\n${error.stack || error}`);
  }
}
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const canonicalSettings = (locale = 'ja', revision = 'hash:initial', preference = locale) => ({
  locale, revision: String(revision), preference, availableLocales: ['ja', 'en', 'en-XA']
});

// Read generated MessageArgs. Reading types and catalogs separately also detects missing keys.
function readArgumentTypes() {
  const { source, diagnostics } = parser.parse(keysFile, keySource);
  assert.equal(diagnostics.length, 0);
  const definition = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'MessageArgs');
  assert.ok(definition, 'generated keys.ts must declare MessageArgs');
  const result = new Map();
  for (const member of definition.members) {
    assert.ok(ts.isPropertySignatureDeclaration(member) && ts.isTypeLiteralNode(member.type));
    const key = member.name.text;
    const args = {};
    for (const argument of member.type.members) {
      assert.ok(ts.isPropertySignatureDeclaration(argument));
      args[argument.name.text] = argument.type.getText(source);
    }
    result.set(key, args);
  }
  return result;
}
const argumentTypes = readArgumentTypes();
const sentinel = 'RAW_利用者の値_<b>&"_42';
function sampleArgs(key) {
  return Object.fromEntries(Object.entries(argumentTypes.get(key) || {}).map(([name, type]) => [name,
    type.includes('Date') ? new Date('2026-01-02T03:04:05Z') : type === 'number' ? 2 : sentinel
  ]));
}

// Replace only Vite's DEV constant at the environment boundary. Do not rewrite logic, types, or error handling.
const compiledRuntime = compileModule(runtimeSource.replace(/\bimport\.meta\.env\.DEV\b/g, 'true'), runtimeFile);

const runtimeResources = new WeakMap();
function publishLocale(api, preference, resource) {
  const context = runtimeResources.get(api);
  if (resource) context.resource = resource;
  const locale = preference ?? api.matchLocale(context.languages);
  api.applyRuntimeLocalization(context.resource, canonicalSettings(locale, `fixture:${++context.revision}`, preference));
}
function loadRuntime(options = {}) {
  const warnings = [], titles = [], storageCalls = [];
  const storage = new Map(options.unrelatedLocale ? [['other-app.locale', options.unrelatedLocale]] : []);
  const document = options.document || { documentElement: { lang: '', dir: '' }, title: '' };
  const window = { location: { pathname: options.pathname || '/' } };
  const react = options.react || { useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); } };
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports,
    require(specifier) {
      if (specifier === 'react') return react;
      if (specifier === 'intl-messageformat') return { IntlMessageFormat };
      if (specifier === '@tauri-apps/api/core') return { isTauri: () => !!options.native };
      if (specifier === '@tauri-apps/api/window') return { getCurrentWindow: () => ({ async setTitle(title) { titles.push(title); } }) };
      if (specifier === '@/app/settings/generated/catalog.json') return require(path.join(root, 'src/app/settings/generated/catalog.json'));
      if (specifier === './generated/catalog.json') return options.catalog || copy(catalog);
      throw new Error(`Unexpected runtime dependency: ${specifier}`);
    },
    window, document, localStorage: {
      getItem(key) { storageCalls.push(['get', key]); return storage.get(key) ?? null; },
      setItem(key, value) { storageCalls.push(['set', key]); storage.set(key, value); },
      removeItem(key) { storageCalls.push(['remove', key]); storage.delete(key); }
    },
    navigator: { languages: options.languages || ['ja-JP'] },
    console: { ...console, warn: (...args) => warnings.push(args) },
    Intl: options.Intl || Intl, Date, Error, Map, Set, Promise, JSON, Object, String, Number, Boolean,
    setTimeout, clearTimeout, queueMicrotask
  });
  vm.runInContext(compiledRuntime, context, { filename: runtimeFile });
  runtimeResources.set(module.exports, { resource: options.catalog || copy(catalog), languages: options.languages || ['ja-JP'], revision: 0 });
  return { api: module.exports, document, storage, storageCalls, warnings, titles };
}
async function browserRuntime(options = {}) {
  const runtime = loadRuntime(options);
  await runtime.api.initializeI18n();
  if (options.locale && Object.hasOwn((options.catalog || catalog).locales, options.locale)) publishLocale(runtime.api, options.locale);
  return runtime;
}

// Collect non-other plural/select branches from the actual catalogs and generate arguments for each branch.
function branchVariants(source, initial, locale) {
  const result = [initial];
  function walk(nodes, current) {
    for (const node of nodes) {
      if (node.type === 5 || node.type === 6) {
        for (const [selector, option] of Object.entries(node.options)) {
          let value = selector;
          if (node.type === 6) {
            if (selector.startsWith('=')) value = Number(selector.slice(1));
            else {
              const rules = new Intl.PluralRules(locale === 'en-XA' ? 'en' : locale, { type: node.pluralType });
              const candidates = [...Array.from({ length: 201 }, (_, i) => i), 1000, 1000000, 1.5];
              const count = candidates.find(number => rules.select(number) === selector && !node.options[`=${number + node.offset}`]);
              // ICU accepts categories unreachable in a locale too, so verify that they can be formatted.
              value = (count ?? 7) + node.offset;
            }
          }
          const variant = { ...current, [node.value]: value };
          result.push(variant);
          walk(option.value, variant);
        }
      }
    }
  }
  walk(parse(source, { ignoreTag: true }), initial);
  return result;
}

function checkHookPlacement() {
  const roots = [
    'src/app/components/column-editor', 'src/app/pages/table_rule_dialog',
    'src/app/pages/main_window/project_view/table_view/components', 'src/lib/react-data-grid',
    'src/components/ui', 'src/lib/markdown-bubble-menu.tsx', 'src/app/components/ColorPicker.tsx',
    'src/app/components/ReferenceConfigSelector.tsx'
  ];
  const files = [];
  function collect(relative) {
    const full = path.join(root, relative);
    if (fs.statSync(full).isDirectory()) for (const entry of fs.readdirSync(full)) collect(path.join(relative, entry));
    else if (/\.tsx?$/.test(relative) && !relative.endsWith('InterfaceView.tsx')) files.push(full);
  }
  roots.forEach(collect);
  let count = 0;
  for (const file of files) {
    const { source, diagnostics } = parser.parse(file, fs.readFileSync(file, 'utf8'));
    assert.equal(diagnostics.length, 0);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'useI18n') {
        count++;
        let owner = node.parent;
        while (owner && !ts.isFunctionLikeDeclaration(owner)) owner = owner.parent;
        const ownerName = owner?.name?.getText(source)
          || (owner && ts.isVariableDeclaration(owner.parent) ? owner.parent.name.getText(source) : '');
        const forwarded = owner && ts.isCallExpression(owner.parent)
          && /(?:^|\.)(forwardRef|memo)$/.test(owner.parent.expression.getText(source));
        assert.ok(owner && (/^[A-Z]|^use[A-Z]/.test(ownerName) || forwarded),
          `${path.relative(root, file)}: useI18n must not run inside effects, then, map, or event callbacks`);
        let statement = node;
        while (statement.parent && statement.parent !== owner.body) statement = statement.parent;
        assert.equal(statement.parent, owner.body, `${file}: hook must be directly inside the component body`);
        assert.ok(!ts.isIfStatement(statement) && !ts.isSwitchStatement(statement)
          && !ts.isForStatement(statement) && !ts.isWhileStatement(statement), `${file}: conditional hook`);
        assert.ok(owner.body.statements.indexOf(statement) >= 0, `${file}: hook cannot live in a parameter initializer`);
      }
      node.forEachChild(visit);
    }
    visit(source);
  }
  assert.ok(count > 0);
  console.log(`  useI18n placement: ${count} call sites checked (renderer invocation paths also reviewed manually).`);
}

async function checkGeneratedArgumentTypes() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-i18n-types-'));
  try {
    const fixture = path.join(directory, 'localization-types.ts');
    const calls = [];
    for (const [key, args] of argumentTypes) {
      const values = Object.entries(args).map(([name, type]) => `${JSON.stringify(name)}: ${type.includes('Date') ? "new Date('2026-01-02T03:04:05Z')" : type === 'number' ? '2' : JSON.stringify(sentinel)}`).join(', ');
      calls.push(`t(${JSON.stringify(key)}${values ? `, { ${values} }` : ''});`);
    }
    const withString = [...argumentTypes].find(([, args]) => Object.values(args).includes('string'));
    const withNumber = [...argumentTypes].find(([, args]) => Object.values(args).includes('number'));
    const withoutArgs = [...argumentTypes].find(([, args]) => !Object.keys(args).length);
    assert.ok(withString && withNumber && withoutArgs, 'fixture needs string, number and no-argument keys');
    const wrongNumber = Object.fromEntries(Object.entries(withNumber[1]).map(([name, type]) => [name, type === 'number' ? 'not-a-number' : sentinel]));
    fs.writeFileSync(fixture, `import { t, message, formatNumber } from ${JSON.stringify(runtimeFile)};\n`
      + 'declare global { interface ImportMeta { env: { DEV: boolean }; } }\n'
      + calls.join('\n') + '\n'
      + `message(${JSON.stringify(withoutArgs[0])});\nformatNumber(18446744073709551615n);\n`
      + '// @ts-expect-error unknown message keys must not compile\nt("__unknown_fixture_key__");\n'
      + `// @ts-expect-error required placeholders must not be omitted\nt(${JSON.stringify(withString[0])});\n`
      + `// @ts-expect-error numeric placeholders must not accept strings\nt(${JSON.stringify(withNumber[0])}, ${JSON.stringify(wrongNumber)});\n`
      + `// @ts-expect-error extra arguments are rejected for no-argument messages\nt(${JSON.stringify(withoutArgs[0])}, { unexpected: "value" });\n`);
    const options = {
      strict: true, noEmit: true, skipLibCheck: true, resolveJsonModule: true, esModuleInterop: true,
      allowImportingTsExtensions: true, target: 'ES2020', module: 'ESNext',
      moduleResolution: 'bundler', paths: { '@/*': [path.join(root, 'src/*')] }, types: [], lib: ['ES2020', 'DOM']
    };
    const config = path.join(directory, 'tsconfig.json');
    fs.writeFileSync(config, JSON.stringify({ compilerOptions: options, files: [fixture] }));
    const compiler = path.join(path.dirname(studioRequire.resolve('typescript/package.json')), 'bin/tsc');
    execFileSync(process.execPath, [compiler, '--project', config, '--pretty', 'false'], { cwd: root, stdio: 'pipe' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function findHappyDom() {
  const requests = [studioRequire];
  if (process.env.DEVCEL_TEST_NODE_MODULES) {
    requests.unshift(createRequire(path.join(path.resolve(process.env.DEVCEL_TEST_NODE_MODULES), '__devcel_harness__.cjs')));
  }
  for (const request of requests) {
    try { return await import(pathToFileURL(request.resolve('happy-dom')).href); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  }
  return null;
}

async function checkRealReactState() {
  const dom = await findHappyDom();
  if (!dom) {
    checks.skipped++;
    console.log('SKIP real React DOM state preservation: happy-dom is unavailable. Set DEVCEL_TEST_NODE_MODULES to an existing environment.');
    console.log('LIMITATION subscriptions and snapshots use the real runtime, but mocks alone cannot prove React remount, DOM selection, or focus preservation.');
    return;
  }
  await check('real React: locale subscriptions update display while preserving component draft, ref, DOM, and mount', async () => {
    const React = studioRequire('react');
    const window = new dom.Window({ url: 'http://localhost/' });
    const saved = new Map();
    for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator,
      HTMLElement: window.HTMLElement, Node: window.Node, MutationObserver: window.MutationObserver,
      requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      IS_REACT_ACT_ENVIRONMENT: true })) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    let reactRoot;
    try {
      const { createRoot } = studioRequire('react-dom/client');
      const { api } = await browserRuntime({ react: React, document: window.document });
      const host = window.document.createElement('div'); window.document.body.appendChild(host);
      let setDraft; let firstIdentity; let mounts = 0; let unmounts = 0;
      function EditorFixture() {
        const { locale, t } = api.useI18n();
        const [draft, setter] = React.useState('未保存_日本語');
        const identity = React.useRef({ stable: true });
        setDraft = setter;
        if (!firstIdentity) firstIdentity = identity.current;
        assert.equal(identity.current, firstIdentity);
        React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
        return React.createElement('section', { 'data-locale': locale },
          React.createElement('input', { value: draft, onChange: event => setter(event.target.value) }),
          React.createElement('span', null, t('common.save')));
      }
      reactRoot = createRoot(host);
      await React.act(async () => { reactRoot.render(React.createElement(EditorFixture)); });
      await React.act(async () => { setDraft('編集中_<b>&保持'); });
      const input = host.querySelector('input');
      input.focus(); input.setSelectionRange(2, 5);
      await React.act(async () => { await publishLocale(api, 'en'); });
      assert.equal(host.querySelector('input'), input);
      assert.equal(input.value, '編集中_<b>&保持');
      assert.equal(host.querySelector('span').textContent, catalog.messages.en['common.save']);
      assert.equal(host.querySelector('section').dataset.locale, 'en');
      assert.equal(window.document.activeElement, input);
      assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 5);
      assert.equal(mounts, 1); assert.equal(unmounts, 0);
      for (const locale of ['eu', 'ca', 'en-XA', 'ja']) {
        await React.act(async () => { await publishLocale(api, locale); });
        assert.equal(host.querySelector('input'), input);
        assert.equal(input.value, '編集中_<b>&保持');
        assert.equal(window.document.activeElement, input);
        assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 5);
        assert.equal(host.querySelector('span').textContent, catalog.messages[locale]['common.save']);
        assert.equal(mounts, 1); assert.equal(unmounts, 0);
      }
      assert.equal(input.value, '編集中_<b>&保持'); assert.equal(mounts, 1);
      await React.act(async () => { reactRoot.unmount(); }); reactRoot = null;
      assert.equal(unmounts, 1);
    } finally {
      if (reactRoot) await React.act(async () => { reactRoot.unmount(); });
      await window.happyDOM.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
      }
    }
  });
}

async function main() {
  await check('useI18n runs only directly within components, custom hooks, or forwardRef', checkHookPlacement);
  await check('locale matching: explicit setting, OS candidates, regions, case, underscores, and ja fallback', async () => {
    const { api } = loadRuntime();
    assert.equal(api.matchLocale(['en-US']), 'en');
    assert.equal(api.matchLocale(['JA_jp.UTF-8']), 'ja');
    assert.equal(api.matchLocale(['ko-KR', 'EN_gb']), 'en');
    assert.equal(api.matchLocale(['ko-KR']), 'ja');
    assert.notEqual(api.matchLocale(['en-XA']), 'en-XA', 'do not select a pseudo-locale automatically from the OS');
    assert.equal((await browserRuntime({ locale: 'en', languages: ['ja-JP'] })).api.getLocale(), 'en');
    assert.equal((await browserRuntime({ languages: ['en-US'] })).api.getLocale(), 'en');
    assert.equal((await browserRuntime({ locale: 'unknown', languages: ['ko-KR'] })).api.getLocale(), 'ja');
    const browser = await browserRuntime({ locale: 'ja', languages: ['en-GB'] });
    await publishLocale(browser.api, null);
    assert.equal(browser.api.getLocale(), 'en'); assert.equal(browser.api.getLocalePreference(), null);
    assert.equal(browser.storageCalls.length, 0, 'runtime locale snapshots do not read or write localStorage');
    assert.equal(browser.document.documentElement.lang, 'en');
  });

  await check('multilingual locale matching: Chinese script priority, regions, Bokmal aliases, and RTL settings', async () => {
    const resource = copy(catalog);
    for (const locale of ['zh-Hans', 'zh-Hant', 'nb', 'ar', 'bn', 'hi', 'fr']) {
      resource.locales[locale] ??= { displayName: locale, fallback: 'en', direction: locale === 'ar' ? 'rtl' : 'ltr' };
      resource.messages[locale] ??= {};
    }
    const { api, document } = loadRuntime({ catalog: resource });
    for (const [input, expected] of [
      ['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-MO', 'zh-Hant'],
      ['zh-CN', 'zh-Hans'], ['zh-SG', 'zh-Hans'], ['zh', 'zh-Hans'],
      ['zh-Hans-TW', 'zh-Hans'], ['zh-Hant-CN', 'zh-Hant'], ['ZH_hant_HK.UTF-8', 'zh-Hant'],
      ['eu-ES', 'eu'], ['EU_es.UTF-8', 'eu'], ['ca-ES', 'ca'], ['ca-AD', 'ca'], ['CA_es.UTF-8', 'ca'],
      ['nb-NO', 'nb'], ['no-NO', 'nb'], ['ar-EG', 'ar'], ['bn-BD', 'bn'], ['hi-IN', 'hi'], ['fr-FR', 'fr']
    ]) assert.equal(api.matchLocale([input]), expected, input);
    assert.equal(api.matchLocale(['nn-NO', 'en-US']), 'en', 'Nynorsk must not silently become Bokmål');
    for (const locale of ['ar', 'eu', 'ca', 'bn', 'hi', 'fr', 'ar', 'ja']) {
      publishLocale(api, locale);
      assert.equal(document.documentElement.lang, locale);
      assert.equal(document.documentElement.dir, locale === 'ar' ? 'rtl' : 'ltr');
      assert.equal(api.getLocaleDirection(), locale === 'ar' ? 'rtl' : 'ltr');
    }
  });

  await check('Basque and Catalan: self-names, direct translations, and user settings choices', async () => {
    const labels = { exports: {} };
    vm.runInNewContext(compileModule(fs.readFileSync(path.join(root, 'src/app/settings/displayLabels.ts'), 'utf8'), 'displayLabels.ts'), {
      module: labels, exports: labels.exports, require(name) {
        if (name === '@/app/settings') return { getSettingsSnapshot: () => ({ bundle: { localization: catalog } }) };
        if (name === '@/app/applicationMode') return { isSettingsEditor: () => true };
        if (name === '@/app/i18n') return { getLocaleName: id => catalog.locales[id]?.displayName ?? id };
        throw Error(name);
      }
    });
    const localeColumn = '0b0c717a-e3e5-5c57-b2a8-6460d753b954';
    const choices = labels.exports.settingsSelectOptions(localeColumn, [{ value: 'system', label: 'System' }]);
    const { api } = await browserRuntime();
    for (const [locale, name, save, welcome] of [
      ['eu', 'Euskara', 'Gorde', 'Ongi etorri Devcel Studio-ra!'],
      ['ca', 'Català', 'Desa', 'Us donem la benvinguda a Devcel Studio!'],
    ]) {
      assert.equal(catalog.locales[locale].displayName, name);
      assert.equal(catalog.locales[locale].direction, 'ltr');
      assert.equal(catalog.locales[locale].fallback, 'en');
      assert.ok(choices.some(option => option.value === locale));
      assert.equal(labels.exports.settingsSelectOptionLabel(localeColumn, locale, locale), name);
      await publishLocale(api, locale);
      assert.equal(api.t('common.save'), save);
      assert.equal(api.t('welcome.title'), welcome);
    }
  });

  await check('all locales and keys: generated type/catalog consistency, no empty translations, and every ICU branch formatted by the real runtime', async () => {
    const sourceKeys = Object.keys(catalog.messages.ja).sort();
    assert.deepEqual([...argumentTypes.keys()].sort(), sourceKeys);
    const { api, warnings } = await browserRuntime();
    for (const locale of Object.keys(catalog.locales)) {
      assert.deepEqual(Object.keys(catalog.messages[locale]).sort(), sourceKeys, `${locale}: missing or extra keys`);
      await publishLocale(api, locale);
      for (const key of sourceKeys) {
        const source = catalog.messages[locale][key];
        assert.equal(typeof source, 'string', `${locale}:${key}`);
        assert.ok(source.trim(), `${locale}:${key}: empty translation`);
        const formatter = new IntlMessageFormat(source, locale === 'en-XA' ? 'en' : locale, undefined, { ignoreTag: true });
        for (const args of branchVariants(source, sampleArgs(key), locale)) {
          const expected = String(formatter.format(args));
          const actual = api.t(key, args);
          assert.equal(actual, expected, `${locale}:${key}`);
          assert.notEqual(actual, `[${key}]`, `${locale}:${key}: unexpected fallback`);
          checks.formatted++;
        }
      }
    }
    assert.equal(warnings.length, 0, 'valid catalogs produce no formatting warnings');
  });

  await check('MessageArgs: positive cases for every key and negative unknown/missing/wrong-type/extra arguments', checkGeneratedArgumentTypes);

  await check('en-XA: expansion preserves user arguments, type IDs, and Japanese text', async () => {
    const { api, document } = await browserRuntime({ locale: 'en' });
    const values = { name: sentinel };
    const english = api.t('column.managedBy', values);
    await publishLocale(api, 'en-XA');
    const pseudo = api.t('column.managedBy', values);
    assert.ok(pseudo.length > english.length);
    assert.equal(pseudo.split(sentinel).length, 2);
    assert.ok(pseudo.includes('⟦') && pseudo.includes('⟧'));
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(api.formatNumber(18446744073709551615n), new Intl.NumberFormat('en').format(18446744073709551615n));
  });

  await check('typed descriptor/code/text/input_validation: resolve again after locale changes while preserving user text', async () => {
    const { api } = await browserRuntime();
    const descriptor = api.message('column.defaultValue');
    const error = api.localizedError(descriptor);
    const code = { kind: 'code', code: 'column.defaultValue', params: {} };
    const literal = 'DEVCEL_APP_ERROR:' + JSON.stringify({ key: 'column.defaultValue' });
    const custom = { kind: 'text', text: literal };
    const report = { kind: 'input_validation', report: { acknowledgement: 'fixed', issues: [
      { diagnostic: code }, { diagnostic: custom }
    ] } };
    const nested = { kind: 'code', code: 'grid.errorWithCause', params: { summary: 'wrapper', error: code } };
    for (const locale of ['ja', 'en', 'en-XA']) {
      await publishLocale(api, locale);
      for (const candidate of [descriptor, error, code]) assert.equal(api.localizeError(candidate), api.t('column.defaultValue'));
      assert.equal(api.resolveMessage(descriptor), api.t('column.defaultValue'));
      assert.equal(api.localizeError(custom), literal);
      assert.equal(api.localizeError(report), api.t('column.defaultValue') + '\n' + literal);
      assert.equal(api.localizeError(nested), api.t('grid.errorWithCause', { summary: 'wrapper', error: api.t('column.defaultValue') }));
      assert.equal(api.localizeError(new Error('disk full')), 'disk full');
    }
    assert.equal(api.localizeError(null), '');
  });

  await check('column conversion: resolve preview/save diagnostic codes in Japanese and English while preserving blocked counts and type names', async () => {
    const { api } = await browserRuntime();
    const codes = ['formulaReviewRequired', 'undefinedType', 'invalidValue', 'precisionLoss',
      'selectValueUnavailable', 'referenceConfigMissing', 'referenceTableMissing', 'referenceRecordMissing',
      'tableReferenceConfigMissing', 'referenceInterfaceNotImplemented'];
    const samples = codes.map(suffix => ({ original_value: sentinel, converted_value: null,
      error: { kind: 'code', code: `column.conversion.${suffix}`, params: suffix === 'invalidValue' ? { type: 'U8' } : {} } }));
    const saved = { kind: 'diagnostics', diagnostics: [
      { kind: 'code', code: 'column.conversion.saveBlocked', params: { count: samples.length } },
      ...samples.map(sample => sample.error)
    ] };
    const wire = copy({ samples, saved });
    for (const locale of ['ja', 'en', 'ja']) {
      await publishLocale(api, locale);
      for (const sample of wire.samples) {
        const diagnostic = sample.error;
        assert.ok(Object.hasOwn(catalog.messages[locale], diagnostic.code), `${locale}: ${diagnostic.code}`);
        const text = api.localizeError(diagnostic);
        assert.equal(text, api.t(diagnostic.code, diagnostic.params));
        assert.equal(/[\u3040-\u30ff\u3400-\u9fff]/u.test(text), locale === 'ja', `${locale}: ${text}`);
        assert.equal(sample.original_value, sentinel, 'do not translate the original user value before conversion');
      }
      assert.equal(api.localizeError(wire.saved), wire.saved.diagnostics.map(value => api.localizeError(value)).join('\n'));
      assert.ok(api.localizeError(wire.samples[2].error).includes('U8'));
    }
    await publishLocale(api, 'en');
    assert.equal(api.localizeError(wire.samples[2].error), 'This value cannot be converted to U8.');
    for (const count of [1, 2]) {
      assert.equal(api.localizeError({ kind: 'code', code: 'column.conversion.saveBlocked', params: { count } }),
        `The column cannot be saved (${count} value error${count === 1 ? '' : 's'}).`);
    }
  });

  await check('owned backend diagnostic keys have compiled messages in every bundled locale', async () => {
    const paths = [
      '../devcel-core/src/app_error.rs', '../devcel-core/src/app_catalog.rs', '../devcel-core/src/localization.rs',
      '../devcel-core/src/cell_rules.rs', '../devcel-core/src/reference_integrity.rs',
      'src-tauri/src/app_settings_store.rs', 'src-tauri/src/settings_transactions_store.rs',
      'src-tauri/src/plugin_packages.rs', 'src-tauri/src/plugin_catalog.rs',
      'src-tauri/src/settings_mode.rs', 'src-tauri/src/settings_profile.rs', '../devcel-core/src/plugin_resources.rs'
    ];
    const prefixes = /"((?:error\.|settings\.(?:schema\.|localization\.|translation|file|state|generation|snapshot|compiled|cache|source|project|swatch|legacy|singleton|transaction)|color\.swatches\.|plugin\.(?:package|catalog)\.error\.)[A-Za-z0-9_.]+)"/g;
    const codes = new Set();
    for (const relative of paths) {
      const file = path.join(root, relative);
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(prefixes)) codes.add(match[1]);
      for (const match of source.matchAll(/AppError::code\(\s*"((?:settings|plugin)\.[A-Za-z0-9_.]+)"/g)) codes.add(match[1]);
      if (relative.endsWith('/plugin_resources.rs')) for (const match of source.matchAll(/invalid\(\s*"([A-Za-z][A-Za-z0-9]+)"/g)) codes.add(`plugin.resources.error.${match[1]}`);
    }
    assert.ok(codes.size >= 150, `expected audited structured producer inventory, got ${codes.size}`);
    for (const code of codes) for (const locale of Object.keys(catalog.messages)) {
      assert.ok(Object.hasOwn(catalog.messages[locale], code), `${locale}: missing owned backend diagnostic ${code}`);
    }
    console.log(`  ${codes.size} owned backend diagnostic keys checked across ${Object.keys(catalog.messages).length} locales.`);
  });

  await check('authoring errors, singleton recovery, filesystem details and nested causes remain localized across locale changes', async () => {
    const { api } = await browserRuntime();
    const technical = 'OS_DETAIL: permission denied / User_日本語.toml';
    const examples = [
      ['column.validation.emptyName', {}], ['column.validation.contentVersion', {}],
      ['error.settingsSingleton', {}], ['column.conversion.invalidValue', { type: 'U8' }],
      ['column.conversion.referenceRecordMissing', {}], ['error.rules.selectOptions', {}],
      ['error.staleData', {}], ['grid.snapshotInvalid', {}], ['grid.snapshotChanged', {}],
      ['error.io', { details: technical }], ['error.formula.divisionByZero', { details: technical }],
      ['error.referencedRowDelete', { table: sentinel, row: { kind: 'code', code: 'grid.defaultRowLabel', params: { number: 3 } }, column: sentinel }]
    ];
    const wire = copy(examples.map(([code, params]) => ({ kind: 'code', code, params })));
    const snapshots = [];
    for (const locale of ['ja', 'en', 'fr', 'ja']) {
      publishLocale(api, locale);
      const output = wire.map(diagnostic => api.localizeError(diagnostic));
      for (let index = 0; index < output.length; index++) {
        const text = output[index];
        assert.ok(Object.hasOwn(catalog.messages[locale], wire[index].code));
        assert.ok(!text.includes('Validation error:') && !text.includes('[object Object]'));
        assert.ok(!text.includes('error.settingsSingleton'));
      }
      assert.ok(output[9].includes(technical), 'OS/parser technical details are preserved, not translated');
      assert.ok(!output[10].includes(technical), 'formula summary does not leak technical identity/context');
      assert.ok(output[11].includes(sentinel) && output[11].includes(api.t('grid.defaultRowLabel', { number: 3 })));
      const nested = { kind: 'code', code: 'color.swatches.committedReloadRequired', params: {
        error: { kind: 'code', code: 'grid.errorWithCause', params: { summary: sentinel, error: wire[2] } }
      } };
      const localized = api.localizeError(copy(nested));
      assert.ok(localized.includes(output[2]) && localized.includes(sentinel));
      assert.ok(!localized.includes('Validation error:') && !localized.includes('error.settingsSingleton'));
      assert.equal(api.localizeError({ kind: 'text', text: 'Name cannot be empty.' }), 'Name cannot be empty.');
      snapshots.push(output);
    }
    assert.notDeepEqual(snapshots[0], snapshots[1]);
    assert.notDeepEqual(snapshots[1], snapshots[2]);
    assert.deepEqual(snapshots[0], snapshots[3]);
    assert.deepEqual(wire, copy(examples.map(([code, params]) => ({ kind: 'code', code, params }))));
  });

  await check('preserve user names and values containing prefixes exactly in all locales', async () => {
    const { api } = await browserRuntime();
    const known = 'DEVCEL_APP_ERROR:' + JSON.stringify({ key: 'column.defaultValue' });
    const validation = 'DEVCEL_INPUT_VALIDATION:' + JSON.stringify({ issues: [], acknowledgement: null });
    const literals = [known, validation, `Error: ${known}`, `LocalizedError: ${known}`, known + '\n' + validation];
    for (const locale of ['ja', 'en', 'en-XA']) {
      await publishLocale(api, locale);
      for (const literal of literals) {
        assert.equal(api.localizeError(literal), literal);
        for (const [key, values] of [
          ['column.managedBy', { name: literal }],
          ['rules.dialog.inputValue', { value: literal }],
          ['rules.conditionValue', { label: literal, value: literal }],
          ['grid.errorWithCause', { summary: 'diagnostic', error: literal }]
        ]) {
          const expected = String(new IntlMessageFormat(catalog.messages[locale][key], locale === 'en-XA' ? 'en' : locale,
            undefined, { ignoreTag: true }).format(values));
          assert.equal(api.t(key, values), expected);
          assert.equal(api.resolveMessage(api.message(key, values)), expected);
          assert.ok(expected.includes(literal));
        }
      }
    }
  });

  await check('export diagnostics: all locales preserve projected identities and nested typed causes across live switching', async () => {
    const { api } = await browserRuntime();
    const params = { table: 'Name cannot be empty. 日本語', tableId: 'table-identity', row: 'row-identity',
      column: 'error.parse {user-column}', target: 'target-identity' };
    const reference = { kind: 'code', code: 'error.export.referenceUnavailable', params };
    const parserDetails = 'Parser payload: error.parse {token} 日本語\nline 3: <unaltered>';
    const parse = { kind: 'code', code: 'error.parse', params: { details: parserDetails } };
    const path = 'Tables/利用者 {error.parse}.interface.toml';
    const loaded = { kind: 'code', code: 'error.interface.load', params: { path, error: parse } };
    const missing = { kind: 'code', code: 'error.interface.missingId', params: { id: 'source-interface' } };
    const context = 'source bytes 2..7 / row identity';
    const contextual = { kind: 'code', code: 'grid.errorWithCause', params: { summary: missing, error: { kind: 'text', text: context } } };
    const formula = { kind: 'code', code: 'error.export.formula', params: {
      table: params.table, tableId: params.tableId, row: params.row, column: params.column,
      columnId: 'column-identity', error: contextual
    } };
    const before = JSON.stringify({ reference, loaded, formula });
    const outputs = new Map();
    for (const locale of Object.keys(catalog.locales).filter(code => code !== 'en-XA')) {
      publishLocale(api, locale);
      const format = (key, values) => {
        assert.ok(Object.hasOwn(catalog.messages[locale], key), `${locale} must translate ${key} directly`);
        return new IntlMessageFormat(catalog.messages[locale][key], locale, undefined, { ignoreTag: true }).format(values);
      };
      assert.equal(api.localizeError(reference), format(reference.code, params));
      for (const value of Object.values(params)) assert.ok(api.localizeError(reference).includes(value));
      assert.equal(api.localizeError(loaded), format(loaded.code, { path, error: format(parse.code, parse.params) }));
      assert.ok(api.localizeError(loaded).includes(parserDetails));
      const cause = format(contextual.code, { summary: format(missing.code, missing.params), error: context });
      assert.equal(api.localizeError(formula), format(formula.code, { ...formula.params, error: cause }));
      assert.equal(api.localizeError({ kind: 'text', text: reference.code }), reference.code);
      outputs.set(locale, api.localizeError(reference));
    }
    publishLocale(api, 'ja'); assert.equal(api.localizeError(reference), outputs.get('ja'));
    publishLocale(api, 'en'); assert.equal(api.localizeError(reference), outputs.get('en'));
    assert.notEqual(outputs.get('ja'), outputs.get('en'));
    assert.equal(JSON.stringify({ reference, loaded, formula }), before, 'locale changes must not mutate wire data');
  });

  await check('always preserve original table names, Reference names, and typed custom validation text', async () => {
    const { api } = await browserRuntime();
    const marker = 'DEVCEL_APP_ERROR:' + JSON.stringify({ key: 'column.defaultValue' });
    for (const locale of ['ja', 'en', 'en-XA']) {
      await publishLocale(api, locale);
      for (const name of [marker, `Error: ${marker}`, '<script>user()</script>', 'column.defaultValue']) {
        assert.equal(api.resolveMessage(name), name);
        const customIssue = { table_uuid: 'table', column_uuid: 'column', record_uuid: 'row', kind: 'unique',
          diagnostic: { kind: 'text', text: name }, mode: 'warn', raw_value: name, effective_value: name, rule_key: 'user-rule', peers: [] };
        assert.equal(api.localizeError(customIssue), name);
        assert.equal(api.localizeError({ kind: 'input_validation', report: { issues: [customIssue], acknowledgement: 'same' } }), name);
      }
    }
  });

  await check('display unknown codes and invalid objects safely without inferring untagged diagnostics', async () => {
    const { api } = await browserRuntime({ locale: 'en' });
    assert.equal(api.localizeError({ kind: 'code', code: '__missing_code__', params: {} }), '[__missing_code__]');
    assert.equal(api.resolveMessage({ key: '__missing_key__', values: {} }), '[__missing_key__]');
    const objects = [{}, { code: 'column.defaultValue', params: {} }, { message: 'untagged diagnostic' },
      { kind: 'future', details: 'unrecognized variant' }, { kind: 'input_validation', report: {} }];
    for (const object of objects) {
      assert.equal(api.localizeError(object), api.t('common.error'));
      assert.notEqual(api.localizeError(object), '[object Object]');
    }
    const cycle = { kind: 'code', code: 'grid.errorWithCause', params: { summary: 'cycle' } };
    cycle.params.error = cycle;
    assert.doesNotThrow(() => api.localizeError(cycle));
    assert.ok(!api.localizeError(cycle).includes('[object Object]'));
  });

  await check('AppError/PluginBridge: preserve codes, free text, multiple diagnostics, and warning reports through JSON round trips', async () => {
    const { api } = await browserRuntime();
    const reports = { issues: [{ table_uuid: 't', column_uuid: 'c', record_uuid: 'r', kind: 'required',
      diagnostic: { kind: 'text', text: 'DEVCEL_INPUT_VALIDATION:これは利用者文' }, mode: 'warn', raw_value: '',
      effective_value: '', rule_key: 'same-rule', peers: [] }], acknowledgement: 'fixed-token' };
    const variants = [
      { kind: 'code', code: 'column.defaultValue', params: {} },
      { kind: 'text', text: 'DEVCEL_APP_ERROR:{"key":"common.save"}' },
      { kind: 'input_validation', report: reports },
      { kind: 'diagnostics', diagnostics: [{ kind: 'code', code: 'column.defaultValue', params: {} }, { kind: 'text', text: 'user' }] }
    ];
    const sourceFile = path.join(root, 'src/app/services/PluginBridge.ts');
    const compiled = compileModule(fs.readFileSync(sourceFile, 'utf8'), sourceFile);
    const bridgeModule = { exports: {} };
    vm.runInNewContext(compiled, { module: bridgeModule, exports: bridgeModule.exports, Error, Blob,
      require: name => name === '@/app/i18n' ? api : {}, console, Promise, Map, Set, Date, JSON, Object, Array, String,
      setTimeout, clearTimeout }, { filename: sourceFile });
    for (const value of variants) {
      const wrapped = api.appErrorException(value);
      assert.deepEqual(copy(api.toAppError(wrapped)), value);
      const encoded = await bridgeModule.exports.encodePluginValue(wrapped);
      assert.equal(encoded.__pluginWire, 'error');
      assert.equal('message' in encoded, false, 'the error wire requires a structured variant');
      const decoded = bridgeModule.exports.decodePluginValue(copy(encoded));
      for (const locale of ['ja', 'en', 'en-XA']) {
        await publishLocale(api, locale);
        assert.equal(api.localizeError(decoded), api.localizeError(value));
      }
    }
    const free = new Error('third-party text');
    assert.deepEqual(copy(api.toAppError(free)), { kind: 'text', text: 'third-party text' });
    const localized = api.localizedError(api.message('column.defaultValue'));
    assert.deepEqual(copy(api.toAppError(localized)), variants[0]);
    const source = path.join(root, 'src/app/types/tableRules.ts');
    const ruleModule = { exports: {} };
    vm.runInNewContext(compileModule(fs.readFileSync(source, 'utf8'), source),
      { module: ruleModule, exports: ruleModule.exports, Array }, { filename: source });
    assert.deepEqual(copy(ruleModule.exports.inputValidationReport(variants[2])), reports);
    assert.deepEqual(copy(ruleModule.exports.inputValidationReport(api.appErrorException(variants[2]))), reports);
    assert.equal(ruleModule.exports.inputValidationReport('DEVCEL_INPUT_VALIDATION:' + JSON.stringify(reports)), null);
    assert.equal(ruleModule.exports.inputValidationReport({ report: reports }), null);
  });

  await check('missing/broken ICU/unknown key: fall back to ja and avoid crashes even if all locales are broken', async () => {
    const fixture = copy(catalog);
    delete fixture.messages.en['common.save'];
    fixture.messages.en['common.close'] = 'broken {';
    fixture.messages.en['common.cancel'] = 'missing {notProvided}';
    const { api, warnings } = await browserRuntime({ locale: 'en', catalog: fixture });
    for (const key of ['common.save', 'common.close', 'common.cancel']) assert.equal(api.t(key), catalog.messages.ja[key]);
    assert.equal(api.t('__unknown_fixture_key__'), '[__unknown_fixture_key__]');
    assert.ok(warnings.length >= 2);
    const broken = copy(catalog);
    for (const locale of Object.keys(broken.messages)) broken.messages[locale]['common.save'] = 'broken {';
    const all = await browserRuntime({ locale: 'en', catalog: broken });
    assert.equal(all.api.t('common.save'), '[common.save]');
    const cycle = copy(catalog);
    cycle.locales.en.fallback = 'en-XA'; cycle.locales['en-XA'].fallback = 'en';
    delete cycle.messages.en['common.save']; delete cycle.messages['en-XA']['common.save'];
    assert.equal((await browserRuntime({ locale: 'en', catalog: cycle })).api.t('common.save'), catalog.messages.ja['common.save']);
  });

  await check('arguments containing HTML remain safe plain strings', async () => {
    const { api } = await browserRuntime({ locale: 'en' });
    const html = '<img src=x onerror="globalThis.__i18nExecuted=true">&<script>bad()</script>';
    const value = api.t('column.managedBy', { name: html });
    assert.equal(typeof value, 'string'); assert.ok(value.includes(html));
    assert.equal(globalThis.__i18nExecuted, undefined);
    const React = studioRequire('react');
    const { renderToStaticMarkup } = studioRequire('react-dom/server');
    const markup = renderToStaticMarkup(React.createElement('div', null, value));
    assert.ok(markup.includes('&lt;img'));
    assert.ok(!markup.includes('<img') && !markup.includes('<script'));
  });

  await check('plugin catalogs: protect namespace conflicts, input validation, fallback, isolation, and cleanup generations', async () => {
    const { api } = await browserRuntime({ locale: 'en' });
    api.applyPluginTranslationTables({
      'fixture.tables': { en: { title: 'Table English', 'common.save': 'Plugin only' }, ja: { title: 'テーブル日本語' } },
      'fixture.other': { en: { title: 'Other owner' } },
    });
    assert.equal(api.translatePluginMessage('fixture.tables','title'),'Table English');
    assert.equal(api.translatePluginMessage('fixture.other','title'),'Other owner');
    assert.notEqual(api.t('common.save'), 'Plugin only', 'local plugin keys cannot override the core namespace');
    const coded = (code, params) => error => { assert.deepEqual(copy(api.toAppError(error)), {kind:'code',code,params}); return true; };
    assert.throws(()=>api.registerPluginMessages('fixture.tables',{en:{title:'Override'}}), coded('plugin.i18n.error.collision',{owner:'fixture.tables',key:'title'}));
    const cleanupExtra=api.registerPluginMessages('fixture.tables',{en:{extra:'Runtime extra'}});
    assert.equal(api.translatePluginMessage('fixture.tables','extra'),'Runtime extra'); cleanupExtra();
    api.applyPluginTranslationTables({'fixture.tables':{en:{title:'Edited in table'}}});
    assert.equal(api.translatePluginMessage('fixture.tables','title'),'Edited in table');
    assert.equal(api.translatePluginMessage('fixture.other','title',undefined,'missing'),'missing');
    api.applyPluginTranslationTables({});
    const removeFirst = api.registerPluginMessages('fixture.editor', { ja: { hello: 'こんにちは {name}', onlyJa: '日本語fallback' }, en: { hello: 'Hello {name}' } });
    assert.equal(api.translatePluginMessage('fixture.editor', 'hello', { name: sentinel }), `Hello ${sentinel}`);
    assert.equal(api.translatePluginMessage('fixture.editor', 'onlyJa'), '日本語fallback');
    assert.throws(() => api.registerPluginMessages('fixture.editor', {}), coded('plugin.i18n.error.namespace',{owner:'fixture.editor'}));
    assert.throws(() => api.registerPluginMessages('../invalid', {}), coded('plugin.i18n.error.namespace',{owner:'../invalid'}));
    assert.throws(() => api.registerPluginMessages('invalid.locale', { zz: { hello: 'Hi' } }), coded('plugin.i18n.error.locale',{owner:'invalid.locale',locale:'zz'}));
    assert.throws(() => api.registerPluginMessages('invalid.key', { en: { '../raw-key': 'Literal text' } }), coded('plugin.i18n.error.message',{owner:'invalid.key',key:'../raw-key'}));
    assert.throws(() => api.registerPluginMessages('invalid.text', { en: { rawKey: 42 } }), coded('plugin.i18n.error.message',{owner:'invalid.text',key:'rawKey'}));
    let syntaxError;
    assert.throws(() => api.registerPluginMessages('invalid.message', { en: { broken: 'Bad {' } }), error => {
      syntaxError = api.toAppError(error);
      assert.equal(syntaxError.kind, 'code'); assert.equal(syntaxError.code, 'plugin.i18n.error.syntax');
      assert.equal(syntaxError.params.owner, 'invalid.message'); assert.equal(syntaxError.params.key, 'broken');
      assert.equal(syntaxError.params.error.kind, 'text'); assert.ok(syntaxError.params.error.text.length > 0);
      return true;
    });
    assert.equal(api.translatePluginMessage('fixture.editor', 'missing', undefined, 'Existing plugin label'), 'Existing plugin label');
    assert.equal(api.translatePluginMessage('fixture.editor', 'hello', {}, 'Existing plugin label'), 'Existing plugin label');
    assert.equal(api.t('common.save'), catalog.messages.en['common.save']);
    removeFirst();
    assert.equal(api.translatePluginMessage('fixture.editor', 'hello', { name: sentinel }, 'Existing plugin label'), 'Existing plugin label');
    const removeSecond = api.registerPluginMessages('fixture.editor', { en: { hello: 'Second {name}' } });
    removeFirst(); // Old cleanup must not remove a newer registration in the same namespace.
    assert.equal(api.translatePluginMessage('fixture.editor', 'hello', { name: sentinel }), `Second ${sentinel}`);
    removeSecond();
    const removeAfterFailure = api.registerPluginMessages('invalid.message', { en: { good: 'Recovered' } });
    assert.equal(api.translatePluginMessage('invalid.message', 'good'), 'Recovered'); removeAfterFailure();
  });

  await check('i18n consumes only settings project snapshots without independent locale mutations or localStorage', async () => {
    assert.doesNotMatch(runtimeSource, /get_locale_settings|set_locale_preference|devcel-locale-changed|localStorage/);
    const runtime = await browserRuntime({ native: true, languages: ['en-US'], unrelatedLocale: 'ja' });
    assert.equal(runtime.api.getLocale(), 'en'); assert.equal(runtime.api.getLocalePreference(), null);
    assert.equal('setLocalePreference' in runtime.api, false);
    publishLocale(runtime.api, 'ja');
    assert.equal(runtime.api.getLocale(), 'ja'); assert.equal(runtime.storage.get('other-app.locale'), 'ja');
    assert.deepEqual(runtime.storageCalls, []);
  });

  await check('reloading the same-locale translation table clears compiled ICU cache and updates fallback and locale metadata', async () => {
    const { api, document } = await browserRuntime({ locale: 'en' });
    api.t('common.save'); api.t('column.managedBy', { name: sentinel });
    const changed = copy(catalog);
    changed.messages.en['common.save'] = 'Runtime table save';
    changed.messages.en['column.managedBy'] = 'Runtime table owner: {name}';
    changed.locales.en.displayName = 'Runtime English'; changed.locales.en.direction = 'rtl';
    publishLocale(api, 'en', changed);
    assert.equal(api.t('common.save'), 'Runtime table save');
    assert.equal(api.t('column.managedBy', { name: sentinel }), `Runtime table owner: ${sentinel}`);
    assert.equal(api.getLocaleName('en'), 'Runtime English'); assert.equal(document.documentElement.dir, 'rtl');
    const fallback = copy(changed); delete fallback.messages.en['common.save'];
    publishLocale(api, 'en', fallback); assert.equal(api.t('common.save'), catalog.messages.ja['common.save']);
    publishLocale(api, 'en', catalog); assert.equal(api.t('common.save'), catalog.messages.en['common.save']);
    assert.equal(document.documentElement.dir, 'ltr');
  });

  await check('number formatters reuse identical options and invalidate cache when the project snapshot changes', async () => {
    let constructed = 0;
    const realIntl = Intl;
    const instrumented = Object.create(realIntl);
    instrumented.NumberFormat = class extends realIntl.NumberFormat { constructor(...args) { super(...args); constructed++; } };
    const { api } = await browserRuntime({ locale: 'en', Intl: instrumented });
    const expected = new realIntl.NumberFormat('en', { minimumFractionDigits: 2 }).format(12.5);
    assert.equal(api.formatNumber(12.5, { minimumFractionDigits: 2 }), expected);
    assert.equal(api.formatNumber(12.5, { minimumFractionDigits: 2 }), expected); assert.equal(constructed, 1);
    publishLocale(api, 'en', copy(catalog));
    assert.equal(api.formatNumber(12.5, { minimumFractionDigits: 2 }), expected); assert.equal(constructed, 2);
  });

  await check('subscriptions, unsubscriptions, and failing-subscriber isolation survive runtime snapshot updates', async () => {
    const { api, warnings } = await browserRuntime({ languages: ['ja-JP'] });
    const snapshots = [];
    const removeBroken = api.subscribeLocale(() => { throw new Error('subscriber failure'); });
    const remove = api.subscribeLocale(() => snapshots.push(api.useI18n().locale));
    publishLocale(api, 'en'); assert.deepEqual(snapshots, ['en']); assert.equal(warnings.length, 1);
    publishLocale(api, 'ja'); assert.deepEqual(snapshots, ['en', 'ja']); assert.equal(warnings.length, 2);
    remove(); removeBroken(); publishLocale(api, 'en-XA'); assert.equal(snapshots.length, 2);
  });

  await check('dates, numbers, and native titles: 64-bit precision, invalid dates, and display-only locale changes', async () => {
    const runtime = await browserRuntime({ native: true, pathname: '/table_rule_dialog' });
    await publishLocale(runtime.api, 'en');
    assert.equal(runtime.api.formatNumber(18446744073709551615n), new Intl.NumberFormat('en').format(18446744073709551615n));
    assert.equal(runtime.api.formatNumber(0.125, { style: 'percent' }), new Intl.NumberFormat('en', { style: 'percent' }).format(0.125));
    const date = new Date('2026-01-02T03:04:05Z'); const options = { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' };
    assert.equal(runtime.api.formatDateTime(date, options), new Intl.DateTimeFormat('en', options).format(date));
    assert.equal(runtime.api.formatDateTime(NaN), runtime.api.t('common.unknownDate'));
    await tick(); assert.equal(runtime.document.title, runtime.api.t('window.rules'));
    assert.equal(runtime.titles.at(-1), runtime.api.t('window.rules'));
  });

  await checkRealReactState();
  console.log(`\nLocalization runtime: ${checks.passed} passed, ${checks.failed} failed, ${checks.skipped} skipped; ${checks.formatted} real ICU formats.`);
  if (checks.failed) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
