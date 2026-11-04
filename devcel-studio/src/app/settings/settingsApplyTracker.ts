/** Tracks a committed source write separately from publication of validated settings. */
export type ApplyPhase = 'idle' | 'saving' | 'applying' | 'applied' | 'error';
export interface ApplyState { phase: ApplyPhase; revision: string; error: unknown }
export function createSettingsApplyTracker(read: () => Promise<{ generation: string; revision: string; source: string; warning: unknown; migrationFailed: boolean }>) {
  let sequence = 0;
  let state: ApplyState = { phase: 'idle', revision: '', error: null };
  const listeners = new Set<() => void>();
  const publish = (next: ApplyState) => { state = next; for (const listener of listeners) listener(); };
  return {
    get: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    begin(generation: string) {
      const id = ++sequence;
      const previous: ApplyState = state.phase === 'saving' || state.phase === 'applying'
        ? { phase: 'idle', revision: '', error: null } : state;
      publish({ phase: 'saving', revision: '', error: null });
      return {
        cancel() { if (id === sequence) publish(previous); },
        fail(error: unknown) { if (id === sequence) publish({ phase: 'error', revision: '', error }); },
        async committed() {
          if (id !== sequence) return;
          publish({ phase: 'applying', revision: '', error: null });
          try {
            const result = await read();
            if (id !== sequence) return;
            if (!generation || result.generation !== generation) throw { code: 'settings.staleGeneration', params: {} };
            if (result.migrationFailed || result.source !== 'project' || result.warning) {
              publish({ phase: 'error', revision: '', error: result.warning }); return;
            }
            publish({ phase: 'applied', revision: result.revision, error: null });
          } catch (error) { if (id === sequence) publish({ phase: 'error', revision: '', error }); }
        },
      };
    },
  };
}
