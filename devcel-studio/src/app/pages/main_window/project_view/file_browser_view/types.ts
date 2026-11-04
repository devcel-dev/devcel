export interface FileNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'folder' | 'table' | 'project' | 'markdown' | 'interface';
  modified?: number; // Unix milliseconds; unavailable timestamps sort last
  uuid?: string; // UUID for interfaces
  children?: FileNode[];
}

export interface FileTreeProps {
  nodes: FileNode[];
  setNodes: (nodes: FileNode[]) => void;
  clipboard: FileNode | null;
  setClipboard: (node: FileNode | null) => void;
  projectPath: string;
  level?: number;
  selectedItems: Set<string>;
  handleItemSelect: (itemId: string, isCtrlPressed: boolean) => void;
  clearSelection: () => void;
  refreshProjectEntries: () => Promise<void>;
  findNodeById: (nodes: FileNode[], id: string) => FileNode | null;
  findNodeByIdInAllTrees: (id: string) => FileNode | null;
  expandedFolders: Set<string>;
  setExpandedFolders: (folders: Set<string>) => void;
  buildFileTree: (entries: any[]) => FileNode[];
  expandParentFolders: (targetPath: string, newNodes: FileNode[]) => void;
  selectItemAfterOperation: (targetPath: string, newNodes: FileNode[]) => void;
}

export interface FileNodeComponentProps extends FileTreeProps {
  node: FileNode;
  level: number;
  expanded: boolean;
  onToggle: () => void;
  allNodes: FileNode[];
} 