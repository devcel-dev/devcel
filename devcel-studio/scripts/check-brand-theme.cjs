const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const css = read('src/app/settings/generated/themes.css');
function rgb(h,s,l) {
  s/=100;l/=100;
  const a=s*Math.min(l,1-l), f=n=>{const k=(n+h/30)%12;return l-a*Math.max(-1,Math.min(k-3,9-k,1));};
  return [f(0),f(8),f(4)];
}
function lum(c) { return c.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0); }
function contrast(a,b) {a=lum(a);b=lum(b);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
for (const theme of [':root', '.dark']) {
 const block=css.slice(css.indexOf(theme)).split('}')[0];
 const tokens=Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g)].map(m=>[m[1],rgb(...m.slice(2).map(Number))]));
 for(const [fg,bg] of [['foreground','background'],['primary-foreground','primary'],['accent-foreground','accent'],['primary-ink','accent'],['primary-ink','background'],['muted-foreground','muted']]) {
  const ratio=contrast(tokens[fg],tokens[bg]); assert(ratio>=4.5,`${theme} ${fg}/${bg}: ${ratio}`); console.log(`${theme} ${fg}/${bg}: ${ratio.toFixed(2)}:1`);
 }
  for (const bg of ['background', 'secondary', 'accent']) assert(contrast(tokens.ring,tokens[bg])>=3, `${theme} focus ring on ${bg}`);
  const mint=rgb(164.07,51.13,56.67);
  assert(tokens.primary.every((v,i)=>Math.abs(v-mint[i])<0.001), `${theme} uses selected #58C9AB mint fill`);
  const hover=tokens.primary.map((v,i)=>v*.9+tokens.background[i]*.1);
  assert(contrast(tokens['primary-foreground'],hover)>=4.5, `${theme} primary hover text`);
}
assert.match(read('src/app/config/brand.ts'), /DEFAULT_PROJECT_HEADER_COLOR = '#242A30'/);
assert.match(read('../devcel-core/src/project_impl.rs'), /DEFAULT_PROJECT_HEADER_COLOR: &str = "#242A30"/);
assert.match(read('src/app/pages/main_window/MainWindow.tsx'), /session\?\.header_color \?\? DEFAULT_PROJECT_HEADER_COLOR/);
assert.match(read('../devcel-cli/src/main.rs'), /default_value = devcel_core::project_impl::DEFAULT_PROJECT_HEADER_COLOR/);
console.log('PASS brand defaults, persisted session color precedence, and light/dark text contrast');

assert.doesNotMatch(read('src/app/pages/main_window/project_view/file_browser_view/components/FileNodeComponent.tsx'), /text-white/, 'Neutral selected file rows must not retain white child text');

// Every plugin theme supplies the full color contract without inferred values.
const vm = require('node:vm');
const compiled = require('esbuild').transformSync(read('src/app/config/brand.ts'), { loader: 'ts', format: 'cjs' }).code;
const sandbox = { module: { exports: {} }, exports: {} }; vm.runInNewContext(compiled, sandbox);
const { THEME_COLOR_TOKENS, isCompleteTheme, themeCssVariables } = sandbox.module.exports;
const colors = Object.fromEntries(THEME_COLOR_TOKENS.map(key => [key, '210 70% 40%']));
const theme = { id: 'complete', name: 'Complete', description: 'Complete tokens', type: 'light', colors };
assert(isCompleteTheme(theme));
for (const key of THEME_COLOR_TOKENS) {
  const incomplete = { ...colors }; delete incomplete[key];
  assert.equal(isCompleteTheme({ ...theme, colors: incomplete }), false, `missing ${key} is rejected`);
}
assert.equal(isCompleteTheme({ ...theme, colors: { primary: '210 70% 40%' } }), false);
assert.equal(isCompleteTheme({ ...theme, colors: { ...colors, primary: '' } }), false);
assert.equal(isCompleteTheme({ ...theme, cssVariables: { primary: '0 0% 0%' } }), false);
assert.equal(isCompleteTheme({ ...theme, cssVariables: { '--primary': '0 0% 0%' } }), false);
const explicit = { ...theme, colors: { ...colors, 'primary-foreground': '0 0% 90%', 'primary-ink': '210 80% 20%' }, cssVariables: { '--plugin-accent': 'red' } };
assert(isCompleteTheme(explicit));
const vars = themeCssVariables(explicit);
assert.equal(vars['--primary-foreground'], '0 0% 90%');
assert.equal(vars['--primary-ink'], '210 80% 20%');
assert.equal(vars['--plugin-accent'], 'red');
assert.equal(colors['--primary'], undefined, 'do not mutate plugin colors');
const semanticTokens = new Set([...css.matchAll(/--([\w-]+):/g)].map(match => match[1]).filter(key => key !== 'radius'));
assert.deepEqual(new Set(THEME_COLOR_TOKENS), semanticTokens);
const plugin = read('src/app/settings/AppTheme.tsx');
assert(plugin.indexOf('const vars = selectedTheme ? themeCssVariables') < plugin.indexOf('const previous ='), 'every theme variable participates in cleanup');
console.log('PASS explicit complete plugin colors, exact mint fill, and hover/focus contrast');

// Markdown insertion carets must follow the same accessible light/dark foreground token.
const markdownStyles = read('src/index.css');
const editorRules = [...markdownStyles.matchAll(/\.ProseMirror\s*\{([^}]+)\}/g)];
assert(editorRules.length > 0, 'Markdown editor styles exist');
assert(editorRules.some(([, rule]) => /caret-color:/.test(rule)), 'Markdown caret declaration exists');
for (const [, rule] of editorRules) {
  if (/caret-color:/.test(rule)) assert.match(rule, /caret-color:\s*hsl\(var\(--foreground\)\)/, 'Markdown caret uses theme foreground');
}
assert.doesNotMatch(markdownStyles, /caret-color:\s*rgb\(55 65 81\)/, 'Do not reintroduce a dark fixed caret on dark backgrounds');
console.log('PASS Markdown caret follows accessible theme foreground');

assert.match(markdownStyles, /\.ProseMirror pre\s*\{[^}]*caret-color:\s*#f3f4f6/, 'Always-dark code blocks keep a light caret in both themes');
