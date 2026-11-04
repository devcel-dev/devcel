// Production display projection -> filter/sort projection. Rust evaluation is a
// boundary fixture; these checks do not claim native UI or storage validation.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(project, '.grid-filter-sort-check-'));
const reports = [];
const check = (name, body) => { body(); reports.push(name); console.log('PASS', name); };
const column = (uuid, type = 'String', extra = {}) => ({ min_version: 0, uuid, data_name: uuid, display_name: uuid,
  data_type: type, read_only: false, default_value: '', tooltip: '', memo_text: '', tags: [], reference_config: null,
  style: { width: 140, color: '#ffffff', font_size: 12 }, ...extra });
const row = (rowId, values = {}, errors = {}) => ({ rowId, rowLabel: rowId, rowIndex: Number(rowId) || 0, ...values,
  cellPresentations: Object.fromEntries(Object.entries(errors).map(([uuid, formula_error]) => [uuid, { formula_error }])) });
const ids = rows => rows.map(row => row.rowId);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
try {
  const bundled = await build({ absWorkingDir: project, stdin: {
    contents: `export * from './src/app/pages/main_window/project_view/table_view/components/gridFilterSort'; export { createGridDisplayModel } from './src/app/pages/main_window/project_view/table_view/components/gridDisplayModel';`,
    resolveDir: project, loader: 'ts'
  }, bundle: true, format: 'esm', platform: 'node', packages: 'external', write: false, alias: { '@': resolve(project, 'src') } });
  const modulePath = resolve(temporary, 'check.mjs');
  await writeFile(modulePath, bundled.outputFiles[0].text);
  const { canSortColumn, collectFilterValues, filterSortRows, sanitizeViewState, validateCondition, createGridDisplayModel } = await import(pathToFileURL(modulePath));
  const sort = (c, direction = 'asc') => ({ columnUuid: c.uuid, dataType: c.data_type, direction });
  const filter = (c, extra) => ({ columnUuid: c.uuid, dataType: c.data_type, ...extra });
  const condition = (operator, value, max) => ({ operator, ...(value === undefined ? {} : { value }), ...(max === undefined ? {} : { max }) });
  const apply = (rows, c, conditions, join) => filterSortRows(rows, [c], [filter(c, { conditions, join })], []);

  check('Inactive, stale and already-ordered projections preserve input array identity', () => {
    const c = column('number', 'I32'), rows = freeze([row('1', { number: '1' }), row('2', { number: '2' })]);
    assert.equal(filterSortRows(rows, [c], [], []), rows);
    assert.equal(filterSortRows(rows, [c], [], [sort(c)]), rows);
    assert.equal(apply(rows, c, [condition('greater_than', '0')]), rows);
    assert.equal(filterSortRows(rows, [c], [filter(column('deleted'), { values: ['x'] })], []), rows);
    assert.equal(filterSortRows(rows, [c], [filter({ ...c, data_type: 'String' }, { values: ['x'] })], [sort(column('deleted'))]), rows);
  });
  check('Value alternatives OR together; columns and same-column conditions AND together', () => {
    const name = column('name'), number = column('number', 'I32');
    const rows = freeze([row('a', { name: 'Alpha', number: '1' }), row('b', { name: 'Beta', number: '2' }), row('c', { name: 'Gamma', number: '2' }), row('d', { name: 'Beta', number: '3' })]);
    assert.deepEqual(ids(filterSortRows(rows, [name, number], [filter(name, { values: ['Alpha', 'Beta'] }), filter(number, { values: ['2', '3'], conditions: [condition('less_than', '3')] })], [])), ['b']);
    assert.deepEqual(ids(filterSortRows(rows, [name], [filter(name, { values: [] })], [])), []);
    assert.equal(filterSortRows(rows, [name], [filter(name, { values: ['Alpha', 'Beta', 'Gamma'] })], []), rows);
    assert.deepEqual(ids(filterSortRows(rows, [name], [filter(name, { values: ['alpha'] })], [])), [], 'checkbox identity is exact');
  });
  check('Two conditions support AND and OR with inclusive range boundaries', () => {
    const c = column('n', 'I32'), rows = freeze(Array.from({ length: 6 }, (_, n) => row(String(n), { n: String(n) })));
    assert.deepEqual(ids(apply(rows, c, [condition('greater_than_or_equal', '1'), condition('less_than_or_equal', '4')], 'and')), ['1', '2', '3', '4']);
    assert.deepEqual(ids(apply(rows, c, [condition('less_than', '1'), condition('greater_than', '4')], 'or')), ['0', '5']);
    assert.deepEqual(ids(apply(rows, c, [condition('between', '1', '4')])), ['1', '2', '3', '4']);
    assert.deepEqual(ids(apply(rows, c, [condition('equals', '2')])), ['2']);
    assert.deepEqual(ids(apply(rows, c, [condition('not_equals', '2')])), ['0', '1', '3', '4', '5']);
  });
  check('String conditions are case-insensitive, preserve Unicode and do not interpret regex', () => {
    const c = column('s'), rows = freeze([row('one', { s: 'Alpha.[Beta]' }), row('two', { s: 'alphabet' }), row('three', { s: 'カタカナ' }), row('empty', { s: '' })]);
    for (const [operator, value, expected] of [
      ['contains', 'ALPHA', ['one', 'two']], ['not_contains', 'alpha', ['three', 'empty']], ['starts_with', 'AlPhA', ['one', 'two']],
      ['ends_with', 'BETA]', ['one']], ['contains', '.[', ['one']], ['equals', 'ALPHABET', ['two']],
      ['not_equals', 'ALPHABET', ['one', 'three', 'empty']], ['contains', 'カタ', ['three']]
    ]) assert.deepEqual(ids(apply(rows, c, [condition(operator, value)])), expected, operator);
  });
  check('Empty, zero and false remain distinct and never reapply column defaults', () => {
    const c = column('v', 'String', { read_only: false, default_value: 'default' });
    const rows = freeze([row('empty', { v: '' }), row('zero', { v: 0 }), row('false', { v: false }), row('missing'), row('null', { v: null }), row('space', { v: ' ' })]);
    assert.deepEqual(ids(apply(rows, c, [condition('empty')])), ['empty', 'missing', 'null']);
    assert.deepEqual(ids(apply(rows, c, [condition('not_empty')])), ['zero', 'false', 'space']);
    assert.deepEqual(new Set(collectFilterValues(rows, c).map(value => value.value)), new Set(['', '0', 'false', ' ']));
    assert.deepEqual(ids(filterSortRows(rows, [c], [filter(c, { values: [''] })], [])), ['empty', 'missing', 'null']);
  });
  check('Every integer type orders numerically and i64/u64 keep full precision', () => {
    for (const type of ['U8', 'I8', 'U16', 'I16', 'U32', 'I32', 'U64', 'I64']) {
      const c = column('n', type), rows = freeze([row('ten', { n: '10' }), row('two', { n: '2' }), row('zero', { n: '0' })]);
      assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c)])), ['zero', 'two', 'ten'], type);
    }
    for (const [type, values] of [
      ['U64', ['18446744073709551615', '18446744073709551614', '9007199254740993', '9007199254740992']],
      ['I64', ['9223372036854775807', '9223372036854775806', '-9223372036854775807', '-9223372036854775808']]
    ]) {
      const c = column('n', type), rows = freeze(values.map((n, index) => row(String(index), { n })));
      assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c)])), ['3', '2', '1', '0'], type);
      assert.deepEqual(ids(apply(rows, c, [condition('between', values[1], values[0])])), ['0', '1'], type);
      assert.deepEqual(ids(apply(rows, c, [condition('equals', values[0])])), ['0'], type);
    }
  });
  check('Floating point handles negatives, exponent notation, infinities and invalid text', () => {
    for (const type of ['F32', 'F64']) {
      const c = column('n', type), rows = freeze([row('small', { n: '-1e-20' }), row('big', { n: '1.25e2' }), row('zero', { n: '-0' }), row('inf', { n: 'inf' }), row('negative-inf', { n: '-Infinity' }), row('invalid', { n: '2 apples' }), row('nan', { n: 'NaN' })]);
      assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c)])), ['negative-inf', 'small', 'zero', 'big', 'inf', 'invalid', 'nan']);
      assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c, 'desc')])), ['inf', 'big', 'zero', 'small', 'negative-inf', 'invalid', 'nan']);
      assert.deepEqual(ids(apply(rows, c, [condition('greater_than', '0')])), ['big', 'inf']);
      assert.deepEqual(ids(apply(rows, c, [condition('equals', '0')])), ['zero']);
    }
  });
  check('Boolean false sorts before true; empty and errors stay separate', () => {
    const c = column('b', 'Boolean'), rows = freeze([row('true', { b: true }), row('false', { b: false }), row('empty', { b: '' }), row('error', { b: 'true' }, { b: 'formula failed' })]);
    assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c)])), ['false', 'true', 'empty', 'error']);
    assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c, 'desc')])), ['true', 'false', 'empty', 'error']);
    assert.deepEqual(ids(apply(rows, c, [condition('equals', 'false')])), ['false']);
  });
  check('Dates compare chronologically across offsets, dates and submillisecond fractions', () => {
    const c = column('d', 'DateTime'), rows = freeze([
      row('later', { d: '2026-10-14T01:00:00Z' }), row('earlier', { d: '2026-10-14T09:00:00+09:00' }), row('same', { d: '2026-10-14' }),
      row('nano2', { d: '2026-10-14T00:00:00.000000002Z' }), row('nano1', { d: '2026-10-14T00:00:00.000000001Z' }),
      row('invalid', { d: '2026-02-30' }), row('ambiguous', { d: '01/02/2026' }), row('numeric', { d: '0' })
    ]);
    assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c)])), ['earlier', 'same', 'nano1', 'nano2', 'later', 'invalid', 'ambiguous', 'numeric']);
    assert.deepEqual(ids(apply(rows, c, [condition('between', '2026-10-14T00:00:00Z', '2026-10-14T00:00:00.000000002Z')])), ['earlier', 'same', 'nano2', 'nano1']);
    assert.deepEqual(ids(apply(rows, c, [condition('equals', '2026-10-14T00:00:00Z')])), ['earlier', 'same']);
    assert.equal(apply(rows, c, [condition('greater_than', '2026-13-01')]), rows, 'invalid draft condition is inactive');
  });
  check('Missing, malformed and formula-error keys remain last in both directions', () => {
    const c = column('n', 'I64'), rows = freeze([row('error-a', { n: '-100' }, { n: 'failure' }), row('two', { n: '2' }), row('empty', { n: '' }), row('invalid', { n: '=formula' }), row('one', { n: '1' }), row('error-b', { n: '' }, { n: 'failure' })]);
    assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c)])), ['one', 'two', 'empty', 'invalid', 'error-a', 'error-b']);
    assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c, 'desc')])), ['two', 'one', 'empty', 'invalid', 'error-a', 'error-b']);
    assert.deepEqual(ids(apply(rows, c, [condition('empty')])), ['empty']);
    assert.deepEqual(ids(apply(rows, c, [condition('less_than', '0')])), []);
    assert.deepEqual(ids(filterSortRows(rows, [c], [filter(c, { values: ['-100'] })], [])), ['error-a']);
  });
  check('Multiple sort levels are stable and retain row objects, UUIDs and source positions', () => {
    const name = column('name'), n = column('n', 'I32');
    const rows = freeze([row('a', { name: 'Beta', n: '2', rowIndex: 91 }), row('b', { name: 'Alpha', n: '1', rowIndex: 8 }), row('c', { name: 'Alpha', n: '2', rowIndex: 70 }), row('d', { name: 'Alpha', n: '2', rowIndex: 6 })]);
    const result = filterSortRows(rows, [name, n], [], [sort(name), sort(n, 'desc')]);
    assert.deepEqual(ids(result), ['c', 'd', 'b', 'a']); assert.deepEqual(result.map(row => row.rowIndex), [70, 6, 8, 91]);
    result.forEach(row => assert.equal(row, rows.find(source => source.rowId === row.rowId))); assert.deepEqual(ids(rows), ['a', 'b', 'c', 'd']);
    const ties = freeze([row('first', { name: 'é' }), row('second', { name: 'e\u0301' })]);
    assert.equal(filterSortRows(ties, [name], [], [sort(name)]), ties); assert.equal(filterSortRows(ties, [name], [], [sort(name, 'desc')]), ties);
  });
  check('Select candidates and ordering use labels while selections retain stored values', () => {
    const c = column('s', 'Select', { select_config: { options: [{ value: 'z', label: 'Alpha' }, { value: 'a', label: 'Zulu' }, { value: 'unused', label: 'Unused' }] } });
    const rows = freeze([row('first', { s: 'a' }), row('second', { s: 'z' }), row('third', { s: 'z' }), row('unknown', { s: 'Middle' })]);
    assert.deepEqual(collectFilterValues(rows, c), [{ value: 'z', label: 'Alpha' }, { value: 'Middle', label: 'Middle' }, { value: 'a', label: 'Zulu' }]);
    assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c)])), ['second', 'third', 'unknown', 'first']);
    assert.deepEqual(ids(filterSortRows(rows, [c], [filter(c, { values: ['z'] })], [])), ['second', 'third']);
    assert.deepEqual(ids(apply(rows, c, [condition('contains', 'ALP')])), ['second', 'third']);
  });
  check('Reference label sorting preserves real candidate identity, ties and unresolved fallbacks', () => {
    for (const type of ['Reference', 'TableRef']) {
      const c = column('r', type), rows = freeze([row('1', { r: 'uuid-z' }), row('2', { r: 'uuid-a' }), row('3', { r: 'uuid-b' })]);
      assert.deepEqual(collectFilterValues(rows, c), [{ value: 'uuid-a', label: 'uuid-a' }, { value: 'uuid-b', label: 'uuid-b' }, { value: 'uuid-z', label: 'uuid-z' }]);
      assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c)])), ['2', '3', '1']);
      const labels = new Map([['r', new Map([['uuid-z', 'Alpha'], ['uuid-a', 'Alpha']])]]);
      assert.equal(filterSortRows(rows, [c], [], [sort(c)], labels), rows);
      assert.deepEqual(ids(filterSortRows(rows, [c], [], [sort(c, 'desc')], labels)), ['3', '1', '2']);
    }
  });
  check('Unsupported color, curve and None columns cannot add artificial sorting', () => {
    for (const type of ['Color32', 'ColorFloat', 'Curve', 'None']) {
      const c = column('c', type), rows = freeze([row('a', { c: 'z' }), row('b', { c: 'a' })]);
      assert.equal(canSortColumn(c), false); assert.equal(filterSortRows(rows, [c], [], [sort(c)]), rows);
      assert.deepEqual(sanitizeViewState([c], [], [sort(c)]).sorts, []);
      assert.deepEqual(ids(filterSortRows(rows, [c], [filter(c, { values: ['a'] })], [])), ['b']);
    }
  });
  check('Schema sanitization removes deleted, changed and duplicate columns, preserving stable state references', () => {
    const a = column('a'), b = column('b', 'I64');
    const filters = freeze([filter(a, { values: ['not-present'] }), filter(b, { conditions: [condition('greater_than', '10')], join: 'and' })]);
    const sorts = freeze([sort(a), sort(b, 'desc')]); const unchanged = sanitizeViewState([a, b], filters, sorts);
    assert.equal(unchanged.filters, filters); assert.equal(unchanged.sorts, sorts);
    assert.equal(sanitizeViewState([{ ...a, data_name: 'renamed', display_name: 'Renamed' }, b], filters, sorts).filters, filters);
    assert.deepEqual(sanitizeViewState([{ ...a, data_type: 'Boolean' }], filters, sorts), { filters: [], sorts: [] });
    const deduplicated = sanitizeViewState([a], [filters[0], filters[0]], [sorts[0], sorts[0]]);
    assert.deepEqual(deduplicated.filters, [filters[0]]); assert.deepEqual(deduplicated.sorts, [sorts[0]]);
    const emptyValues = [filter(a, { values: [] })]; assert.equal(sanitizeViewState([a], emptyValues, []).filters, emptyValues);
  });
  check('Sanitization drops invalid draft conditions and keeps a maximum of two', () => {
    const c = column('n', 'I64');
    const state = sanitizeViewState([c], [filter(c, { values: ['1', '1'], conditions: [condition('contains', '1'), condition('greater_than', ''), condition('between', '3', '1'), condition('equals', '1'), condition('not_equals', '2'), condition('equals', '3')] })], []);
    assert.deepEqual(state.filters[0].values, ['1']); assert.deepEqual(state.filters[0].conditions, [condition('equals', '1'), condition('not_equals', '2')]);
    assert.deepEqual(sanitizeViewState([c], [filter(c, { conditions: [] })], []).filters, []);
    for (const invalid of [condition('greater_than', ''), condition('between', '3', '1'), condition('between', '1'), condition('contains', '1')]) assert.equal(validateCondition(invalid, 'I64'), false);
    assert.equal(validateCondition(condition('equals', '-1'), 'U64'), false);
    assert.equal(validateCondition(condition('equals', '18446744073709551615'), 'U64'), true);
    assert.equal(validateCondition(condition('greater_than', 'Infinity'), 'F64'), true);
    assert.equal(validateCondition(condition('empty'), 'DateTime'), true);
  });
  check('Authoritative default, formula and interface-column display values drive filtering without changing raw inputs', () => {
    const plain = column('ordinary-id', 'I64', { data_name: 'ordinary', read_only: false, default_value: '12' });
    const iface = column('interface-id', 'I64', { data_name: 'ordinary', interface_origin: 'interface', read_only: false, default_value: '99' });
    const table = freeze({ metadata: { initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, uuid: 'table' }, schema: { columns: [plain, iface] }, records: [
      { min_version: 0, uuid: 'formula', label: 'Formula', values: { ordinary: '=6*7' }, interface_values: { 'interface-id': '100' } },
      { min_version: 0, uuid: 'default', label: 'Default', values: {}, interface_values: { 'interface-id': '7' } }
    ] });
    const presentation = freeze({ cells: { formula: { 'ordinary-id': { display_value: '42', raw_value: '=6*7', formula_error: null } } } });
    const before = JSON.stringify(table), model = createGridDisplayModel(undefined, table, presentation, 'session');
    assert.deepEqual(ids(filterSortRows(model.rows, model.columns, [filter(plain, { conditions: [condition('greater_than', '40')] })], [])), ['formula']);
    assert.deepEqual(ids(filterSortRows(model.rows, model.columns, [filter(plain, { values: ['12'] })], [])), ['default']);
    assert.deepEqual(ids(filterSortRows(model.rows, model.columns, [], [sort(iface)])), ['default', 'formula']);
    assert.equal(JSON.stringify(table), before); assert.equal(model.rows[0].tableRecord, table.records[0]);
    assert.equal(model.rows[0].cellPresentations['ordinary-id'].raw_value, '=6*7');
  });
  check('A 12,668-row projection keeps complete candidates, filtered UUID identity and source order', () => {
    const c = column('n', 'I64'); const rows = freeze(Array.from({ length: 12_668 }, (_, index) => row(String(index), { n: String(12_667 - index), rowIndex: index })));
    const candidates = collectFilterValues(rows, c);
    assert.equal(candidates.length, rows.length); assert.equal(candidates[0].value, '0'); assert.equal(candidates.at(-1).value, '12667');
    const filtered = filterSortRows(rows, [c], [filter(c, { conditions: [condition('between', '111', '115')] })], [sort(c)]);
    assert.deepEqual(filtered.map(row => row.n), ['111', '112', '113', '114', '115']); filtered.forEach(item => assert.equal(item, rows[item.rowIndex]));
    assert.equal(rows[0].n, '12667'); assert.equal(rows.at(-1).n, '0');
  });
  console.log(JSON.stringify({ passed: reports.length, checks: reports, scope: 'Production display model and pure view projection; no native UI, mutation or storage claims.' }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
