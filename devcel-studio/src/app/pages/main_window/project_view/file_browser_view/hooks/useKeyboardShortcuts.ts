import { isComposingKey, isTextInputTarget, isModalTarget } from '@/app/utils/shortcutGuards';
import { useEffect, type RefObject } from 'react';
import { FileNode } from '../types';

interface UseKeyboardShortcutsProps {
  root: RefObject<HTMLElement | null>;
  selectedItems: Set<string>;
  setSelectedItems: (items: Set<string>) => void;
  files: FileNode[];
  findNodeByIdInAllTrees: (id: string) => FileNode | null;
  handleBulkDelete: (ids: Set<string>) => Promise<void>;
  handleRename: (node: FileNode) => void;
}

export function useKeyboardShortcuts({
  root,
  selectedItems,
  setSelectedItems,
  findNodeByIdInAllTrees,
  handleBulkDelete,
  handleRename
}: UseKeyboardShortcutsProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check whether the file browser has focus
      const fileBrowser = root.current;
      if (!fileBrowser || !fileBrowser.contains(document.activeElement)) {
        return;
      }

      if (e.defaultPrevented || isComposingKey(e) || isTextInputTarget(e.target) || isModalTarget(e.target)
        || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return;

      // Delete: Delete
      if (e.key === 'Delete' && selectedItems.size > 0) {
        e.preventDefault();
        if (!e.repeat) void handleBulkDelete(new Set(selectedItems));
      }

      // F2: Rename
      if (e.key === 'F2' && selectedItems.size === 1) {
        e.preventDefault();
        const id = Array.from(selectedItems)[0];
        const node = findNodeByIdInAllTrees(id);
        if (node) {
          handleRename(node);
        }
      }


      // Escape: Clear selection
      if (e.key === 'Escape') {
        e.preventDefault();
        setSelectedItems(new Set());
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [root, selectedItems, findNodeByIdInAllTrees, handleBulkDelete, handleRename, setSelectedItems]);
} 