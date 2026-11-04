import { type Diagnostic, toAppError, message, type LocalizedMessage } from '@/app/i18n';
/** The controller owns one checked release until it is discarded or installed. */
export interface UpdaterConfiguration {
  currentVersion: string;
  platform: string;
  supported: boolean;
  configurationStatus: 'unconfigured' | 'invalid' | 'ready';
  reason: Diagnostic;
  platformReason: Diagnostic | null;
  endpoints: string[];
}
export type UpdateProgress =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };
export interface CheckedRelease {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
  download(onEvent: (event: UpdateProgress) => void): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}
export interface UpdaterTransport {
  configuration(): Promise<UpdaterConfiguration>;
  check(configuration: UpdaterConfiguration): Promise<CheckedRelease | null>;
  restart(): Promise<void>;
}
export type UpdaterPhase = 'loading' | 'disabled' | 'idle' | 'checking' | 'available' |
  'downloading' | 'downloaded' | 'confirming' | 'installing' | 'installed' | 'restarting' | 'error';
export interface UpdaterSnapshot {
  phase: UpdaterPhase;
  configuration?: UpdaterConfiguration;
  release?: { version: string; currentVersion: string; body?: string; date?: string };
  downloaded: number;
  total?: number;
  verifying: boolean;
  cancelling: boolean;
  notice: string | LocalizedMessage;
  error: string | LocalizedMessage;
  retry?: 'configuration' | 'check' | 'download';
}
export const initialUpdaterSnapshot: UpdaterSnapshot = {
  phase: 'loading', downloaded: 0, verifying: false, cancelling: false, notice: '', error: '',
};
const busyPhases: UpdaterPhase[] = ['loading', 'checking', 'downloading', 'confirming', 'installing', 'restarting'];
export const updaterIsBusy = (state: UpdaterSnapshot): boolean => busyPhases.includes(state.phase);
const errorText = toAppError;

export class AppUpdaterController {
  private state: UpdaterSnapshot = initialUpdaterSnapshot;
  private release: CheckedRelease | null = null;
  private listeners = new Set<(state: UpdaterSnapshot) => void>();
  private disposed = false;
  private running = false;
  private cancellationRequested = false;

