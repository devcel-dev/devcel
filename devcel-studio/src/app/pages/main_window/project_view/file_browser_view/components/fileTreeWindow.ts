import { FileNode } from '../types';

// text-sm (20px) + py-1 (8px). Keep the row and viewport calculations in sync.
export const FILE_TREE_ROW_HEIGHT = 28;
export const FILE_TREE_OVERSCAN = 8;

export interface FileTreeRow {
  node: FileNode;
  level: number;
  parentFolderId: string | null;
}

/** Only expanded branches contribute rows. No React elements are created here. */
export function flattenExpandedFileTree(
  nodes: FileNode[],
  expandedFolders: Set<string>,
  level = 0,
  parentFolderId: string | null = null
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const append = (siblings: FileNode[], depth: number, parentId: string | null) => {
    for (const node of siblings) {
      rows.push({ node, level: depth, parentFolderId: parentId });
      if (node.type === 'folder' && expandedFolders.has(node.id) && node.children) {
        append(node.children, depth + 1, node.id);
      }
    }
  };
  append(nodes, level, parentFolderId);
  return rows;
}

/** The mounted range stays bounded even before measurement or after a tree shrinks. */
export function getFileTreeWindow(rowCount: number, scrollTop: number, viewportHeight: number, rowHeight = FILE_TREE_ROW_HEIGHT) {
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const firstVisible = Math.min(
    Math.max(0, Math.floor(scrollTop / rowHeight)),
    Math.max(0, rowCount - visibleCount)
  );
  return {
    start: Math.max(0, firstVisible - FILE_TREE_OVERSCAN),
    // The extra row covers a partially visible first/last row.
    end: Math.min(rowCount, firstVisible + visibleCount + FILE_TREE_OVERSCAN + 1)
  };
}
