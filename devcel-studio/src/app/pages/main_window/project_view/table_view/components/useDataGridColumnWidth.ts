import { getSettingsSnapshot } from '@/app/settings';
import { versionedStorageKey } from '@/app/settings/storageKey';
import { useState, useLayoutEffect, useCallback, useMemo } from 'react';

// Keep table/column identity inside an exact-version preference namespace.
const STORAGE_KEY = 'devcel-datagrid-column-widths';

type ColumnWidths = Record<string, number>;
type ColumnWidthStorage = Record<string, ColumnWidths>;
const emptyColumnWidths: ColumnWidths = {};

interface WidthScope {
  tableUuid: string;
  projectSessionId: string | undefined;
  pending: ColumnWidths;
  active: boolean;
}

function loadColumnWidths(tableUuid: string): ColumnWidths {
  try {
    const stored = localStorage.getItem(versionedStorageKey(STORAGE_KEY, getSettingsSnapshot().appVersion));
    return stored ? (JSON.parse(stored) as ColumnWidthStorage)[tableUuid] || {} : {};
  } catch (error) {
    console.error('Failed to load column widths:', error);
    return {};
  }
}

function persistPendingWidths(scope: WidthScope) {
  if (Object.keys(scope.pending).length === 0) return;
  try {
    // Merge at flush time so another table's completed resize is not overwritten.
    const stored = localStorage.getItem(versionedStorageKey(STORAGE_KEY, getSettingsSnapshot().appVersion));
    const allWidths: ColumnWidthStorage = stored ? JSON.parse(stored) : {};
    allWidths[scope.tableUuid] = { ...allWidths[scope.tableUuid], ...scope.pending };
    localStorage.setItem(versionedStorageKey(STORAGE_KEY, getSettingsSnapshot().appVersion), JSON.stringify(allWidths));
    scope.pending = {};
  } catch (error) {
    // Retain the final widths for a later flush (for example pagehide).
    console.error('Failed to save column width:', error);
  }
}

export const useDataGridColumnWidth = (tableUuid: string, projectSessionId?: string) => {
  // Old callbacks keep their original table/session identity and become inert on cleanup.
  const scope = useMemo<WidthScope>(() => ({ tableUuid, projectSessionId, pending: {}, active: false }),
    [tableUuid, projectSessionId]);
  const [snapshot, setSnapshot] = useState<{ scope: WidthScope; widths: ColumnWidths }>(
    () => ({ scope, widths: {} })
  );
  const columnWidths = snapshot.scope === scope ? snapshot.widths : emptyColumnWidths;

  // The grid already applies live widths internally. Keep move events out of
  // parent React state and localStorage; publish only the completed widths.
  const queueColumnWidth = useCallback((columnUuid: string, width: number) => {
    if (scope.active && Number.isFinite(width) && width > 0) {
      scope.pending[columnUuid] = width;
    }
  }, [scope]);

  const flushColumnWidths = useCallback(() => {
    if (!scope.active || Object.keys(scope.pending).length === 0) return;
    const pending = { ...scope.pending };
    persistPendingWidths(scope);
    setSnapshot(previous => {
      const widths = previous.scope === scope ? previous.widths : {};
      if (Object.entries(pending).every(([key, width]) => widths[key] === width)) return previous;
      return { scope, widths: { ...widths, ...pending } };
    });
  }, [scope]);

  useLayoutEffect(() => {
    scope.active = true;
    setSnapshot({ scope, widths: loadColumnWidths(scope.tableUuid) });
    // Covers reload/close while a pointer is still held down.
    window.addEventListener('pagehide', flushColumnWidths);
    return () => {
      scope.active = false;
      window.removeEventListener('pagehide', flushColumnWidths);
      // Persist against the old UUID without setting state on an unmounted view.
      persistPendingWidths(scope);
    };
  }, [scope, flushColumnWidths]);

  // Preserve the immediate-save API for callers that are not dragging.
  const saveColumnWidth = useCallback((columnUuid: string, width: number) => {
    queueColumnWidth(columnUuid, width);
    flushColumnWidths();
  }, [queueColumnWidth, flushColumnWidths]);

  const getColumnWidth = useCallback((columnUuid: string, defaultWidth: number): number => {
    const savedWidth = columnWidths[columnUuid];
    return savedWidth ? Number(savedWidth) : defaultWidth;
  }, [columnWidths]);

  const clearColumnWidths = useCallback(() => {
    if (!scope.active) return;
    // A pending drag must not restore widths after an explicit reset.
    scope.pending = {};
    setSnapshot({ scope, widths: {} });
    try {
      const stored = localStorage.getItem(versionedStorageKey(STORAGE_KEY, getSettingsSnapshot().appVersion));
      if (stored) {
        const allWidths: ColumnWidthStorage = JSON.parse(stored);
        delete allWidths[scope.tableUuid];
        localStorage.setItem(versionedStorageKey(STORAGE_KEY, getSettingsSnapshot().appVersion), JSON.stringify(allWidths));
      }
    } catch (error) {
      console.error('Failed to clear column widths:', error);
    }
  }, [scope]);

  return {
    getColumnWidth,
    queueColumnWidth,
    flushColumnWidths,
    saveColumnWidth,
    clearColumnWidths,
    columnWidths
  };
};
