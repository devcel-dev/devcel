import { useI18n, t } from '@/app/i18n';
import React, { useMemo, useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, File, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

// Base file item type
export interface FileItem {
  name: string;
  path: string;
  description?: string;
  metadata?: Record<string, any>;
}

// Tree node type
interface TreeNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children?: TreeNode[];
  fileData?: FileItem;
}

// Component properties
export interface FileSelectTreeViewProps<T extends FileItem = FileItem> {
  // Required properties
  items: T[];
  selectedItems: Set<string>;
  onToggleItem: (path: string) => void;
  
  // Optional properties
  height?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  fileIcon?: React.ComponentType<{ className?: string }>;
  renderBadges?: (item: T) => React.ReactNode;
  autoExpandThreshold?: number;
  showClearButton?: boolean;
  onClearAll?: () => void;
}

export function FileSelectTreeView<T extends FileItem = FileItem>({
  items,
  selectedItems,
  onToggleItem,
  height = '300px',
  searchPlaceholder = t('file.search'),
  emptyMessage = t('file.notFound'),
  fileIcon: FileIcon = File,
  renderBadges,
  autoExpandThreshold = 10,
  showClearButton = true,
  onClearAll,
}: FileSelectTreeViewProps<T>) {
  useI18n();
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Search filtering
  const filteredItems = useMemo(() => {
    if (!searchQuery) return items;
    
    const query = searchQuery.toLowerCase();
    return items.filter(
      item =>
        item.name.toLowerCase().includes(query) ||
        item.path.toLowerCase().includes(query) ||
        (item.description && item.description.toLowerCase().includes(query))
    );
  }, [items, searchQuery]);

  // Automatically expand everything when there are few items
  useEffect(() => {
    if (filteredItems.length <= autoExpandThreshold) {
      // Collect all folder paths
      const allFolderPaths = new Set<string>();
      filteredItems.forEach(item => {
        const normalizedPath = item.path.replace(/\\/g, '/');
        const pathParts = normalizedPath.split('/').filter(part => part !== '');
        for (let i = 0; i < pathParts.length - 1; i++) {
          allFolderPaths.add(pathParts.slice(0, i + 1).join('/'));
        }
      });
      setExpandedPaths(allFolderPaths);
    }
  }, [filteredItems, autoExpandThreshold]);

  // Build the tree structure from the item list
  const treeData = useMemo(() => {
    const root: TreeNode = {
      name: 'root',
      path: '',
      type: 'folder',
      children: [],
    };

    // Group items by path
    filteredItems.forEach((item) => {
      // Normalize path separators
      const normalizedPath = item.path.replace(/\\/g, '/');
      const pathParts = normalizedPath.split('/').filter(part => part !== '');
      let currentNode = root;

      // Build the directory structure
      for (let i = 0; i < pathParts.length - 1; i++) {
        const folderName = pathParts[i];
        const folderPath = pathParts.slice(0, i + 1).join('/');
        
        let folderNode = currentNode.children?.find(
          child => child.type === 'folder' && child.name === folderName
        );

        if (!folderNode) {
          folderNode = {
            name: folderName,
            path: folderPath,
            type: 'folder',
            children: [],
          };
          currentNode.children = currentNode.children || [];
          currentNode.children.push(folderNode);
        }

        currentNode = folderNode;
      }

      // Add a file node
      const fileNode: TreeNode = {
        name: item.name,
        path: item.path,
        type: 'file',
        fileData: item,
      };

      currentNode.children = currentNode.children || [];
      currentNode.children.push(fileNode);
    });

    // Sort each level
    const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
      return nodes.sort((a, b) => {
        // Folders first
        if (a.type !== b.type) {
          return a.type === 'folder' ? -1 : 1;
        }
        // Sort items of the same type by name
        return a.name.localeCompare(b.name);
      });
    };

    const sortTree = (node: TreeNode): TreeNode => {
      if (node.children) {
        node.children = sortNodes(node.children).map(child => sortTree(child));
      }
      return node;
    };

    sortTree(root);
    return root.children || [];
  }, [filteredItems]);

  const toggleExpanded = (path: string) => {
    setExpandedPaths(prev => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  const renderTreeNode = (node: TreeNode, level: number = 0) => {
    const isExpanded = expandedPaths.has(node.path);
    const paddingLeft = level * 16 + 4;

    if (node.type === 'folder') {
      return (
        <div key={node.path}>
          <div
            className="flex items-center py-1 px-2 hover:bg-accent rounded cursor-pointer"
            style={{ paddingLeft }}
            onClick={() => toggleExpanded(node.path)}
          >
            <button className="p-0 h-4 w-4 mr-1">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {isExpanded ? (
              <FolderOpen className="h-4 w-4 mr-2 text-muted-foreground" />
            ) : (
              <Folder className="h-4 w-4 mr-2 text-muted-foreground" />
            )}
            <span className="text-sm font-medium">{node.name}</span>
          </div>
          {isExpanded && node.children && (
            <div>
              {node.children.map(child => renderTreeNode(child, level + 1))}
            </div>
          )}
        </div>
      );
    }

    // File node
    const isSelected = selectedItems.has(node.path);
    return (
      <div
        key={node.path}
        className={cn(
          "flex items-center py-1 px-2 hover:bg-accent rounded cursor-pointer",
          isSelected && "bg-accent"
        )}
        style={{ paddingLeft }}
        onClick={() => onToggleItem(node.path)}
      >
        <Checkbox
          checked={isSelected}
          className="mr-2"
          onCheckedChange={() => onToggleItem(node.path)}
          onClick={(e) => e.stopPropagation()}
        />
        <FileIcon className="h-4 w-4 mr-2 text-muted-foreground" />
        <span className="text-sm flex-1">{node.name}</span>
        {node.fileData && renderBadges && (
          <div className="flex gap-1.5 ml-2">
            {renderBadges(node.fileData as T)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder={searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        {showClearButton && selectedItems.size > 0 && onClearAll && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearAll}
          >
            {t('file.clearSelection')}</Button>
        )}
      </div>
      
      <ScrollArea className="border rounded-lg p-2" style={{ height }}>
        <div className="space-y-1">
          {treeData.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              {emptyMessage}
            </div>
          ) : (
            treeData.map(node => renderTreeNode(node))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}