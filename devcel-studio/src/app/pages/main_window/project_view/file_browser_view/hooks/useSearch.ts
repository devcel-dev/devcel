import { useState, useMemo } from 'react';
import { FileNode } from '../types';

export function useSearch(files: FileNode[]) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'folder' | 'table'>('all');
  const [useRegex, setUseRegex] = useState(false);

  const filteredFiles = useMemo(() => {
    const filterNodes = (nodes: FileNode[]): FileNode[] => {
      return nodes.reduce((filtered: FileNode[], node) => {
        let matches = true;

        // Type filter
        if (filterType !== 'all' && node.type !== filterType) {
          matches = false;
        }

        // Search query
        if (matches && searchQuery) {
          if (useRegex) {
            try {
              const regex = new RegExp(searchQuery, 'i');
              matches = regex.test(node.name);
            } catch {
              matches = false;
            }
          } else {
            matches = node.name.toLowerCase().includes(searchQuery.toLowerCase());
          }
        }

        // Filter children recursively
        let filteredChildren: FileNode[] = [];
        if (node.children) {
          filteredChildren = filterNodes(node.children);
        }

        // Include the node if it matches or has matching children
        if (matches || filteredChildren.length > 0) {
          filtered.push({
            ...node,
            children: filteredChildren.length > 0 ? filteredChildren : node.children
          });
        }

        return filtered;
      }, []);
    };

    if (!searchQuery && filterType === 'all') {
      return files;
    }
    return filterNodes(files);
  }, [files, searchQuery, filterType, useRegex]);

  return {
    searchQuery,
    setSearchQuery,
    filterType,
    setFilterType,
    useRegex,
    setUseRegex,
    filteredFiles
  };
} 