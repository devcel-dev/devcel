import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createTauriDevInvocation(port, extraArgs = []) {
  if (!/^(142[1-9]|1430)$/.test(port ?? '')) {
    throw new Error('Expected a development port from 1421 through 1430.');
  }
  return {
    command: process.execPath,
    args: [fileURLToPath(import.meta.resolve('@tauri-apps/cli/tauri.js')), 'dev', '--port', port, ...extraArgs],
    options: { stdio: 'inherit', env: { ...process.env, VITE_PORT: port }, shell: false },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const invocation = createTauriDevInvocation(process.argv[2], process.argv.slice(3));
    const child = spawn(invocation.command, invocation.args, invocation.options);
    const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = new Map(signals.map(signal => [signal, () => child.kill(signal)]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const cleanup = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
    child.once('error', error => { cleanup(); console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => { cleanup(); process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1); });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
