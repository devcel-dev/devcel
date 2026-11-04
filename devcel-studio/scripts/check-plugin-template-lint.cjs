'use strict';
const assert = require('node:assert/strict');
const { createSourceParser } = require('./typescript-analysis.cjs');
const { inspectSource } = require('../templates/plugin-template/scripts/check-source.cjs');
const parser = createSourceParser();
const rejected = [
  ['explained-type-check', '// @ts-ignore\nconst value = missing;'],
  ['explained-type-check', '// @ts-expect-error\nconst value = missing;'],
  ['array-literal', 'export const values = new Array(1, 2);'],
  ['unique-enum', 'enum Example { A = "a", B = "a" }'],
  ['explicit-object-type', 'type Empty = {};'],
  ['single-non-null', 'export const value = source!!;'],
  ['constructor-shape', 'interface Example { new(): Example }'],
  ['constructor-shape', 'class Example { new(): Example { return this; } }'],
  ['es-modules', 'namespace Example { export const value = 1; }'],
  ['optional-chain-result', 'export const value = source?.item!;'],
  ['es-imports', 'const fs = require("node:fs");'],
  ['used-catch-binding', 'try { call(); } catch (error) {}'],
  ['no-this-alias', 'let self; self = this;'],
  ['function-signature', 'interface Example extends Function {}'],
  ['no-this-alias', 'class Example { method() { const self = this; return self; } }'],
  ['meaningful-constraint', 'type Example<T extends unknown> = T;'],
  ['separate-declarations', 'interface Example { value: string; } class Example {}'],
  ['function-signature', 'export let callback: Function;'],
  ['effectful-expression', 'value;'],
  ['primitive-types', 'export let value: String;'],
  ['literal-inference', 'export const value = "a" as "a";'],
  ['es-modules', 'module Example { export const value = 1; }'],
  ['module-references', '/// <reference path="./other.ts" />\nexport const value = 1;'],
];
const accepted = [
  'export const value = 1;',
  '// @ts-expect-error deliberate invalid fixture\nexport const value = missing;',
  'export const text = `// @ts-ignore`; ',
  'export const values = new Array<number>(3);',
  'export type Callback = (value: string) => void;',
  'export function value() { "use strict"; call(); return 1; }',
  'export const value = "a" as const;',
  '/// <reference lib="dom" />\nexport const value = 1;',
];
try {
  for (const [rule, text] of rejected) {
    const { source, diagnostics } = parser.parse('fixture.ts', text);
    assert.equal(diagnostics.length, 0);
    assert(inspectSource(source).some(issue => issue.rule === rule), `${rule}: ${text}`);
  }
  for (const text of accepted) {
    const { source, diagnostics } = parser.parse('fixture.ts', text);
    assert.equal(diagnostics.length, 0);
    assert.deepEqual(inspectSource(source), [], text);
  }
  console.log(`PASS plugin source safety: ${rejected.length} rejecting and ${accepted.length} accepting fixtures`);
} finally { parser.close(); }
