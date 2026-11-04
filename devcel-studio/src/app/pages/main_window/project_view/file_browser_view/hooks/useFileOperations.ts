import { appAlert, appConfirm, appPrompt } from '@/app/services/appDialogs';
import { useRef } from 'react';
import { t, localizeError } from '@/app/i18n';
import { invoke } from '@tauri-apps/api/core';
import { FileNode } from '../types';
import { 
  getProjectEntries,
  ProjectEntry,
  type ProjectSession
} from '@/app/commands/projectCommands';
import { loadTable, getLoadedTables, invalidateTableCatalog } from '@/app/commands/tableCommands';
import { validateAndShowError, validateDataName } from '@/app/utils/validation';
import { fileOperation } from '@/api/fileOperation';
import type { FileType } from '@/types/fileOperation';
import { flushMarkdownEdits } from '@/app/utils/markdownSaveLifecycle';
import { normalizeTablePath } from '@/app/utils/DemandTableLoader';

// File type mapping definitions
const FILE_TYPE_MAP: Record<FileNode['type'], FileType | undefined> = {
  'folder': 'Directory',
  'table': 'Table',
  'interface': 'Interface',
  'markdown': 'Markdown',
  'file': undefined,
  'project': undefined
};

export function useFileOperations(
  files: FileNode[],
  selectedItems: Set<string>,
  findNodeByIdInAllTrees: (id: string) => FileNode | null,
  refreshProjectEntries: () => Promise<boolean>,
  buildFileTree: (entries: ProjectEntry[]) => FileNode[],
  expandParentFolders: (targetPath: string, newNodes: FileNode[]) => void,
  selectItemAfterOperation: (targetPath: string, newNodes: FileNode[]) => void,
  retargetItemAfterOperation: (oldPath: string, newPath: string) => void,
  setFiles: (nodes: FileNode[]) => void,
  projectSession: ProjectSession,
  isActive: () => boolean,
  getNavigationVersion: () => number,
  onFileSelect?: (file: FileNode) => Promise<boolean>,
  onFileRenamed?: (oldPath: string, newFile: FileNode) => void
) {
  // Keep every operation tied to the project that supplied its relative paths,
  // including continuations after dialogs or an awaited native command.
  const expectedProjectSession = projectSession.id;
  const renamingPaths = useRef(new Set<string>());
  const creating = useRef(false);
  const prompting = useRef(false);
  const deleting = useRef(false);
  const currentSession = useRef(expectedProjectSession);
  currentSession.current = expectedProjectSession;
  const isCurrent = () => isActive() && currentSession.current === expectedProjectSession;
  const nameError = (value: string) => validateDataName(value).errorMessage;
  const promptForCreation = async (kind: 'folder' | 'table') => {
    if (!isCurrent() || creating.current || prompting.current) return null;
    prompting.current = true;
    try {
      const value = await appPrompt(t(kind === 'folder' ? 'file.enterFolder' : 'file.enterTable'),
        kind === 'folder' ? 'new_folder' : 'new_table', {
          title: t(kind === 'folder' ? 'file.addFolder' : 'file.newTitle'),
          confirmLabel: t('common.create'), validate: nameError,
        });
      return isCurrent() ? value : null;
    } finally { prompting.current = false; }
  };

  const flushBeforeFileChange = async (node: FileNode) => {
    if (node.type === 'markdown' || node.type === 'folder') {
      await flushMarkdownEdits(expectedProjectSession, node.type === 'markdown' ? node.path : undefined);
    }
  };

  const selectedParentPath = () => {
    if (selectedItems.size !== 1) return '';
    const selected = findNodeByIdInAllTrees([...selectedItems][0]);
    if (!selected) return '';
    return selected.type === 'folder' ? selected.path : selected.path.split('/').slice(0, -1).join('/');
  };

  const createFile = async (fileType: FileType, path: string): Promise<boolean> => {
    if (!isCurrent() || creating.current) return false;
    creating.current = true;
    const navigationVersion = getNavigationVersion();
    let created = false;
    try {
      const entry = await fileOperation({ type: 'Create', file_type: fileType, path }, expectedProjectSession);
      created = true;
      invalidateTableCatalog();
      if (!isCurrent()) return true;
      window.dispatchEvent(new CustomEvent('devcel-table-loaded'));
      const refreshed = await refreshProjectEntries();
      if (!refreshed || !isCurrent() || navigationVersion !== getNavigationVersion()) return true;

      const nodeType = { Table: 'table', Interface: 'interface', Markdown: 'markdown', Directory: 'folder' } as const;
      const node: FileNode = {
        id: entry.path,
        path: entry.path,
        name: entry.path.split('/').pop()!,
        type: nodeType[entry.file_type],
        uuid: entry.uuid ?? undefined,
        children: entry.file_type === 'Directory' ? [] : undefined,
      };
      // Open only the authoritative created identity, and let later user navigation win.
      if (node.type !== 'folder' && onFileSelect && !await onFileSelect(node)) return true;
      if (!isCurrent()) return true;
      expandParentFolders(entry.path, files);
      selectItemAfterOperation(entry.path, [node]);
      return true;
    } catch (error) {
      console.error('Failed to create the file:', error);
      if (isCurrent()) await appAlert(t(created ? 'file.refreshFailed' : 'file.createFailed', { error: localizeError(error) }));
      return created;
    } finally {
      creating.current = false;
    }
  };

  const handleAddFile = async (fileType: "table" | "interface" | "markdown", fileName: string, overrideTargetPath?: string): Promise<boolean> => {
    if (!isCurrent() || !fileName || !await validateAndShowError(fileName, t('file.name'))) return false;
    const targetPath = overrideTargetPath ?? selectedParentPath();
    const extension = { table: '.table.toml', interface: '.interface.toml', markdown: '.md' }[fileType];
    const path = `${targetPath ? `${targetPath}/` : ''}${fileName}${extension}`;
    return createFile(FILE_TYPE_MAP[fileType]!, path);
  };

  const handleAddFolder = async () => {
    const targetPath = selectedParentPath();
    const folderName = await promptForCreation('folder');
    if (!folderName || !isCurrent()) return;
    await createFile('Directory', `${targetPath ? `${targetPath}/` : ''}${folderName}`);
  };

  const handleBulkDelete = async (nodeIds: Set<string>) => {
    if (!isCurrent() || deleting.current) return;
    // Capture identities before an asynchronous confirmation. Selection and the
    // current project may change while the user is deciding.
    const selected = [...new Set(nodeIds)].map(id => findNodeByIdInAllTrees(id))
      .filter((node): node is FileNode => node !== null)
      .map(node => ({ ...node }));
    // A selected folder owns its descendants: never race a child deletion with
    // deletion of its parent directory (Ctrl+A selects both).
    const nodes = selected.filter(node => !selected.some(parent => parent.type === 'folder'
      && parent.path !== node.path && node.path.startsWith(`${parent.path}/`)));
    if (nodes.length === 0) return;
    deleting.current = true;
    try {
      const confirmMessage = nodes.length === 1
        ? t('file.deleteNamedConfirm', { name: nodes[0].name })
        : t('file.deleteCountConfirm', { count: nodes.length });
      if (!await appConfirm(confirmMessage, { destructive: true, confirmLabel: t('common.delete') }) || !isCurrent()) return;
      // Complete every validation and draft flush before the first deletion.
      // A failed draft flush must not leave a partially deleted selection.
      for (const node of nodes) {
        if (!FILE_TYPE_MAP[node.type]) throw new Error(t('file.unsupportedDelete', { type: node.type }));
      }
      await Promise.all(nodes.map(flushBeforeFileChange));
      if (!isCurrent()) return;
      for (const node of nodes) {
        if (!isCurrent()) return;
        await fileOperation({ type: 'Delete', file_type: FILE_TYPE_MAP[node.type]!, path: node.path }, expectedProjectSession);
      }
      invalidateTableCatalog();
      if (!isCurrent()) return;
      window.dispatchEvent(new CustomEvent('devcel-table-loaded'));
      await refreshProjectEntries();
    } catch (error) {
      console.error('Failed to delete items:', error);
      if (isCurrent()) await appAlert(t('file.deleteFailed', { error: localizeError(error) }));
    } finally { deleting.current = false; }
  };

  // Context-menu single deletion follows exactly the same confirmation and
  // all-or-nothing draft preflight as keyboard and multi-selection deletion.
  const handleDelete = async (node: FileNode) => handleBulkDelete(new Set([node.id]));

  const handleDuplicate = async (node: FileNode) => {
    if (!isCurrent()) return;
    try {
      // Duplication reads persisted bytes, including every descendant Markdown.
      await flushMarkdownEdits();
      if (!isCurrent()) return;
      const baseName = node.type === 'folder' ? node.name : node.name.replace(/\.(table\.toml|interface\.toml|[^.]+)$/, '');
      const extension = node.name.substring(baseName.length);
      
      // Get file names at the same level
      const pathParts = node.path.split('/').filter(part => part !== '');
      let siblingNames: string[] = [];
      
      if (pathParts.length > 1) {
        const parentPath = pathParts.slice(0, -1).join('/');
        const parentNode = findNodeByIdInAllTrees(parentPath);
        siblingNames = parentNode?.children?.map(child => child.name) || [];
      } else {
        siblingNames = files.map(file => file.name);
      }
      
      // Generate a unique name
      let counter = 1;
      let newName = `${baseName}_copy${extension}`;
      while (siblingNames.includes(newName)) {
        counter++;
        newName = `${baseName}_copy${counter}${extension}`;
      }
      
      const newPath = pathParts.length > 1
        ? `${pathParts.slice(0, -1).join('/')}/${newName}`
        : newName;
      
      const createdPath = await invoke<string>('duplicate_project_entry', { sourcePath: node.path, destPath: newPath, expectedProjectSession });
      if (!isCurrent()) return;

      await refreshProjectEntries();
      if (!isCurrent()) return;
      
      const entries: ProjectEntry[] = await getProjectEntries(expectedProjectSession);
      if (!isCurrent()) return;
      const fileNodes = buildFileTree(entries);
      selectItemAfterOperation(createdPath, fileNodes);
      setFiles(fileNodes);
    } catch (error) {
      console.error('Failed to duplicate:', error);
      if (isCurrent()) await appAlert(t('file.duplicateFailed', {error: localizeError(error)}));
    }
  };

  const handleRename = async (node: FileNode) => {
    if (!isCurrent() || renamingPaths.current.has(node.path)) return;
    renamingPaths.current.add(node.path);
    let renamed = false;
    try {
      const fileType = FILE_TYPE_MAP[node.type];
      if (!fileType) return;
      const extension = node.type === 'table' ? '.table.toml'
        : node.type === 'interface' ? '.interface.toml'
        : node.type === 'markdown' ? '.md' : '';
      const currentDisplayName = node.type === 'table' && node.name.endsWith(extension)
        ? node.name.slice(0, -extension.length) : node.name;
      const newName = await appPrompt(t('file.enterNewName'), currentDisplayName);
      if (!newName || newName === currentDisplayName || !isCurrent()) return;

      // Accept either the stem or the same filename format shown in the prompt.
      const nameWithoutExt = extension && newName.endsWith(extension)
        ? newName.slice(0, -extension.length) : newName;
      // File names and exported data symbols have different contracts. Rust owns
      // this validation and repeats it at the rename boundary before touching disk.
      const isIdentityFile = node.type === 'table' || node.type === 'interface';
      if (!isIdentityFile && !await validateAndShowError(nameWithoutExt,
        node.type === 'folder' ? t('file.folderName') : t('file.name'))) return;
      const newFileName = isIdentityFile
        ? await invoke<string>('validate_file_name_command', { name: newName, fileType })
        : `${nameWithoutExt}${extension}`;
      if (!isCurrent()) return;
      const pathParts = node.path.split('/');
      pathParts[pathParts.length - 1] = newFileName;
      const newPath = pathParts.join('/');
      if (newPath === node.path) return;

      await flushBeforeFileChange(node);
      if (!isCurrent()) return;
      // Resolve identity before changing the path so reused tab caches can never
      // supply another table's UUID after this operation.
      let renamedUuid = node.uuid;
      if (node.type === 'table') {
        const result = await loadTable(node.path, expectedProjectSession);
        if (!isCurrent()) return;
        if (result !== 'ok') throw new Error(result);
        const loaded = await getLoadedTables(expectedProjectSession);
        if (!isCurrent()) return;
        renamedUuid = loaded.find(table => normalizeTablePath(table.path, projectSession.path) === node.path)?.uuid;
        if (!renamedUuid) throw new Error(t('file.tableUuidMissing'));
      }
      // FileOperation uses a path for all file types; Rust resolves table identity.
      await fileOperation({
        type: 'Rename',
        file_type: fileType,
        old_path: node.path,
        new_name: newFileName
      }, expectedProjectSession);
      renamed = true;
      invalidateTableCatalog();
      if (!isCurrent()) return;
      window.dispatchEvent(new CustomEvent('devcel-table-loaded'));
      // Retarget existing selection and open tabs without navigating to the file.
      retargetItemAfterOperation(node.path, newPath);
      onFileRenamed?.(node.path, { ...node, id: newPath, path: newPath, name: newFileName, uuid: renamedUuid });

      const entries: ProjectEntry[] = await getProjectEntries(expectedProjectSession);
      if (!isCurrent()) return;
      const fileNodes = buildFileTree(entries);
      const parentPath = newPath.split('/').slice(0, -1).join('/');
      if (parentPath) expandParentFolders(parentPath, fileNodes);
      setFiles(fileNodes);
    } catch (error) {
      console.error('Failed to rename:', error);
      if (isCurrent()) await appAlert(t(renamed ? 'file.refreshFailed' : 'file.renameFailed', { error: localizeError(error) }));
    } finally {
      renamingPaths.current.delete(node.path);
    }
  };

  const handleMove = async (draggedNodeId: string, targetNode: FileNode | null, isRoot: boolean = false) => {
    if (!isCurrent() || renamingPaths.current.has(draggedNodeId)) return;
    renamingPaths.current.add(draggedNodeId);
    const navigationVersion = getNavigationVersion();
    let moved = false;
    try {
      const draggedNode = findNodeByIdInAllTrees(draggedNodeId);
      if (!draggedNode) {
        console.error('Dragged node not found:', draggedNodeId);
        return;
      }


      const draggedNodePathParts = draggedNode.path.split('/').filter(part => part !== '');
      
      let newPath: string;
      let draggedNodeParentPath: string;

      if (isRoot) {
        if (draggedNodePathParts.length === 1) {
          return;
        }
        newPath = draggedNode.name;
        draggedNodeParentPath = draggedNodePathParts.length > 1 
          ? draggedNodePathParts.slice(0, -1).join('/') 
          : '';
      } else if (targetNode && targetNode.type === 'folder') {
        draggedNodeParentPath = draggedNodePathParts.length > 1 
          ? draggedNodePathParts.slice(0, -1).join('/') 
          : '';

        if (draggedNodeParentPath === targetNode.path) {
          return;
        }

        newPath = `${targetNode.path}/${draggedNode.name}`;
      } else if (targetNode && targetNode.id) {
        // When targetNode contains only an id, for moves to the parent folder
        draggedNodeParentPath = draggedNodePathParts.length > 1 
          ? draggedNodePathParts.slice(0, -1).join('/') 
          : '';

        if (draggedNodeParentPath === targetNode.id) {
          return;
        }

        // targetNode.id is used as the path
        newPath = targetNode.id ? `${targetNode.id}/${draggedNode.name}` : draggedNode.name;
      } else {
        console.error('Invalid target node:', targetNode);
        return;
      }


      await flushBeforeFileChange(draggedNode);
      if (!isCurrent()) return;
      // Move the file using the unified API
      const fileType = FILE_TYPE_MAP[draggedNode.type];
      if (fileType) {
        const entry = await fileOperation({
          type: 'Move',
          file_type: fileType,
          old_path: draggedNode.path,
          new_path: newPath
        }, expectedProjectSession);
        moved = true;
        if (!isCurrent()) return;
        // Table moves may choose a collision-free suffix. Use the committed
        // path returned by Rust rather than guessing it from the drop target.
        newPath = entry?.path ?? newPath;
        retargetItemAfterOperation(draggedNode.path, newPath);
        if (draggedNode.type !== 'folder') onFileRenamed?.(draggedNode.path, {
          ...draggedNode, id: newPath, path: newPath,
          name: newPath.split('/').pop()!, uuid: entry?.uuid ?? draggedNode.uuid
        });
        invalidateTableCatalog();
        window.dispatchEvent(new CustomEvent('devcel-table-loaded'));
      } else {
        return;
      }

      const entries: ProjectEntry[] = await getProjectEntries(expectedProjectSession);
      if (!isCurrent()) return;
      const fileNodes = buildFileTree(entries);
      setFiles(fileNodes);
      if (navigationVersion === getNavigationVersion()) {
        expandParentFolders(newPath, fileNodes);
      }
    } catch (error) {
      console.error('Failed to move:', error);
      if (isCurrent()) await appAlert(t(moved ? 'file.refreshFailed' : 'file.moveFailed', {error: localizeError(error)}));
    } finally {
      renamingPaths.current.delete(draggedNodeId);
    }
  };


  const handleCreateTable = async (parentNode: FileNode) => {
    const parentPath = parentNode.type === 'folder' ? parentNode.path : parentNode.path.split('/').slice(0, -1).join('/');
    const tableName = await promptForCreation('table');
    if (!tableName || !isCurrent()) return;
    await handleAddFile('table', tableName, parentPath);
  };

  const handleCreateFolder = async (parentNode: FileNode) => {
    const parentPath = parentNode.type === 'folder' ? parentNode.path : parentNode.path.split('/').slice(0, -1).join('/');
    const folderName = await promptForCreation('folder');
    if (!folderName || !isCurrent()) return;
    await createFile('Directory', `${parentPath ? `${parentPath}/` : ''}${folderName}`);
  };

  return {
    handleAddFile,
    handleAddFolder,
    handleDelete,
    handleBulkDelete,
    handleDuplicate,
    handleRename,
    handleMove,
    handleCreateTable,
    handleCreateFolder
  };
}
