import { useSyncExternalStore } from 'react';
import { useI18n } from '@/app/i18n';
import { settingsApply } from '@/app/settings/settingsApply';
export function SettingsApplyNotice() {
  const { t } = useI18n();
  const state = useSyncExternalStore(settingsApply.subscribe, settingsApply.get, settingsApply.get);
  const label = state.phase === 'saving' ? t('grid.saving') : state.phase === 'applying' ? t('settings.applyPending')
    : state.phase === 'applied' ? t('settings.applyComplete') : state.phase === 'error' ? t('settings.applyFailed') : '';
  return <div className="shrink-0 border-b border-border bg-muted px-3 py-2 text-sm text-foreground">
    <p>{t('settings.cellCommitHint')}</p>
    <p role={state.phase === 'error' ? 'alert' : 'status'} aria-live="polite" data-settings-apply-phase={state.phase}
      className={state.phase === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{label}</p>
  </div>;
}
