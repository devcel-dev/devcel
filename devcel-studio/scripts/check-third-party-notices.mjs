import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../../scripts/generate-third-party-notices.py', import.meta.url));
const candidates = process.platform === 'win32'
  ? [['python'], ['py', '-3'], ['python3']]
  : [['python3'], ['python']];

for (const [command, ...prefix] of candidates) {
  const probe = spawnSync(command, [...prefix, '-c', "import sys, tomllib; sys.exit(0 if sys.version_info >= (3, 11) and not sys.flags.isolated else 1)"], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) continue;
  const result = spawnSync(command, [...prefix, checker, '--check-locks'], { stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') continue;
  if (result.error) {
    console.error(`Could not run the third-party notice check: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
console.error('Standard Python 3.11+ with script imports enabled is required. Install it as python, py -3, or python3 and reopen the shell; isolated embeddable distributions are unsupported.');
process.exit(1);
