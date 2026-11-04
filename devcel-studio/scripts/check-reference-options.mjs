// Run from devcel-studio: node scripts/check-reference-options.mjs
// Checks production Reference components/cache with synthetic IPC and DOM data.
// This does not exercise native P2P delivery, Rust commands, or browser layout.
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), 'devcel-reference-check-'));
const modulePath = join(temporary, 'reference-checks.mjs');

const mocks = {
  tauri: `export const invoke = (...args) => globalThis.__invoke(...args);`,
  i18n: `
    export const useI18n = () => ({ t: key => key });
    export const formatNumber = value => globalThis.__formatNumber?.(value) ?? String(value);
    export const message = key => ({ key });
    export const resolveMessage = value => typeof value === 'string' ? value : value.key;
  `,
  popover: `
    export function ReferenceSelectPopover(props) {
      globalThis.__popover = props;
      return <div data-picker>{props.options.map(option =>
        <span key={option.value}>{option.label}</span>
      )}</div>;
    }
  `,
  icons: `export const ChevronDown = () => null;`,
};

try {
  await build({
    absWorkingDir: project,
    entryPoints: [resolve(project, 'scripts/fixtures/reference-options.tsx')],
    outfile: modulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    plugins: [{
      name: 'reference-regression-check',
      setup(builder) {
        // Resolve runtime dependencies from this project even though generated
        // code lives in the OS temp directory. No copied packages or symlinks.
        builder.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|happy-dom)$/ }, args => ({
          path: pathToFileURL(require.resolve(args.path)).href, external: true,
        }));
        builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'tauri', namespace: 'mock' }));
        builder.onResolve({ filter: /^@\/app\/i18n$/ }, () => ({ path: 'i18n', namespace: 'mock' }));
        builder.onResolve({ filter: /^@\/components\/ui\/reference-select-popover$/ }, () => ({ path: 'popover', namespace: 'mock' }));
        builder.onResolve({ filter: /^lucide-react$/ }, () => ({ path: 'icons', namespace: 'mock' }));
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({
          loader: 'tsx', contents: mocks[args.path],
        }));
      },
    }],
  });
  const { runReferenceOptionsChecks } = await import(pathToFileURL(modulePath));
  await runReferenceOptionsChecks();
} finally {
  await rm(temporary, { recursive: true, force: true });
}
