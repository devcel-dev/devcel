import { getSettingsSnapshot } from '@/app/settings';
import { versionedStorageKey } from '@/app/settings/storageKey';
import { useState, useCallback, useEffect, useRef } from 'react';

const ROW_HEIGHT_STORAGE_PREFIX = 'dataGridRowHeight_';
const DEFAULT_ROW_HEIGHT = 30;

export interface RowHeightMap {
  [rowId: string]: number;
}

export function useDataGridRowHeight(tableUuid: string | undefined) {
  const [rowHeights, setRowHeights] = useState<RowHeightMap>({});
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Generate the storage key
  const getStorageKey = useCallback((rowId: string) => {
    return tableUuid ? `${versionedStorageKey(ROW_HEIGHT_STORAGE_PREFIX, getSettingsSnapshot().appVersion)}:${tableUuid}_${rowId}` : null;
  }, [tableUuid]);

  // Read row heights from storage
  useEffect(() => {
    if (!tableUuid) return;

    const loadedHeights: RowHeightMap = {};
    const keys = Object.keys(localStorage);
    const prefix = `${versionedStorageKey(ROW_HEIGHT_STORAGE_PREFIX, getSettingsSnapshot().appVersion)}:${tableUuid}_`;

    keys.forEach(key => {
      if (key.startsWith(prefix)) {
        const rowId = key.substring(prefix.length);
        const height = parseInt(localStorage.getItem(key) || '', 10);
        if (!isNaN(height) && height > 0) {
          loadedHeights[rowId] = height;
        }
      }
    });

    setRowHeights(loadedHeights);
  }, [tableUuid]);

  // Get a row's height
  const getRowHeight = useCallback((rowId: string): number => {
    return rowHeights[rowId] || DEFAULT_ROW_HEIGHT;
  }, [rowHeights]);

  // Set a row's height and debounce saving to localStorage
  const setRowHeight = useCallback((rowId: string, height: number) => {
    // Update state immediately for responsive UI
    setRowHeights(prev => {
      if (height === DEFAULT_ROW_HEIGHT) {
        const { [rowId]: _, ...rest } = prev;
        return rest;
      } else {
        return {
          ...prev,
          [rowId]: height
        };
      }
    });

    // Debounce saving to localStorage
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      const storageKey = getStorageKey(rowId);
      if (storageKey) {
        if (height === DEFAULT_ROW_HEIGHT) {
          localStorage.removeItem(storageKey);
        } else {
          localStorage.setItem(storageKey, height.toString());
        }
      }
    }, 300); // 300ms debounce
  }, [getStorageKey]);

  // Reset all row heights
  const resetAllRowHeights = useCallback(() => {
    if (!tableUuid) return;

    const keys = Object.keys(localStorage);
    const prefix = `${versionedStorageKey(ROW_HEIGHT_STORAGE_PREFIX, getSettingsSnapshot().appVersion)}:${tableUuid}_`;

    keys.forEach(key => {
      if (key.startsWith(prefix)) {
        localStorage.removeItem(key);
      }
    });

    setRowHeights({});
  }, [tableUuid]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  return {
    rowHeights,
    getRowHeight,
    setRowHeight,
    resetAllRowHeights,
    defaultRowHeight: DEFAULT_ROW_HEIGHT
  };
}