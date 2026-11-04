import { message, toAppError, type AppError } from '@/app/i18n';
import { Plugin } from '@/app/types/pluginTypes';
import { valid, validRange, satisfies } from 'semver';
export interface DependencyNode { id: string; plugin: Plugin; dependencies: string[]; dependents: string[]; resolved: boolean }
export interface DependencyGraph { nodes: Map<string, DependencyNode>; edges: Map<string, string[]> }
export interface ResolutionResult { success: boolean; order: string[]; errors: AppError[]; warnings: AppError[]; unresolvedDependencies: string[]; circularDependencies: string[][] }

export class PluginDependencyResolver {
  private plugins = new Map<string, Plugin>();
  addPlugin(plugin: Plugin) { this.plugins.set(plugin.metadata.id, plugin); }
  removePlugin(id: string) { this.plugins.delete(id); }
  clear() { this.plugins.clear(); }
  resolveDependencies(ids = [...this.plugins.keys()]): ResolutionResult {
    const order: string[] = [], errors: AppError[] = [], unresolvedDependencies: string[] = [], circularDependencies: string[][] = [];
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string, path: string[]) => {
      if (visiting.has(id)) { const cycle = [...path.slice(path.indexOf(id)), id]; circularDependencies.push(cycle); errors.push(toAppError(message('plugin.dependency.cycle', { cycle: cycle.join(' → ') }))); return; }
      if (visited.has(id)) return;
      const plugin = this.plugins.get(id);
      if (!plugin) { unresolvedDependencies.push(id); errors.push(toAppError(message('plugin.dependency.missing', { id }))); return; }
      visiting.add(id);
      for (const [dependency, range] of Object.entries(plugin.metadata.dependencies || {})) {
        const target = this.plugins.get(dependency);
        if (!validRange(range)) errors.push(toAppError(message('plugin.dependency.invalidRange', { id, dependency, range })));
        else if (target && (!valid(target.metadata.version) || !satisfies(target.metadata.version, range))) errors.push(toAppError(message('plugin.dependency.versionMismatch', { id, dependency, range, version: target.metadata.version })));
        visit(dependency, [...path, id]);
      }
      visiting.delete(id); visited.add(id); order.push(id);
    };
    ids.forEach(id => visit(id, []));
    return { success: errors.length === 0, order: errors.length ? [] : order, errors: [...new Map(errors.map(error => [JSON.stringify(error), error])).values()], warnings: [], unresolvedDependencies: [...new Set(unresolvedDependencies)], circularDependencies };
  }
  generateGraphVisualization() {
    return { nodes: [...this.plugins].map(([id, p]) => ({ id, label: p.metadata.name, dependencies: Object.keys(p.metadata.dependencies || {}).length })),
      edges: [...this.plugins].flatMap(([id, p]) => Object.keys(p.metadata.dependencies || {}).map(to => ({ from: id, to }))) };
  }
  analyzeRemovalImpact(id: string) {
    const affectedPlugins = [...this.plugins].filter(([, p]) => id in (p.metadata.dependencies || {})).map(([key]) => key);
    const seen = new Set<string>();
    const visit = (target: string) => {
      for (const [key, plugin] of this.plugins) if (!seen.has(key) && target in (plugin.metadata.dependencies || {})) { seen.add(key); visit(key); }
    };
    visit(id); seen.delete(id);
    return { affectedPlugins, cascadeRemovals: [...seen], warnings: [...seen].map(key => toAppError(message('plugin.dependency.removalWarning', { dependent: key, id }))) };
  }
  generateDependencyReport() {
    const dependencyDepth = new Map<string, number>();
    const depth = (id: string, seen = new Set<string>()): number => {
      if (seen.has(id)) return 0;
      const deps = Object.keys(this.plugins.get(id)?.metadata.dependencies || {});
      return deps.length ? 1 + Math.max(...deps.map(dep => depth(dep, new Set([...seen, id])))) : 0;
    };
    for (const id of this.plugins.keys()) dependencyDepth.set(id, depth(id));
    const mostDependent = [...this.plugins.keys()].map(id => ({ id, dependents: this.analyzeRemovalImpact(id).affectedPlugins.length })).sort((a, b) => b.dependents - a.dependents);
    return { totalPlugins: this.plugins.size, dependencyDepth, mostDependent: mostDependent.slice(0, 5),
      orphanPlugins: mostDependent.filter(p => !p.dependents && !dependencyDepth.get(p.id)).map(p => p.id),
      complexDependencies: [...this.plugins].filter(([, p]) => Object.keys(p.metadata.dependencies || {}).length >= 3).map(([id]) => id) };
  }
}
