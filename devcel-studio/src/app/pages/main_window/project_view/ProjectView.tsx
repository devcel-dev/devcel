import { isSettingsEditor } from '@/app/applicationMode';
import type { ReferenceNavigationRequest } from './referenceNavigation';
import { t, localizeError } from '@/app/i18n';
import { flushMarkdownEdits } from '@/app/utils/markdownSaveLifecycle';
import { message } from '@/app/services/appDialogs';

import { normalizeTablePath } from '@/app/utils/DemandTableLoader';
import type { ProjectSession } from '@/app/commands/projectCommands';
import { listen } from '@tauri-apps/api/event';
// import { IMainWindowProps } from "@/app/pages/main_window/MainWindow";
import TableTabView, { type TableTabViewHandle } from "@/app/pages/main_window/project_view/table_view/TableTabView";
import { FileBrowserView, FileBrowserViewRef } from "@/app/pages/main_window/project_view/file_browser_view/FileBrowserView";
import { useState, useRef, useCallback, useEffect, useEffectEvent } from "react";
import { FileNode } from "@/app/pages/main_window/project_view/file_browser_view/types";
import { StatusBar } from "@/app/components/StatusBar";
import { P2PToastContainer } from "@/app/components/P2PToast";
import { PropertiesPanel } from "@/app/pages/main_window/project_view/properties_panel/PropertiesPanel";
import { DuplicateInterfaceDetector } from "@/app/components/interface/DuplicateInterfaceDetector";

