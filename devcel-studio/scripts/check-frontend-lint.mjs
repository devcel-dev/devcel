import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(studio, '.oxlintrc.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(studio, 'package.json'), 'utf8'));
const executable = path.join(studio, 'node_modules/oxlint/bin/oxlint');
const args = manifest.scripts.lint.split(' ');
assert.equal(args.shift(), 'oxlint');
assert.deepEqual(args.slice(-2), ['src', 'vite.config.ts']);
const gateArgs = args.slice(0, -2);
assert(gateArgs.includes('--deny-warnings'));
assert.deepEqual(gateArgs.slice(gateArgs.indexOf('--max-warnings'), gateArgs.indexOf('--max-warnings') + 2), ['--max-warnings', '0']);
assert(gateArgs.includes('--no-ignore'));
assert.deepEqual(config.ignorePatterns, []);
assert.equal(config.options.denyWarnings, true);
assert.equal(config.options.maxWarnings, 0);
assert.equal(manifest.devDependencies.oxlint, '1.89.0');

function run(extra) {
  const result = spawnSync(process.execPath, [executable, ...extra], { cwd: studio, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, result.stderr);
  return result;
}

// Freeze the complete nonexperimental correctness inventory, rather than a
// small handpicked set. Compiler checks are opt-in and do not apply to this
// application's non-compiler build. Type checking uses the pinned tsc instead.
const compilerRules = new Set([
  'error-boundaries', 'globals', 'immutability', 'incompatible-library',
  'preserve-manual-memoization', 'purity', 'refs', 'set-state-in-effect',
  'set-state-in-render', 'static-components', 'use-memo', 'void-use-memo',
]);
const available = run(['--rules', '--format', 'json']);
assert.equal(available.status, 0, available.stderr);
const plugins = new Set(['eslint', ...config.plugins]);
const expectedRules = JSON.parse(available.stdout)
  .filter(rule => plugins.has(rule.scope) && !rule.type_aware
    && (rule.category === 'correctness' || (rule.scope === 'react' && rule.value === 'rules-of-hooks'))
    && !(rule.scope === 'react' && compilerRules.has(rule.value)))
  .map(rule => `${rule.scope}/${rule.value}`).sort();
assert.deepEqual(Object.keys(config.rules).sort(), expectedRules);
assert.equal(expectedRules.length, 116);
assert(Object.values(config.rules).every(level => level === 'error'));

const discovered = run([...gateArgs, '--debug', 'files', 'src', 'vite.config.ts']);
assert.equal(discovered.status, 0, discovered.stderr);
const selected = discovered.stdout.trim().split(/\r?\n/).map(file => file.replaceAll('\\', '/')).sort();
const expectedFiles = fs.readdirSync(path.join(studio, 'src'), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name))
  .map(entry => path.relative(studio, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
expectedFiles.push('vite.config.ts');
assert.deepEqual(selected, expectedFiles.sort(), 'Lint must cover every authored, vendored, and generated application source.');

const compiler = path.join(studio, 'node_modules/typescript/bin/tsc');
const compilerConfig = spawnSync(process.execPath, [compiler, '--showConfig'], { cwd: studio, encoding: 'utf8' });
if (compilerConfig.error) throw compilerConfig.error;
assert.equal(compilerConfig.status, 0, compilerConfig.stdout + compilerConfig.stderr);
const compilerOptions = JSON.parse(compilerConfig.stdout).compilerOptions;
for (const option of ['strict', 'noUnusedLocals', 'noUnusedParameters', 'noFallthroughCasesInSwitch']) {
  assert.equal(compilerOptions[option], true, `The compiler must retain ${option}.`);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-lint-'));
try {
  const cases = [
    ['clean.tsx', 'export function Example({ value }: { value: string }) { return <span>{value}</span>; }', null],
    ['unused.ts', 'export function example() { const unused = 1; return 0; }', 'eslint(no-unused-vars)'],
    ['enum.ts', 'export enum Example { First = 1, Second = 1 }', 'typescript(no-duplicate-enum-values)'],
    ['hooks.tsx', 'import { useState } from "react"; export function Example({ ready }: { ready: boolean }) { if (ready) useState(0); return null; }', 'react-hooks(rules-of-hooks)'],
    ['dependencies.tsx', 'import { useEffect } from "react"; export function Example({ value }: { value: string }) { useEffect(() => console.log(value), []); return null; }', 'react-hooks(exhaustive-deps)'],
    ['warning.ts', 'debugger; export const value = 1;', 'eslint(no-debugger)'],
  ];
  for (const [name, source, expected] of cases) {
    const file = path.join(temporary, name);
    fs.writeFileSync(file, source);
    const result = run([...gateArgs, ...(name === 'warning.ts' ? ['--warn', 'eslint/no-debugger'] : []), '--format', 'json', file]);
    const diagnostics = JSON.parse(result.stdout).diagnostics;
    assert.equal(result.status, expected ? 1 : 0, `${name}: ${result.stdout}\n${result.stderr}`);
    if (expected) assert(diagnostics.some(item => item.code === expected), `${name}: expected ${expected}: ${result.stdout}`);
    else assert.deepEqual(diagnostics, []);
    if (name === 'warning.ts') {
      assert.equal(diagnostics.length, 1, result.stdout);
      assert.equal(diagnostics[0].severity, 'warning', result.stdout);
    }
  }
  const typeFixture = path.join(temporary, 'type-error.ts');
  const typeConfig = path.join(temporary, 'tsconfig.json');
  fs.writeFileSync(typeFixture, 'export const value: number = "not a number";');
  fs.writeFileSync(typeConfig, JSON.stringify({
    extends: path.join(studio, 'tsconfig.json'),
    compilerOptions: { types: [] },
    files: [typeFixture], include: [], references: [],
  }));
  const typecheck = spawnSync(process.execPath, [compiler, '--noEmit', '--project', typeConfig], {
    cwd: studio, encoding: 'utf8',
  });
  if (typecheck.error) throw typecheck.error;
  assert.equal(typecheck.signal, null, typecheck.stderr);
  assert.notEqual(typecheck.status, 0, typecheck.stdout + typecheck.stderr);
  assert.match(typecheck.stdout, /TS2322/, 'The strict compiler must reject an actual incompatible assignment.');
  console.log(`PASS frontend lint: ${expectedRules.length} stable correctness rules, ${selected.length} source files, six rejecting compiler/lint fixtures (including one warning), and one clean fixture.`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
