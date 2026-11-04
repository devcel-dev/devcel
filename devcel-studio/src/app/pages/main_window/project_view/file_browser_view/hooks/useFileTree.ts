import { useState, useEffect, useCallback, useRef } from 'react';
import { FileNode } from '../types';
import { getProjectEntries, ProjectEntry } from '@/app/commands/projectCommands';
import { listen } from '@tauri-apps/api/event';

function findNodeById(nodes: FileNode[], id: string): FileNode | null {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    if (node.children) {
      const found = findNodeById(node.children, id);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export function useFileTree(projectKey: string, expectedProjectSession: string) {
  const expandedFoldersKey = `fileBrowser_expandedFolders:${projectKey}`;
  const active = useRef(false);
  const lifecycle = useRef(0);
  const requestSequence = useRef(0);
  const refreshTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    // Restore saved expansion state during initialization
    try {
      const saved = sessionStorage.getItem(expandedFoldersKey);
      if (saved) {
        const expandedArray = JSON.parse(saved);
        return new Set(expandedArray);
      }
    } catch (error) {
      console.error('Failed to restore initial expansion state:', error);
    }
    return new Set();
  });
  // const [lastSelectedItemId, setLastSelectedItemId] = useState<string | null>(null);
  const [rangeAnchorId, setRangeAnchorId] = useState<string | null>(null);

  // Key for storing expansion state
  const EXPANDED_FOLDERS_KEY = expandedFoldersKey;

  // Save expansion state to local storage
  const saveExpandedState = useCallback((expanded: Set<string>) => {
    try {
      const expandedArray = Array.from(expanded);
      sessionStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify(expandedArray));
    } catch (error) {
      console.error('Failed to save expansion state:', error);
    }
  }, [EXPANDED_FOLDERS_KEY]);

  // Restore expansion state from local storage
  const loadExpandedState = (): Set<string> => {
    try {
      const saved = sessionStorage.getItem(EXPANDED_FOLDERS_KEY);
      if (saved) {
        const expandedArray = JSON.parse(saved);
        return new Set(expandedArray);
      }
    } catch (error) {
      console.error('Failed to restore expansion state:', error);
    }
    return new Set();
  };

  // Apply saved expansion state to the new file tree
  const restoreExpandedStateFromSaved = (newNodes: FileNode[], savedExpandedState: Set<string>) => {
    const newExpandedFolders = new Set<string>();
    
    
    // Walk the new node tree to find folders matching saved paths
    const traverseAndRestore = (nodes: FileNode[]) => {
      nodes.forEach(node => {
        if (node.type === 'folder') {
          // Restore expansion state if the saved paths include the current node's path
          if (savedExpandedState.has(node.path) || savedExpandedState.has(node.id)) {
            newExpandedFolders.add(node.id);
          }
          
          if (node.children) {
            traverseAndRestore(node.children);
          }
        }
      });
    };
    
    traverseAndRestore(newNodes);
    
    
    setFiles(newNodes);
    setExpandedFolders(newExpandedFolders);
  };

  const buildFileTree = (entries: ProjectEntry[]): FileNode[] => {
    const nodeMap = new Map<string, FileNode>();
    const rootNodes: FileNode[] = [];

    entries.forEach(entry => {
      if (entry.path === "") return;

      const pathParts = entry.path.split('/').filter(part => part !== '');
      const fileName = pathParts[pathParts.length - 1];
      
      let nodeType: 'file' | 'folder' | 'table' | 'project' | 'interface' | 'markdown';
      switch (entry.entry_type) {
        case 'Directory':
          nodeType = 'folder';
          break;
        case 'Table':
          nodeType = 'table';
          break;
        case 'Project':
          nodeType = 'project';
          break;
        case 'Interface':
          nodeType = 'interface';
          break;
        case 'Markdown':
          nodeType = 'markdown';
          break;
        default:
          nodeType = 'file';
          break;
      }
      
      const node: FileNode = {
        id: entry.path,
        name: fileName,
        path: entry.path,
        type: nodeType,
        modified: entry.modified,
        uuid: entry.uuid, // UUID for interfaces
        children: nodeType === 'folder' ? [] : undefined
      };

      nodeMap.set(entry.path, node);
    });

    entries.forEach(entry => {
      if (entry.path === "") return;

      const node = nodeMap.get(entry.path);
      if (!node) return;

      const pathParts = entry.path.split('/').filter(part => part !== '');
      
      if (pathParts.length === 1) {
        rootNodes.push(node);
      } else {
        const parentPath = pathParts.slice(0, -1).join('/');
        const parentNode = nodeMap.get(parentPath);
        
        if (parentNode && parentNode.children) {
          parentNode.children.push(node);
        }
      }
    });

    const sortNodes = (nodes: FileNode[]): FileNode[] => {
      return nodes.sort((a, b) => {
        if (a.type !== b.type) {
          const typeOrder = { folder: 0, markdown: 1, table: 2, project: 3, interface: 4, file: 5 };
          return typeOrder[a.type] - typeOrder[b.type];
        }
        return a.name.localeCompare(b.name);
      });
    };

    nodeMap.forEach(node => {
      if (node.children) {
        node.children = sortNodes(node.children);
      }
    });

    return sortNodes(rootNodes);
  };

  const findNodeByIdInAllTrees = useCallback((id: string): FileNode | null => {
    return findNodeById(files, id);
  }, [files]);

  const updateNodesWithExpandedState = (newNodes: FileNode[]) => {
    const expandedByName = new Map<string, string[]>();
    
    const recordExpandedFolders = (nodes: FileNode[], parentPath: string[] = []) => {
      nodes.forEach(node => {
        if (node.type === 'folder') {
          const currentPath = [...parentPath, node.name];
          if (expandedFolders.has(node.id)) {
            expandedByName.set(node.name, currentPath);
          }
          if (node.children) {
            recordExpandedFolders(node.children, currentPath);
          }
        }
      });
    };
    
    recordExpandedFolders(files);
    
    const newExpandedFolders = new Set<string>();
    
    const restoreExpandedFolders = (nodes: FileNode[], parentPath: string[] = []) => {
      nodes.forEach(node => {
        if (node.type === 'folder') {
          const currentPath = [...parentPath, node.name];
          
          if (expandedByName.has(node.name)) {
            const savedPath = expandedByName.get(node.name);
            if (JSON.stringify(savedPath) === JSON.stringify(currentPath)) {
              newExpandedFolders.add(node.id);
            }
          }
          
          if (node.children) {
            restoreExpandedFolders(node.children, currentPath);
          }
        }
      });
    };
    
    restoreExpandedFolders(newNodes);
    
    setFiles(newNodes);
    setExpandedFolders(newExpandedFolders);
  };

  const expandParentFolders = (targetPath: string, newNodes: FileNode[]) => {
    const pathParts = targetPath.split('/').filter(part => part !== '');
    const newExpandedFolders = new Set(expandedFolders);
    
    for (let i = 1; i <= pathParts.length; i++) {
      const parentPath = pathParts.slice(0, i).join('/');
      
      const findAndExpandFolder = (nodes: FileNode[]) => {
        for (const node of nodes) {
          if (node.path === parentPath && node.type === 'folder') {
            newExpandedFolders.add(node.id);
            return true;
          }
          if (node.children && findAndExpandFolder(node.children)) {
            return true;
          }
        }
        return false;
      };
      
      findAndExpandFolder(newNodes);
    }
    
    setExpandedFolders(newExpandedFolders);
    // Save expansion state
    saveExpandedState(newExpandedFolders);
  };

  const selectItemAfterOperation = (targetPath: string, newNodes: FileNode[]) => {
    const findAndSelectItem = (nodes: FileNode[]): boolean => {
      for (const node of nodes) {
        if (node.path === targetPath) {
          setSelectedItems(new Set([node.id]));
          return true;
        }
        if (node.children && findAndSelectItem(node.children)) {
          return true;
        }
      }
      return false;
    };
    
    findAndSelectItem(newNodes);
  };

  // A relocation changes identity paths, not the user's current selection.
  // Functional updates preserve newer navigation and Ctrl/Shift selections.
  const retargetItemAfterOperation = (oldPath: string, newPath: string) => {
    setSelectedItems(previous => previous.has(oldPath)
      ? new Set([...previous].map(id => id === oldPath ? newPath : id)) : previous);
    setRangeAnchorId(previous => previous === oldPath ? newPath : previous);
  };

  const refreshProjectEntries = async (): Promise<boolean> => {
    if (!active.current) return false;
    const generation = lifecycle.current;
    const request = ++requestSequence.current;
    try {
      const entries: ProjectEntry[] = await getProjectEntries(expectedProjectSession);
      if (!active.current || generation !== lifecycle.current) return false;
      // A newer refresh owns the tree, but this session-bound read still succeeded.
      if (request !== requestSequence.current) return true;
      const fileNodes = buildFileTree(entries);
      
      // Restore saved expansion state before updating nodes
      const savedExpandedState = loadExpandedState();
      if (savedExpandedState.size > 0) {
        restoreExpandedStateFromSaved(fileNodes, savedExpandedState);
      } else {
        updateNodesWithExpandedState(fileNodes);
      }
      return true;
    } catch (error) {
      console.error('Failed to retrieve project entries:', error);
      return false;
    }
  };

  const refreshRef = useRef(refreshProjectEntries);
  refreshRef.current = refreshProjectEntries;
  const expandedRef = useRef(expandedFolders);
  expandedRef.current = expandedFolders;

  const debouncedRefresh = useCallback(() => {
    if (!active.current) return;
    if (refreshTimeout.current !== null) clearTimeout(refreshTimeout.current);
    refreshTimeout.current = setTimeout(() => {
      refreshTimeout.current = null;
      void refreshRef.current();
    }, 300);
  }, []);

  useEffect(() => {
    active.current = true;
    const generation = ++lifecycle.current;
    const invalidateRequests = () => { ++lifecycle.current; ++requestSequence.current; };
    const refresh = () => {
      if (active.current && generation === lifecycle.current) debouncedRefresh();
    };
    const save = () => {
      try { sessionStorage.setItem(expandedFoldersKey, JSON.stringify([...expandedRef.current])); }
      catch (error) { console.error('Failed to save expansion state:', error); }
    };
    const visibility = () => { if (document.hidden) save(); else refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('blur', save);
    document.addEventListener('visibilitychange', visibility);
    const subscriptions = ['p2p-data-changed', 'project-modified', 'table-updated', 'markdown-saved', 'tauri://focus']
      .map(event => listen(event, refresh));
    return () => {
      active.current = false;
      invalidateRequests();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('blur', save);
      document.removeEventListener('visibilitychange', visibility);
      // Promise-based cleanup also removes listeners whose registration resolves after unmount.
      subscriptions.forEach(subscription => { void subscription.then(unlisten => unlisten()).catch(console.error); });
      if (refreshTimeout.current !== null) clearTimeout(refreshTimeout.current);
      refreshTimeout.current = null;
    };
  }, [expandedFoldersKey, expectedProjectSession, debouncedRefresh]);

  // Flatten the visible file list, preserving display order
  const flattenDisplayFiles = useCallback((nodes: FileNode[], result: FileNode[] = []): FileNode[] => {
    nodes.forEach(node => {
      result.push(node);
      if (node.type === 'folder' && node.children && expandedFolders.has(node.id)) {
        flattenDisplayFiles(node.children, result);
      }
    });
    return result;
  }, [expandedFolders]);


  const handleItemSelect = useCallback((itemId: string, isCtrlPressed: boolean, isShiftPressed: boolean, displayFiles?: FileNode[], expandFolder = true) => {
    const selectedNode = findNodeByIdInAllTrees(itemId);
    
    // Handle folder expansion first to avoid duplicate processing
    if (expandFolder && !isCtrlPressed && !isShiftPressed && selectedNode && selectedNode.type === 'folder') {
      setExpandedFolders(prevExpanded => {
        const newExpanded = new Set(prevExpanded);
        const wasExpanded = newExpanded.has(itemId);
        if (wasExpanded) {
          newExpanded.delete(itemId);
        } else {
          newExpanded.add(itemId);
        }
        // Save expansion state
        saveExpandedState(newExpanded);
        return newExpanded;
      });
    }
    
    setSelectedItems(prev => {
      const newSelection = new Set(prev);
      
      if (isShiftPressed && rangeAnchorId && displayFiles) {
        // Shift+click: Range selection with a fixed anchor
        const flatNodes = flattenDisplayFiles(displayFiles);
        const rangeSelection = selectRange(rangeAnchorId, itemId, flatNodes);
        
        if (isCtrlPressed) {
          // Ctrl+Shift: Add the range to the existing selection
          rangeSelection.forEach(id => newSelection.add(id));
        } else {
          // Shift only: Replace the selection with the range
          newSelection.clear();
          rangeSelection.forEach(id => newSelection.add(id));
        }
      } else if (isCtrlPressed) {
        // Ctrl+click: Select or deselect individual items
        if (newSelection.has(itemId)) {
          newSelection.delete(itemId);
        } else {
          newSelection.add(itemId);
          // Update the anchor when selecting a new item with Ctrl
          if (!rangeAnchorId) {
            setRangeAnchorId(itemId);
          }
        }
      } else {
        // Regular click: Single selection
        newSelection.clear();
        newSelection.add(itemId);
        
        // Reset the anchor on a regular click
        setRangeAnchorId(itemId);
      }
      
      return newSelection;
    });
    
    // Remember the last selected item; do not update when deselecting with Ctrl
    // if (!isCtrlPressed || !selectedItems.has(itemId)) {
    //   setLastSelectedItemId(itemId);
    // }
  }, [findNodeByIdInAllTrees, rangeAnchorId, saveExpandedState, flattenDisplayFiles]);

  const clearSelection = () => {
    setSelectedItems(new Set());
    // setLastSelectedItemId(null);
    setRangeAnchorId(null); // Also clear the anchor
  };

  const toggleFolder = (id: string) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedFolders(newExpanded);
    // Save expansion state
    saveExpandedState(newExpanded);
  };

  // Helper function for range selection
  const selectRange = (startId: string, endId: string, flatNodes: FileNode[]): Set<string> => {
    const startIndex = flatNodes.findIndex(node => node.id === startId);
    const endIndex = flatNodes.findIndex(node => node.id === endId);
    
    if (startIndex === -1 || endIndex === -1) {
      return new Set([endId]);
    }
    
    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);
    
    const selectedIds = new Set<string>();
    for (let i = minIndex; i <= maxIndex; i++) {
      selectedIds.add(flatNodes[i].id);
    }
    
    return selectedIds;
  };

  return {
    files,
    setFiles,
    selectedItems,
    setSelectedItems,
    expandedFolders,
    setExpandedFolders,
    buildFileTree,
    findNodeById,
    findNodeByIdInAllTrees,
    updateNodesWithExpandedState,
    expandParentFolders,
    selectItemAfterOperation,
    retargetItemAfterOperation,
    refreshProjectEntries,
    handleItemSelect,
    clearSelection,
    toggleFolder
  };
} 