function ProjectView({ projectSession }: { projectSession: ProjectSession }) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const tableTabViewRef = useRef<TableTabViewHandle>(null);
  const [tableTransitionPending, setTableTransitionPending] = useState(false);
  const [selectedItems, setSelectedItems] = useState<FileNode[]>([]);
  const fileBrowserRef = useRef<FileBrowserViewRef>(null);
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(300);
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const resizerRef = useRef<HTMLDivElement>(null);

  // UI visibility state
  const [showFileBrowser, setShowFileBrowser] = useState(true);
  const [showPropertiesPanel, setShowPropertiesPanel] = useState(false);
  const [activeFileNode, setActiveFileNode] = useState<FileNode | null>(null);
  const [requestedTab, setRequestedTab] = useState<{ id: string } | null>(null);
  const [referenceNavigation, setReferenceNavigation] = useState<ReferenceNavigationRequest | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsResizing(true);
    e.preventDefault();
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing) return;

    const container = resizerRef.current?.parentElement;
    if (container) {
      const containerRect = container.getBoundingClientRect();
      const newWidth = e.clientX - containerRect.left;
      const minWidth = 200;
      const maxWidth = containerRect.width - 200;

      setLeftPanelWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
    }
  }, [isResizing]);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Global mouse events for resizing
  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  // Listen for menu events
  useEffect(() => {
    const handleToggleFileBrowser = () => {
      setShowFileBrowser(prev => !prev);
    };

    const handleTogglePropertiesPanel = () => {
      setShowPropertiesPanel(prev => !prev);
    };

    window.addEventListener('devcel-toggle-file-browser', handleToggleFileBrowser);
    window.addEventListener('devcel-toggle-properties-panel', handleTogglePropertiesPanel);

    return () => {
      window.removeEventListener('devcel-toggle-file-browser', handleToggleFileBrowser);
      window.removeEventListener('devcel-toggle-properties-panel', handleTogglePropertiesPanel);
    };
  }, []);

  const navigationRequest = useRef(0);
  const onNavigate = () => { ++navigationRequest.current; tableTabViewRef.current?.cancelPendingActivation(); setReferenceNavigation(null); };
  const getNavigationVersion = () => navigationRequest.current;
  const handleFileSelect = useCallback(async (file: FileNode, reference?: ReferenceNavigationRequest, preserveSidebarSelection = false) => {
    const request = reference?.id ?? ++navigationRequest.current;
    tableTabViewRef.current?.cancelPendingActivation();
    if (!reference) setReferenceNavigation(null);
    try { await flushMarkdownEdits(projectSession.id); }
    catch (error) { await message(t('project.saveFailed', { error: localizeError(error) }), { kind: 'error' }); return false; }
    if (!mounted.current || request !== navigationRequest.current) return false;
    if (!await tableTabViewRef.current?.prepareActivation(file, { revealInTree: !preserveSidebarSelection })) return false;
    if (!mounted.current || request !== navigationRequest.current) return false;
    setRequestedTab({ id: file.id });
    setReferenceNavigation(reference ?? null);
    // Manage all file types in one array
    if (file.type === 'file' || file.type === 'table' || file.type === 'markdown' || file.type === 'interface') {
      setSelectedItems(prev => {
        const existingIndex = prev.findIndex(item => item.id === file.id);
        if (existingIndex !== -1) {
          // Move an existing item to the front
          const newItems = [...prev];
          newItems.splice(existingIndex, 1);
          return [file, ...newItems];
        }
        // Add a new item at the front
        return [file, ...prev];
      });
    }
    return true;
  }, [projectSession.id]);

  // One real catalog read per settings-project mount, shared across StrictMode's
  // effect replay. User navigation or unmount always wins over this convenience.
  const initialSettingsTable = useRef<{ session: string; lookup: Promise<{ path: string; uuid: string; data_name: string }[]> } | null>(null);
  useEffect(() => {
    if (!isSettingsEditor()) return;
    let cancelled = false;
    const navigation = navigationRequest.current;
    if (initialSettingsTable.current?.session !== projectSession.id) {
      initialSettingsTable.current = { session: projectSession.id, lookup: import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke<{ path: string; uuid: string; data_name: string }[]>('get_table_catalog', { expectedProjectSession: projectSession.id })) };
    }
    void initialSettingsTable.current.lookup.then(async tables => {
      if (cancelled || !mounted.current || navigationRequest.current !== navigation) return;
      const matches = tables.filter(table => table.data_name === 'UserSettings');
      if (matches.length !== 1) return;
      const table = matches[0];
      const path = normalizeTablePath(table.path, projectSession.path);
      if (!path || !table.uuid) return;
      await handleFileSelect({ id: path, path, name: path.split('/').pop() || path, type: 'table', uuid: table.uuid });
    }).catch(error => {
      // A broken/missing settings table must leave the ordinary tree available for repair.
      if (!cancelled) console.warn('Could not select the settings table:', localizeError(error));
    });
    return () => { cancelled = true; };
  }, [projectSession.id, projectSession.path, handleFileSelect]);

  useEffect(() => {
    const subscription = listen<{uuid:string; path:string; name:string; projectSession:string}>('devcel-open-interface', event => {
      if (event.payload.projectSession !== projectSession.id) return;
      if (!mounted.current) return;
      const item = event.payload;
      void handleFileSelect({id:item.path, path:item.path, name:item.path.split('/').pop() || item.name, type:'interface', uuid:item.uuid}).then(selected => {
        if (selected && mounted.current) setRequestedTab({ id: item.path });
      });
    });
    return () => { void subscription.then(unlisten => unlisten()); };
  }, [projectSession.id, handleFileSelect]);

  const handleActiveItemChange = (file: FileNode | null, revealInTree = true) => {
    setActiveFileNode(file);
    if (file) setSelectedItems(items => {
      const index = items.findIndex(item => item.id === file.id || file.uuid && item.type === file.type && item.uuid === file.uuid);
      return index < 0 ? [...items, file] : items.map((item, itemIndex) => itemIndex === index ? file : item);
    });
    // Sidebar selection already includes Ctrl/Shift state; only explicit tab
    // and reference navigation collapse/reveal it after the display commits.
    if (revealInTree) fileBrowserRef.current?.selectFileInTree(file?.id ?? null);
  };

  // A hidden sidebar remounts with an empty tree selection. Restore the visible tab.
  const revealActiveFile = useEffectEvent(() => fileBrowserRef.current?.selectFileInTree(activeFileNode?.id ?? null));
  useEffect(() => {
    if (showFileBrowser) revealActiveFile();
  }, [showFileBrowser]);

  const handleTabRemove = (itemId: string) => {
    onNavigate();
    setSelectedItems(prev => prev.filter(item => item.id !== itemId));
    setActiveFileNode(current => current?.id === itemId ? null : current);
  };

  const handleFileRenamed = (oldPath: string, newFile: FileNode) => {
    tableTabViewRef.current?.cancelPendingActivation(oldPath);
    tableTabViewRef.current?.retargetHistory(oldPath, newFile);
    // Keep tab order and active identity, including descendants of a renamed folder.
    const retarget = (item: FileNode): FileNode => {
      if (item.id === oldPath) return newFile;
      if (newFile.type === 'folder' && item.path.startsWith(`${oldPath}/`)) {
        const path = `${newFile.path}${item.path.slice(oldPath.length)}`;
        return { ...item, id: path, path };
      }
      return item;
    };
    setSelectedItems(prev => prev.map(retarget));
    setActiveFileNode(prev => prev ? retarget(prev) : prev);
    setRequestedTab(prev => prev?.id === oldPath || newFile.type === 'folder' && prev?.id.startsWith(`${oldPath}/`) ? null : prev);
  };

  const handleOpenTableWithRecord = async (tableUuid: string, recordUuid = '') => {
    const request = ++navigationRequest.current;
    tableTabViewRef.current?.cancelPendingActivation();
    setReferenceNavigation(null);
    const live = () => mounted.current && request === navigationRequest.current;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (!live()) return;
      const tablePath = await invoke<string>('get_table_path_by_uuid', { tableUuid, expectedProjectSession: projectSession.id });
      if (!live()) return;
      if (!tablePath) {
        await message(t('grid.loading.referenceNotFound'), { kind: 'error' });
        return;
      }

      const relativePath = normalizeTablePath(tablePath, projectSession.path);
      const fileNode: FileNode = {
        id: relativePath,
        path: relativePath,
        name: relativePath.split('/').pop() || '',
        type: 'table',
        uuid: tableUuid
      };
      const selected = await handleFileSelect(fileNode, {
        id: request, projectSessionId: projectSession.id, tableUuid, recordUuid
      });
      if (!selected || !live()) return;
      fileBrowserRef.current?.selectFileInTree(fileNode.id);
    } catch (error) {
      if (live()) await message(localizeError(error), { kind: 'error' });
    }
  };

  const handleReferenceNavigationHandled = useCallback((request: ReferenceNavigationRequest) => {
    setReferenceNavigation(current => current === request ? null : current);
  }, []);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      overflow: 'hidden'
    }}>
      {/* Automatically detect conflict copies of the same interface and guide users through merging */}
      <DuplicateInterfaceDetector key={projectSession.id} expectedProjectSession={projectSession.id} />

      {/* Main content area */}
      <div style={{
        display: 'flex',
        flex: 1,
        width: '100%',
        overflow: 'hidden'
      }}>
        {/* Left: File browser */}
        {showFileBrowser && (
          <div style={{
            width: `${leftPanelWidth}px`,
            minWidth: '200px',
            maxWidth: 'calc(100% - 200px)',
            height: '100%',
            overflow: 'hidden'
          }}>
            <FileBrowserView
              projectSession={projectSession}
              ref={fileBrowserRef}
              onFileSelect={file => handleFileSelect(file, undefined, true)}
              getNavigationVersion={getNavigationVersion}
              onNavigate={onNavigate}
              onFileRenamed={handleFileRenamed}
            />
          </div>
        )}

        {/* Resizer */}
        {showFileBrowser && (
          <div
            ref={resizerRef}
            onMouseDown={handleMouseDown}
            style={{
              width: '6px',
              height: '100%',
              backgroundColor: 'var(--border)',
              cursor: 'col-resize',
              flexShrink: 0,
              borderLeft: '1px solid var(--border)',
              borderRight: '1px solid var(--border)'
            }}
          />
        )}

        {/* Center: Table tabs */}
        <div style={{
          flex: 1,
          height: '100%',
          overflow: 'hidden'
        }}>
          <TableTabView
            ref={tableTabViewRef}
            onTransitionChange={setTableTransitionPending}
            onTabMove={(from, to) => setSelectedItems(items => {
              const next = [...items]; const [item] = next.splice(from, 1);
              if (item) next.splice(to, 0, item); return next;
            })}
            projectSession={projectSession}
            selectedItems={selectedItems}
            requestedTab={requestedTab}
            referenceNavigation={referenceNavigation}
            onReferenceNavigationHandled={handleReferenceNavigationHandled}
            onNavigate={onNavigate}
            getNavigationVersion={getNavigationVersion}
            onActiveItemChange={handleActiveItemChange}
            onTabRemove={handleTabRemove}
            onOpenTable={handleOpenTableWithRecord}
          />
        </div>

        {/* Right: Properties panel */}
        {showPropertiesPanel && (
          <div inert={tableTransitionPending} aria-busy={tableTransitionPending} style={{
            width: '250px',
            height: '100%',
            overflow: 'hidden',
            borderLeft: '1px solid var(--border)'
          }}>
            <PropertiesPanel selectedItem={activeFileNode} onClose={() => setShowPropertiesPanel(false)} />
          </div>
        )}
      </div>

      {/* Status bar */}
      <StatusBar projectSession={projectSession} />

      {/* P2P toast notification container */}
      {!isSettingsEditor() && <P2PToastContainer />}
    </div>
  );
}

export default ProjectView;
