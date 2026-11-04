// Production indicator rendered with status DTO fixtures; native client counts are tested separately.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(project, '.p2p-status-check-'));
const browser = new Window({ url: 'http://p2p-status.invalid' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? browser : browser[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__p2pStatus = { connected: false };
let root;
try {
  const bundled = await build({
    absWorkingDir: project,
    stdin: { contents: "export { P2PStatusIndicator } from './src/app/components/P2PStatusIndicator';", resolveDir: project, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', write: false,
    alias: { '@': resolve(project, 'src') },
    plugins: [{ name: 'p2p-fixtures', setup(plugin) {
      const fixtures = {
        '../hooks/useP2P': 'export const useP2P = () => ({ status: globalThis.__p2pStatus });',
        '@/app/i18n': 'export const useI18n=()=>{}; export const t=(key)=>key; export const localizeError=String;',
        '@tauri-apps/api/core': 'export const invoke=async()=>JSON.stringify(globalThis.__p2pStatus);',
      };
      plugin.onResolve({ filter: /^(\.\.\/hooks\/useP2P|@\/app\/i18n|@tauri-apps\/api\/core)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: fixtures[args.path] }));
    } }],
  });
  const path = resolve(temporary, 'check.mjs');
  await writeFile(path, bundled.outputFiles[0].text);
  const { P2PStatusIndicator } = await import(pathToFileURL(path));
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const render = async status => {
    globalThis.__p2pStatus = status;
    await React.act(async () => root.render(React.createElement(P2PStatusIndicator)));
  };
  for (const connectedClients of [undefined, 0]) {
    await render({ connected: true, mode: 'server', connectedClients });
    assert.equal(host.innerHTML, '', 'Listening alone must not show a server indicator');
  }
  for (const connectedClients of [1, 2]) {
    await render({ connected: true, mode: 'server', connectedClients });
    const indicator = host.querySelector('[data-p2p-status="server"]');
    assert(indicator, 'A server with connected clients must be visible');
    assert.equal(indicator.tagName, 'SPAN');
    assert(!/\b(?:bg-|border|rounded|shadow)/.test(indicator.className), 'No chip background, border, or shadow');
    assert(host.textContent.includes('p2p.server'));
  }
  await render({ connected: true, mode: 'server', connectedClients: 1 });
  assert(host.querySelector('[data-p2p-status="server"]'));
  await render({ connected: true, mode: 'server', connectedClients: 0 });
  assert.equal(host.innerHTML, '', 'Last disconnect must hide the still-listening server');
  await render({ connected: true, mode: 'client', address: '127.0.0.1:1234' });
  assert(host.querySelector('[data-p2p-status="client"]'), 'Connected client state stays visible');
  await render({ connected: false, mode: 'client' });
  assert(host.textContent.includes('p2p.offline'), 'Disconnected client state stays visible');
  await render({ connected: false });
  assert(host.textContent.includes('p2p.offline'), 'Unknown/failed connection state stays visible');
  console.log('PASS: server 0/unknown/1/2 clients, last disconnect, unstyled status, client and offline states');
} finally {
  if (root) await (await import('react')).act(async () => root.unmount());
  delete globalThis.__p2pStatus;
  await browser.happyDOM.abort();
  await rm(temporary, { recursive: true, force: true });
}
