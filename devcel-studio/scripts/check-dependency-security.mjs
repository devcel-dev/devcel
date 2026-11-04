import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const studio = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(studio, 'package.json'));
const wywRequire = createRequire(require.resolve('@wyw-in-js/transform'));
// Exercise both consumers, including a nested dependency if npm creates one.
const domModules = new Set([require.resolve('happy-dom'), wywRequire.resolve('happy-dom')]);
for (const entry of domModules) {
  const { Window } = await import(pathToFileURL(entry));
  const { default: Compiler } = await import(pathToFileURL(resolve(dirname(entry), 'module/ECMAScriptModuleCompiler.js')));
  const window = new Window({ settings: { enableJavaScriptEvaluation: true, disableErrorCapturing: true } });
  try {
    const run = async (source) => {
      const module = new Compiler(window).compile('https://fixture.invalid/main.js', source);
      await module.execute({ imports: new Map([['https://fixture.invalid/data.json', { value: 7 }]]) });
    };
    await run('import { value as validAlias } from "./data.json" with { type: "json" }; globalThis.validResult = validAlias;');
    assert.equal(window.validResult, 7, 'Valid aliases still execute');
    // Only a local sentinel: no network, host process, or filesystem access.
    await run('import { missing as invalidAlias = globalThis.invalidAliasExecuted = true } from "./data.json" with { type: "json" };');
    assert.equal(window.invalidAliasExecuted, undefined, 'Invalid import aliases must not become executable initializers');
  } finally {
    await window.happyDOM.close();
  }
}

// Run the algorithmic-complexity regression in a bounded child so a vulnerable
// dependency cannot hang the complete check. No timing ratio assertion is used.
const markdown = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import MarkdownIt from 'markdown-it';
  const md = new MarkdownIt();
  assert.equal(md.render('**text**'), '<p><strong>text</strong></p>\\n');
  for (const source of ['[a]: /u "' + 'x\\n'.repeat(400000), '[' + 'a\\n'.repeat(100000)]) {
    assert.equal(typeof md.render(source), 'string');
  }
`], { cwd: studio, encoding: 'utf8', timeout: 10000 });
assert.ifError(markdown.error);
assert.equal(markdown.status, 0, markdown.stderr);
console.log('PASS patched direct/WyW module aliases and bounded Markdown reference parsing');
