"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
const path = require('path');
const { Importer } = require('../editor/importer.cjs');
let importer;
let lastWatch = null;
function getImporter() {
    if (!importer)
        importer = new Importer({ packageRoot: path.resolve(__dirname, '..'), configPath: path.join(Editor.Project.path, 'devcel.import.json'), validateConfig: validateCocos, onImported: async (source) => {
                for (const output of [source.runtime_out, source.code_out].filter(Boolean)) {
                    const relative = path.relative(path.join(Editor.Project.path, 'assets'), path.resolve(Editor.Project.path, output));
                    if (relative.startsWith('..') || path.isAbsolute(relative))
                        throw new Error('Cocos output must be under assets');
                    await Editor.Message.request('asset-db', 'refresh-asset', 'db://assets/' + relative.split(path.sep).join('/'));
                }
                if (source.code_out) {
                    const directory = path.relative(path.join(Editor.Project.path, 'assets'), path.dirname(path.resolve(Editor.Project.path, source.code_out))).split(path.sep).join('/');
                    await Editor.Message.request('asset-db', 'refresh-asset', 'db://assets/' + directory);
                }
                Editor.Message.broadcast('devcel-importer:imported', { sourceId: source.id, runtime: source.runtime_out });
            } });
    return importer;
}
function validateCocos(config) {
    for (const source of config.sources ?? []) {
        for (const [field, base] of [['runtime_out', 'assets/resources'], ['code_out', 'assets']]) {
            if (!source[field])
                continue;
            const relative = path.relative(path.resolve(Editor.Project.path, base), path.resolve(Editor.Project.path, source[field]));
            if (relative.startsWith('..') || path.isAbsolute(relative))
                throw new Error(`${field} must be inside ${base}`);
        }
    }
}
exports.methods = {
    openPanel() { Editor.Panel.open('devcel-importer'); },
    async tagPresets(project) { return getImporter().tagPresets(project); },
    async config() { return { ...(await getImporter().configState()), path: getImporter().configPath, watch: lastWatch }; },
    async save(config, revision) { validateCocos(config); await getImporter().save(config, revision); return getImporter().configState(); },
    async importSource(id = '') { validateCocos(await getImporter().config()); return getImporter().import(id); },
    async status() { return { result: await getImporter().import('', true), watch: lastWatch }; },
    watch(enabled) { if (enabled)
        getImporter().watch((value) => { lastWatch = value; });
    else
        getImporter().stopWatch(); return { watching: enabled }; },
    async chooseProject() { const result = await Editor.Dialog.select({ title: 'Select a source project', filters: [{ name: 'Devcel project', extensions: ['toml'] }], multi: false }); return result.canceled || !result.filePaths.length ? '' : path.relative(Editor.Project.path, result.filePaths[0]).split(path.sep).join('/'); }
};
function load() { }
function unload() { if (importer)
    importer.stopWatch(); importer = undefined; }
