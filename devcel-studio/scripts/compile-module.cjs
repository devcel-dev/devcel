'use strict';
const { transformSync } = require('esbuild');
/** Compile a production module for an isolated CommonJS integration harness. */
function compileModule(source, fileName, jsx = 'automatic') {
  return transformSync(source, {
    sourcefile: fileName, loader: fileName.endsWith('.json') ? 'json' : fileName.endsWith('.tsx') ? 'tsx' : 'ts',
    target: 'es2020', format: 'cjs', jsx,
  }).code;
}
module.exports = { compileModule };
