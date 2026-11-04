'use strict';
const $ = id => document.getElementById(id);
const token = location.hash.slice(1);
let config, engine, revision, editing = -1, busy = false, filterSource = {}, filters;
const show = (text, error = false) => { $('message').textContent = text; $('message').className = error ? 'error' : 'success'; };
async function api(path, body) {
  const response = await fetch(path, {method:body === undefined ? 'GET' : 'POST',headers:{'X-Devcel-Token':token,'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not connect');
  return data;
}
async function task(action) {
  if (busy) return;
  busy = true; document.querySelectorAll('button,input,select').forEach(button => button.disabled = true);
  try { await action(); } catch(error) { show(error.message, true); }
  finally { busy = false; document.querySelectorAll('button,input,select').forEach(button => button.disabled = false); }
}
function outputPath(id) { return engine === 'gamemaker' ? `datafiles/devcel/${id}.json` : `devcel_generated/${id}.json`; }
function render() {
  $('sources').replaceChildren();
  for (const [index, source] of config.sources.entries()) {
    const row = document.createElement('div'); row.className = 'source';
    const info = document.createElement('div'); const title = document.createElement('strong'); title.textContent = `${source.id} · ${source.namespace}`;
    const detail = document.createElement('small'); detail.textContent = source.project; info.append(title, detail);
    const actions = document.createElement('div'); actions.className = 'actions';
    for (const [label, action] of [['Settings', () => edit(index)], ['Check status', () => pull(source.id, true)], ['Import', () => pull(source.id, false)]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', action); actions.append(button);
    }
    row.append(info, actions); $('sources').append(row);
  }
  if (!config.sources.length) $('sources').textContent = 'No sources have been added yet.';
}
function edit(index) {
  editing = index; const source = config.sources[index] || {};
  $('edit-title').textContent = index < 0 ? 'Add source' : `${source.id} settings`;
  $('source-id').value = source.id || ''; $('source-id').readOnly = index >= 0;
  $('project').value = source.project || ''; $('namespace').value = source.namespace || '';
  $('class-name').value = source.class_name || ''; $('version').value = source.version ?? '';
  if (filters) filters.dispose();
  filterSource = JSON.parse(JSON.stringify(source));
  filters = DevcelTagFilters.create($('tag-filters'), filterSource, async project => (await api('/api/tags', {project})).presets, () => {}, () => busy);
  filters.update($('project').value);
  $('editor').hidden = false; updateOutput(); $('project').focus();
}
function updateOutput() { $('output').textContent = `Output: ${editing >= 0 ? config.sources[editing].runtime_out : outputPath($('source-id').value || 'SOURCE_ID')}`; }
function pull(id, status) { task(async () => {
  show(status ? 'Checking status…' : 'Importing…');
  const data = await api(status ? '/api/status' : '/api/pull', {source:id});
  const states = {ready:'Up to date',needs_pull:'Reimport required',pulled:'Import completed',error:'Failed'};
  show(data.report.sources.map(source => `${source.id}: ${states[source.status] || source.status}`).join('\n') + (data.wolf ? '\nGenerated WOLF CSV files. Import them into a dedicated Variable DB.' : ''));
}); }
async function load() {
  const data = await api('/api/config'); config = data.config; engine = data.engine; revision = data.revision;
  $('context').textContent = `${engine} · ${data.root}`; $('wolf-help').hidden = engine !== 'wolf'; $('reload-help').hidden = engine === 'wolf';
  $('runtime-url').textContent = `${location.origin}/runtime/SOURCE_ID?token=${token}`;
  if (filters) filters.dispose();
  $('editor').hidden = true; render();
}
$('add').onclick = () => edit(-1); $('cancel').onclick = () => { if (filters) filters.dispose(); $('editor').hidden = true; };
$('refresh').onclick = () => task(load); $('source-id').oninput = updateOutput;
$('project').oninput = () => { if (filters) filters.update(''); };
$('project').onchange = () => { if (filters) filters.update($('project').value.trim().replaceAll('\\','/')); };
$('form').onsubmit = event => {
  event.preventDefault(); task(async () => {
    const next = JSON.parse(JSON.stringify(config));
    const id = $('source-id').value.trim();
    const source = editing >= 0 ? {...next.sources[editing]} : {id,mode:'full',runtime_out:outputPath(id)};
    for (const key of ['row_include_tags','row_exclude_tags','column_include_tags','column_exclude_tags']) source[key] = filterSource[key] || [];
    Object.assign(source,{project:$('project').value.trim().replaceAll('\\','/'),namespace:$('namespace').value.trim(),class_name:$('class-name').value.trim() || null,version:$('version').value === '' ? null : Number($('version').value)});
    if (editing < 0) next.sources.push(source); else next.sources[editing] = source;
    const result = await api('/api/config',{config:next,revision}); revision = result.revision; config = next; render(); $('editor').hidden = true; show('Settings saved. Click Import.');
  });
};
task(load);