  constructor(private readonly transport: UpdaterTransport) {}
  getSnapshot = (): UpdaterSnapshot => this.state;
  subscribe(listener: (state: UpdaterSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private set(patch: Partial<UpdaterSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener(this.state));
  }
  private async releaseHandle(): Promise<void> {
    const release = this.release;
    this.release = null;
    // Resource cleanup must not turn an installed update into a failed installation.
    if (release) await release.close().catch(() => {});
  }
  async initialize(): Promise<void> {
    if (this.disposed || this.running) return;
    this.running = true;
    this.set({ phase: 'loading', error: '', notice: '', retry: undefined });
    try {
      const configuration = await this.transport.configuration();
      this.set({ configuration, phase: configuration.configurationStatus === 'ready' && configuration.supported ? 'idle' : 'disabled' });
    } catch (error) {
      this.set({ phase: 'error', error: message('updater.error.configuration', { error: errorText(error) }), retry: 'configuration' });
    } finally { this.running = false; }
  }
  async check(): Promise<void> {
    const configuration = this.state.configuration;
    if (this.disposed || this.running || !configuration || configuration.configurationStatus !== 'ready' || !configuration.supported || ['installed', 'downloaded'].includes(this.state.phase)) return;
    this.running = true;
    this.cancellationRequested = false;
    this.set({ phase: 'checking', release: undefined, downloaded: 0, total: undefined, verifying: false, cancelling: false, error: '', notice: '', retry: undefined });
    try {
      await this.releaseHandle();
      if (this.disposed || this.cancellationRequested) return;
      this.release = await this.transport.check(configuration);
      if (this.disposed || this.cancellationRequested) {
        await this.releaseHandle();
        this.set({ phase: 'idle', cancelling: false, notice: message('updater.notice.checkCancelled') });
        return;
      }
      if (!this.release) {
        this.set({ phase: 'idle', notice: message('updater.notice.upToDate') });
      } else {
        const { version, currentVersion, body, date } = this.release;
        this.set({ phase: 'available', release: { version, currentVersion, body, date } });
      }
    } catch (error) {
      await this.releaseHandle();
      this.set(this.cancellationRequested
        ? { phase: 'idle', cancelling: false, notice: message('updater.notice.checkCancelled') }
        : { phase: 'error', error: message('updater.error.check', { error: errorText(error) }), retry: 'check' });
    } finally {
      this.running = false;
      if (this.cancellationRequested && this.state.phase === 'checking') this.set({ phase: 'idle', cancelling: false });
    }
  }
  async download(): Promise<void> {
    if (this.disposed || this.running || !this.release || !(this.state.phase === 'available' || this.state.retry === 'download')) return;
    this.running = true;
    this.cancellationRequested = false;
    this.set({ phase: 'downloading', downloaded: 0, total: undefined, verifying: false, cancelling: false, error: '', notice: '', retry: undefined });
    try {
      await this.release.download(event => {
        if (this.cancellationRequested || this.disposed) return;
        if (event.event === 'Started') {
          this.set({ downloaded: 0, total: Number.isFinite(event.data.contentLength) && event.data.contentLength! > 0 ? event.data.contentLength : undefined });
        } else if (event.event === 'Progress') {
          const bytes = event.data.chunkLength;
          if (Number.isFinite(bytes) && bytes >= 0) this.set({ downloaded: this.state.downloaded + bytes });
        } else {
          // The plugin emits Finished BEFORE signature verification has completed.
          this.set({ verifying: true });
        }
      });
      if (this.disposed || this.cancellationRequested) {
        await this.releaseHandle();
        this.set({ phase: 'idle', release: undefined, cancelling: false, verifying: false, notice: message('updater.notice.downloadDiscarded') });
      } else {
        this.set({ phase: 'downloaded', verifying: false, notice: message('updater.notice.downloadVerified') });
      }
    } catch (error) {
      if (this.disposed || this.cancellationRequested) {
        await this.releaseHandle();
        this.set({ phase: 'idle', release: undefined, cancelling: false, verifying: false, notice: message('updater.notice.downloadCancelled') });
      } else {
        this.set({ phase: 'error', verifying: false, error: message('updater.error.download', { error: errorText(error) }), retry: 'download' });
      }
    } finally { this.running = false; }
  }
  async install(confirm: () => Promise<boolean>): Promise<void> {
    if (this.disposed || this.running || !this.release || this.state.phase !== 'downloaded') return;
    this.running = true;
    this.set({ phase: 'confirming', error: '', notice: '' });
    let installing = false;
    try {
      if (!await confirm() || this.disposed) {
        this.set({ phase: 'downloaded', notice: message('updater.notice.installDeferred') });
        return;
      }
      installing = true;
      this.set({ phase: 'installing' });
      await this.release.install();
      this.set({ phase: 'installed', notice: message('updater.notice.installed') });
      await this.releaseHandle();
    } catch (error) {
      if (installing) {
        await this.releaseHandle();
        this.set({ phase: 'error', retry: 'check', error: message('updater.error.install', { error: errorText(error) }) });
      } else {
        this.set({ phase: 'downloaded', error: message('updater.error.confirmation', { error: errorText(error) }) });
      }
    } finally {
      this.running = false;
      if (this.disposed) await this.releaseHandle();
    }
  }
  async restart(confirm: () => Promise<boolean>): Promise<void> {
    if (this.disposed || this.running || this.state.phase !== 'installed') return;
    this.running = true;
    this.set({ phase: 'restarting', error: '' });
    try {
      if (!await confirm() || this.disposed) { this.set({ phase: 'installed' }); return; }
      await this.transport.restart();
      // A successful relaunch normally exits this process. Remain actionable if it does not.
      this.set({ phase: 'installed' });
    } catch (error) {
      this.set({ phase: 'installed', error: message('updater.error.restart', { error: errorText(error) }) });
    } finally { this.running = false; }
  }
  cancel(): void {
    if (this.disposed || !['checking', 'downloading'].includes(this.state.phase)) return;
    this.cancellationRequested = true;
    this.set({ cancelling: true, notice: message('updater.notice.cancellationRequested') });
  }
  async discard(): Promise<void> {
    if (this.disposed || this.running || !['available', 'downloaded', 'error'].includes(this.state.phase)) return;
    this.running = true;
    await this.releaseHandle();
    this.set({ phase: 'idle', release: undefined, error: '', retry: undefined, downloaded: 0, total: undefined, notice: message('updater.notice.discarded') });
    this.running = false;
  }
  async retry(): Promise<void> {
    if (this.state.retry === 'configuration') await this.initialize();
    else if (this.state.retry === 'download') await this.download();
    else if (this.state.retry === 'check') await this.check();
  }
  dispose(): void {
    this.disposed = true;
    this.cancellationRequested = true;
    this.listeners.clear();
    // In-flight downloads still own the native resource. Close it only when they settle.
    if (!this.running) void this.releaseHandle();
  }
}
