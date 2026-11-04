// Node's ESM loader accepts file URLs, not Windows drive-letter paths.
// options is passed through only to exercise both host path conventions in tests.
const { pathToFileURL } = require("node:url");
function fileImportUrl(filename, options) {
  return pathToFileURL(filename, options).href;
}
module.exports = { fileImportUrl };
