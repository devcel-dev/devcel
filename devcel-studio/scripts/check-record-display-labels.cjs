#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IntlMessageFormat } = require('intl-messageformat');
const { compileModule } = require('./compile-module.cjs');
const catalog = require('../src/app/i18n/generated/catalog.json');
let locale = 'en';
const moduleObject = { exports: {} };
vm.runInNewContext(compileModule(fs.readFileSync(path.join(__dirname, '../src/app/utils/recordDisplayLabel.ts'), 'utf8'), 'recordDisplayLabel.ts'), {
  module: moduleObject, exports: moduleObject.exports, require(name) {
    if (name === '@/app/i18n') return { t: (key, values) => new IntlMessageFormat(catalog.messages[locale][key], locale).format(values) };
    throw Error(name);
  },
});
const { recordDisplayLabel: label, recordReferenceLabel } = moduleObject.exports;
const id = 'd786e0f2-edbd-4cc2-bc84-a38bf5621290';
const row = { uuid: id, label: '', parent_uuid: '', values: { title: 'Player inventory' }, interface_values: {}, tags: [], memo_texts: {}, min_version: 0 };
const table = { uuid:'table', display_name:'', metadata: {}, schema: { columns: [{ uuid:'title', data_name:'title', data_type:'String' }] }, records:[row] };
const before = JSON.stringify(table);
for (const current of ['en','ja','de']) { locale=current; assert.equal(label(row, table, 4), ''); }
assert.equal(JSON.stringify(table), before, 'empty labels never rewrite cells or identities');
assert.equal(recordReferenceLabel(row, table), 'Player inventory', 'reference picker retains its distinct display projection');
for (const authored of [' ', id, `record_${id.replace(/-/g, '')}`, 'A deliberate label']) {
  row.label=authored; assert.equal(label(row,table),authored);
}
assert.equal(label({ ...row, label:undefined },table),'');
console.log('PASS row headings: empty remains empty, authored labels preserved, reference labels remain separate');
const previewModule = { exports: {} };
const translate = (key, values) => new IntlMessageFormat(catalog.messages[locale][key], locale).format(values);
vm.runInNewContext(compileModule(fs.readFileSync(path.join(__dirname, '../src/app/components/column-editor/previewDisplayLabels.ts'), 'utf8'), 'previewDisplayLabels.ts'), {
  module: previewModule, exports: previewModule.exports, require(name) {
    if (name === '@/app/i18n') return { t: translate, localizeError: value => value.kind === 'text' ? value.text : translate(value.code, value.params) };
    throw Error(name);
  },
});
const { previewRecordLabel, previewTableLabel } = previewModule.exports;
const preview = { locations: { 'internal-table-uuid': {table_name:'Inventory table',records:{
  [id]: {kind:'code',code:'grid.defaultRowLabel',params:{number:26}},
  'authored-row-id': {kind:'text',text:'Authored label'},
}}}};
const previewBefore = JSON.stringify(preview);
for (const current of ['ja','en','de']) {
  locale=current;
  assert.equal(previewTableLabel(preview, 'internal-table-uuid'), 'Inventory table');
  assert.equal(previewRecordLabel(preview,'internal-table-uuid',id),translate('grid.defaultRowLabel',{number:26}));
  assert.equal(previewRecordLabel(preview,'internal-table-uuid','authored-row-id'),'Authored label');
  assert.equal(previewRecordLabel(null,'internal-table-uuid',id,3),translate('rules.preview.sampleIndex',{index:4}));
  assert.equal(previewRecordLabel(null,'internal-table-uuid',id),translate('column.unknown'));
  assert.equal(previewRecordLabel(preview,'internal-table-uuid',null),translate('column.defaultValue'));
  for(const value of [previewTableLabel(null,'internal-table-uuid'),previewRecordLabel(null,'internal-table-uuid',id,0)]) assert(!value.includes('internal-table-uuid')&&!value.includes(id));
}
assert.equal(JSON.stringify(preview),previewBefore,'preview identities and labels are display-only');
console.log('PASS preview labels: localized source row, authored label, bounded sample fallback, default values, no internal UUID headings');
