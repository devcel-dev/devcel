import {execFileSync} from 'node:child_process';
import path from 'node:path';

// Reuse the release renderer; never modify tracked TypeScript during a build.
export function bundledPluginVersions(studio) {
  const root = path.resolve(studio, '..');
  const normalize = value => value.replaceAll('\\', '/');
  const files = new Set([
    normalize(path.join(studio, 'src/app/plugins/examples/CSVExporterPlugin.ts')),
  ]);
  return {
    name: 'bundled-plugin-versions',
    enforce: 'pre',
    buildStart() { this.addWatchFile(path.join(studio, 'src-tauri/tauri.conf.json')); },
    load(id) {
      if (!files.has(normalize(id))) return null;
      const rendered = JSON.parse(execFileSync(process.env.PYTHON || 'python', [
        path.join(root, 'scripts/bundled_plugin_versions.py'), '--render-json', '--root', root,
      ], {encoding: 'utf8'}));
      return rendered[normalize(path.relative(root, id))];
    },
  };
}
