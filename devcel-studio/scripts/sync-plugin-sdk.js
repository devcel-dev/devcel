import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(studio, 'src/app/types');
const target = path.join(studio, 'templates/plugin-template/src/types');
const check = process.argv.includes('--check');
// Ship the host's exact public DTOs; never maintain an independent older SDK.
const files = ['pluginTypes.ts', 'menuTypes.ts', 'tableTypes.ts', 'tableRules.ts', 'colorTypes.ts'];
for (const name of files) {
  let contents = fs.readFileSync(path.join(source, name), 'utf8').replace(/\r\n/g, '\n');
  if (name === 'pluginTypes.ts') contents += "\nexport type { MenuConfiguration } from './menuTypes';\n";
  if (check) {
    if (!fs.existsSync(path.join(target, name)) || fs.readFileSync(path.join(target, name), 'utf8').replace(/\r\n/g, '\n') !== contents) throw new Error(`Plugin SDK is stale: ${name}`);
  } else fs.writeFileSync(path.join(target, name), contents);
}
console.log('Plugin SDK matches current host DTOs');
