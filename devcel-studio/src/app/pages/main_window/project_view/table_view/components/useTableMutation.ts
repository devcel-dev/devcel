import { beginSettingsSave } from '@/app/settings/settingsApply';
import { getTableSnapshotInvalidationVersion } from '@/app/services/tableSnapshotInvalidation';
import { captureTableInteractionScope, isTableInteractionScopeCurrent, subscribeTableInteractionScope } from '@/app/services/tableInteractionScope';
import { useI18n, message, localizeError } from '@/app/i18n';
import { gridErrorNotice, resolveGridError } from './gridErrorNotice';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { confirmInputWarnings } from '@/app/utils/table_rule_dialogs';
import { inputValidationReport, type MutationResult, type TableMutation } from '@/app/types/tableRules';

type BuildMutation = (signal: AbortSignal) => Promise<TableMutation | null>;
/** One operation, including warning confirmation, owns the write gate. */
export function useTableMutation(tableUuid: string, expectedProjectSession: string, onCommitted: (result: MutationResult, invalidationVersion: number) => void, isDetachedDraftCurrent?: () => boolean) {
  useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  const active = useRef<AbortController | null>(null);
  const identity = useRef({ tableUuid, expectedProjectSession });
  identity.current = { tableUuid, expectedProjectSession };
  // A separately-owned one-cell draft may finish its guarded close decision
  // while table navigation has already revoked ordinary grid interaction.
  const detachedOwner = useRef(isDetachedDraftCurrent);
  detachedOwner.current = isDetachedDraftCurrent;
  const committed = useRef(onCommitted);
  committed.current = onCommitted;
  useEffect(() => {
    lock.current = false; setBusy(false); setError(null);
    return () => { active.current?.abort(); active.current = null; lock.current = false; };
  }, [tableUuid, expectedProjectSession]);
  useEffect(() => subscribeTableInteractionScope(() => {
    const scope = identity.current;
    if (detachedOwner.current ? !detachedOwner.current() : captureTableInteractionScope(scope.expectedProjectSession, scope.tableUuid) === null) active.current?.abort();
  }), []);
  const run = useCallback(async (build: BuildMutation, onRejected?: (error: unknown) => void): Promise<boolean> => {
    const draftOwner = isDetachedDraftCurrent;
    const scopeOwner = draftOwner ? null : captureTableInteractionScope(expectedProjectSession, tableUuid);
    const ownsTarget = () => draftOwner
      ? detachedOwner.current === draftOwner && draftOwner()
      : isTableInteractionScopeCurrent(expectedProjectSession, tableUuid, scopeOwner);
    const invalidationVersion = getTableSnapshotInvalidationVersion(expectedProjectSession);
    if (lock.current || !ownsTarget()) return false;
    lock.current = true; setBusy(true); setError(null);
    const controller = new AbortController();
    active.current = controller;
    const live = () => !controller.signal.aborted && identity.current.tableUuid === tableUuid && identity.current.expectedProjectSession === expectedProjectSession
      && ownsTarget();
    let settingsSave: ReturnType<typeof beginSettingsSave>;
    let settingsSettled = false;
    try {
      const request = await build(controller.signal);
      if (!request || !live()) return false;
      // Never mutate the operation after a warning; only attach its exact acknowledgement.
      const fixed = JSON.parse(JSON.stringify(request)) as TableMutation;
      settingsSave = beginSettingsSave();
      let result: MutationResult;
      try { result = await invoke<MutationResult>('apply_table_mutation', { request: fixed, expectedProjectSession }); }
      catch (e) {
        const report = inputValidationReport(e);
        if (!live()) return false;
        if (!report?.acknowledgement || report.issues.some(issue => issue.mode === 'reject')) throw e;
        if (!await confirmInputWarnings(tableUuid, report, controller.signal) || !live()) return false;
        result = await invoke<MutationResult>('apply_table_mutation', { request: { ...fixed, acknowledgement: report.acknowledgement }, expectedProjectSession });
      }
      settingsSettled = true;
      void settingsSave?.committed();
      if (live()) {
        try { committed.current(result, invalidationVersion); }
        catch (e) { setError(gridErrorNotice(message('grid.committedDisplayFailed'), e)); }
      }
      return true;
    } catch (e) {
      settingsSettled = true; settingsSave?.fail(e);
      if (live()) {
        setError(e);
        onRejected?.(e);
      }
      return false;
    } finally {
      if (!settingsSettled) settingsSave?.cancel();
      if (active.current === controller) {
        active.current = null; lock.current = false;
        // Detached drafts stay mounted after project/scope revocation so their
        // stale text must become dismissible again when the write settles.
        if (!controller.signal.aborted || draftOwner) setBusy(false);
      }
    }
  }, [tableUuid, expectedProjectSession, isDetachedDraftCurrent]);
  // Undo/Redo use the same gate, so history cannot race a warning or value write.
  const runExclusive = useCallback(async (action: (signal: AbortSignal) => Promise<unknown>): Promise<boolean> => {
    const scopeOwner = captureTableInteractionScope(expectedProjectSession, tableUuid);
    if (lock.current || scopeOwner === null) return false;
    lock.current = true; setBusy(true); setError(null);
    const controller = new AbortController(); active.current = controller;
    try {
      if (!isTableInteractionScopeCurrent(expectedProjectSession, tableUuid, scopeOwner)) return false;
      await action(controller.signal);
      return !controller.signal.aborted && isTableInteractionScopeCurrent(expectedProjectSession, tableUuid, scopeOwner);
    }
    catch (e) { if (!controller.signal.aborted) setError(e); return false; }
    finally {
      if (active.current === controller) { active.current = null; lock.current = false; if (!controller.signal.aborted) setBusy(false); }
    }
  }, [tableUuid, expectedProjectSession]);
  const isBusy = useCallback(() => lock.current, []);
  const clearError = useCallback(() => setError(null), []);
  const report = inputValidationReport(error);
  const errorText = report ? report.issues.map(issue => `${issue.column_name}: ${localizeError(issue)}`).join('\n') : resolveGridError(error);
  return { busy, isBusy, error: errorText, rawError: error, run, runExclusive, clearError };
}
