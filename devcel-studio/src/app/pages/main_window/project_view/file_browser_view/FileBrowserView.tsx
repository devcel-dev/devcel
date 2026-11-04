import { useSelectAll } from '@/app/utils/useSelectAll';
import { appAlert, appPrompt } from '@/app/services/appDialogs';
import { settingsDisplayLabel } from '@/app/settings/displayLabels';
import { useI18n, getLocale, t } from '@/app/i18n';
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FilePlus, FolderPlus, ArrowUpDown, ArrowUp, ArrowDown, Search } from "lucide-react";
import { useEffect, useEffectEvent, useState, forwardRef, useImperativeHandle, useRef, useCallback } from "react";
import { useDrop, DropTargetMonitor, useDragLayer } from 'react-dnd';
import { type ProjectSession } from "@/app/commands/projectCommands";
import { loadTable, getLoadedTables, getTableDisplayCatalog } from "@/app/commands/tableCommands";
import { renameTableDisplayName } from "@/app/commands/tableCommands";
import { FileTree, type FileTreeRef } from './components/FileTree';
import { SearchBar } from './components/SearchBar';
import { Breadcrumb } from './components/Breadcrumb';
import { FileTypeDialog } from './components/FileTypeDialog';
import { useFileTree } from './hooks/useFileTree';
import { useFileOperations } from './hooks/useFileOperations';
import { useSearch } from './hooks/useSearch';
import { useSort } from './hooks/useSort';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { FileNode } from './types';

interface FileBrowserViewProps {
  projectSession: ProjectSession;
  onFileSelect?: (file: FileNode) => Promise<boolean>;
  getNavigationVersion: () => number;
  onNavigate: () => void;
  onFileRenamed?: (oldPath: string, newFile: FileNode) => void;
}

export interface FileBrowserViewRef {
  selectFileInTree: (fileId: string | null) => void;
}

// Remove only the project's Tables directory, preserving same-named parent and child directories.
function getRelativeTablePath(tablePath: string, projectFilePath: string): string {
  const normalizedTablePath = tablePath.replace(/\\/g, '/');
  const normalizedProjectPath = projectFilePath.replace(/\\/g, '/');
  const separatorIndex = normalizedProjectPath.lastIndexOf('/');
  if (separatorIndex === -1) return normalizedTablePath;

  const tablesPrefix = `${normalizedProjectPath.slice(0, separatorIndex + 1)}Tables/`;
  return normalizedTablePath.startsWith(tablesPrefix)
    ? normalizedTablePath.slice(tablesPrefix.length)
    : normalizedTablePath;
}

