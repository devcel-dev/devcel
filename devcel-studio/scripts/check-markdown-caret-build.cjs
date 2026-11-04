const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// Run after npm run build: inspect emitted CSS, not only source declarations.
const assets = path.resolve(__dirname, '../dist/assets');
const files = fs.readdirSync(assets).filter(name => /^index-.*\.css$/.test(name));
assert.equal(files.length, 1, 'Expected one freshly built application stylesheet');
const css = fs.readFileSync(path.join(assets, files[0]), 'utf8');
assert.equal([...css.matchAll(/\.ProseMirror\{[^}]*caret-color:hsl\(var\(--foreground\)\)[^}]*\}/g)].length, 2, 'Both editor rules retain their theme caret in emitted CSS');
assert.match(css, /--foreground\s*:/, 'Theme foreground variable exists in emitted CSS');
assert.match(css, /\.ProseMirror pre\{[^}]*caret-color:#f3f4f6[^}]*\}/, 'Always-dark code block retains its explicit light caret');
assert.doesNotMatch(css, /caret-color:var\(--color-gray-100\)/, 'Do not depend on an undeclared palette variable');
console.log('PASS emitted Markdown caret colors and foreground definition');
