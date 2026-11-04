import { toAppError, t, useI18n, formatNumber, formatDateTime, localizeError, message, resolveMessage, type LocalizedMessage } from '@/app/i18n';
import { useEffect, useRef, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ask } from '@/app/services/appDialogs';

import { Button } from '@/components/ui/button';
import { AppUpdaterController, initialUpdaterSnapshot, updaterIsBusy, type UpdaterSnapshot, type UpdaterTransport } from '@/app/services/AppUpdaterController';
import { getAutomaticUpdateCheck, nativeUpdaterTransport } from '@/app/utils/updater';

const phaseLabels = {
  loading: 'updater.phase.loading', disabled: 'updater.phase.disabled', idle: 'updater.phase.idle', checking: 'updater.phase.checking',
  available: 'updater.phase.available', downloading: 'updater.phase.downloading', downloaded: 'updater.phase.downloaded',
  confirming: 'updater.phase.confirming', installing: 'updater.phase.installing', installed: 'updater.phase.installed',
  restarting: 'updater.phase.restarting', error: 'updater.phase.error',
} as const;
const bytes = (value: number) => value >= 1024 * 1024 ? `${formatNumber(value / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB` : `${formatNumber(value / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;

// The optional transport is an in-memory verification seam, never selected by a URL or build flag.
export function AppUpdaterPage({ transport = nativeUpdaterTransport }: { transport?: UpdaterTransport }) {
  useI18n();
  const [localError, setLocalError] = useState<string | LocalizedMessage>('');
  const [state, setState] = useState<UpdaterSnapshot>(initialUpdaterSnapshot);
  const [closeNotice, setCloseNotice] = useState<string | LocalizedMessage>('');
  const controller = useRef<AppUpdaterController | null>(null);
  const busy = updaterIsBusy(state);
  useEffect(() => {
    const instance = new AppUpdaterController(transport);
    controller.current = instance;
    const unsubscribe = instance.subscribe(setState);
    let disposed = false;
    let stopClose: (() => void) | undefined;
    let stopKey: (() => void) | undefined;
    // Delay one microtask so StrictMode's first setup is disposed before any native call.
    void Promise.resolve().then(async () => {
      if (disposed) return;
      await instance.initialize();
      if (!disposed && new URLSearchParams(location.search).get('check') === '1' && getAutomaticUpdateCheck()) await instance.check();
    });
    void getCurrentWebviewWindow().onCloseRequested(event => {
      if (updaterIsBusy(instance.getSnapshot())) {
        event.preventDefault();
        setCloseNotice(message('updater.closeBlocked'));
      }
    }).then(stop => { if (disposed) stop(); else stopClose = stop; }).catch(error => {
      if (!disposed) setLocalError(message('updater.error.closeProtection', { error: toAppError(error) }));
    });
    const preventNavigation = (event: KeyboardEvent) => {
      // Do not navigate away while an install owns native resources.
      if (updaterIsBusy(instance.getSnapshot()) && (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') || (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)))) event.preventDefault();
    };
    window.addEventListener('keydown', preventNavigation);
    stopKey = () => window.removeEventListener('keydown', preventNavigation);
    return () => { disposed = true; unsubscribe(); instance.dispose(); stopClose?.(); stopKey?.(); };
  }, [transport]);
  const run = (action: (instance: AppUpdaterController) => Promise<void> | void) => {
    setCloseNotice('');
    if (controller.current) void action(controller.current);
  };
  const configuration = state.configuration;
  const percentage = state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : undefined;
  const install = () => run(instance => instance.install(() => ask(
    t('updater.confirmInstall', { version: state.release?.version || '' }),
    { title: t('updater.installTitle'), kind: 'warning' },
  )));
  const restart = () => run(instance => instance.restart(() => ask(
    t('updater.confirmRestart'),
    { title: t('updater.restartTitle'), kind: 'warning' },
  )));

  return <main className="h-screen overflow-auto bg-background text-foreground p-6 space-y-5">
    <header><h1 className="text-xl font-semibold">{t('updater.title')}</h1></header>
    <section aria-label={t('updater.settings')} className="rounded border p-4 space-y-3 text-sm">
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
        <dt>{t('updater.currentVersion')}</dt><dd>{configuration ? `v${configuration.currentVersion}` : t('updater.checking')}</dd>
        <dt>{t('updater.platform')}</dt><dd>{configuration?.platform || t('updater.checking')}</dd>
        <dt>{t('updater.distributionSettings')}</dt><dd>{configuration ? { ready: t('updater.configurationStatus.ready'), unconfigured: t('updater.configurationStatus.unconfigured'), invalid: t('updater.configurationStatus.invalid') }[configuration.configurationStatus] : t('updater.checking')}</dd>
      </dl>
      {configuration?.reason && <p>{localizeError(configuration.reason)}</p>}
      {configuration && !configuration.supported && <p className="text-amber-700 dark:text-amber-300">{localizeError(configuration.platformReason)}</p>}
      {!!configuration?.endpoints.length && <details><summary className="cursor-pointer">{t('updater.endpoints')}</summary><ul className="pt-2 space-y-1">{configuration.endpoints.map(endpoint => <li key={endpoint} className="break-all select-text">{endpoint}</li>)}</ul></details>}

    </section>
    <section className="rounded border p-4 space-y-4" aria-label={t('updater.status')}>
      <h2 className="font-semibold" role="status" aria-live="polite">{state.cancelling ? t('updater.cancelling') : state.verifying ? t('updater.verifying') : t(phaseLabels[state.phase])}</h2>
      {state.release && <div className="space-y-3 text-sm">
        <p>{state.release.date ? t('updater.releaseDate', { version: state.release.version, date: formatDateTime(new Date(state.release.date)) }) : t('updater.releaseVersion', { version: state.release.version })}</p>
        <div><h3 className="font-medium mb-2">{t('updater.releaseNotes')}</h3><pre className="font-sans whitespace-pre-wrap break-words max-h-56 overflow-auto rounded bg-muted p-3 select-text">{state.release.body || t('updater.noReleaseNotes')}</pre></div>
      </div>}
      {state.phase === 'downloading' && <div className="space-y-2">
        <progress aria-label={t('updater.progress')} className="w-full" max={100} value={percentage} />
        <p className="text-sm">{state.total ? t('updater.progressKnown', { downloaded: bytes(state.downloaded), total: bytes(state.total), percentage: percentage ?? 0 }) : t('updater.progressUnknown', { downloaded: bytes(state.downloaded) })}</p>
      </div>}
      {state.notice && <p className="text-sm" aria-live="polite">{resolveMessage(state.notice)}</p>}
      {(state.error || localError) && <p role="alert" className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap break-words">{[state.error, localError].filter(Boolean).map(localizeError).join('\n')}</p>}
      {closeNotice && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{resolveMessage(closeNotice)}</p>}
      <div className="flex flex-wrap gap-2">
        {['idle', 'disabled', 'available'].includes(state.phase) && <Button disabled={busy || state.phase === 'disabled'} onClick={() => run(instance => instance.check())}>{t('updater.check')}</Button>}
        {state.phase === 'available' && <Button onClick={() => run(instance => instance.download())}>{t('updater.download')}</Button>}
        {state.phase === 'downloaded' && <Button onClick={install}>{t('updater.install')}</Button>}
        {state.phase === 'installed' && <Button onClick={restart}>{t('updater.restart')}</Button>}
        {state.phase === 'error' && state.retry && <Button onClick={() => run(instance => instance.retry())}>{t('updater.retry')}</Button>}
        {['available', 'downloaded'].includes(state.phase) && <Button variant="outline" onClick={() => run(instance => instance.discard())}>{t('updater.defer')}</Button>}
        {['checking', 'downloading'].includes(state.phase) && <Button variant="outline" disabled={state.cancelling} onClick={() => run(instance => instance.cancel())}>{t('updater.cancel')}</Button>}
      </div>
    </section>
    <footer className="flex justify-end"><Button variant="outline" disabled={busy} onClick={() => void getCurrentWebviewWindow().close().catch(error => setLocalError(message('updater.error.close', { error: toAppError(error) })))}>{state.phase === 'installed' ? t('updater.restartLater') : t('updater.close')}</Button></footer>
  </main>;
}
