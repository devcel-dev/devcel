// Compile the public documentation and complete current storage DTO without running plugin code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const studio = path.resolve(__dirname, '..');
const sdk = path.join(studio, 'templates/plugin-template/src/types');
const reference = fs.readFileSync(path.join(studio, 'docs/plugin-api-reference.md'), 'utf8');
const verification = reference.slice(reference.indexOf('### Table replacement contract'));
const dataExample = reference.match(/## Data API[\s\S]*?```typescript\r?\n([\s\S]*?)```/);
const updateExample = verification.match(/```typescript\r?\n([\s\S]*?)```/);
assert(dataExample && updateExample, 'Current table API examples must remain available to compile');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devcel-plugin-sdk-types-'));
try {
  const fixture = path.join(work, 'contract.ts');
  fs.writeFileSync(fixture, `
import type { PluginAPI } from ${JSON.stringify(path.join(sdk, 'pluginTypes'))};
import type { TableData, TableMetadata, TableRecord, Column, InterfaceImplementation } from ${JSON.stringify(path.join(sdk, 'tableTypes'))};
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Contracts = [
  Expect<Equal<IsAny<Awaited<ReturnType<PluginAPI['data']['getTable']>>>, false>>,
  Expect<Equal<Awaited<ReturnType<PluginAPI['data']['getTable']>>, TableData>>,
  Expect<Equal<Awaited<ReturnType<PluginAPI['data']['getTableSnapshot']>>, { table: TableData; revision: string }>>,
  Expect<Equal<Parameters<PluginAPI['data']['updateTable']>[1], TableData>>,
  Expect<Equal<RequiredKeys<TableData>, 'uuid' | 'display_name' | 'description' | 'metadata' | 'interface_implementations' | 'schema' | 'records'>>,
  Expect<Equal<RequiredKeys<TableMetadata>, 'interface_order' | 'parent_uuid' | 'data_name' | 'initial_transposed' | 'edit_permissions'>>,
  Expect<Equal<RequiredKeys<TableRecord>, 'uuid' | 'parent_uuid' | 'label' | 'min_version' | 'tags' | 'values' | 'interface_values' | 'memo_texts'>>,
  Expect<Equal<RequiredKeys<Column>, 'uuid' | 'display_name' | 'data_name' | 'data_type' | 'min_version' | 'tooltip' | 'tags' | 'default_value' | 'style' | 'memo_text' | 'reference_config' | 'read_only'>>,
  Expect<Equal<RequiredKeys<InterfaceImplementation>, 'interface_uuid' | 'synced_version_id' | 'last_sync_date' | 'effective_fingerprint'>>
];
export type { Contracts };

const column = {
  uuid: '11111111-1111-4111-8111-111111111111', display_name: 'Value', data_name: 'value',
  data_type: 'String', min_version: 0, tooltip: '', tags: [], read_only: false, default_value: '',
  style: { color: '#FFFFFF', font_size: 12, width: 100 }, memo_text: '', reference_config: null
} satisfies Column;
const record = {
  uuid: '22222222-2222-4222-8222-222222222222', parent_uuid: '', label: 'One', min_version: 0,
  tags: [], values: { value: 'current' }, interface_values: {}, memo_texts: {}, } satisfies TableRecord;
const table = {
  description: 'Current complete table',
  uuid: '33333333-3333-4333-8333-333333333333', display_name: 'Example', metadata: { interface_order: [],  initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, parent_uuid: '',
    data_name: 'example' },
  interface_implementations: {}, schema: { columns: [column] }, records: [record]
} satisfies TableData;
const configured: Column = {
  ...column,
  reference_config: { target_table_uuid: table.uuid, display_column_uuid: null },
  table_ref_config: { interface_uuid: '44444444-4444-4444-8444-444444444444' },
  curve_config: { start_value: 0, end_value: 1 },
  select_config: { options: [{ value: 'a', label: '' }] },
  interface_origin: '44444444-4444-4444-8444-444444444444', interface_origin_name_fallback: 'Current',
  required: true, constraints: { unique: true, min_value: 0, max_value: 10, pattern: '.*' },
  input_validation: { mode: 'warn', message: '', hint: '', rules: [{ kind: 'number_range', min: null, max: '10' }] },
  conditional_formatting: { rules: [] }, conditional_formatting_override: { rules: [] }
};
const implementation: InterfaceImplementation = {
  interface_uuid: '44444444-4444-4444-8444-444444444444', synced_version_id: '55555555-5555-4555-8555-555555555555',
  last_sync_date: '2026-10-03T00:00:00Z', effective_fingerprint: null
};
export { table, configured, implementation };

// Required storage fields and canonical serialized enum representations cannot regress.
// @ts-expect-error incomplete columns are not full current storage columns
const incompleteColumn: Column = { uuid: column.uuid, display_name: 'Value', data_name: 'value', data_type: 'String' };
// @ts-expect-error missing interface collections are not current TableData
const incompleteTable: TableData = { description: '', metadata: table.metadata, schema: table.schema, records: table.records };
// @ts-expect-error undeclared type names are not ValueType values
const invalidNamedColumn: Column = { ...column, data_type: 'Str' };
// @ts-expect-error arbitrary strings are not current ValueType values
const unknownColumn: Column = { ...column, data_type: 'anything' };
export { incompleteColumn, incompleteTable, invalidNamedColumn, unknownColumn };

export function preferenceContract(api: PluginAPI): void {
  const value: string = api.settings.getTable<{ prefix: string }>('preferences').prefix;
  const scalar: string | number | boolean | null = api.settings.get('preferences.prefix');
  api.settings.watchTable('preferences', next => { void next.prefix; });
  const optional = api.settings.getTable<{ optionalCount: number | null }>('preferences').optionalCount;
  api.settings.watchTable('preferences', next => { const optionalValue: string | number | boolean | null = next.optionalCount; void optionalValue; });
  void optional; void value; void scalar;
  // @ts-expect-error there is no preference mutation API
  api.settings.set('preferences.prefix', 'New');
  // @ts-expect-error plugins cannot select another owner
  api.settings.getTable('preferences', 'another-plugin');
}

export async function referenceExample(api: PluginAPI): Promise<void> {
${dataExample[1]}
}
export async function updateVerificationExample(api: PluginAPI): Promise<void> {
${updateExample[1]}
}
`);
  const result = spawnSync(process.execPath, [
    path.join(studio, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2020', '--module', 'ESNext', '--moduleResolution', 'bundler',
    '--lib', 'ES2020,DOM,DOM.Iterable', '--esModuleInterop', fixture
  ], { cwd: studio, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else console.log('PASS: public table examples and current SDK storage DTO compile without any or partial storage shapes');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

// Both shipped and host helpers must leave inheritance/default mode on explicit edit.
const { transformSync } = require('esbuild');
for (const directory of [sdk, path.join(studio, 'src/app/types')]) {
  const source = fs.readFileSync(path.join(directory, 'tableTypes.ts'), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2020' }).code;
  const module = { exports: {} };
  new Function('module', 'exports', compiled)(module, module.exports);
  const api = module.exports;
  for (const origin of [undefined, 'stats']) for (const value of ['', '42']) {
    const column = { uuid: 'hp', data_name: 'hp', default_value: '10', interface_origin: origin };
    const parent = { uuid: 'parent', parent_uuid: '', values: { hp: '20' }, interface_values: { hp: '20' }, };
    const child = { uuid: 'child', parent_uuid: 'parent', values: {}, interface_values: {} };
    const table = { records: [parent, child] };
    assert.equal(api.resolveEffectiveCellInput(table, child, column), '20');
    api.setEffectiveCellValue(child, column, value);
    assert.equal(api.hasLocalCellValue(child,column),value !== '');
    assert.equal(api.resolveEffectiveCellInput(table, child, column), value === '' ? '20' : value);
    assert.equal(api.getEffectiveCellValue(parent, column), '20');
    assert.deepEqual(origin ? child.values : child.interface_values, {});
  }
}
console.log('PASS: host and shipped SDK edits override inheritance/defaults, with empty input clearing back to inheritance');
