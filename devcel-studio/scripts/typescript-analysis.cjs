'use strict';
const path = require('node:path');
const { API } = require('typescript/unstable/sync');
let nextParser = 0;
const normalizePath = value => value.replace(/\\/g, '/');
/** Parse isolated sources with the application TypeScript compiler. */
function createSourceParser() {
  const root = normalizePath(path.resolve(__dirname, `.source-analysis-${process.pid}-${nextParser++}`));
  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  const files = new Map();
  const api = new API({ cwd: __dirname, fs: {
    readFile: file => files.get(normalizePath(file)), fileExists: file => files.has(normalizePath(file)) ? true : undefined,
    directoryExists: directory => (normalizePath(directory) === root || normalizePath(directory).startsWith(`${root}/`)) ? true : undefined,
  } });
  let previousConfig, sourceId = 0, closed = false;
  const close = () => { if (!closed) api.close(); closed = true; process.removeListener('exit', close); };
  process.once('exit', close);
  return {
    parse(file, text) {
      const extension = path.extname(file);
      if (!extensions.includes(extension)) throw new Error(`Unsupported analysis source: ${file}`);
      const directory = path.posix.join(root, String(sourceId++));
      const config = path.posix.join(directory, 'tsconfig.json');
      const virtualFile = path.posix.join(directory, `source${extension}`);
      files.set(virtualFile, text);
      files.set(config, JSON.stringify({ compilerOptions: { noLib: true, noResolve: true, allowJs: true, jsx: 'preserve' }, files: [virtualFile] }));
      const snapshot = api.updateSnapshot({ openProjects: [config], ...(previousConfig ? { closeProjects: [previousConfig] } : {}) });
      previousConfig = config;
      try {
        const program = snapshot.getProject(config)?.program;
        const source = program?.getSourceFile(virtualFile);
        if (!source) throw new Error(`TypeScript did not parse ${file}`);
        return { source, diagnostics: program.getSyntacticDiagnostics(virtualFile) };
      } finally { snapshot.dispose(); }
    }, close,
  };
}
module.exports = { createSourceParser };
