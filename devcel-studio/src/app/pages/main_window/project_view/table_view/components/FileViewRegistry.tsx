import type { AuthoritativeTableSnapshot } from '@/app/services/tableSnapshotCache';
import type { ReferenceNavigationRequest } from '../../referenceNavigation';
import { useI18n } from '@/app/i18n';
import React from 'react';
import { FileNode } from '../../file_browser_view/types';
import DataGridView from './DataGridView';
import { MarkdownView } from './MarkdownView';
import { InterfaceView } from './InterfaceView';

// Shared properties for file view components
export interface FileViewProps {
  currentItem: FileNode;
  projectSessionId: string;
  [key: string]: any; // Component-specific properties
}

// Default file view for unsupported file types
const DefaultFileView: React.FC<FileViewProps> = ({ currentItem }) => {
  const { t } = useI18n();
  return (
  <div className="flex items-center justify-center h-full">
    <p className="text-muted-foreground">
      {currentItem.type === 'file'
        ? t('grid.fileContentPlaceholder')
        : t('grid.unsupportedFileType', { type: currentItem.type })
      }
    </p>
  </div>
);
};

// Table view wrapper handling DataGridView properties
const TableViewWrapper: React.FC<FileViewProps & {
  projectSessionId: string;
  tableData?: any;
  preparedSnapshot?: AuthoritativeTableSnapshot;
  interactionLocked?: boolean;
  onAuthoritativeSnapshot?: (snapshot: AuthoritativeTableSnapshot) => void;
  versionEditMode?: boolean;
  onVersionEditModeChange?: (enabled: boolean) => void;
  versionPreview?: boolean;
  onVersionPreviewChange?: (enabled: boolean) => void;
  releaseVersion?: number;
  onReleaseVersionChange?: (version: number) => void;
  onDataChange?: (data: any) => void;
  onOpenReference?: (targetTableUuid: string, recordUuid: string) => void;
  referenceNavigation?: ReferenceNavigationRequest;
  onReferenceNavigationHandled?: (request: ReferenceNavigationRequest) => void;
}> = ({ currentItem, projectSessionId, tableData, preparedSnapshot, interactionLocked, onAuthoritativeSnapshot, versionEditMode, onVersionEditModeChange, versionPreview, onVersionPreviewChange, releaseVersion, onReleaseVersionChange, onDataChange, onOpenReference, referenceNavigation, onReferenceNavigationHandled }) => {
  const { t } = useI18n();
  if (!tableData) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="text-yellow-500 mb-4">{t('grid.noTableData')}</div>
        <p className="text-muted-foreground mb-4">{t('grid.loadTableDataPrompt')}</p>
      </div>
    );
  }

  // Extract the table name from currentItem, removing the extension
  const tableName = currentItem.name.replace(/\.table\.toml$/, '');

  return (
    <DataGridView
      projectSessionId={projectSessionId}
      tableData={tableData}
      preparedSnapshot={preparedSnapshot}
      interactionLocked={interactionLocked}
      onAuthoritativeSnapshot={onAuthoritativeSnapshot}
      tableName={tableName}
      versionEditMode={versionEditMode || false}
      onVersionEditModeChange={onVersionEditModeChange}
      versionPreview={versionPreview}
      onVersionPreviewChange={onVersionPreviewChange}
      releaseVersion={releaseVersion}
      onReleaseVersionChange={onReleaseVersionChange}
      onDataChange={onDataChange || (() => {})}
      onOpenReference={onOpenReference}
      referenceNavigation={referenceNavigation}
      onReferenceNavigationHandled={onReferenceNavigationHandled}
    />
  );
};

// MarkdownView wrapper converting FileViewProps to MarkdownViewProps
const MarkdownViewWrapper: React.FC<FileViewProps> = ({ currentItem, projectSessionId }) => {
  return (
    <MarkdownView
      expectedProjectSession={projectSessionId}
      filePath={currentItem.path}
      fileName={currentItem.name}
    />
  );
};

// InterfaceView wrapper converting FileViewProps to InterfaceViewProps
const InterfaceViewWrapper: React.FC<FileViewProps> = ({ currentItem, projectSessionId }) => {
  return (
    <InterfaceView
      expectedProjectSession={projectSessionId}
      filePath={currentItem.path}
      fileName={currentItem.name}
      interfaceUuid={currentItem.uuid || ''}
    />
  );
};

// Mapping from file types to view components
const FILE_VIEW_REGISTRY = {
  'table': TableViewWrapper,
  'markdown': MarkdownViewWrapper,
  'file': DefaultFileView,
  'project': DefaultFileView,
  'interface': InterfaceViewWrapper, // Interface file view
  'folder': DefaultFileView, // Folders normally do not open, but handle them defensively
} as const;

/**
 * Get the appropriate view component based on file type
 *
 * @param fileType - File type
 * @returns The corresponding view component
 */
export const getFileViewComponent = (fileType: FileNode['type']) => {
  return FILE_VIEW_REGISTRY[fileType] || DefaultFileView;
};

/**
 * Dynamically render a view component based on file type
 *
 * @param props - File view properties
 * @returns The rendered view component
 */
export const FileViewRenderer: React.FC<FileViewProps> = React.memo((props) => {
  const ViewComponent = getFileViewComponent(props.currentItem.type);
  return <ViewComponent {...props} />;
});

