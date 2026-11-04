import { useState, useMemo } from 'react';
import { FileNode } from '../types';

export type SortType = 'name' | 'type' | 'modified';
export type SortOrder = 'asc' | 'desc';

export function useSort(files: FileNode[]) {
  const [sortType, setSortType] = useState<SortType>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  const sortedFiles = useMemo(() => {
    const sortNodes = (nodes: FileNode[]): FileNode[] => {
      const sorted = [...nodes].sort((a, b) => {
        // Group by folder or file first, with folders always first
        const aIsFolder = a.type === 'folder';
        const bIsFolder = b.type === 'folder';
      
        if (aIsFolder && !bIsFolder) return -1;
        if (!aIsFolder && bIsFolder) return 1;
      
        // Among files, always display Markdown files above tables
        if (sortType !== 'modified' && !aIsFolder && !bIsFolder) {
          const aIsMarkdown = a.type === 'markdown';
          const bIsMarkdown = b.type === 'markdown';
          const aIsTable = a.type === 'table';
          const bIsTable = b.type === 'table';
        
          // Markdown files take precedence over tables
          if (aIsMarkdown && bIsTable) return -1;
          if (aIsTable && bIsMarkdown) return 1;
        }
      
        // For the same type, compare using the specified sort mode
        let comparison = 0;

        switch (sortType) {
          case 'name':
            comparison = a.name.localeCompare(b.name);
            break;
          case 'type':
            const typeOrder = { folder: 0, markdown: 1, table: 2, project: 3, interface: 4, file: 5 };
            comparison = typeOrder[a.type] - typeOrder[b.type];
            if (comparison === 0) {
              comparison = a.name.localeCompare(b.name);
            }
            break;
          case 'modified':
            // Unknown metadata is last in either direction, never fabricated as a date.
            const aKnown = typeof a.modified === 'number' && Number.isFinite(a.modified);
            const bKnown = typeof b.modified === 'number' && Number.isFinite(b.modified);
            if (aKnown !== bKnown) return aKnown ? -1 : 1;
            comparison = aKnown && bKnown ? a.modified! - b.modified! : 0;
            if (comparison === 0) return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
            break;
        }

        return sortOrder === 'asc' ? comparison : -comparison;
      });

      // Sort children recursively too
      return sorted.map(node => ({
        ...node,
        children: node.children ? sortNodes(node.children) : undefined
      }));
    };

    return sortNodes(files);
  }, [files, sortType, sortOrder]);

  const toggleSortOrder = () => {
    setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
  };

  return {
    sortType,
    setSortType,
    sortOrder,
    setSortOrder,
    toggleSortOrder,
    sortedFiles
  };
} 