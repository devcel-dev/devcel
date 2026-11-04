// Source CSS geometry contract; not a browser hit-test or native screenshot test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postcss from 'postcss';
const css = postcss.parse(await readFile(new URL('../src/app/pages/main_window/project_view/table_view/components/DataGridView.css', import.meta.url), 'utf8'));
function declarations(selector) {
  const result = {};
  css.walkRules(rule => {
    if (rule.selectors.includes(selector) && rule.parent.type === 'root') {
      rule.walkDecls(decl => { result[decl.prop] = decl.value; });
    }
  });
  return result;
}
const px = (selector, key) => parseFloat(declarations(selector)[key]);
for (const selector of ['.rdg-boundary-button', '.rdg-row-insert-control button', '.rdg-transpose-column-insert', '.rdg-corner-inserts button']) {
  const style = declarations(selector);
  assert.equal(style.width, '20px', selector);
  assert.equal(style.height, '20px', selector);
  assert.equal(style['border-radius'], '0', 'rectangle, including its corners');
  assert.equal(style.background, 'transparent');
}
assert.equal(px('.rdg-row-insert-control', 'width'), 20, 'wrapper centers the whole target');
assert.equal(px('.rdg-row-insert-control', 'height'), 20);
assert.equal(px('.rdg-insert-icon', 'width'), 16);
assert.equal(px('.rdg-insert-icon', 'height'), 16);
assert.equal(declarations('.rdg-insert-icon')['pointer-events'], 'none');
const start = px('.rdg-column-insert-start', 'inset-inline-start');
const end = px('.rdg-column-insert-end', 'inset-inline-end');
const width = px('.rdg-cell-has-inline-buttons > .rdg-cell-resizer', 'width');
for (const side of ['left', 'right']) {
  const offset = px(`.rdg-cell-has-inline-buttons > .rdg-cell-resizer-${side}`, `inset-inline-${side === 'left' ? 'start' : 'end'}`);
  assert.equal(offset + width / 2, 0, 'resize centered, not displaced into neighbor');
}
for (const zoom of [1, 2]) {
  assert.equal((20 - 16) / 2 * zoom, 2 * zoom, 'two CSS pixels extra on every side');
  assert.equal((start + 10) * zoom, (6 + 8) * zoom, 'approved left icon center preserved');
  assert.equal((end + 10) * zoom, (6 + 8) * zoom, 'approved right icon center preserved');
  assert.equal((start - width / 2) * zoom, zoom, 'left target and centered resize have a positive gap');
  assert.equal((end - width / 2) * zoom, zoom, 'right target and centered resize have a positive gap');
  assert.equal((px('.rdg-column-filter-slot', 'inset-inline-end') - end - 20) * zoom, 4 * zoom, 'sort slot stays separated from right insert');
}
console.log('PASS: rectangular targets, fixed SVG, preserved centers, centered resize and sort gaps at 100/200%. Source contract only; native hit-test remains pending.');

assert.equal(declarations('[data-narrow-insertion] > .rdg-column-insert-end').display,'none');
assert.equal(px('[data-narrow-insertion] > .rdg-column-filter-slot','inset-inline-end'),4);
assert.equal(declarations('.rdg-column-filter-slot')['max-width'],'calc(100% - 52px)');
assert.equal(declarations('.rdg-column-filter-slot .grid-fs-trigger')['max-width'],'100%');
for(const zoom of [1,2]) for(const columnWidth of [50,70,71,100]) for(const naturalSortWidth of [18,30,48]) {
  const narrow=columnWidth<=70;
  const sortWidth=narrow?18:Math.min(naturalSortWidth,columnWidth-52);
  const sortEnd=narrow?4:28;
  const sortStart=columnWidth-sortEnd-sortWidth;
  assert(sortStart*zoom >= (start+20)*zoom,`left plus vs actual capped sort: ${columnWidth}/${naturalSortWidth}/${zoom}`);
  if(!narrow) assert((columnWidth-sortEnd)*zoom <= (columnWidth-end-20)*zoom);
}
console.log('PASS: 50/70/71 widths, both insertion sides, variable sort content, and 100/200% CSS geometry; hidden right target uses display:none.');
