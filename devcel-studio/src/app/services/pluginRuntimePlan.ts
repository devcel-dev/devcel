import { valid, validRange, satisfies } from 'semver';
import type { PluginMetadata } from '@/app/types/pluginTypes';

/** Pure plan: dependency resolution never changes a user's enabled selection. */
export function pluginRuntimePlan(metadata: ReadonlyMap<string, PluginMetadata>,
  requested: (id: string) => boolean, permitted: (id: string) => boolean) {
  const order: string[] = [], blocked = new Set<string>(), ready = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (ready.has(id)) return true;
    if (blocked.has(id)) return false;
    const item = metadata.get(id);
    if (!item || !requested(id) || !permitted(id) || visiting.has(id)) { blocked.add(id); return false; }
    visiting.add(id);
    let good = true;
    for (const [dependency, range] of Object.entries(item.dependencies || {})) {
      const target = metadata.get(dependency);
      if (!target || !validRange(range) || !valid(target.version) || !satisfies(target.version, range)
        || !visit(dependency)) good = false;
    }
    visiting.delete(id);
    if (!good) { blocked.add(id); return false; }
    ready.add(id); order.push(id); return true;
  };
  for (const id of metadata.keys()) if (requested(id)) visit(id);
  return { order, ready, blocked };
}
