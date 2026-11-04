// Executes the production notice JSX in isolation. Native migration is tested separately.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/app/pages/main_window/MainWindow.tsx'), 'utf8');
const expression = source.split('\n').find(line => line.includes('settings.migrationFailed') && line.includes('role="alert"'))?.trim();
assert.ok(expression, 'MainWindow renders the nonmodal migration notice');
const { code } = await transform(`globalThis.render = (settings, t, localizeError) => (${expression.slice(1, -1)});`, { loader:'tsx', jsxFactory:'h' });
const context = vm.createContext({h:(tag,props,...children)=>({tag,props,children})});
vm.runInContext(code, context);
const render = context.render;
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/app/i18n/generated/catalog.json'), 'utf8'));
assert.equal(render({ migrationFailed:false, warning:null }, ()=>{throw Error('Unexpected translation on success')}), null);
for (const locale of Object.keys(catalog.locales)) {
 const text = catalog.messages[locale]['settings.migrationFailed'];
 assert.ok(text?.trim(), `${locale}: migration notice translation present`);
 const node = render({ migrationFailed:true, warning:'private native diagnostic' }, key => { assert.equal(key,'settings.migrationFailed'); return text; });
 assert.equal(node.tag,'p'); assert.equal(node.props.role,'alert');
 assert.equal(node.children.join(''),text);
 assert.ok(!node.children.join('').includes('private native diagnostic'));
}
const ordinary = render({ migrationFailed:false, warning:[{kind:'text',text:'ordinary warning'}] },()=>{throw Error('Unexpected migration translation')}, error => error.text);
assert.equal(ordinary.children[0],'ordinary warning');
assert.ok(ordinary.props.className.includes('select-text'), 'recovery paths remain selectable');
assert.ok(ordinary.props.className.includes('max-h-40') && ordinary.props.className.includes('overflow-auto'), 'warnings cannot consume the entire project workspace');
assert.equal(render({ migrationFailed:false, warning:null },()=>''),null);
assert.equal(catalog.messages.en['settings.migrationFailed'], 'Settings migration failed. Using defaults for this version. Your previous settings are preserved.');
console.log(`PASS migration notice: failure-only, all ${Object.keys(catalog.locales).length} locales, raw diagnostic hidden, existing warnings preserved, success clears notice`);
