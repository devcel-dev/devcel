/* Shared importer tag selectors. Keep the RPG Maker copy byte-for-byte identical. */
(function (global) {
    'use strict';
    var fields = [
        ['row_include_tags', 'Include rows'], ['row_exclude_tags', 'Exclude rows'],
        ['column_include_tags', 'Include columns'], ['column_exclude_tags', 'Exclude columns']
    ];
    function node(tag, text) { var n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; }
    function create(host, source, loadPresets, changed, isBusy) {
        var presets = [], generation = 0, project = '', message = '', loading = false;
        function select(value, placeholder) {
            var input = node('select'), empty = node('option', placeholder); empty.value = ''; input.appendChild(empty);
            presets.forEach(function (name) { var option = node('option', name); option.value = name; input.appendChild(option); });
            input.value = value; return input;
        }
        function render() {
            host.textContent = '';
            host.appendChild(node('h3', 'Tag filters'));
            host.appendChild(node('p', 'Empty include filters keep all rows or columns. Any include tag matches; exclude tags take priority.'));
            var status = node('p', message); status.setAttribute('role', 'status'); host.appendChild(status);
            var refresh = node('button', 'Reload project tags'); refresh.type = 'button'; refresh.addEventListener('click', function () { update(project); }); host.appendChild(refresh);
            fields.forEach(function (field) {
                var key = field[0], group = node('div'); group.className = 'tag-filter';
                group.appendChild(node('h4', field[1]));
                var values = source[key] || [];
                values.forEach(function (value, index) {
                    var row = node('div'); row.className = 'actions toolbar';
                    var known = presets.indexOf(value) >= 0;
                    var input = known ? select(value, 'Select a project tag') : node('input');
                    input.setAttribute('aria-label', field[1] + ' tag ' + (index + 1));
                    if (!known) { input.value = value; input.title = 'Unregistered tag. Edit the existing value or remove it explicitly.'; }
                    if (!known) input.addEventListener('input', function () { source[key][index] = input.value; changed(); });
                    input.addEventListener('change', function () {
                        if (known && input.value === '') { input.value = value; return; }
                        source[key][index] = input.value; changed(); render();
                    });
                    row.appendChild(input);
                    if (!known) row.appendChild(node('small', loading ? 'Checking registry…' : 'Unregistered tag (kept)'));
                    var remove = node('button', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove ' + field[1].toLowerCase() + ' tag ' + (index + 1));
                    remove.addEventListener('click', function () { source[key].splice(index, 1); changed(); render(); }); row.appendChild(remove); group.appendChild(row);
                });
                var add = select('', presets.length ? 'Add a project tag…' : 'No project tags available'); add.setAttribute('aria-label', 'Add ' + field[1].toLowerCase() + ' tag');
                add.addEventListener('change', function () {
                    if (!add.value || presets.indexOf(add.value) < 0) return;
                    if (!source[key]) source[key] = [];
                    if (source[key].indexOf(add.value) < 0) { source[key].push(add.value); changed(); }
                    render();
                }); group.appendChild(add); host.appendChild(group);
            });
            if (isBusy && isBusy()) Array.prototype.forEach.call(host.querySelectorAll('button,input,select'), function (input) { input.disabled = true; });
        }
        function update(path) {
            project = path; var current = ++generation; presets = []; loading = !!path;
            message = path ? 'Loading project tags…' : 'Choose a project to select its tags. Existing filters are kept.'; render();
            if (!path) return Promise.resolve();
            return Promise.resolve().then(function () { return loadPresets(path); }).then(function (names) {
                if (current !== generation) return;
                if (!Array.isArray(names) || names.some(function (name) { return typeof name !== 'string'; })) throw new Error('Invalid project tag registry');
                presets = names.filter(function (name, index) { return names.indexOf(name) === index; }); loading = false;
                message = presets.length ? '' : 'This project has no registered tags. Existing filters are kept.'; render();
            }).catch(function (error) {
                if (current !== generation) return;
                loading = false; message = 'Could not load project tags. Existing filters are kept. ' + error.message; render();
            });
        }
        render(); return {update: update, dispose: function () { generation++; }};
    }
    global.DevcelTagFilters = {create: create};
})(typeof window === 'undefined' ? globalThis : window);
