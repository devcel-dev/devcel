import { isComposingKey, isTextInputTarget } from '@/app/utils/shortcutGuards';
import { forwardRef, useCallback, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileNode } from '../types';
import { FileNodeComponent } from './FileNodeComponent';
import { FILE_TREE_ROW_HEIGHT, flattenExpandedFileTree, getFileTreeWindow } from './fileTreeWindow';

interface FileTreeProps {
  nodes: FileNode[];
  showModified?: boolean;
  onKeyboardSelect?: (id: string, extend: boolean) => void;
  level?: number;
  projectPath: string;
  selectedItems: Set<string>;
  handleItemSelect: (itemId: string, isCtrlPressed: boolean, isShiftPressed: boolean, displayFiles?: FileNode[]) => void;
  expandedFolders: Set<string>;
  toggleFolder: (id: string) => void;
  onDelete: (node: FileNode) => void;
  onRename: (node: FileNode) => void;
  onCreateTable: (node: FileNode) => void;
  onCreateFolder: (node: FileNode) => void;
  onCreateFile?: (node: FileNode) => void;
  onMove: (draggedNodeId: string, targetNode: FileNode | null, isRoot?: boolean) => void;
  onDuplicate?: (node: FileNode) => void;
  onBulkDelete?: (nodeIds: Set<string>) => void;
  onRenameDisplayName?: (node: FileNode) => void;
  displayFiles?: FileNode[];
  dropTargetFolderId?: string | null;
  onDropTargetChange?: (folderId: string | null) => void;
  parentFolderId?: string | null;
  findNodeByIdInAllTrees?: (id: string) => FileNode | null;
  dropTargetParentFolderId?: string | null;
  onDropTargetParentChange?: (folderId: string | null) => void;
  onFileSelect?: (file: FileNode) => void;
  loadedTables?: Map<string, string>;
  tableDisplayNames?: Map<string, string>;
}

export interface FileTreeRef {
  scrollToFile: (fileId: string) => void;
}

