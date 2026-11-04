#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const studio = path.resolve(__dirname, '..');
const root = path.resolve(studio, '..');
const read = (p) => fs.readFileSync(path.join(root, p));
const text = (p) => read(p).toString('utf8');
const copies = {
  'svg/devcel-lockup-stacked-transparent.svg': 'brand/devcel-lockup-stacked-transparent.svg',
  'svg/devcel-lockup-stacked-inverse.svg': 'brand/devcel-lockup-stacked-inverse.svg',
  'icons/devcel-favicon-small.svg': 'brand/devcel-favicon-small.svg',
  'icons/favicon.ico': 'brand/favicon.ico',
  'icons/favicon-32.png': 'brand/favicon-32.png',
  'icons/favicon-180.png': 'brand/favicon-180.png',
  'icons/devcel-app-icon-dark.png': 'devcel.png',
};
for (const [source, target] of Object.entries(copies)) {
  assert.deepEqual(read(`assets/brand/${source}`), read(`devcel-studio/public/${target}`), target);
}
const config = JSON.parse(text('devcel-studio/src-tauri/tauri.conf.json'));
for (const icon of config.bundle.icon) assert.ok(read(`devcel-studio/src-tauri/${icon}`).length > 0, icon);
for (const [name, size] of Object.entries({ '32x32.png': 32, '64x64.png': 64, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512 })) {
  const png = read(`devcel-studio/src-tauri/icons/${name}`);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), size, name);
  assert.equal(png.readUInt32BE(20), size, name);
  assert.equal(png[25], 6, `${name} must retain RGBA`);
}
assert.equal(read('devcel-studio/src-tauri/icons/icon.icns').subarray(0, 4).toString(), 'icns');
assert.equal(read('devcel-studio/src-tauri/icons/icon.ico').readUInt16LE(2), 1);
const readme = text('README.md');
assert.match(readme, /prefers-color-scheme: dark/);
assert.match(readme, /prefers-color-scheme: light/);
for (const match of readme.matchAll(/(?:src|srcset)="(assets\/brand\/[^"]+)"/g)) assert.ok(read(match[1]).length > 0);
for (const file of ['devcel-studio/index.html', 'devcel-studio/src/app/components/common/WindowHeader.tsx', 'devcel-studio/src/app/pages/main_window/welcome_view/WelcomeView.tsx']) {
  for (const match of text(file).matchAll(/(?:href|src)="(\/brand\/[^"]+)"/g)) assert.ok(read(`devcel-studio/public${match[1]}`).length > 0);
}
assert.match(text('devcel-studio/src/app/pages/main_window/welcome_view/WelcomeView.tsx'), /sr-only.*welcome.title/);
const welcome = text('devcel-studio/src/app/pages/main_window/welcome_view/WelcomeView.tsx');
assert.match(welcome, /relative h-full w-full overflow-hidden/);
assert.match(welcome, /<AnimatedBackgroundManager[^>]+>[\s\S]*relative z-10 flex h-full w-full flex-col items-center overflow-auto p-6/);
console.log('PASS brand source parity, native icon sizes/formats, README light/dark assets, frontend references and accessible welcome heading');

assert.match(welcome, /welcome-logo-light/);
assert.match(welcome, /welcome-logo-dark/);
assert.doesNotMatch(text('devcel-studio/src/app/pages/main_window/welcome_view/welcome.css'), /brightness\(/);
