import { isComposingKey, isTextInputTarget, isModalTarget, hasBlockingShortcutSurface } from '@/app/utils/shortcutGuards';
import { createNavigationQueue } from './navigationQueue';
import { isSettingsEditor } from '@/app/applicationMode';
import { getTableSnapshotInvalidationVersion, retainTableSnapshotInvalidation } from '@/app/services/tableSnapshotInvalidation';
import type { ReferenceNavigationRequest } from '../referenceNavigation';
import { flushMarkdownEdits } from '@/app/utils/markdownSaveLifecycle';
import { requestCloseStringEditor } from '@/app/utils/string_editor_window';
import { message } from '@/app/services/appDialogs';

import { appAlert } from '@/app/services/appDialogs';
import { toAppError, useI18n, t, localizeError, localizedError, message as localizedMessage } from '@/app/i18n';
import { useState, useEffect, useEffectEvent, useLayoutEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import { getProjectEntries, type ProjectSession } from '@/app/commands/projectCommands';
import { loadTable, isTableLoadingSessionCurrent, type TableReference } from '@/app/commands/tableCommands';
import { normalizeTablePath } from '@/app/utils/DemandTableLoader';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useDrag, useDrop, DragSourceMonitor, DropTargetMonitor } from 'react-dnd';
import type { FileNode } from '../file_browser_view/types';
import type { TableData } from '@/app/types/tableTypes';
import { X, FileText, Table2, AlertCircle, FileType, ArrowLeft, ArrowRight } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { FileHeader, getDisplayTitle } from './components/FileHeader';
import { FileViewRenderer } from './components/FileViewRegistry';
import { PluginManager } from '@/app/services/PluginManager';
import { getTableSnapshot, rememberTableSnapshot, forgetTableSnapshot, clearTableSnapshots, requestTableSnapshot,
  type AuthoritativeTableSnapshot, type TableSnapshotRequest } from '@/app/services/tableSnapshotCache';
import { setTableInteractionTarget, tableEditorsAllowNavigation } from '@/app/services/tableInteractionScope';
import { commitNavigation, emptyNavigationHistory, navigationTarget, reconcileNavigationHistory, retargetNavigationHistory, type NavigationHistory } from './navigationHistory';

export interface TableTabViewHandle { prepareActivation: (item: FileNode, options?: { revealInTree?: boolean }) => Promise<boolean>; cancelPendingActivation: (itemId?: string) => void; retargetHistory: (oldPath: string, next: FileNode) => void }
interface TableTabViewProps {
  projectSession: ProjectSession;
  selectedItems?: FileNode[];
  requestedTab?: { id: string } | null;
  onNavigate?: () => void;
  getNavigationVersion?: () => number;
  onActiveItemChange?: (file: FileNode | null, revealInTree?: boolean) => void;
  onTransitionChange?: (pending: boolean) => void;
  referenceNavigation?: ReferenceNavigationRequest | null;
  onReferenceNavigationHandled?: (request: ReferenceNavigationRequest) => void;
  onTabRemove?: (itemId: string) => void;
  onTabMove?: (from: number, to: number) => void;
  onOpenTable?: (tableUuid: string, recordUuid?: string) => void;
}

interface TableTabItemProps {
  tab: string;
  index: number;
  currentItem: FileNode | undefined;
  isActive: boolean;
  onActivate: () => void;
  onRemove: (event: React.MouseEvent) => void;
  onMove: (dragIndex: number, hoverIndex: number) => void;
}

