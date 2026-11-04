import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TablePresentation } from '@/app/types/tableRules';

/** Availability belongs to an exact displayed snapshot, never a previous tab. */
export function useTableHistory(tableUuid: string, expectedProjectSession: string, basis: TablePresentation | null, enabled: boolean) {
  const sequence = useRef(0);
  const [state, setState] = useState<{ basis: TablePresentation | null; session: string; tableUuid: string; canUndo: boolean; canRedo: boolean } | null>(null);
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    setState(null);
    if (!enabled || !basis) return;
    try {
      const result = await invoke<{ canUndo: boolean; canRedo: boolean }>('get_table_history_status', { tableUuid, expectedProjectSession });
      if (ticket === sequence.current) setState({ ...result, basis, session: expectedProjectSession, tableUuid });
    } catch (error) {
      if (ticket === sequence.current) console.warn('Failed to read table history availability', error);
    }
  }, [tableUuid, expectedProjectSession, basis, enabled]);
  const cancel = useCallback(() => { ++sequence.current; }, []);
  useEffect(() => { void refresh(); return cancel; }, [refresh, cancel]);
  const current = enabled && state?.basis === basis && state?.session === expectedProjectSession && state?.tableUuid === tableUuid;
  return { canUndo: !!(current && state?.canUndo), canRedo: !!(current && state?.canRedo) };
}
