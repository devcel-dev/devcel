import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, createLogger } from 'vite';
import { catalogChunks, catalogLocaleGroup } from './catalog-chunks.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-catalog-chunks-'));
const i18nFile = path.join(root, 'src/app/i18n/generated/catalog.json');
const settingsFile = path.join(root, 'src/app/settings/generated/catalog.json');
const originalI18n = JSON.parse(fs.readFileSync(i18nFile, 'utf8'));
const originalSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const warnings = [];
try {
  const output = await build({
    configFile: false, root, logLevel: 'error',
    plugins: [catalogChunks(root), {
      name: 'catalog-test-entry',
      resolveId(id) { if (id === 'catalog-test-entry') return '\0catalog-test-entry'; },
      load(id) { if (id === '\0catalog-test-entry') return `
        export { default as i18n } from ${JSON.stringify(i18nFile)};
        export * as i18nExports from ${JSON.stringify(i18nFile)};
        export { default as settings } from ${JSON.stringify(settingsFile)};
        export * as settingsExports from ${JSON.stringify(settingsFile)};
      `; },
    }],
    build: {
      write: false, minify: false, target: 'es2020',
      rolldownOptions: {
        input: 'catalog-test-entry',
        onwarn(warning) { warnings.push(warning); },
        preserveEntrySignatures: 'strict',
        output: { format: 'es', entryFileNames: 'entry.mjs', chunkFileNames: '[name].mjs', codeSplitting: { groups: [catalogLocaleGroup] } },
      },
    },
  });
  assert.deepEqual(warnings, []);
  const chunks = output.output.filter(item => item.type === 'chunk');
  const localeChunks = chunks.filter(item => item.fileName.startsWith('locale-'));
  assert.equal(localeChunks.length, Object.keys(originalI18n.messages).length);
  for (const chunk of localeChunks) {
    assert.deepEqual(chunk.imports, [], `Locale chunk must be a leaf: ${chunk.fileName}`);
    assert.deepEqual(chunk.dynamicImports, []);
  }
  for (const chunk of chunks) fs.writeFileSync(path.join(temp, chunk.fileName), chunk.code);
  const { i18n, settings, i18nExports, settingsExports } = await import(pathToFileURL(path.join(temp, 'entry.mjs')));
  assert.deepEqual(i18n, originalI18n);
  assert.deepEqual(settings, originalSettings);
  assert.equal(JSON.stringify(i18n), JSON.stringify(originalI18n));
  assert.equal(JSON.stringify(settings), JSON.stringify(originalSettings));
  for (const [value, exports] of [[i18n, i18nExports], [settings, settingsExports]]) {
    for (const key of Object.keys(value)) assert.equal(exports[key], value[key]);
    assert.equal(exports.default, value);
  }
  assert.notEqual(i18n, settings.localization);
  assert.notEqual(i18n.messages, settings.localization.messages);
  assert.notEqual(i18n.locales, settings.localization.locales);
  for (const locale of Object.keys(originalI18n.messages)) {
    assert.notEqual(i18n.messages[locale], settings.localization.messages[locale]);
    assert.notEqual(i18n.locales[locale], settings.localization.locales[locale]);
    const key = Object.keys(i18n.messages[locale])[0];
    i18n.messages[locale][key] = 'independent i18n mutation';
    assert.equal(settings.localization.messages[locale][key], originalSettings.localization.messages[locale][key]);
    settings.localization.locales[locale].displayName = 'independent settings mutation';
    assert.equal(i18n.locales[locale].displayName, originalI18n.locales[locale].displayName);
  }
  console.log(`PASS exact values, metadata, property order, named/default identity and mutation isolation across ${localeChunks.length} shared locale payloads`);
  console.log('PASS locale payload chunks have no dependencies or initialization cycles');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

if (process.argv.includes('--production')) {
  const messages = [];
  const logger = createLogger('error');
  logger.warn = message => messages.push(message);
  logger.warnOnce = message => messages.push(message);
  const result = await build({ root, configFile: path.join(root, 'vite.config.ts'), customLogger: logger, build: { write: false } });
  assert.deepEqual(messages, [], 'Production build must not emit warnings');
  const chunks = result.output.filter(item => item.type === 'chunk');
  const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
  const complete = new Set();
  function visit(name, stack = []) {
    assert(!stack.includes(name), `Static initialization cycle: ${[...stack, name].join(' -> ')}`);
    if (complete.has(name)) return;
    const chunk = byName.get(name);
    assert(chunk, `Missing static chunk ${name}`);
    for (const dependency of chunk.imports) visit(dependency, [...stack, name]);
    complete.add(name);
  }
  for (const chunk of chunks) {
    visit(chunk.fileName);
    for (const dependency of chunk.dynamicImports) assert(byName.has(dependency), `Missing route chunk ${dependency}`);
    assert(Buffer.byteLength(chunk.code) < 2000 * 1000, `Oversized chunk ${chunk.fileName}`);
  }
  const payloads = chunks.filter(chunk => chunk.fileName.startsWith('assets/locale-'));
  assert.equal(payloads.length, Object.keys(originalI18n.messages).length);
  for (const chunk of payloads) assert.deepEqual(chunk.imports, []);
  const largest = chunks.reduce((max, chunk) => Math.max(max, Buffer.byteLength(chunk.code)), 0);
  console.log(`PASS production build: zero warnings, ${chunks.length} chunks, ${payloads.length} locale leaves, no static cycles or missing route imports; largest ${largest} bytes`);
}
