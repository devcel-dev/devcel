import type { ProjectEntry, TableReference } from '@/app/commands/projectCommands';
import type { FileNode } from '../file_browser_view/types';

/** Only committed displays enter history. Missing files are tombstones so an
 * unsuccessful traversal never moves the current history position. */
export interface NavigationHistory {
  entries: Array<FileNode | null>;
  index: number;
}
export const emptyNavigationHistory = (): NavigationHistory => ({ entries: [], index: -1 });
export const sameNavigationItem = (left: FileNode | null | undefined, right: FileNode | null | undefined): boolean =>
  !!left && !!right && left.type === right.type
    && (left.uuid && right.uuid ? left.uuid === right.uuid : left.path === right.path);

export function commitNavigation(history: NavigationHistory, item: FileNode, targetIndex?: number): NavigationHistory {
  if (targetIndex !== undefined && sameNavigationItem(history.entries[targetIndex], item)) {
    const entries = [...history.entries]; entries[targetIndex] = item;
    return { entries, index: targetIndex };
  }
  if (sameNavigationItem(history.entries[history.index], item)) {
    const entries = [...history.entries]; entries[history.index] = item;
    return { entries, index: history.index };
  }
  const entries = [...history.entries.slice(0, history.index + 1), item].slice(-100);
  return { entries, index: entries.length - 1 };
}

export function navigationTarget(history: NavigationHistory, direction: -1 | 1, displayed?: FileNode | null): number | null {
  // Closing the last tab does not fabricate a history entry. Back can reopen its
  // most recent display instead of silently skipping that file.
  const start = !displayed && direction === -1 ? history.index : history.index + direction;
  for (let index = start; index >= 0 && index < history.entries.length; index += direction) {
    if (history.entries[index] && !sameNavigationItem(history.entries[index], displayed)) return index;
  }
  return null;
}

export function retargetNavigationHistory(history: NavigationHistory, oldPath: string, next: FileNode): NavigationHistory {
  return { ...history, entries: history.entries.map(item => {
    if (!item) return null;
    if (item.path === oldPath) return next;
    if (next.type === 'folder' && item.path.startsWith(`${oldPath}/`)) {
      const path = `${next.path}${item.path.slice(oldPath.length)}`;
      return { ...item, id: path, path };
    }
    return item;
  }) };
}

const entryTypes: Record<ProjectEntry['entry_type'], FileNode['type']> = {
  Table: 'table', Interface: 'interface', Markdown: 'markdown', Other: 'file', Directory: 'folder', Project: 'project'
};
/** Resolve UUID-bearing files by identity, never a stale path that can have
 * been reused. Other documents must still exist with the same file kind. */
export function reconcileNavigationHistory(history: NavigationHistory, entries: ProjectEntry[], tables: TableReference[]): NavigationHistory {
  return { ...history, entries: history.entries.map(item => {
    if (!item) return null;
    const matchingTables = item.type === 'table' && item.uuid ? tables.filter(candidate => candidate.uuid === item.uuid) : [];
    if (item.type === 'table' && item.uuid && matchingTables.length !== 1) return null;
    const matchingEntries = item.uuid && item.type === 'interface'
      ? entries.filter(candidate => candidate.entry_type === 'Interface' && candidate.uuid === item.uuid)
      : entries.filter(candidate => candidate.path === (matchingTables[0]?.path ?? item.path) && entryTypes[candidate.entry_type] === item.type);
    if (matchingEntries.length !== 1) return null;
    const entry = matchingEntries[0];
    if (entry.uuid && item.uuid && entry.uuid !== item.uuid) return null;
    return { ...item, id: entry.path, path: entry.path,
      name: entry.path === item.path ? item.name : entry.path.split('/').pop() || item.name };
  }) };
}
