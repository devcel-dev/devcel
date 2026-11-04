import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getTableCatalog } from '@/app/commands/tableCommands';
import { retainTableSnapshotInvalidation } from '@/app/services/tableSnapshotInvalidation';
import type { CompletionCatalog, CompletionTable } from '@/app/utils/formulaCompletion';

interface Source {
  version: number;
  getCatalog: (needed?: string[]) => Promise<CompletionCatalog>;
}
const FormulaContext = createContext<Source | null>(null);
export const useFormulaCompletionSource = () => useContext(FormulaContext);

export function FormulaCompletionProvider({ session, tableUuid, children }: {
  session: string; tableUuid?: string; children: ReactNode;
}) {
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const cache = useRef<Promise<CompletionCatalog> | null>(null);
  const schemas = useRef(new Map<string, Promise<CompletionTable | null>>());
  useEffect(() => {
    const retire = () => {
      generation.current++;
      cache.current = null;
      schemas.current.clear();
    };
    const invalidate = () => {
      retire();
      setVersion(v => v + 1);
    };
    invalidate();
    const subscription = retainTableSnapshotInvalidation(session, invalidate);
    void subscription.ready.catch(invalidate);
    window.addEventListener('devcel-table-catalog-invalidated', invalidate);
    window.addEventListener('focus', invalidate);
    return () => {
      retire();
      subscription.release();
      window.removeEventListener('devcel-table-catalog-invalidated', invalidate);
      window.removeEventListener('focus', invalidate);
    };
  }, [session, tableUuid]);
  const getCatalog = useCallback(async (needed: string[] = []) => {
    const revision = generation.current;
    if (!cache.current) {
      const promise = Promise.all([
        getTableCatalog(session),
        invoke<{ functions: string[]; table: CompletionTable | null }>('get_formula_completion_schema', { uuid: tableUuid ?? null, expectedProjectSession: session })
      ]).then(([tables, metadata]) => ({ functions: metadata.functions, currentTable: tableUuid,
        tables: [...tables.map(t => metadata.table?.uuid === t.uuid ? metadata.table : { uuid: t.uuid, data_name: t.data_name, display_name: t.display_name }), ...(metadata.table?.isInterface ? [metadata.table] : [])] }));
      cache.current = promise;
      void promise.catch(() => { if (cache.current === promise) cache.current = null; });
    }
    const catalog = await cache.current;
    const results = await Promise.all(needed.filter(uuid => uuid.startsWith('interface:') || catalog.tables.some(t => t.uuid === uuid)).slice(0, 16).map(async uuid => {
      if (!schemas.current.has(uuid)) {
        const promise = invoke<{ table: CompletionTable | null }>('get_formula_completion_schema', { uuid, expectedProjectSession: session }).then(r => r.table);
        schemas.current.set(uuid, promise);
        void promise.catch(() => { if (schemas.current.get(uuid) === promise) schemas.current.delete(uuid); });
      }
      return await schemas.current.get(uuid)!;
    }));
    if (generation.current !== revision) throw new Error('Stale completion context');
    const loaded = new Map(results.filter((t): t is CompletionTable => t !== null).map(t => [t.uuid, t]));
    return { ...catalog, tables: [...catalog.tables.map(t => loaded.get(t.uuid) ?? t), ...results.filter((t): t is CompletionTable => t !== null && !catalog.tables.some(old => old.uuid === t.uuid))] };
  }, [session, tableUuid]);
  const source = useMemo(() => ({ version, getCatalog }), [version, getCatalog]);
  return <FormulaContext.Provider value={source}>{children}</FormulaContext.Provider>;
}
