#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compileModule } = require('./compile-module.cjs');
const root = path.resolve(__dirname, '..');
const catalog = require('../src/app/i18n/generated/catalog.json');
let mode = true, locale = 'en';
const themes = [{key:'dark',labelKey:'appOptions.dark'},{key:'light',labelKey:'appOptions.light'}];
const pluginLabels = {
  'owned-table': {owner:'generic-plugin',key:'table.title',source:'Original title'},
  'owned-column\0choice': {owner:'generic-plugin',key:'option.choice',source:'Original choice'},
};
const pluginMessages = {en:{'table.title':'Plugin table','option.choice':'Plugin choice'},ja:{'table.title':'プラグインの表','option.choice':'プラグインの選択肢'}};
const translatePluginMessage = (owner,key,_values,fallback) => { assert.equal(owner,'generic-plugin');return pluginMessages[locale]?.[key] ?? fallback; };
const source = fs.readFileSync(path.join(root, 'src/app/settings/displayLabels.ts'), 'utf8');
const compiled = compileModule(source, 'displayLabels.ts');
const moduleObject = { exports: {} };
vm.runInNewContext(compiled, { module: moduleObject, exports: moduleObject.exports, require(name) {
  if (name === '@/app/settings') return {getSettingsSnapshot:()=>({bundle:{pluginLabels,themes,localization:catalog}})};
  if (name === '@/app/applicationMode') return { isSettingsEditor: () => mode };
  if (name === '@/app/i18n') return { localizeError: value => catalog.messages[locale][value.code], translatePluginMessage, t: key => catalog.messages[locale][key], getLocaleName: code => catalog.locales[code]?.displayName ?? code };
  throw new Error(name);
}});
const label = moduleObject.exports.settingsDisplayLabel;
const uuid = '0b0c717a-e3e5-5c57-b2a8-6460d753b954';
assert.equal(label(uuid, '表示言語'), 'Display language');
locale = 'ja'; assert.equal(label(uuid, '表示言語'), '表示言語');
locale = 'en'; assert.equal(label(uuid, 'My language preference'), 'My language preference');
assert.equal(label('custom-uuid', '表示言語'), '表示言語');
mode = false; assert.equal(label(uuid, '表示言語'), '表示言語');
mode = true; assert.equal(label('6a6882ac-5a9a-51fc-b1d3-3ba3169b3a6e', 'アプリ設定'), 'App settings');
assert.equal(label('6a6882ac-5a9a-51fc-b1d3-3ba3169b3a6e', 'My settings'), 'My settings');
const grid = fs.readFileSync(path.join(root, 'src/app/pages/main_window/project_view/table_view/components/DataGridView.tsx'), 'utf8');
assert.ok(grid.includes('name: settingsDisplayLabel(column.uuid, column.display_name || column.data_name)'));
assert.ok(grid.includes('{settingsDisplayLabel(definition.uuid, definition.display_name || definition.data_name)}'));
console.log('PASS settings labels: English/Japanese, live locale, normal project, custom identity/name, normal/transposed headings');

