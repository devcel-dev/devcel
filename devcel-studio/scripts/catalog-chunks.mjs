import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const prefix = '\0devcel-catalog:';
const payloadPrefix = `${prefix}locale:`;

// Shared strings avoid duplicating the generated dictionaries in the bundle while
// JSON.parse in each wrapper preserves the original catalogs' independent objects.
// Only the two exact generated files are redirected, and only for production builds.
export function catalogChunks(root) {
  const targets = new Map([
    [path.resolve(root, 'src/app/i18n/generated/catalog.json'), 'i18n'],
    [path.resolve(root, 'src/app/settings/generated/catalog.json'), 'settings'],
  ]);
  const modules = new Map();
  return {
    name: 'devcel-catalog-chunks',
    enforce: 'pre',
    apply: 'build',
    buildStart() {
      modules.clear();
      for (const [filename, kind] of targets) {
        this.addWatchFile(filename);
        const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        const localization = kind === 'settings' ? data.localization : data;
        const imports = [];
        const dictionaries = [];
        for (const [locale, messages] of Object.entries(localization.messages)) {
          const payload = JSON.stringify(messages);
          const hash = createHash('sha256').update(payload).digest('hex');
          const id = `${payloadPrefix}${locale}:${hash}`;
          modules.set(id, `export default ${JSON.stringify(payload)};`);
          const binding = `locale${imports.length}`;
          imports.push(`import ${binding} from ${JSON.stringify(id)};`);
          dictionaries.push(`[${JSON.stringify(locale)}]: JSON.parse(${binding})`);
        }
        const metadata = { ...localization };
        delete metadata.messages;
        const localizationCode = `{...JSON.parse(${JSON.stringify(JSON.stringify(metadata))}), messages: {${dictionaries.join(',')}}}`;
        // Preserve generated property order as well as values and object ownership.
        const fields = Object.entries(data).map(([key, value]) => {
          const expression = kind === 'settings' && key === 'localization' ? localizationCode
            : kind === 'i18n' && key === 'messages' ? `{${dictionaries.join(',')}}`
            : `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
          return `export const ${key} = ${expression};`;
        });
        modules.set(`${prefix}${kind}`, `${imports.join('\n')}\n${fields.join('\n')}\nexport default {${Object.keys(data).join(',')}};`);
      }
    },
    async resolveId(source, importer) {
      if (modules.has(source)) return source;
      if (!source.endsWith('catalog.json')) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      const kind = resolved && targets.get(path.resolve(resolved.id));
      return kind ? `${prefix}${kind}` : null;
    },
    load(id) { return modules.get(id) ?? null; },
  };
}

// Leaf data chunks cannot introduce application initialization cycles.
export const catalogLocaleGroup = {
  debugName: 'generated-locale-payloads',
  name: id => id.startsWith(payloadPrefix) ? `locale-${id.slice(payloadPrefix.length).split(':')[0]}` : null,
  test: id => id.startsWith(payloadPrefix),
  priority: 60,
};