export const FileBrowserView = forwardRef<FileBrowserViewRef, FileBrowserViewProps>(({ projectSession, onFileSelect, onFileRenamed, getNavigationVersion, onNavigate }, ref) => {
  const { locale } = useI18n();
  const projectPath = projectSession.path;
  const lifecycle = useRef(0);
  const active = useRef(false);
  const loadedRequest = useRef(0);
  const displayRenaming = useRef(new Set<string>());
  const displayRequest = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReveal = useRef<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(null);
  const [dropTargetParentFolderId, setDropTargetParentFolderId] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [tableDisplayNames, setTableDisplayNames] = useState<Map<string, string>>(new Map());
  const [loadedTables, setLoadedTables] = useState<Map<string, string>>(new Map());
  const [showFileTypeDialog, setShowFileTypeDialog] = useState(false);
  const [contextMenuTargetNode, setContextMenuTargetNode] = useState<FileNode | null>(null);
  
  const {
    files,
    setFiles,
    selectedItems,
    setSelectedItems,
    expandedFolders,
    toggleFolder,
    buildFileTree,
    findNodeByIdInAllTrees,
    expandParentFolders,
    selectItemAfterOperation,
    retargetItemAfterOperation,
    refreshProjectEntries,
    handleItemSelect,
    clearSelection
  } = useFileTree(projectPath, projectSession.id);

  const {
    handleAddFile,
    handleAddFolder,
    handleDelete,
    handleBulkDelete,
    handleDuplicate,
    handleRename,
    handleMove,
    handleCreateTable,
    handleCreateFolder
  } = useFileOperations(
    files,
    selectedItems,
    findNodeByIdInAllTrees,
    refreshProjectEntries,
    buildFileTree,
    expandParentFolders,
    selectItemAfterOperation,
    retargetItemAfterOperation,
    setFiles,
    projectSession,
    () => active.current,
    getNavigationVersion,
    onFileSelect,
    onFileRenamed
  );

  // Search
  const {
    searchQuery,
    setSearchQuery,
    filterType,
    setFilterType,
    useRegex,
    setUseRegex,
    filteredFiles
  } = useSearch(files);

  // Sorting
  const {
    sortType,
    setSortType,
    sortOrder,
    toggleSortOrder,
    sortedFiles
  } = useSort(filteredFiles);

  // External writers need not emit Studio events. Refresh only while timestamps
  // are visible; serialize reads and retire the timer on session/mode changes.
  const refreshModifiedEntries = useEffectEvent(() => refreshProjectEntries());
  useEffect(() => {
    if (sortType !== 'modified') return;
    let retired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!document.hidden) await refreshModifiedEntries();
      if (!retired) timer = setTimeout(() => { void refresh(); }, 5000);
    };
    void refresh();
    return () => { retired = true; if (timer !== undefined) clearTimeout(timer); };
  }, [sortType, projectSession.id]);

  const shortcutRoot = useRef<HTMLDivElement>(null);
  useSelectAll(shortcutRoot, () => {
    const ids = new Set<string>();
    const collect = (nodes: FileNode[]) => { for (const node of nodes) { ids.add(node.id); if (node.children) collect(node.children); } };
    collect(files); onNavigate(); setSelectedItems(ids);
  }, () => {
    setShowSearch(true);
    requestAnimationFrame(() => {
      const input = shortcutRoot.current?.querySelector<HTMLInputElement>('[data-file-search]');
      input?.focus(); input?.select();
    });
  });

  // Keyboard shortcuts
  useKeyboardShortcuts({
    root: shortcutRoot,
    selectedItems,
    setSelectedItems: (items) => { onNavigate(); setSelectedItems(items); },
    files,
    findNodeByIdInAllTrees,
    handleBulkDelete,
    handleRename
  });

  // File creation handler for the context menu
  const handleCreateFile = useCallback((node: FileNode) => {
    setContextMenuTargetNode(node);
    setShowFileTypeDialog(true);
  }, []);

  // Monitor drag state
  const { isDragging } = useDragLayer((monitor) => ({
    isDragging: monitor.isDragging()
  }));

  // Clear highlights when dragging ends
  useEffect(() => {
    if (!isDragging) {
      setDropTargetFolderId(null);
      setDropTargetParentFolderId(null);
    }
  }, [isDragging]);

  // useDrop for the root-level drop zone
  const dropRootRef = useRef<HTMLDivElement>(null);
  const fileTreeRef = useRef<FileTreeRef>(null);
  const [{ isOverRoot, canDropRoot }, drop] = useDrop({
    accept: 'FILE_NODE',
    canDrop: (item: { id: string, type: string }) => {
      // Disallow dropping items already at the root
      const isRootItem = files.some(f => f.id === item.id);
      return !isRootItem;
    },
    drop: async (item: { id: string, type: string }, monitor: DropTargetMonitor) => {
      if (!monitor.isOver({ shallow: true })) {
        return;
      }
      await handleMove(item.id, null, true);
    },
    hover: (_, monitor) => {
      const isOverShallow = monitor.isOver({ shallow: true });
      
      // Clear all highlights when hovering over the root level
      if (isOverShallow) {
        setDropTargetFolderId(null);
        setDropTargetParentFolderId(null);
      }
    },
    collect: (monitor) => ({
      isOverRoot: monitor.isOver({ shallow: true }),
      canDropRoot: monitor.canDrop(),
    }),
  });

  // Connect the drop target after component mounts
  useEffect(() => {
    if (dropRootRef.current) {
      drop(dropRootRef.current);
    }
  }, [drop]);

  const updateLoadedTables = useCallback(async () => {
    if (!active.current) return;
    const generation = lifecycle.current;
    const request = ++loadedRequest.current;
    try {
      const loaded = await getLoadedTables(projectSession.id);
      if (!active.current || generation !== lifecycle.current || request !== loadedRequest.current || locale !== getLocale()) return;
      const next = new Map<string, string>();
      for (const table of loaded) {
        const relativePath = getRelativeTablePath(table.path, projectPath);
        // Never mark an absolute path from another project as a relative tree entry.
        if (relativePath !== table.path.replace(/\\/g, '/')) next.set(relativePath, settingsDisplayLabel(table.uuid, table.display_name || table.data_name));
      }
      setLoadedTables(previous => previous.size === next.size && [...next].every(([path, name]) => previous.get(path) === name) ? previous : next);
    } catch (error) {
      if (active.current && generation === lifecycle.current) console.error('Failed to retrieve loaded tables:', error);
    }
  }, [projectPath, projectSession.id, locale]);

  const updateTableDisplayNames = useCallback(async () => {
    if (!active.current) return;
    const generation = lifecycle.current;
    const request = ++displayRequest.current;
    try {
      const tables = await getTableDisplayCatalog(projectSession.id);
      if (!active.current || generation !== lifecycle.current || request !== displayRequest.current || locale !== getLocale()) return;
      const next = new Map<string, string>();
      for (const table of tables) {
        const path = getRelativeTablePath(table.path, projectPath);
        if (path !== table.path.replace(/\\/g, '/')) next.set(path, settingsDisplayLabel(table.uuid, table.display_name || table.data_name));
      }
      setTableDisplayNames(previous => previous.size === next.size && [...next].every(([path, name]) => previous.get(path) === name) ? previous : next);
    } catch (error) {
      if (active.current && generation === lifecycle.current) console.error('Failed to retrieve table display names:', error);
    }
  }, [projectPath, projectSession.id, locale]);

  // The mount/locale refresh uses the latest tree expansion without subscribing to tree updates.
  const refreshEntriesOnMount = useEffectEvent(() => refreshProjectEntries());
  useEffect(() => {
    active.current = true;
    ++lifecycle.current;
    const invalidateRequests = () => { ++lifecycle.current; ++loadedRequest.current; ++displayRequest.current; };
    void refreshEntriesOnMount();
    void updateLoadedTables();
    void updateTableDisplayNames();
    let labelTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshLabels = () => {
      ++displayRequest.current;
      if (labelTimer !== null) clearTimeout(labelTimer);
      labelTimer = setTimeout(() => { labelTimer = null; void updateTableDisplayNames(); }, 100);
    };
    window.addEventListener('devcel-table-catalog-invalidated', refreshLabels);
    const onTableLoaded = () => { void updateLoadedTables(); };
    window.addEventListener('devcel-table-loaded', onTableLoaded);
    const interval = setInterval(onTableLoaded, 5000);
    return () => {
      active.current = false;
      invalidateRequests();
      clearInterval(interval);
      if (labelTimer !== null) clearTimeout(labelTimer);
      window.removeEventListener('devcel-table-catalog-invalidated', refreshLabels);
      window.removeEventListener('devcel-table-loaded', onTableLoaded);
      if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
      scrollTimer.current = null;
    };
  }, [projectSession.id, updateLoadedTables, updateTableDisplayNames]);

  // Renaming is an explicit request, including for a table that has never been opened.
  const handleRenameDisplayName = useCallback(async (node: FileNode) => {
    if (displayRenaming.current.has(node.path)) return;
    displayRenaming.current.add(node.path);
    const generation = lifecycle.current;
    try {
      const result = await loadTable(node.path, projectSession.id);
      if (!active.current || generation !== lifecycle.current) return;
      if (result !== 'ok') throw new Error(result);
      const loaded = await getLoadedTables(projectSession.id);
      if (!active.current || generation !== lifecycle.current) return;
      const tableInfo = loaded.find(table => getRelativeTablePath(table.path, projectPath) === node.path);
      if (!tableInfo) throw new Error(t('file.loadedTableMissing'));

      const newName = await appPrompt(t('file.newDisplayName'), tableInfo.display_name);
      if (!newName || newName === tableInfo.display_name || !active.current || generation !== lifecycle.current) return;
      const renamed = await renameTableDisplayName(tableInfo.uuid, newName, projectSession.id);
      if (!active.current || generation !== lifecycle.current) return;
      if (renamed !== 'ok') throw new Error(renamed);
      await updateLoadedTables();
    } catch (error) {
      if (!active.current || generation !== lifecycle.current) return;
      console.error('Failed to change the display name:', error);
      await appAlert(t('file.displayNameFailed') + error);
    } finally { displayRenaming.current.delete(node.path); }
  }, [projectPath, projectSession.id, updateLoadedTables]);

  // Breadcrumb navigation
  const handleBreadcrumbNavigate = (path: string) => {
    onNavigate();
    setCurrentPath(path);
    // Expand folders along the path
    if (path) {
      const pathParts = path.split('/');
      const newExpandedFolders = new Set(expandedFolders);
      for (let i = 1; i <= pathParts.length; i++) {
        const folderPath = pathParts.slice(0, i).join('/');
        newExpandedFolders.add(folderPath);
      }
      // setExpandedFolders must be called
    }
  };

  // Filter based on the current path
  const getCurrentPathFiles = () => {
    if (!currentPath) return sortedFiles;
    
    const findNodeByPath = (nodes: any[], path: string): any => {
      for (const node of nodes) {
        if (node.path === path) return node;
        if (node.children) {
          const found = findNodeByPath(node.children, path);
          if (found) return found;
        }
      }
      return null;
    };
    
    const currentNode = findNodeByPath(sortedFiles, currentPath);
    return currentNode?.children || [];
  };

  const displayFiles = getCurrentPathFiles();

  // An explicit reveal may arrive before a remounted sidebar has loaded its tree.
  // Keep only that request pending; ordinary Ctrl/Shift selections remain untouched.
  const revealPendingFile = useEffectEvent(() => {
    const fileId = pendingReveal.current;
    if (fileId === null) return;
    if (!selectedItems.has(fileId)) {
      pendingReveal.current = null;
      return;
    }
    const targetFile = findNodeByIdInAllTrees(fileId);
    if (!targetFile) return;
    pendingReveal.current = null;
    expandParentFolders(targetFile.path, files);
    const generation = lifecycle.current;
    if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      scrollTimer.current = null;
      if (!active.current || generation !== lifecycle.current) return;
      fileTreeRef.current?.scrollToFile(fileId);
    }, 100);
  });
  useEffect(() => { revealPendingFile(); }, [files, selectedItems]);

  // Expose methods through ref for external calls
  useImperativeHandle(ref, () => ({
    selectFileInTree: (fileId: string | null) => {
      if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
      scrollTimer.current = null;
      pendingReveal.current = fileId;
      if (fileId === null) clearSelection();
      else {
        handleItemSelect(fileId, false, false);
        if (!findNodeByIdInAllTrees(fileId)) void refreshProjectEntries();
      }
    }
  }));

  return (
    <div ref={shortcutRoot} data-file-browser tabIndex={-1} onPointerDown={event => {
      if (event.target instanceof Element && event.currentTarget.contains(event.target)
        && !event.target.closest('input, textarea, select, [contenteditable], [role="textbox"]')
       && (event.target.closest('[data-file-navigation-tree]') || !event.target.closest('button, a'))) {
        const tree = event.target.closest<HTMLElement>('[data-file-navigation-tree]');
       (tree ?? event.currentTarget).focus({ preventScroll: true });
      }
    }} className="h-full flex flex-col bg-background rounded-lg shadow-sm border border-border overflow-hidden">
      {/* Compact toolbar */}
      <div className="bg-muted border-b border-border">
        <div className="flex items-center h-[34px] px-3">
          <div className="flex items-center gap-1">
            <Button 
              onClick={() => setShowFileTypeDialog(true)}
              variant="ghost"
              size="sm"
              title={t('file.addFile')}
              className="h-7 w-7 p-0 hover:bg-muted"
            >
              <FilePlus className="h-4 w-4" />
            </Button>
            <Button 
              onClick={handleAddFolder}
              variant="ghost"
              size="sm"
              title={t('file.addFolder')}
              className="h-7 w-7 p-0 hover:bg-muted"
            >
              <FolderPlus className="h-4 w-4" />
            </Button>
            
            <div className="w-px h-5 bg-secondary mx-1" />
            
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSearch(!showSearch)}
              title={t('common.search')}
              className={cn(
                "h-7 w-7 p-0 hover:bg-muted",
                showSearch && "bg-muted"
              )}
            >
              <Search className="h-4 w-4" />
            </Button>
          </div>
          
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const types = ['name', 'type', 'modified'] as const;
                const currentIndex = types.indexOf(sortType);
                setSortType(types[(currentIndex + 1) % types.length]);
              }}
              title={t('file.sortLabel', {field: sortType === 'name' ? t('common.name') : sortType === 'type' ? t('file.sortType') : t('file.modifiedTime')})}
              className="h-7 px-2 text-xs hover:bg-muted"
            >
              <ArrowUpDown className="h-3.5 w-3.5 mr-1" />
              {sortType === 'name' ? t('common.name') : sortType === 'type' ? t('file.sortType') : t('file.updated')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleSortOrder}
              title={sortOrder === 'asc' ? t('file.ascending') : t('file.descending')}
              className="h-7 w-7 p-0 hover:bg-muted"
            >
              {sortOrder === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </div>
      
      {/* Collapsible search bar */}
      {showSearch && (
        <div className="p-3 border-b border-border bg-muted">
          <SearchBar
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            filterType={filterType}
            setFilterType={setFilterType}
            useRegex={useRegex}
            setUseRegex={setUseRegex}
          />
        </div>
      )}
      
      {/* Breadcrumbs, displayed only when currentPath exists */}
      {currentPath && (
        <div className="px-3 py-2 border-b border-border">
          <Breadcrumb
            currentPath={currentPath}
            onNavigate={handleBreadcrumbNavigate}
          />
        </div>
      )}
      
      <div 
        ref={dropRootRef}
        className={cn(
          "flex-1 overflow-auto min-h-0 p-2 transition-all duration-200",
          isOverRoot && canDropRoot
            ? "bg-accent" 
            : ""
        )}
        onClick={event => {
          // React portal clicks bubble through this component tree even though
          // the context menu is outside the sidebar's DOM. Only real clicks
          // inside the sidebar background may clear its selection.
          if (!event.currentTarget.contains(event.target as Node)) return;
          onNavigate();
          clearSelection();
        }}
      >
        {isOverRoot && canDropRoot && (
          <div className="absolute top-2 left-2 text-sm text-primary font-medium bg-background px-2 py-1 rounded shadow-sm z-20">
            {t('file.moveRoot')}</div>
        )}
        <FileTree
          ref={fileTreeRef}
          nodes={displayFiles}
          showModified={sortType === 'modified'}
          onKeyboardSelect={(id, extend) => { onNavigate(); handleItemSelect(id, false, extend, displayFiles, false); }}
          projectPath={projectPath}
          selectedItems={selectedItems}
          handleItemSelect={(...args) => { onNavigate(); handleItemSelect(...args); }}
          expandedFolders={expandedFolders}
          toggleFolder={(id) => { onNavigate(); toggleFolder(id); }}
          onDelete={handleDelete}
          onRename={handleRename}
          onCreateTable={handleCreateTable}
          onCreateFolder={handleCreateFolder}
          onCreateFile={handleCreateFile}
          onMove={handleMove}
          onDuplicate={handleDuplicate}
          onBulkDelete={handleBulkDelete}
          onRenameDisplayName={handleRenameDisplayName}
          displayFiles={displayFiles}
          dropTargetFolderId={dropTargetFolderId}
          onDropTargetChange={setDropTargetFolderId}
          dropTargetParentFolderId={dropTargetParentFolderId}
          onDropTargetParentChange={setDropTargetParentFolderId}
          findNodeByIdInAllTrees={findNodeByIdInAllTrees}
          onFileSelect={onFileSelect}
          loadedTables={loadedTables}
          tableDisplayNames={tableDisplayNames}
        />
      </div>
      
      {/* File type selection dialog */}
      <FileTypeDialog
        open={showFileTypeDialog}
        onOpenChange={(open) => {
          setShowFileTypeDialog(open);
          if (!open) {
            setContextMenuTargetNode(null);
          }
        }}
        onConfirm={(fileType, fileName) => {
          // When opened from the context menu, always use that folder as the base
          if (contextMenuTargetNode) {
            const targetPath = contextMenuTargetNode.type === 'folder' 
              ? contextMenuTargetNode.path 
              : contextMenuTargetNode.path.split('/').slice(0, -1).join('/');
            
            return handleAddFile(fileType, fileName, targetPath);
          } else {
            return handleAddFile(fileType, fileName);
          }
        }}
      />
    </div>
  );
});