export const FileTree = forwardRef<FileTreeRef, FileTreeProps>(function FileTree({
  nodes,
  showModified = false,
  onKeyboardSelect,
  level = 0,
  projectPath,
  selectedItems,
  handleItemSelect,
  expandedFolders,
  toggleFolder,
  onDelete,
  onRename,
  onCreateTable,
  onCreateFolder,
  onCreateFile,
  onMove,
  onDuplicate,
  onBulkDelete,
  onRenameDisplayName,
  displayFiles,
  dropTargetFolderId,
  onDropTargetChange,
  parentFolderId = null,
  findNodeByIdInAllTrees,
  dropTargetParentFolderId,
  onDropTargetParentChange,
  onFileSelect,
  loadedTables,
  tableDisplayNames
}: FileTreeProps, ref) {
  const treeRef = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const rowHeight = showModified ? 44 : FILE_TREE_ROW_HEIGHT;
  const [keyboardId, setKeyboardId] = useState<string | null>(null);
  const pointerFileId = useRef<string | null>(null);
  const updateViewportRef = useRef<() => void>(() => {});
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const rows = useMemo(
    () => flattenExpandedFileTree(nodes, expandedFolders, level, parentFolderId),
    [nodes, expandedFolders, level, parentFolderId]
  );
  const { start, end } = getFileTreeWindow(rows.length, viewport.top, viewport.height, rowHeight);

  useLayoutEffect(() => {
    const tree = treeRef.current;
    // FileBrowserView owns the scroll area and its root drop target.
    const scrollArea = tree?.parentElement;
    if (!tree || !scrollArea) return;
    let frame: number | null = null;
    let active = true;
    const measure = () => {
      if (!active) return;
      const top = Math.max(0, scrollArea.getBoundingClientRect().top + scrollArea.clientTop - tree.getBoundingClientRect().top);
      const height = scrollArea.clientHeight;
      setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height });
    };
    const scheduleMeasure = () => {
      if (!active || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    updateViewportRef.current = measure;
    scrollArea.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(scrollArea);
    measure();
    return () => {
      active = false;
      updateViewportRef.current = () => {};
      scrollArea.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  // Collapsing/filtering a long tree can cause the browser to clamp scrollTop.
  useLayoutEffect(() => {
    updateViewportRef.current();
  }, [rows.length, rowHeight]);

  const scrollToFile = useCallback((fileId: string) => {
    const index = rows.findIndex(row => row.node.id === fileId);
    const tree = treeRef.current;
    const scrollArea = tree?.parentElement;
    if (index < 0 || !tree || !scrollArea) return;
    const treeOffset = tree.getBoundingClientRect().top - scrollArea.getBoundingClientRect().top - scrollArea.clientTop + scrollArea.scrollTop;
    const top = treeOffset + index * rowHeight;
    if (top < scrollArea.scrollTop) scrollArea.scrollTop = top;
    else if (top + rowHeight > scrollArea.scrollTop + scrollArea.clientHeight) scrollArea.scrollTop = top + rowHeight - scrollArea.clientHeight;
    updateViewportRef.current();
  }, [rows, rowHeight]);
  useImperativeHandle(ref, () => ({ scrollToFile }), [scrollToFile]);
  const cursor = rows.findIndex(row => row.node.id === keyboardId);
  const activeIndex = cursor >= 0 ? cursor : Math.max(0, rows.findIndex(row => selectedItems.has(row.node.id)));

  return (
    <div
      ref={treeRef}
      role="tree"
      data-file-navigation-tree
      tabIndex={0}
      aria-activedescendant={rows[activeIndex] ? `${treeId}-${activeIndex}` : undefined}
      onPointerDownCapture={event => { const item = (event.target as Element).closest<HTMLElement>('[data-file-id]'); pointerFileId.current = item?.dataset.fileId ?? null; if (pointerFileId.current) setKeyboardId(pointerFileId.current); queueMicrotask(() => { pointerFileId.current = null; }); }}
      onFocus={event => { if (event.target === event.currentTarget) { const id = pointerFileId.current ?? rows[activeIndex]?.node.id; if (id) { setKeyboardId(id); scrollToFile(id); } } }}
      onKeyDown={event => {
        if (isComposingKey(event.nativeEvent) || isTextInputTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !rows.length) return;
        if ((event.target as HTMLElement).closest('button, [role="menu"], [role="dialog"]')) return;
        const row = rows[activeIndex];
        const move = (index: number) => { const next = rows[Math.max(0, Math.min(rows.length - 1, index))]; setKeyboardId(next.node.id); onKeyboardSelect?.(next.node.id, false); scrollToFile(next.node.id); };
        if (event.key === 'ArrowDown') move(activeIndex + 1);
        else if (event.key === 'ArrowUp') move(activeIndex - 1);
        else if (event.key === 'Home') move(0);
        else if (event.key === 'End') move(rows.length - 1);
        else if (event.key === 'ArrowRight') {
          if (row.node.type === 'folder') { if (!expandedFolders.has(row.node.id)) toggleFolder(row.node.id); else if (rows[activeIndex + 1]?.parentFolderId === row.node.id) move(activeIndex + 1); }
        } else if (event.key === 'ArrowLeft') {
          if (row.node.type === 'folder' && expandedFolders.has(row.node.id)) toggleFolder(row.node.id);
          else { const parent = rows.findIndex(candidate => candidate.node.id === row.parentFolderId); if (parent >= 0) move(parent); }
        } else if (event.key === ' ' || event.key === 'Enter') {
          onKeyboardSelect?.(row.node.id, false);
          if (event.key === 'Enter') { if (row.node.type === 'folder') toggleFolder(row.node.id); else onFileSelect?.(row.node); }
        } else return;
        event.preventDefault(); event.stopPropagation();
      }}
      className="relative w-full"
      style={{ height: rows.length * rowHeight }}
      data-file-tree-row-count={rows.length}
    >
      {rows.slice(start, end).map(({ node, level: rowLevel, parentFolderId: rowParentId }, offset) => (
        <div
          key={node.id}
          id={`${treeId}-${start + offset}`}
          role="treeitem"
          aria-level={rowLevel + 1}
          aria-selected={selectedItems.has(node.id)}
          aria-expanded={node.type === 'folder' ? expandedFolders.has(node.id) : undefined}
          data-keyboard-active={start + offset === activeIndex || undefined}
          className={`absolute left-0 w-full ${keyboardId === node.id ? 'ring-1 ring-inset ring-primary' : ''}`}
          style={{ top: (start + offset) * rowHeight, height: rowHeight }}
        >
          {/* Preserve the nested tree's guide lines and indentation without mounting subtrees. */}
          {Array.from({ length: rowLevel - level }, (_, depth) => (
            <span
              key={depth}
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 border-l border-border"
              style={{ left: depth * 25 + 8 }}
            />
          ))}
          <div style={{ marginLeft: (rowLevel - level) * 9 }}>
            <FileNodeComponent
              node={node}
              level={rowLevel}
              expanded={expandedFolders.has(node.id)}
              onToggle={() => toggleFolder(node.id)}
              projectPath={projectPath}
              showModified={showModified}
              selectedItems={selectedItems}
              handleItemSelect={handleItemSelect}
              onDelete={onDelete}
              onRename={onRename}
              onCreateTable={onCreateTable}
              onCreateFolder={onCreateFolder}
              onCreateFile={onCreateFile}
              onMove={onMove}
              onDuplicate={onDuplicate}
              onBulkDelete={onBulkDelete}
              onRenameDisplayName={onRenameDisplayName}
              displayFiles={displayFiles}
              dropTargetFolderId={dropTargetFolderId}
              onDropTargetChange={onDropTargetChange}
              parentFolderId={rowParentId}
              findNodeByIdInAllTrees={findNodeByIdInAllTrees}
              dropTargetParentFolderId={dropTargetParentFolderId}
              onDropTargetParentChange={onDropTargetParentChange}
              onFileSelect={onFileSelect}
              loadedTables={loadedTables}
              tableDisplayNames={tableDisplayNames}
            />
          </div>
        </div>
      ))}
    </div>
  );
});
