import { ProjectTagPresets } from '@/app/components/tags/ProjectTagPresets';
import { ColorField } from '@/app/components/color/ColorField';
import { DEFAULT_PROJECT_HEADER_COLOR } from '@/app/config/brand';
import { useI18n, t, localizeError } from '@/app/i18n';
import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getProjectInfo, getProjectSession, updateProjectInfo } from '@/app/commands/projectCommands';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit, listen } from '@tauri-apps/api/event';
import { useSettingsCloseGuard } from '@/app/utils/useSettingsCloseGuard';

export interface ProjectInfo {
  name: string;
  description: string;
  headerColor: string;
  path: string;
  sessionId?: string;
}

export function ProjectEditDialog() {
  useI18n();
  const composition = useSettingsCloseGuard();
  const [projectInfo, setProjectInfo] = useState<ProjectInfo>({
    name: '',
    description: '',
    headerColor: DEFAULT_PROJECT_HEADER_COLOR,
    path: ''
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tagsBusy, setTagsBusy] = useState(false);

  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const saveRunning = useRef(false);
  const initial = useRef<ProjectInfo | null>(null);
  const closeRunning = useRef(false);
  const requestClose = useRef<() => Promise<void>>(async () => {});
  const saveCurrent = useRef<() => Promise<boolean>>(async () => false);
  const operationBusy = useRef(false); operationBusy.current = saving || tagsBusy;
  useEffect(() => {
    const subscription = getCurrentWebviewWindow().onCloseRequested(event => { event.preventDefault(); void requestClose.current(); });
    return () => { void subscription.then(unlisten => unlisten()).catch(console.error); };
  }, []);
  const sessionId = useRef<string | undefined>(undefined);

  useEffect(() => {
    let mounted = true;
    const checkSession = async () => {
      const session = await getProjectSession();
      if (mounted && sessionId.current && session?.id !== sessionId.current) {
        setStale(true);
        setError(t('project.sessionChanged'));
      }
    };
    const subscriptions = ['project-opened', 'project-closed'].map(event => listen(event, () => { void checkSession().catch(console.error); }));
    void (async () => {
      try {
        const info = await getProjectInfo();
        if (!mounted) return;
        const requestedSession = new URLSearchParams(window.location.search).get('projectSession');
        if (requestedSession && requestedSession !== info.sessionId) {
          setStale(true); setError(t('project.sessionChanged'));
        }
        sessionId.current = info.sessionId;
        initial.current = info;
        setProjectInfo(info);
        await checkSession();
      } catch (error) {
        if (mounted) setError(localizeError(error));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; subscriptions.forEach(subscription => { void subscription.then(unlisten => unlisten()); }); };
  }, []);

  const handleSave = async () => {
    if (saveRunning.current || tagsBusy) return false;
    if (!initial.current || initial.current.description === projectInfo.description && initial.current.headerColor === projectInfo.headerColor) return true;
    if (stale || !projectInfo.sessionId) return false;
    saveRunning.current = true;
    setSaving(true);
    setError('');
    try {
      await updateProjectInfo(projectInfo.description, projectInfo.headerColor, projectInfo.sessionId);
      initial.current = projectInfo;
      await emit('project-info-updated').catch(() => {});
      return true;
    } catch (error) {
      const session = await getProjectSession().catch(() => null);
      if (session?.id !== projectInfo.sessionId) {
        setStale(true);
        setError(t('project.sessionChanged'));
      } else {
        setError(t('project.saveFailed', { error: localizeError(error) }));
      }
      return false;
    } finally {
      saveRunning.current = false;
      setSaving(false);
    }
  };
  saveCurrent.current = handleSave;

  requestClose.current = async () => {
    if (loading || operationBusy.current || closeRunning.current) return;
    closeRunning.current = true;
    try {
      if (!await composition.prepareClose() || operationBusy.current) return;
      if (await saveCurrent.current()) await getCurrentWebviewWindow().destroy();
    } catch (reason) { setError(localizeError(reason)); }
    finally { closeRunning.current = false; }
  };
  const handleClose = () => { void requestClose.current(); };

  if (loading) {
    return (
      <div className="min-h-screen bg-muted flex items-center justify-center">
        <div className="text-center">
          <div className="text-lg font-medium text-foreground">{t('common.loading')}</div>
        </div>
      </div>
    );
  }

  return (
    <div {...composition.captureProps} className="h-full min-h-0 bg-muted">
      <div className="h-full min-h-0 p-3">
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background rounded-lg shadow-sm">
          <div className="shrink-0 px-4 py-3 border-b border-border">
            <h2 className="text-lg font-semibold text-foreground">{t('window.projectEdit')}</h2>
          </div>

          <div data-project-settings-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <div>
              <Label htmlFor="name" className="text-sm font-medium text-foreground">
                {t('project.name')}</Label>
              <Input
                id="name"
                type="text"
                value={projectInfo.name}
                disabled
                className="mt-1 bg-muted"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('project.nameReadOnly')}</p>
            </div>

            <div>
              <Label htmlFor="path" className="text-sm font-medium text-foreground">
                {t('project.path')}</Label>
              <Input
                id="path"
                type="text"
                value={projectInfo.path}
                disabled
                className="mt-1 bg-muted"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('project.pathReadOnly')}</p>
            </div>

            <div>
              <Label htmlFor="description" className="text-sm font-medium text-foreground">
                {t('common.description')}</Label>
              <textarea
                id="description"
                disabled={saving || tagsBusy || stale}
                value={projectInfo.description}
                onChange={(e) => setProjectInfo({...projectInfo, description: e.target.value})}
                placeholder={t('project.descriptionPrompt')}
                className="mt-1 flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                rows={3}
              />
            </div>

            <div>
              <Label htmlFor="headerColor" className="text-sm font-medium text-foreground">
                {t('project.headerColor')}</Label>
              <div className="mt-1"><ColorField id="headerColor" value={projectInfo.headerColor} label={t('project.headerColor')}
                context={projectInfo.sessionId} disabled={saving || tagsBusy || stale}
                onChange={headerColor => setProjectInfo(current => ({ ...current, headerColor }))} /></div>
            </div>
            {projectInfo.sessionId && <ProjectTagPresets key={projectInfo.sessionId} expectedProjectSession={projectInfo.sessionId} disabled={saving || stale} onBusyChange={setTagsBusy} />}
          </div>

          <div className="shrink-0 px-4 py-3 border-t border-border flex flex-wrap justify-end gap-3">
            {stale && initial.current && (initial.current.description !== projectInfo.description || initial.current.headerColor !== projectInfo.headerColor) && <Button type="button" variant="outline" onClick={() => { void getCurrentWebviewWindow().destroy().catch(reason => setError(localizeError(reason))); }} disabled={saving || tagsBusy}>{t('column.discardAndClose')}</Button>}
            <Button type="button" variant="outline" onClick={handleClose} disabled={saving || tagsBusy}>
              {saving ? t('common.saving') : t('common.close')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
