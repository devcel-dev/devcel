import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-formula-tokens-'));
try {
  const out = path.join(work, 'tokens.cjs');
  esbuild.buildSync({ entryPoints: [path.join(studio, 'src/app/utils/formulaTokens.ts')], outfile: out,
    bundle: true, platform: 'node', format: 'cjs' });
  const { tokenizeFormula: scan, insertFormulaCompletion: insert, quoteFormulaName, quoteFormulaString } = require(out);
  assert.equal(quoteFormulaName('enemy hp'), '`enemy hp`');
  assert.equal(quoteFormulaName('a`b'), '`a``b`');
  for (const name of ['TRUE', '123', 'SUM', '変数', '😀']) assert.equal(scan(quoteFormulaName(name))[0].text, name);
  assert.equal(quoteFormulaString('Drops "rare"'), '"Drops ""rare"""');
  assert.equal(quoteFormulaString('${enemy.hp}'), '"$${enemy.hp}"');
  const tokens = scan('=MAP(TABLE("Drops"), reward => reward.enemy.hp)');
  assert.deepEqual(tokens.filter(t => t.kind === 'name').map(t => t.text), ['MAP', 'TABLE', 'reward', 'reward', 'enemy', 'hp']);
  assert(tokens.some(t => t.text === '=>' && t.kind === 'punctuation'));
  for (const source of ['=SUM(a,', '=TABLE("Dr', '=`enemy h', '=LET(x,1,x', '=a>=b && b<>c', '=😀.名前', '=a\n+ b']) {
    let previous = 0;
    for (const token of scan(source)) {
      assert(token.start >= previous && token.end > token.start && token.end <= source.length);
      previous = token.end;
    }
  }
  assert.equal(scan('=TABLE("Dr').at(-1).closed, false);
  assert.equal(scan('=`a``b`').at(-1).text, 'a`b');
  assert.equal(scan('="a""b"').at(-1).text, 'a"b');
  assert.equal(scan('="text => not a lambda"').length, 2);
  assert.deepEqual(insert('=SU+2', { start: 1, end: 3, expected: 'SU' }, 'SUM()', 4), { value: '=SUM()+2', caret: 5 });
  assert.deepEqual(insert('=😀+x', { start: 4, end: 5, expected: 'x' }, '`名前`'), { value: '=😀+`名前`', caret: 8 });
  assert.equal(insert('=changed', { start: 1, end: 3, expected: 'SU' }, 'SUM()'), null);
  assert.equal(insert('=😀', { start: 1, end: 2, expected: '\uD83D' }, 'x'), null);
  for (const [start, end] of [[-1, 1], [2, 1], [0, 999], [0.5, 1]]) {
    assert.equal(insert('abc', { start, end, expected: 'a' }, 'b'), null);
  }
  console.log('PASS formula token boundaries, native quoting, Unicode insertion and stale-draft rejection');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
