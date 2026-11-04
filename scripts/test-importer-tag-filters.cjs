#!/usr/bin/env node
'use strict';
// Dependency-free DOM contract tests, not a substitute for native editor/browser QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const code = readSource(path.join(root, 'devcel-cli/src/importer_tag_filters.js'));
assert.equal(code, readSource(path.join(root, 'importers/rpgmaker/js/plugins/devcel/tag-filters.js')), 'Bundled filter widget must stay synchronized');
assert.equal(code, readSource(path.join(root, 'importers/javascript/editor/tag-filters.js')), 'JavaScript filter widget must stay synchronized');
class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.value = ''; }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return (this.text || '') + this.children.map(n => n.textContent).join(''); }
    appendChild(n) { this.children.push(n); return n; }
    setAttribute(k,v) { this.attributes[k] = v; }
    addEventListener(k,fn) { this.events[k] = fn; }
    querySelectorAll(selector) { return all(this).slice(1).filter(n => selector.split(',').includes(n.tagName)); }
    fire(k) { if (this.events[k]) this.events[k]({}); }
}
const context = {document:{createElement:tag => new Element(tag)}};
vm.createContext(context); vm.runInContext(code, context);
function all(n) { return [n, ...n.children.flatMap(all)]; }
function field(host, label) { const n = all(host).find(n => n.attributes['aria-label'] === label); assert(n, label); return n; }
function choose(host,label,value,event='change') { const n=field(host,label); n.value=value; n.fire(event); }
(async () => {
    const host = new Element('div');
    const source = {row_include_tags:['obsolete'], row_exclude_tags:['release'], column_include_tags:['wide'], column_exclude_tags:[]};
    let edits = 0;
    const widget = context.DevcelTagFilters.create(host, source, async () => ['release','wide','release'], () => edits++);
    await widget.update('../A.devcelproj.toml');
    assert.equal(field(host,'Include rows tag 1').tagName,'input');
    assert.equal(field(host,'Exclude rows tag 1').tagName,'select');
    assert.deepEqual(field(host,'Add include rows tag').children.map(n=>n.value),['','release','wide']);
    choose(host,'Include rows tag 1','Release','input');
    assert.equal(source.row_include_tags[0],'Release', 'Unsaved typing is retained before blur');
    choose(host,'Include rows tag 1','release');
    assert.equal(field(host,'Include rows tag 1').tagName,'select', 'Exact registry match returns to selector');
    choose(host,'Add include rows tag','wide'); choose(host,'Add include rows tag','wide');
    assert.deepEqual(source.row_include_tags,['release','wide'], 'Repeated adds do not duplicate');
    choose(host,'Add include rows tag','not-registered');
    assert.deepEqual(source.row_include_tags,['release','wide'], 'New arbitrary names cannot be added');
    await widget.update('');
    assert.deepEqual(source.row_include_tags,['release','wide'], 'Clearing project never clears filters');
    assert.equal(field(host,'Include rows tag 1').tagName,'input');
    field(host,'Remove include rows tag 1').fire('click');
    assert.deepEqual(source.row_include_tags,['wide']);
    assert(edits >= 4);

    // Overlapping project requests cannot leak a previous project's vocabulary.
    const pending = {};
    const isolated = new Element('div'); const untouched = {row_include_tags:['old']};
    const delayed = context.DevcelTagFilters.create(isolated, untouched, p => new Promise((resolve,reject)=>{pending[p]={resolve,reject};}), () => {});
    const a = delayed.update('A'); await Promise.resolve();
    const b = delayed.update('B'); await Promise.resolve();
    pending.B.resolve(['b']); await b;
    pending.A.resolve(['a']); await a;
    assert.deepEqual(field(isolated,'Add include rows tag').children.map(n=>n.value),['','b']);
    assert.deepEqual(untouched.row_include_tags,['old']);
    const failed = delayed.update('missing'); await Promise.resolve(); pending.missing.reject(new Error('missing file')); await failed;
    assert(isolated.textContent.includes('Existing filters are kept'));
    assert.deepEqual(untouched.row_include_tags,['old']);
    assert.deepEqual(field(isolated,'Add include rows tag').children.map(n=>n.value),['']);
    const second = new Element('div');
    const other = context.DevcelTagFilters.create(second, {}, async()=>['other'], ()=>{}); await other.update('C');
    assert.deepEqual(field(second,'Add include rows tag').children.map(n=>n.value),['','other']);
    assert.deepEqual(field(isolated,'Add include rows tag').children.map(n=>n.value),['']);
    const stale = delayed.update('abandoned'); await Promise.resolve(); delayed.dispose();
    isolated.textContent = 'New editor'; pending.abandoned.resolve(['stale']); await stale;
    assert.equal(isolated.textContent, 'New editor', 'Closing or switching source prevents old responses from repainting the shared host');
    const busyHost = new Element('div');
    const busyWidget = context.DevcelTagFilters.create(busyHost, {}, async()=>['locked'], ()=>{}, ()=>true);
    await busyWidget.update('busy');
    assert(busyHost.querySelectorAll('button,input,select').every(n=>n.disabled), 'Late registry responses cannot unlock controls during save/import');
    console.log('Importer tag filters: synchronized assets, registry-only choices, unknown recovery, explicit remove, source isolation, failure preservation and stale-request tests passed');
})().catch(error => { console.error(error); process.exitCode=1; });
