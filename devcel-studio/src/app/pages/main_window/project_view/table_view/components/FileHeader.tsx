import React from 'react';
import { FileText, Table2, FileType } from 'lucide-react';
import { FileNode } from '../../file_browser_view/types';

interface FileHeaderProps {
  /** File item to display */
  currentItem: FileNode;
  /** Custom control elements added on the right */
  children?: React.ReactNode;
}

// Shared title display function, exported for reuse
export const getDisplayTitle = (item: FileNode) => {
  switch (item.type) {
    case 'table':
      return item.name.replace('.table.toml', '');
    case 'markdown':
      return item.name.replace('.md', '');
    case 'project':
      return item.name.replace('.devcelproj.toml', '');
    default:
      return item.name;
  }
};

// Icon lookup function
const getFileIcon = (item: FileNode) => {
  switch (item.type) {
    case 'file':
      return <FileText className="w-5 h-5 text-purple-600" />;
    case 'markdown':
      return <FileType className="w-5 h-5 text-orange-600" />;
    case 'table':
      return <Table2 className="w-5 h-5 text-green-600" />;
    default:
      return <FileText className="w-5 h-5 text-muted-foreground" />;
  }
};

/** Shared file heading. Keep table operations together in the toolbar. */
export const FileHeader: React.FC<FileHeaderProps> = ({ 
  currentItem, 
  children 
}) => {
  return (
    <div className="flex items-center justify-between border-b border-border min-h-[60px]">
      <div className="flex items-center gap-2 px-3 pt-4 pb-3">
        {getFileIcon(currentItem)}
        <h3 className="text-xl font-semibold text-foreground leading-none">
          {getDisplayTitle(currentItem)}
        </h3>
      </div>
      
      {children && <div className="flex items-center justify-end px-3 pt-4 pb-3">{children}</div>}
    </div>
  );
};
