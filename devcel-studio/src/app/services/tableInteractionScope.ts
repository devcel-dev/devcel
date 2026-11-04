/** Main-window table ownership. Independent dialog windows have their own context. */
interface Scope { tableUuid: string | null; generation: number; pending: boolean }
const scopes = new Map<string, Scope>();
const listeners = new Set<() => void>();
let generation = 0;

export function setTableInteractionTarget(projectSession: string, tableUuid: string | null, pending = false): void {
  scopes.set(projectSession, { tableUuid, generation: ++generation, pending });
  // Retain closed-session tombstones so a late handler cannot regain authority.
  while (scopes.size > 16) scopes.delete(scopes.keys().next().value!);
  for (const listener of listeners) listener();
}

export function isTableInteractionAllowed(projectSession: string, tableUuid: string): boolean {
  const scope = scopes.get(projectSession);
  return !scope || scope.tableUuid === tableUuid;
}

export function isTableTransitionPending(projectSession?: string): boolean {
  return projectSession ? scopes.get(projectSession)?.pending === true
    : [...scopes.values()].some(scope => scope.pending);
}

export function captureTableInteractionScope(projectSession: string, tableUuid: string): number | null {
  if (!isTableInteractionAllowed(projectSession, tableUuid)) return null;
  return scopes.get(projectSession)?.generation ?? 0;
}

export function isTableInteractionScopeCurrent(projectSession: string, tableUuid: string, owner: number | null): boolean {
  return owner !== null && isTableInteractionAllowed(projectSession, tableUuid)
    && (scopes.get(projectSession)?.generation ?? 0) === owner;
}

export function subscribeTableInteractionScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

type NavigationBlocker = () => boolean | Promise<boolean>;
const navigationBlockers = new Map<NavigationBlocker, number>();
export function registerTableNavigationBlocker(blocker: NavigationBlocker, priority = 0): () => void {
  navigationBlockers.set(blocker, priority);
  return () => { navigationBlockers.delete(blocker); };
}
export async function tableEditorsAllowNavigation(): Promise<boolean> {
  for (const [blocker] of Array.from(navigationBlockers).sort((a, b) => b[1] - a[1])) if (!await blocker()) return false;
  return true;
}

export function captureProjectInteractionScope(projectSession: string): number | null {
  return isTableTransitionPending(projectSession) ? null : scopes.get(projectSession)?.generation ?? 0;
}
export function isProjectInteractionScopeCurrent(projectSession: string, owner: number | null): boolean {
  return owner !== null && !isTableTransitionPending(projectSession)
    && (scopes.get(projectSession)?.generation ?? 0) === owner;
}
