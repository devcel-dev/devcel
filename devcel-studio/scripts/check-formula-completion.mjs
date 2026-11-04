import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-formula-completion-'));
try {
  const out = path.join(work, 'completion.cjs');
  require('esbuild').buildSync({ entryPoints: [path.join(studio, 'src/app/utils/formulaCompletion.ts')], outfile: out, bundle: true, platform: 'node', format: 'cjs' });
  const { completeFormula } = require(out);
  const col = (name, type = 'Number', extra = {}) => ({ uuid: name, data_name: name, display_name: name, data_type: type, ...extra });
  const catalog = { functions: ['SUM', 'MAP', 'TABLE', 'LET', 'LETREC'], currentTable: 'drops', tables: [
    { uuid: 'drops', data_name: 'Drops', display_name: 'Rewards', columns: [col('price'), col('enemy', 'Reference', { reference_config: { target_table_uuid: 'enemies' } })] },
    { uuid: 'enemies', data_name: 'Enemies', display_name: 'Enemies', columns: [col('hp'), col('boss', 'Reference', { reference_config: { target_table_uuid: 'enemies' } })] },
  ] };
  const complete = (text, cat = catalog) => {
    const caret = text.indexOf('|');
    assert(caret >= 0);
    return completeFormula(text.replace('|', ''), caret, cat);
  };
  const labels = text => complete(text)?.candidates.map(c => c.label) ?? [];
  assert.equal(complete('plain|'), null);
  assert.equal(complete('="plain|"'), null);
  assert.equal(complete('=SUM(1)|'), null);
  assert.equal(complete('=enemy |'), null);
  assert(complete('=SUM(1)+|').candidates.some(c => c.label === 'SUM'));
  assert(labels('=SU|').includes('SUM'));
  assert(labels('=pr|').includes('price'));
  assert(labels('=enemy.|').includes('hp'));
  assert(!labels('=enemy.|').includes('price'));
  assert(labels('=enemy.boss.|').includes('hp'));
  assert(labels('=MAP(TABLE("Drops"), reward => reward.|)').includes('price'));
  assert(labels('=MAP(TABLE("Drops"), reward => reward.enemy.|)').includes('hp'));
  assert(labels('=LET(x,enemy,x.|)').includes('hp'));
  assert(!labels('=LET(x,enemy,1)+x.|').includes('hp'));
  assert(!labels('=LET(x,x.|,1)').includes('hp'));
  assert(labels('=LET(enemy,1,enemy.|)').length === 0);
  assert(labels('=LET(enemy,1,`enemy`.|)').includes('hp'));
  assert(labels('=MAP(TABLE("Drops"), r => MAP(TABLE("Enemies"), r => r.|))').includes('hp'));
  assert(!labels('=MAP(TABLE("Drops"), r => MAP(TABLE("Enemies"), r => r.|))').includes('price'));
  assert(labels('=LETREC(f,x=>f|,f(1))').includes('f'));
  assert(!labels('=LET(f,x=>f|,f(1))').includes('f'));
  assert.equal(complete('=LET(ne|,1,2)'), null);
  assert(labels('=MAP(TABLE("Drops"), r => {nested:r.enemy}.nested.|)').includes('hp'));
  const table = complete('=TABLE("Dr|ops")').candidates.find(c => c.kind === 'table');
  assert.equal(table.insert, '"Drops"');
  assert.equal(complete('=TABLE("Dr|ops")').expected, '"Drops"');
  const missing = structuredClone(catalog); missing.tables = missing.tables.filter(t => t.uuid !== 'enemies');
  assert.deepEqual(complete('=enemy.|', missing).candidates, []);
  const lazy = structuredClone(catalog); delete lazy.tables[1].columns;
  assert.deepEqual(complete('=enemy.|', lazy).neededTables, ['enemies']);
  const renamed = structuredClone(catalog); renamed.tables[1].columns[0] = col('health');
  assert(!complete('=enemy.|', renamed).candidates.some(c => c.label === 'hp'));
  const ambiguous = structuredClone(catalog); ambiguous.tables[0].columns.push(col('price', 'String', { uuid: 'duplicate' }));
  assert(!complete('=pr|', ambiguous).candidates.some(c => c.kind === 'column'));
  const sparse = structuredClone(catalog);
  for (const table of sparse.tables) for (const column of table.columns) delete column.display_name;
  assert(complete('=pr|', sparse).candidates.some(c => c.label === 'price'));
  assert(complete('=enemy.|', sparse).candidates.some(c => c.label === 'hp'));
  assert(labels('=MAP(TABLE("Rewards"), r=>r.|)').includes('price'));
  assert(labels('=LETREC(f,(x=>f|),f(1))').includes('f'));
  assert(!labels('=LET(x,enemy,(x=>x.|))').includes('hp'));
  assert.deepEqual(labels('=MAP(GROUPBY(TABLE("Drops"),r=>r.price),g=>g.|)'), ['key', 'rows']);
  assert(labels('=MAP(GROUPBY(TABLE("Drops"),r=>r.price),g=>MAP(g.rows,r=>r.enemy.|))').includes('hp'));
  assert.equal(complete('=SU|M(1)').candidates.find(c => c.label === 'SUM').insert, 'SUM');
  assert(labels('="HP: ${enemy.|}"').includes('hp'));
  assert(labels('=LET(e,enemy,"HP: ${e.|}")').includes('hp'));
  assert.equal(complete('="literal $${enemy.|}"'), null);
  assert(labels('="${MAP(TABLE(""Drops""),r=>r.enemy.|)}"').includes('hp'));
  assert.equal(complete('=LOOKUP("Drops","pr|",1,"price")').candidates.find(c => c.label === 'price').insert, '"price"');
  assert(complete('=TABLE("|")').candidates.every(c => c.kind === 'table'), 'quoted table names cannot insert local variables or column expressions');
  const collision = structuredClone(catalog);
  collision.tables[1].display_name = 'Drops';
  assert(complete('=MAP(TABLE("Drops"),r=>r.|)', collision).candidates.some(c => c.label === 'price'), 'internal names precede display aliases');
  collision.tables[1].data_name = 'drops';
  assert(complete('=MAP(TABLE("drops"),r=>r.|)', collision).candidates.some(c => c.label === 'price'), 'UUID precedes internal names');
  const interfaces = structuredClone(catalog);
  interfaces.tables[0].columns.push(col('source', 'TableRef', { table_ref_config: { interface_uuid: 'damage' } }));
  interfaces.tables.push({ uuid: 'interface:damage', data_name: 'Damageable', isInterface: true, columns: [col('health')] });
  assert.deepEqual(complete('=MAP(TABLE(source),r=>r.|)', interfaces).candidates.map(c => c.label), ['health']);
  delete interfaces.tables[2].columns;
  assert.deepEqual(complete('=MAP(TABLE(source),r=>r.|)', interfaces).neededTables, ['interface:damage']);
  assert(labels('=MAP(MAP(TABLE("Drops"),(r=>r.enemy)),e=>e.|)').includes('hp'));
  assert(labels('=MAP([enemy,enemy],r=>r.|)').includes('hp'));
  assert.deepEqual(labels('=MAP([enemy,1],r=>r.|)'), [], 'heterogeneous arrays cannot inherit only the first item schema');
  for (const name of ['MAP','FILTER','GROUPBY','REDUCE','JOIN']) {
    const args = name === 'REDUCE' ? 'TABLE("Drops"),0,(a,r)=>r.|' : name === 'JOIN' ? 'TABLE("Drops"),TABLE("Drops"),(r,s)=>r.|' : 'TABLE("Drops"),r=>r.|';
    assert.deepEqual(labels(`=LET(${name},(xs,f)=>f(1),${name}(${args}))`), [], `${name} local function cannot infer builtin callback schema`);
    assert.deepEqual(labels(`=LET(r,enemy,LET(${name},(xs,f)=>f(1),${name}(${args})))`), [], 'unknown callback parameter shadows outer row');
    assert.deepEqual(labels(`=LETREC(${name},(xs,f)=>f(1),${name}(${args}))`), [], 'LETREC local function shadows builtin callback');
  }
  assert(!labels('=LET(LETREC,(x,f)=>f(1),LETREC(fake,(r=>fa|),0))').includes('fake'), 'shadowed LETREC does not introduce a recursive binding');
  // Instrument the actual resolver, not a transcription. Abort old exponential
  // implementations early so the regression cannot freeze the test process.
  const perfOut = path.join(work, 'completion-performance.cjs');
  const sourcePath = path.join(studio, 'src/app/utils/formulaCompletion.ts');
  await require('esbuild').build({ entryPoints: [sourcePath], outfile: perfOut, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'inference-visits', setup(build) { build.onLoad({ filter: /formulaCompletion\.ts$/ }, () => ({ loader: 'ts', resolveDir: path.dirname(sourcePath),
      contents: fs.readFileSync(sourcePath, 'utf8').replace('function infer(node: Node, env: Env, depth = 0): Shape {', 'function infer(node: Node, env: Env, depth = 0): Shape { if (++globalThis.__completionVisits > 5000) throw new Error("Unbounded inference work");') })); } }] });
  const bounded = require(perfOut).completeFormula;
  for (const depth of [4, 12, 24]) {
    globalThis.__completionVisits = 0;
    const expression = '=LET(x,' + '['.repeat(depth) + '0' + ']'.repeat(depth) + ',x)';
    bounded(expression, expression.length - 1, catalog);
    assert(globalThis.__completionVisits < 8 * depth + 64, 'nested partial arrays require linear inference work');
  }
  for (const size of [128, 256, 512]) {
    let reads = 0;
    const tables = Array.from({length:size}, (_, i) => ({ uuid: `table-${i}`, get data_name() { reads++; return `Table${i}`; }, display_name: `Table ${i}`, columns: [] }));
    completeFormula('=T', 2, { functions: [], tables });
    assert(reads < 16 * size, 'catalog candidate generation must not rescan the catalog for each table');
  }
  console.log('PASS completion lexical scopes, shadowing, reference chains, table strings, lazy schemas and invalidation');
} finally { fs.rmSync(work, { recursive: true, force: true }); }
