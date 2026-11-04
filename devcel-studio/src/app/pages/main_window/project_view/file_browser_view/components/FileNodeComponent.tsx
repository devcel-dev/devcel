import { useI18n, t, formatDateTime } from '@/app/i18n';
import React, { useCallback } from 'react';
import { useDrag, useDrop, DragSourceMonitor, DropTargetMonitor } from 'react-dnd';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, File, Folder, ExternalLink, Database, FileText, FolderPlus, Files, FilePlus, FileCode } from "lucide-react";
import { FileNode } from '../types';
import { invoke } from '@tauri-apps/api/core';
import { FILE_TREE_ROW_HEIGHT } from './fileTreeWindow';

interface FileNodeComponentProps {
  node: FileNode;
  level: number;
  expanded: boolean;
  onToggle: () => void;
  projectPath: string;
  selectedItems: Set<string>;
  handleItemSelect: (itemId: string, isCtrlPressed: boolean, isShiftPressed: boolean, displayFiles?: FileNode[]) => void;
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
  showModified?: boolean;
  loadedTables?: Map<string, string>;
  tableDisplayNames?: Map<string, string>;
}

export function FileNodeComponent({
  node,
  level,
  expanded,
  onToggle,
  projectPath,
  selectedItems,
  handleItemSelect,
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
  parentFolderId,
  findNodeByIdInAllTrees,
  dropTargetParentFolderId,
  onDropTargetParentChange,
  onFileSelect,
  showModified = false,
  loadedTables,
  tableDisplayNames
}: FileNodeComponentProps) {
  useI18n();
  const modified = typeof node.modified === 'number' && Number.isFinite(node.modified)
    ? new Date(node.modified) : null;
  const modifiedText = modified && Number.isFinite(modified.getTime())
    ? formatDateTime(modified, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : t('common.unknownDate');
  const [{ isDragging }, drag] = useDrag({
    type: 'FILE_NODE',
    item: { id: node.id, type: node.type },
    collect: (monitor: DragSourceMonitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  // Determine the target folder ID: The parent for files, or the folder itself
  // const targetFolderId = node.type === 'folder' ? node.id : parentFolderId;

  const [{ isOver, canDrop }, drop] = useDrop({
    accept: 'FILE_NODE',
    canDrop: (item: { id: string, type: string }) => {

      // For folders
      if (node.type === 'folder') {
        // Disallow dropping onto itself
        if (item.id === node.id) {
          return false;
        }

        // Prevent cycles: Check whether the dragged item is an ancestor of this node
        const isAncestor = (draggedPath: string, targetPath: string): boolean => {
          return targetPath.startsWith(draggedPath + '/') || targetPath === draggedPath;
        };

        const result = !isAncestor(item.id, node.path);
        return result;
      }

      // For files
      if (node.type === 'file' || node.type === 'table' || node.type === 'project' || node.type === 'markdown' || node.type === 'interface') {
        // Disallow dropping onto itself
        if (item.id === node.id) {
          return false;
        }

        // Always allow dropping onto files, treating it as a move to the same level
        return true;
      }

      return false;
    },
    drop: async (item: { id: string, type: string }, monitor: DropTargetMonitor) => {

      // Skip the didDrop() check when dropping onto a file
      if (node.type !== 'folder' && monitor.didDrop()) {
      } else if (monitor.didDrop()) {
        return;
      }

      // Find the target folder
      if (node.type === 'folder') {
        onMove(item.id, node, false);
      } else if (parentFolderId) {
        // Move to the parent folder when dropping onto a file

        // Get the complete parent folder information
        let parentNode: FileNode | null = null;
        if (findNodeByIdInAllTrees) {
          parentNode = findNodeByIdInAllTrees(parentFolderId);
        }

        if (!parentNode) {
          // Fallback: Create an object containing only id and type
          parentNode = { id: parentFolderId, type: 'folder', path: parentFolderId } as FileNode;
        }

        onMove(item.id, parentNode, false);
      } else {
        // Move to the root when dropping onto a root-level file
        // For root moves, set targetNode to null and isRoot to true
        onMove(item.id, null, true);
      }
    },
    hover: (_, monitor) => {
      const isOverShallow = monitor.isOver({ shallow: true });
      const canDropHere = monitor.canDrop();

      if (isOverShallow && canDropHere) {
        // Highlight only when the current node is the drop target
        onDropTargetChange?.(node.id);

        // Also highlight the parent folder when dropping onto a file
        if (node.type !== 'folder' && parentFolderId) {
          onDropTargetParentChange?.(parentFolderId);
        }
      } else if (dropTargetFolderId === node.id || dropTargetParentFolderId === node.id) {
        // Clear the highlight if this node is no longer hovered

        if (dropTargetFolderId === node.id) {
          onDropTargetChange?.(null);

          // For files, also clear the parent folder highlight
          if (node.type !== 'folder' && parentFolderId) {
            onDropTargetParentChange?.(null);
          }
        }
      }
    },
    collect: (monitor) => ({
      isOver: monitor.isOver({ shallow: true }),
      canDrop: monitor.canDrop(),
    }),
  });

  // Use callback ref with proper type checking
  const setNodeRef = useCallback((element: HTMLDivElement | null) => {
    // Windowed rows are frequently unmounted; detach both DnD connectors too.
    drag(element);
    drop(element);
  }, [drag, drop]);

  const handleOpenInExplorer = async () => {
    try {

      // Join the path and open the file explorer in Rust
      await invoke('open_in_explorer', {
        projectPath: projectPath,
        filePath: node.path
      });
    } catch (error) {
      console.error('Failed to open in the file explorer:', error);
    }
  };

  const getIcon = () => {
    const isSelected = selectedItems.has(node.id);
    const iconClass = isSelected ? "h-3 w-3 mr-1 text-primary" : "h-3 w-3 mr-1";

    switch (node.type) {
      case 'folder':
        return <Folder className={isSelected ? iconClass : "h-3 w-3 mr-1 text-primary"} />;
      case 'table':
        return <Database className={isSelected ? iconClass : "h-3 w-3 mr-1 text-green-600"} />;
      case 'project':
        return <FileText className={isSelected ? iconClass : "h-3 w-3 mr-1 text-purple-600"} />;
      case 'interface':
        return <FileCode className={isSelected ? iconClass : "h-3 w-3 mr-1 text-indigo-600"} />;
      case 'markdown':
        return <FileText className={isSelected ? iconClass : "h-3 w-3 mr-1 text-orange-600"} />;
      default:
        return <File className={isSelected ? iconClass : "h-3 w-3 mr-1 text-muted-foreground"} />;
    }
  };

  const handleItemClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    const isCtrlPressed = event.ctrlKey || event.metaKey;
    const isShiftPressed = event.shiftKey;
    handleItemSelect(node.id, isCtrlPressed, isShiftPressed, displayFiles);

    // Open file, table, markdown, and interface tabs on a single click
    if ((node.type === 'file' || node.type === 'table' || node.type === 'markdown' || node.type === 'interface') && onFileSelect) {
      onFileSelect(node);
    }
    // Folder expansion is handled by handleItemSelect and is unnecessary here
  };

  const handleDoubleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    // Double-click handling is no longer needed
  };

  const handleToggleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    onToggle();
  };

  const handleDeleteClick = () => {
    if (selectedItems.size > 1 && selectedItems.has(node.id)) {
      // Delete in bulk if multiple items are selected
      onBulkDelete?.(selectedItems);
    } else {
      // Delete a single item
      onDelete(node);
    }
  };

  const isSelected = selectedItems.has(node.id);

  const displayName = node.type === 'table' ? tableDisplayNames?.get(node.path) ?? loadedTables?.get(node.path) : undefined;

  // Highlight drop targets
  const isDropTarget = dropTargetFolderId === node.id && isOver && canDrop;

  // If highlighted as a parent folder
  const isParentDropTarget = dropTargetParentFolderId === node.id;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex flex-col cursor-pointer select-none",
        isDragging && "opacity-50"
      )}
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
      data-file-id={node.id}
    >
      <ContextMenu>
        <ContextMenuTrigger>
          <div
            className={cn(
              "flex items-center px-2 py-1 transition-all duration-150 min-w-0 rounded-md group",
              isSelected
                ? "bg-secondary text-secondary-foreground shadow-[inset_3px_0_0_hsl(var(--primary-ink))]"
                : "hover:bg-muted text-foreground",
              isDropTarget && (node.type === 'folder'
                ? "ring-2 ring-ring bg-accent"
                : "ring-2 ring-green-400 bg-green-50"),
              isParentDropTarget && "ring-2 ring-ring bg-accent"
            )}
            style={{ marginLeft: `${level * 16}px`, height: showModified ? 44 : FILE_TREE_ROW_HEIGHT }}
            onClick={handleItemClick}
            onDoubleClick={handleDoubleClick}
          >
            {node.type === 'folder' ? (
              <button
                onClick={handleToggleClick}
                onMouseDown={event => event.preventDefault()}
                tabIndex={-1}
                className={cn(
                  "mr-1 flex-shrink-0 p-0.5 rounded transition-colors",
                  isSelected ? "hover:bg-accent" : "hover:bg-muted"
                )}
              >
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
            ) : (
              <div className="mr-1 flex-shrink-0 w-4 h-4"></div>
            )}
            <div className="flex-shrink-0 mr-2">
              {getIcon()}
            </div>
            <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center">
            <span className={cn(
              "text-sm font-medium truncate min-w-0 flex-1",
              isSelected ? "text-secondary-foreground" : "text-foreground"
            )} title={node.name}>
              {(() => {
                switch (node.type) {
                  case 'table':
                    return node.name.replace('.table.toml', '');
                  case 'interface':
                    return node.name.replace('.interface.toml', '');
                  // Extension point for other types
                  // case 'project':
                  //   return node.name.replace('.project.toml', '');
                  default:
                    return node.name;
                }
              })()}
            </span>
            {displayName && (
              <span className={cn(
                "text-xs ml-2 truncate",
                isSelected ? "text-muted-foreground" : "text-muted-foreground"
              )} title={displayName}>
                ({displayName})
              </span>
            )}
            </div>
            {showModified && <time className="block truncate text-xs leading-4 text-muted-foreground tabular-nums"
              dateTime={modified && Number.isFinite(modified.getTime()) ? modified.toISOString() : undefined}
              title={`${t('file.modifiedTime')}: ${modifiedText}`}>
              {modifiedText}
            </time>}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="bg-background border-border">
          {onDuplicate && ['table', 'interface', 'markdown', 'folder'].includes(node.type) && (
            <>
              <ContextMenuItem onClick={() => onDuplicate(node)} className="hover:bg-muted">
                <Files className="mr-2 h-4 w-4" />
                {t('file.duplicate')}</ContextMenuItem>
              <ContextMenuSeparator className="bg-muted" />
            </>
          )}
          <ContextMenuItem onClick={() => onRename(node)} className="hover:bg-muted">
            <FileText className="mr-2 h-4 w-4" />
            {t('file.rename')}</ContextMenuItem>
          {node.type === 'table' && onRenameDisplayName && (
            <ContextMenuItem onClick={() => onRenameDisplayName(node)} className="hover:bg-muted">
              <FileText className="mr-2 h-4 w-4" />
              {t('file.renameDisplay')}</ContextMenuItem>
          )}
          {node.type === 'folder' && (
            <>
              <ContextMenuSeparator className="bg-muted" />
              {onCreateFile ? (
                <ContextMenuItem onClick={() => onCreateFile(node)} className="hover:bg-muted">
                  <FilePlus className="mr-2 h-4 w-4" />
                  {t('file.createFile')}</ContextMenuItem>
              ) : (
                <ContextMenuItem onClick={() => onCreateTable(node)} className="hover:bg-muted">
                  <Database className="mr-2 h-4 w-4" />
                  {t('file.createTable')}</ContextMenuItem>
              )}
              <ContextMenuSeparator className="bg-muted" />
              <ContextMenuItem onClick={() => onCreateFolder(node)} className="hover:bg-muted">
                <FolderPlus className="mr-2 h-4 w-4" />
                {t('file.createFolder')}</ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator className="bg-muted" />
          <ContextMenuItem onClick={handleOpenInExplorer} className="hover:bg-muted">
            <ExternalLink className="mr-2 h-4 w-4" />
            {t('file.openExplorer')}</ContextMenuItem>
          <ContextMenuSeparator className="bg-muted" />
          <ContextMenuItem onClick={handleDeleteClick} className="text-red-600 hover:bg-red-50">
            {selectedItems.size > 1 && selectedItems.has(node.id)
              ? t('file.deleteCount', {count: selectedItems.size})
              : t('common.delete')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