// Stable component type: parent snapshots must not detach a pressed tab's DOM.
function TableTabItem({ tab, index, currentItem, isActive, onActivate, onRemove, onMove }: TableTabItemProps) {
  useI18n();
    const isFileTab = currentItem?.type === 'file';
    const isMarkdownTab = currentItem?.type === 'markdown';

    const [{ isDragging }, dragSource] = useDrag({
      type: "TAB",
      item: { index },
      collect: (monitor: DragSourceMonitor) => ({
        isDragging: monitor.isDragging(),
      }),
      end: (_item: { index: number }, _monitor: DragSourceMonitor) => {
        // setShowDropArea(false);
      },
    });

    const [{ isOver }, dropTarget] = useDrop({
      accept: "TAB",
      hover: (item: { index: number }) => {
        if (item.index !== index) {
          onMove(item.index, index);
          item.index = index;
        }
      },
      drop: (_item: { index: number }) => {
      },
      collect: (monitor: DropTargetMonitor) => ({
        isOver: monitor.isOver(),
      }),
    });

    // Use callback ref with proper type checking
    const setTabRef = useCallback((element: HTMLDivElement | null) => {
      if (element) {
        dragSource(element);
        dropTarget(element);
      }
    }, [dragSource, dropTarget]);

    return (
      <div
        ref={setTabRef}
        className={`
              group flex items-center gap-2 px-3 py-1.5 cursor-pointer
              border-b-2 transition-all duration-200
              ${isActive
            ? 'bg-background border-primary text-primary shadow-sm'
            : 'bg-muted border-transparent text-muted-foreground hover:bg-muted hover:text-foreground'
          }
              ${isDragging ? 'opacity-50' : ''}
              ${isOver ? 'border-primary' : ''}
            `}
        onClick={onActivate}
      >
        {isFileTab ? (
          <FileText className="w-4 h-4 text-purple-600" />
        ) : isMarkdownTab ? (
          <FileType className="w-4 h-4 text-orange-600" />
        ) : (
          <Table2 className="w-4 h-4 text-green-600" />
        )}
        <span className="text-sm font-medium max-w-[150px] truncate leading-none select-none">
          {currentItem ? getDisplayTitle(currentItem) : tab}
        </span>
        <button
          onClick={onRemove}
          className={`
                ml-auto opacity-0 group-hover:opacity-100 transition-opacity
                hover:bg-muted rounded p-0.5
                ${isActive ? 'opacity-60' : ''}
              `}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
}

interface InitializationRequest { item: FileNode; historyIndex?: number; projectSessionId: string; generation: number }
interface DisplayedItem { item: FileNode; table?: TableData; snapshot?: AuthoritativeTableSnapshot }
interface ActivationOwner {
  generation: number; item: FileNode; authorityClosed: boolean; request: TableSnapshotRequest | null; promise: Promise<boolean>;
}

const TableTabView = forwardRef<TableTabViewHandle, TableTabViewProps>(function TableTabView({
  projectSession, selectedItems = [], requestedTab, referenceNavigation, onReferenceNavigationHandled,
  onNavigate, getNavigationVersion, onActiveItemChange, onTransitionChange, onTabRemove, onTabMove, onOpenTable
}, ref) {
  useI18n();
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [displayed, setDisplayed] = useState<DisplayedItem | null>(null);
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;
  const [pendingItem, setPendingItem] = useState<FileNode | null>(null);
  const [failure, setFailure] = useState<{ item: FileNode; error: unknown; historyIndex?: number } | null>(null);
  const [showInitDialog, setShowInitDialog] = useState<InitializationRequest | null>(null);
  const initializationPending = useRef(false);
  const initializationCancel = useRef<HTMLButtonElement>(null);
  const [versionEditMode, setVersionEditMode] = useState(false);
  const [versionPreview, setVersionPreview] = useState(false);
  const [releaseVersion, setReleaseVersion] = useState(0);
  const handleVersionEditModeChange = useCallback((enabled: boolean) => {
    setVersionEditMode(enabled); if (!enabled) setVersionPreview(false);
  }, []);
  const mounted = useRef(false);
  const sessionIdentity = useRef(projectSession.id);
  sessionIdentity.current = projectSession.id;
  const selectedItemsRef = useRef(selectedItems);
  selectedItemsRef.current = selectedItems;
  const [navigationHistory, setNavigationHistory] = useState<NavigationHistory>(emptyNavigationHistory);
  const historyRef = useRef(navigationHistory);
  const updateNavigationHistory = useCallback((next: NavigationHistory) => {
    historyRef.current = next; setNavigationHistory(next);
  }, []);
  const tabQueue = useRef(createNavigationQueue());
  const tabStrip = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const activation = useRef<ActivationOwner | null>(null);
  const callbacks = useRef({ onActiveItemChange, onTransitionChange, onOpenTable });
  useLayoutEffect(() => { callbacks.current = { onActiveItemChange, onTransitionChange, onOpenTable }; },
    [onActiveItemChange, onTransitionChange, onOpenTable]);
  const liveSession = useCallback(() => mounted.current && sessionIdentity.current === projectSession.id
    && isTableLoadingSessionCurrent(projectSession.id), [projectSession.id]);
  const restoreDisplayedAuthority = useCallback(() => {
    const previous = displayedRef.current;
    setPendingItem(null);
    setRequestedId(previous?.item.id ?? null);
    setTableInteractionTarget(projectSession.id, previous?.table?.uuid ?? null);
    if (!isSettingsEditor()) PluginManager.getInstance().setActiveTable(previous?.table
      ? { uuid: previous.table.uuid, projectSession: projectSession.id } : null);
    callbacks.current.onTransitionChange?.(false);
  }, [projectSession.id]);
  const cancelActivation = useCallback(() => {
    tabQueue.current.cancel();
    generation.current += 1;
    const previous = activation.current;
    previous?.request?.cancel();
    activation.current = null;
    if (previous?.authorityClosed) restoreDisplayedAuthority();
  }, [restoreDisplayedAuthority]);
  const prepareActivation = useCallback((item: FileNode, options?: { revealInTree?: boolean; historyIndex?: number; queuedTab?: boolean }): Promise<boolean> => {
    if (!options?.queuedTab) tabQueue.current.cancel();
    const previous = activation.current;
    if (previous?.item.id === item.id && previous.item.uuid === item.uuid) return previous.promise;
    previous?.request?.cancel();
    if (previous?.authorityClosed) restoreDisplayedAuthority();
    // Reserve before awaiting editor saves: the newest request must win even
    // when an older settings save resolves last. Keep its authority until saved.
    const ticket = ++generation.current;
    setShowInitDialog(null);
    const owner: ActivationOwner = { generation: ticket, item, authorityClosed: false, request: null, promise: Promise.resolve(false) };
    activation.current = owner;
    const live = () => liveSession() && generation.current === ticket && activation.current === owner;
    owner.promise = (async () => {
      try {
        if (!await tableEditorsAllowNavigation() || !live()) {
          if (live()) activation.current = null;
          return false;
        }
        owner.authorityClosed = true;
        setTableInteractionTarget(projectSession.id, null, true);
        if (!isSettingsEditor()) PluginManager.getInstance().setActiveTable(null);
        setPendingItem(item); setRequestedId(item.id); setFailure(null);
        callbacks.current.onTransitionChange?.(true);
        // The independent String window keeps its one-cell draft until its
        // existing close decision succeeds. It cannot write behind a new target.
        if (!await requestCloseStringEditor() || !live()) {
          if (live()) { activation.current = null; restoreDisplayedAuthority(); }
          return false;
        }
        let next: DisplayedItem = { item };
        if (item.type === 'table') {
          const loaded = loadTable(item.path, projectSession.id).then(result => {
            if (result !== 'ok') throw localizedError(localizedMessage('grid.snapshotInvalid'));
          });
          const identified = loaded.then(async () => {
            if (!live()) throw localizedError(localizedMessage('grid.snapshotChanged'));
            const catalog = await invoke<TableReference[]>('get_table_list', { expectedProjectSession: projectSession.id });
            if (!live()) throw localizedError(localizedMessage('grid.snapshotChanged'));
            const path = normalizeTablePath(item.path, projectSession.path);
            const uuid = catalog.find(table => normalizeTablePath(table.path, projectSession.path) === path)?.uuid;
            // A reused/moved path must not activate a previously cached UUID.
            if (!uuid || (item.uuid && uuid !== item.uuid)) throw new Error(t('file.tableUuidMissing'));
            return uuid;
          });
          const uuid = item.uuid ?? await identified;
          if (!live()) return false;
          let known = getTableSnapshot(projectSession.id, uuid);
          let synchronize: Promise<unknown> = identified.then(resolved => {
            if (!live()) throw localizedError(localizedMessage('grid.snapshotChanged'));
            return invoke('check_and_apply_interface_updates', { uuid: resolved, expectedProjectSession: projectSession.id });
          });
          // Native reservation and interface synchronization start before the old
          // grid is removed. Only their authoritative result replaces its UUID.
          let snapshot: AuthoritativeTableSnapshot;
          while (true) {
            owner.request = requestTableSnapshot(uuid, projectSession.id, known, synchronize, error => {
              if (liveSession() && generation.current === ticket) setFailure({ item, error, historyIndex: options?.historyIndex });
            });
            snapshot = await owner.request.promise;
            if (!live() || (item.uuid && snapshot.tableUuid !== item.uuid)) return false;
            if (snapshot.invalidationVersion === getTableSnapshotInvalidationVersion(projectSession.id)) break;
            // A dependency notification received by the old view cannot be lost
            // while the new view's seed is still in transit. Keep the old grid.
            known = snapshot;
            synchronize = invoke('check_and_apply_interface_updates', { uuid, expectedProjectSession: projectSession.id });
          }
          rememberTableSnapshot(snapshot);
          next = { item: { ...item, uuid: snapshot.tableUuid }, table: snapshot.table, snapshot };
        }
        if (!live()) return false;
        activation.current = null;
        displayedRef.current = next;
        setDisplayed(current => current?.item.id === next.item.id && current.item.name === next.item.name
          && current.table === next.table && current.snapshot?.presentation === next.snapshot?.presentation
          ? current : next);
        setPendingItem(null);
        setTableInteractionTarget(projectSession.id, next.table?.uuid ?? null);
        if (!isSettingsEditor()) PluginManager.getInstance().setActiveTable(next.table
          ? { uuid: next.table.uuid, projectSession: projectSession.id } : null);
        updateNavigationHistory(commitNavigation(historyRef.current, next.item, options?.historyIndex));
        callbacks.current.onTransitionChange?.(false);
        callbacks.current.onActiveItemChange?.(next.item, options?.revealInTree !== false);
        return true;
      } catch (error) {
        if (!live()) return false;
        const appError = toAppError(error);
        if (appError.kind === 'code' && ['error.parse', 'error.emptyTable'].includes(appError.code)) setShowInitDialog({ item: { ...item }, historyIndex: options?.historyIndex, projectSessionId: projectSession.id, generation: ticket });
        else setFailure({ item, error, historyIndex: options?.historyIndex });
        activation.current = null;
        if (owner.authorityClosed) restoreDisplayedAuthority();
        return false;
      } finally { owner.request?.cancel(); }
    })();
    return owner.promise;
  }, [projectSession.id, projectSession.path, liveSession, restoreDisplayedAuthority, updateNavigationHistory]);
  useImperativeHandle(ref, () => ({ prepareActivation, cancelPendingActivation: (itemId?: string) => {
    if (activation.current && (!itemId || activation.current.item.id === itemId)) cancelActivation();
  }, retargetHistory: (oldPath, next) => {
    if (activation.current) cancelActivation();
    updateNavigationHistory(retargetNavigationHistory(historyRef.current, oldPath, next));
    const current = displayedRef.current?.item;
    if (current && (current.path === oldPath || (next.type === 'folder' && current.path.startsWith(`${oldPath}/`)))) {
      const renamed = retargetNavigationHistory({ entries: [current], index: 0 }, oldPath, next).entries[0];
      if (renamed) void prepareActivation(renamed, { revealInTree: false });
    }
  } }), [prepareActivation, cancelActivation, updateNavigationHistory]);
  useEffect(() => {
    const queue = tabQueue.current;
    mounted.current = true;
    updateNavigationHistory(emptyNavigationHistory());
    displayedRef.current = null; setDisplayed(null); setRequestedId(null);
    setPendingItem(null); setFailure(null); setShowInitDialog(null);
    const invalidation = retainTableSnapshotInvalidation(projectSession.id);
    setTableInteractionTarget(projectSession.id, null);
    return () => {
      queue.cancel();
      mounted.current = false; generation.current += 1;
      activation.current?.request?.cancel(); activation.current = null;
      invalidation.release();
      clearTableSnapshots(projectSession.id);
      setTableInteractionTarget(projectSession.id, null);
      if (!isSettingsEditor()) PluginManager.getInstance().setActiveTable(null);
    };
  }, [projectSession.id, updateNavigationHistory]);

  const consumedRequest = useRef<typeof requestedTab>(null);
  useEffect(() => {
    if (!liveSession() || !requestedTab || consumedRequest.current === requestedTab) return;
    consumedRequest.current = requestedTab;
    const target = selectedItems.find(item => item.id === requestedTab.id);
    if (target && !activation.current && displayedRef.current?.item.id !== target.id) void prepareActivation(target);
  }, [requestedTab, selectedItems, prepareActivation, liveSession]);
  useEffect(() => {
    if (!liveSession() || activation.current) return;
    const current = displayedRef.current;
    if (!selectedItems.length) {
      if (current) {
        displayedRef.current = null; setDisplayed(null); setRequestedId(null);
        setTableInteractionTarget(projectSession.id, null); if (!isSettingsEditor()) PluginManager.getInstance().setActiveTable(null);
        callbacks.current.onActiveItemChange?.(null);
      }
      return;
    }
    const owner = current && selectedItems.find(item => item.id === current.item.id
      && (!item.uuid || item.uuid === current.table?.uuid || item.uuid === current.item.uuid));
    if (!owner) {
      const relocated = current?.item.uuid && selectedItems.find(item => item.uuid === current.item.uuid);
      void prepareActivation(relocated || selectedItems[0], { revealInTree: !relocated });
    } else if (owner.name !== current!.item.name || owner.path !== current!.item.path) {
      void prepareActivation(owner, { revealInTree: false });
    }
  }, [selectedItems, prepareActivation, liveSession, projectSession.id]);
  const knownOpenUuids = useRef(new Set<string>());
  useEffect(() => {
    const next = new Set(selectedItems.filter(item => item.type === 'table' && item.uuid).map(item => item.uuid!));
    for (const uuid of knownOpenUuids.current) if (!next.has(uuid)) forgetTableSnapshot(projectSession.id, uuid);
    knownOpenUuids.current = next;
  }, [selectedItems, projectSession.id]);

  const onAuthoritativeSnapshot = useCallback((snapshot: AuthoritativeTableSnapshot) => {
    if (!liveSession() || snapshot.projectSessionId !== projectSession.id) return;
    rememberTableSnapshot(snapshot);
    if (activation.current?.authorityClosed || displayedRef.current?.table?.uuid !== snapshot.tableUuid) return;
    const next = { ...displayedRef.current, table: snapshot.table, snapshot };
    displayedRef.current = next;
    setDisplayed(previous => previous?.table === snapshot.table && previous.snapshot?.presentation === snapshot.presentation
      ? previous : next);
  }, [projectSession.id, liveSession]);
  const onDataChange = useCallback((table: TableData) => {
    const current = displayedRef.current;
    if (!liveSession() || activation.current?.authorityClosed || current?.table?.uuid !== table.uuid || current.table === table) return;
    forgetTableSnapshot(projectSession.id, table.uuid);
    const next = { ...current, table, snapshot: undefined };
    displayedRef.current = next; setDisplayed(next);
  }, [projectSession.id, liveSession]);
  const handleOpenReference = useCallback((tableUuid: string, recordUuid: string) => {
    if (!liveSession() || activation.current) return;
    callbacks.current.onOpenTable?.(tableUuid, recordUuid);
  }, [liveSession]);

  // Interface history stays here. Table menu history is owned by DataGrid's same
  // mutation gate as keyboard history, including warning and transition locks.
  useEffect(() => {
    const history = async (redo: boolean) => {
      const item = displayedRef.current?.item;
      if (!liveSession() || activation.current || item?.type !== 'interface' || !item.uuid) return;
      try { await invoke(redo ? 'redo_interface_command' : 'undo_interface_command',
        { interfaceUuid: item.uuid, expectedProjectSession: projectSession.id }); }
      catch (error) { await appAlert(localizeError(error)); }
    };
    const undo = () => { void history(false); }; const redo = () => { void history(true); };
    const key = (event: KeyboardEvent) => {
      if (displayedRef.current?.item.type !== 'interface' || activation.current || event.defaultPrevented
        || isComposingKey(event) || event.repeat || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      if (isTextInputTarget(event.target) || isModalTarget(event.target) || hasBlockingShortcutSurface()) return;
      const value = event.key.toLowerCase();
      if (value === 'z' || value === 'y') { event.preventDefault(); void history(value === 'y' || event.shiftKey); }
    };
    window.addEventListener('devcel-undo', undo); window.addEventListener('devcel-redo', redo); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('devcel-undo', undo); window.removeEventListener('devcel-redo', redo); window.removeEventListener('keydown', key); };
  }, [projectSession.id, liveSession]);

  const navigationTicket = useRef(0);
  const navigateTab = async (item: FileNode) => {
    tabQueue.current.cancel();
    onNavigate?.(); const ticket = ++navigationTicket.current;
    const navigation = getNavigationVersion?.();
    try { await flushMarkdownEdits(projectSession.id); }
    catch (error) { await message(t('project.saveFailed', { error: localizeError(error) }), { kind: 'error' }); return; }
    if (!liveSession() || ticket !== navigationTicket.current || navigation !== getNavigationVersion?.()) return;
    await prepareActivation(item);
  };
  const navigateHistory = useCallback(async (direction: -1 | 1) => {
    tabQueue.current.cancel();
    if (navigationTarget(historyRef.current, direction, displayedRef.current?.item) === null) return;
    onNavigate?.();
    const ticket = ++navigationTicket.current;
    const navigation = getNavigationVersion?.();
    const live = () => liveSession() && ticket === navigationTicket.current && navigation === getNavigationVersion?.();
    try { await flushMarkdownEdits(projectSession.id); }
    catch (error) { await message(t('project.saveFailed', { error: localizeError(error) }), { kind: 'error' }); return; }
    if (!live()) return;
    try {
      const [entries, tables] = await Promise.all([getProjectEntries(projectSession.id),
        invoke<TableReference[]>('get_table_catalog', { expectedProjectSession: projectSession.id })]);
      if (!live()) return;
      const normalizedEntries = entries.map(entry => ({ ...entry, path: normalizeTablePath(entry.path, projectSession.path) }));
      const normalizedTables = tables.map(table => ({ ...table, path: normalizeTablePath(table.path, projectSession.path) }));
      const history = reconcileNavigationHistory(historyRef.current, normalizedEntries, normalizedTables);
      updateNavigationHistory(history);
      const index = navigationTarget(history, direction, displayedRef.current?.item);
      if (index !== null) await prepareActivation(history.entries[index]!, { historyIndex: index });
    } catch (error) {
      if (live()) await message(t('file.loadTableFailed') + ': ' + localizeError(error), { kind: 'error' });
    }
  }, [onNavigate, getNavigationVersion, liveSession, projectSession.id, projectSession.path, updateNavigationHistory, prepareActivation]);
  const moveAdjacentTab = useCallback((direction: -1 | 1) => tabQueue.current.enqueue(async () => {
    if (!liveSession()) return false;
    const tabs = selectedItemsRef.current;
    const index = tabs.findIndex(tab => tab.id === displayedRef.current?.item.id);
    const target = index < 0 ? undefined : tabs[index + direction];
    if (!target) return true; // At an edge: never wrap or enter document history.
    onNavigate?.(); const ticket = ++navigationTicket.current;
    const navigation = getNavigationVersion?.();
    try { await flushMarkdownEdits(projectSession.id); }
    catch (error) { await message(t('project.saveFailed', { error: localizeError(error) }), { kind: 'error' }); return false; }
    if (!liveSession() || ticket !== navigationTicket.current || navigation !== getNavigationVersion?.()) return false;
    if (!selectedItemsRef.current.some(tab => tab.id === target.id)) return false;
    return prepareActivation(target, { queuedTab: true });
  }), [getNavigationVersion, liveSession, onNavigate, prepareActivation, projectSession.id]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (isComposingKey(event) || event.defaultPrevented || isTextInputTarget(event.target)
        || isModalTarget(event.target) || hasBlockingShortcutSurface()) return;
      let direction: -1 | 1;
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const rtl = tabStrip.current && getComputedStyle(tabStrip.current).direction === 'rtl';
        direction = (event.key === 'ArrowLeft') !== !!rtl ? -1 : 1;
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === 'Tab') {
        direction = event.shiftKey ? -1 : 1;
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
        && (event.key === 'PageUp' || event.key === 'PageDown')) {
        direction = event.key === 'PageUp' ? -1 : 1;
      } else return;
      event.preventDefault();
      if (!event.repeat) void moveAdjacentTab(direction);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [moveAdjacentTab]);
  const removeTab = async (index: number, event?: React.MouseEvent) => {
    tabQueue.current.cancel();
    event?.stopPropagation(); onNavigate?.();
    const ticket = ++navigationTicket.current; const navigation = getNavigationVersion?.();
    const item = selectedItems[index];
    try { await flushMarkdownEdits(projectSession.id, item?.path); }
    catch (error) { await message(t('project.saveFailed', { error: localizeError(error) }), { kind: 'error' }); return; }
    if (!item || !liveSession() || ticket !== navigationTicket.current || navigation !== getNavigationVersion?.()) return;
    if (activation.current?.item.id === item.id) cancelActivation();
    if (displayedRef.current?.item.id === item.id) {
      if (!await tableEditorsAllowNavigation()) return;
      if (!liveSession() || ticket !== navigationTicket.current || navigation !== getNavigationVersion?.()) return;
      if (!await requestCloseStringEditor()) return;
      if (!liveSession() || ticket !== navigationTicket.current || navigation !== getNavigationVersion?.()) return;
      const remaining = selectedItems.filter(candidate => candidate.id !== item.id);
      const target = remaining[Math.max(0, index - 1)] ?? remaining[0];
      if (target && !await prepareActivation(target)) return;
      if (!target) {
        displayedRef.current = null; setDisplayed(null); setRequestedId(null);
        setTableInteractionTarget(projectSession.id, null); if (!isSettingsEditor()) PluginManager.getInstance().setActiveTable(null);
        callbacks.current.onActiveItemChange?.(null);
      }
    }
    onTabRemove?.(item.id);
  };
  const closeActiveTab = useEffectEvent(() => {
    const index = selectedItems.findIndex(tab => tab.id === displayedRef.current?.item.id);
    if (index >= 0) void removeTab(index);
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposingKey(event) || event.repeat || event.altKey || event.shiftKey
        || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'w'
        || isModalTarget(event.target) || hasBlockingShortcutSurface()) return;
      event.preventDefault(); closeActiveTab();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const initializeTable = async (target: InitializationRequest) => {
    // A newer navigation/project cannot inherit approval for another file.
    if (initializationPending.current || !liveSession() || target.projectSessionId !== projectSession.id
      || generation.current !== target.generation) return;
    initializationPending.current = true;
    const { item, historyIndex } = target;
    try {
      const initialized = await invoke<string>('initialize_empty_table', { path: item.path, expectedProjectSession: target.projectSessionId });
      if (initialized !== 'ok') throw new Error(initialized);
      if (!liveSession()) return;
      const saved = await invoke<string>('save_project', { expectedProjectSession: target.projectSessionId });
      if (saved !== 'ok') throw new Error(saved);
      if (liveSession() && generation.current === target.generation) await prepareActivation(item, { historyIndex });
    } catch (error) {
      if (liveSession() && generation.current === target.generation) setFailure({ item, error, historyIndex });
    } finally { initializationPending.current = false; }
  };
  const item = displayed?.item;
  const pending = pendingItem !== null;
  return <div className="bg-background rounded-lg overflow-hidden shadow-sm border border-border h-full flex flex-col">
    <div className="bg-muted border-b border-border shrink-0">
      <div className="flex items-center min-w-0">
        <div className="flex items-center shrink-0 border-r border-border px-1 gap-0.5">
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" data-navigation-history="back"
            aria-label={t('file.navigateBack')} title={t('file.navigateBack')}
            disabled={navigationTarget(navigationHistory, -1, item) === null} onClick={() => { void navigateHistory(-1); }}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" data-navigation-history="forward"
            aria-label={t('file.navigateForward')} title={t('file.navigateForward')}
            disabled={navigationTarget(navigationHistory, 1, item) === null} onClick={() => { void navigateHistory(1); }}>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <div ref={tabStrip} data-document-tabs className="flex items-center min-w-0 overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300">
        {selectedItems.map((tab, index) => <TableTabItem key={tab.id} tab={tab.name} index={index} currentItem={tab}
          isActive={requestedId === tab.id} onActivate={() => { void navigateTab(tab); }}
          onRemove={event => { void removeTab(index, event); }} onMove={(from, to) => { tabQueue.current.cancel(); onNavigate?.(); onTabMove?.(from, to); }} />)}
        </div>
      </div>
    </div>
    <div className="flex-1 min-h-0 relative">
      {item ? <div className="h-full flex flex-col" inert={pending} aria-busy={pending}>
        <FileHeader currentItem={item} />
        <div className="flex-1 min-h-0 max-h-[calc(100vh-120px)] overflow-hidden">
          <FileViewRenderer key={`${projectSession.id}:${item.type}:${displayed.table?.uuid || item.id}`}
            currentItem={item} projectSessionId={projectSession.id} tableData={displayed.table}
            preparedSnapshot={displayed.snapshot} interactionLocked={pending}
            onAuthoritativeSnapshot={onAuthoritativeSnapshot} onDataChange={onDataChange}
            versionEditMode={versionEditMode} onVersionEditModeChange={handleVersionEditModeChange} versionPreview={versionPreview} onVersionPreviewChange={setVersionPreview}
            releaseVersion={releaseVersion} onReleaseVersionChange={setReleaseVersion}
            onOpenReference={onOpenTable ? handleOpenReference : undefined}
            referenceNavigation={!pending && item.type === 'table' && referenceNavigation?.projectSessionId === projectSession.id
              && displayed.table?.uuid === referenceNavigation.tableUuid ? referenceNavigation : undefined}
            onReferenceNavigationHandled={onReferenceNavigationHandled} />
        </div>
      </div> : <div className="flex items-center justify-center h-full text-muted-foreground">{t('file.selectFromBrowser')}</div>}
      {pending && <div className="absolute inset-x-0 top-0 z-30 bg-muted/95 border-b px-3 py-2 text-sm" role="status">
        {t('file.loadingTable')} {pendingItem.name}
        <button type="button" className="underline ml-3" onClick={cancelActivation}>{t('common.cancel')}</button>
      </div>}
      {failure && <div role="alert" className="absolute inset-x-0 top-0 z-30 bg-red-50 border-b px-3 py-2 text-sm">
        {t('file.loadTableFailed')}: {failure.item.name} {localizeError(failure.error)}
        <button type="button" className="underline ml-3" onClick={() => { void prepareActivation(failure.item, { historyIndex: failure.historyIndex }); }}>{t('common.retry')}</button>
      </div>}
    </div>
    <Dialog open={showInitDialog !== null} onOpenChange={open => { if (!open) setShowInitDialog(null); }}>
      <DialogContent role="alertdialog" className="max-w-md"
        onOpenAutoFocus={event => { event.preventDefault(); initializationCancel.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle className="flex items-start gap-3"><AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <span>{t('file.initializeTitle')}</span></DialogTitle>
          <DialogDescription className="whitespace-pre-line">{t('file.initializeQuestion')}{'\n\n'}{t('file.initializeDescription')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={initializationCancel} variant="outline" onClick={() => setShowInitDialog(null)}>{t('common.cancel')}</Button>
          <Button onClick={() => {
            const target = showInitDialog;
            setShowInitDialog(null);
            if (target) void initializeTable(target);
          }}>{t('file.initialize')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
});

export default TableTabView;