const { renderToStaticMarkup } = require('react-dom/server');
const headerSource = fs.readFileSync(path.join(root, 'src/app/pages/main_window/project_view/table_view/components/DataGridAdvancedCells.tsx'), 'utf8');
const headerModule = { exports: {} };
vm.runInNewContext(compileModule(headerSource, 'DataGridAdvancedCells.tsx'), {
  module: headerModule, exports: headerModule.exports,
  require(name) {
    if (name === '@/app/settings/displayLabels') return moduleObject.exports;
    if (name === '@/app/i18n') return { t: key => key, formatNumber: String };
    if (name === './GridInsertIcon') { const icon={exports:{}}; vm.runInNewContext(compileModule(fs.readFileSync(path.join(root,'src/app/pages/main_window/project_view/table_view/components/GridInsertIcon.tsx'),'utf8'),'GridInsertIcon.tsx'),{module:icon,exports:icon.exports,require}); return icon.exports; }
    if (name === './RowResizeHandle') return { RowResizeHandle: () => null };
    return require(name);
  }
});
const definition = { uuid, display_name: '表示言語', data_name: 'locale', data_type: 'Select' };
const renderHeader = () => renderToStaticMarkup(headerModule.exports.createAdvancedHeaderCell({ column: definition, columnIndex: 0, tableUuid: 'settings', onInsertLeft() {}, onInsertRight() {}, isUpdating: false }));
locale = 'en'; mode = true;
let html = renderHeader(); assert.ok(html.includes(`title="${moduleObject.exports.settingsTooltip(uuid, '') || 'Display language (locale)'}"`), 'header tooltip uses its own description or display/internal names'); assert.ok(html.includes('>Display language</span>')); assert.ok(!html.includes('表示言語'));
locale = 'ja'; assert.ok(renderHeader().includes('>表示言語</span>'));
locale = 'en'; mode = false; assert.ok(renderHeader().includes('>表示言語</span>'));
mode = true; definition.display_name = 'Custom language'; assert.ok(renderHeader().includes('>Custom language</span>'));
assert.equal(definition.display_name, 'Custom language');
console.log('PASS actual advanced header renderer: localized text and tooltip, Japanese, custom names and standard project');

const option = moduleObject.exports.settingsSelectOptionLabel;
mode = true; locale = 'ja';
assert.equal(option('af3c91ac-5b4d-5d65-89d3-41102912eb8b','dark','dark'), catalog.messages.ja['appOptions.dark']);
assert.equal(option('b3572d14-bf5c-523f-b559-6306092b875a','srgb','srgb'), 'sRGB');
assert.equal(option(uuid,'en','en'), catalog.locales.en.displayName);
assert.equal(option(uuid,'system','system'), catalog.messages.ja['appOptions.system']);
assert.equal(option(uuid,'en','Custom English'), 'Custom English');
mode = false; assert.equal(option(uuid,'system','system'), 'system');
console.log('PASS Select presentation: canonical settings identities only, live locale, user option label overrides and ordinary projects preserved');

mode=true;locale='en';assert.equal(label('owned-table','Original title'),'Plugin table');
locale='ja';assert.equal(label('owned-table','Original title'),'プラグインの表');
assert.equal(option('owned-column','choice','Original choice'),'プラグインの選択肢');
assert.equal(label('owned-table','My override'),'My override');
assert.equal(option('owned-column','choice','My choice'),'My choice');
mode=false;assert.equal(label('owned-table','Original title'),'Original title');
assert.equal(option('owned-column','choice','Original choice'),'Original choice');
console.log('PASS plugin-owned labels: generic ownership metadata, live locale, source identity guard and user overrides');

mode = true; locale = 'en';
themes[0].labelKey = 'appOptions.light';
assert.equal(option('af3c91ac-5b4d-5d65-89d3-41102912eb8b','dark','dark'), catalog.messages.en['appOptions.light']);
assert.equal(option('af3c91ac-5b4d-5d65-89d3-41102912eb8b','dark','My custom label'), 'My custom label');
console.log('PASS edited theme label references flow into chooser without overriding authored labels');

const choices = moduleObject.exports.settingsSelectOptions;
mode = true;
assert.deepEqual(JSON.parse(JSON.stringify(choices('af3c91ac-5b4d-5d65-89d3-41102912eb8b',[]))).map(o=>o.value), ['system','dark','light']);
themes.push({key:'custom',labelKey:'appOptions.dark'});
assert(choices('af3c91ac-5b4d-5d65-89d3-41102912eb8b',[]).some(o=>o.value==='custom'));
assert(!choices(uuid,[]).some(o=>o.value==='en-XA'));
assert(choices(uuid,[]).some(o=>o.value==='ja'));
mode = false; const authored = [{value:'mine',label:'Mine'}];
assert.equal(choices(uuid,authored),authored);
console.log('PASS choices derive from validated theme/locale records; normal project options stay authored');
