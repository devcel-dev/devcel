import { localizedError, message } from '@/app/i18n';
/** A queue contains explicit requests only. Opening a project never populates it. */
export type TableLoadingSession = { id: string; path: string };

type Request = {
  key: string;
  path: string;
  session: TableLoadingSession;
  generation: number;
  promise: Promise<string>;
  resolve: (result: string) => void;
  reject: (error: unknown) => void;
};

export function normalizeTablePath(path: string, projectFilePath: string): string {
  const normalize = (value: string) => {
    const slashPath = value.replace(/\\/g, '/');
    const parts: string[] = [];
    for (const part of slashPath.split('/')) {
      if (part === '.' || part === '') continue;
      if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push(part);
    }
    return (slashPath.startsWith('//') ? '//' : slashPath.startsWith('/') ? '/' : '') + parts.join('/');
  };
  const normalizedPath = normalize(path);
  const projectPath = normalize(projectFilePath);
  const separator = projectPath.lastIndexOf('/');
  const prefix = separator < 0 ? '' : `${projectPath.slice(0, separator + 1)}Tables/`;
  // Do not split on the last '/Tables/': a table can live in a folder with that name.
  return prefix && normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

/** Single-flight per session/path, bounded both in-flight and queued. No idle timers. */
export class DemandTableLoader {
  private session: TableLoadingSession | null = null;
  private generation = 0;
  private running = 0;
  private readonly requests = new Map<string, Request>();
  private queue: Request[] = [];

  constructor(
    private readonly load: (path: string, sessionId: string) => Promise<string>,
    private readonly concurrency = 2,
    private readonly maxPending = 64
  ) {}

  get currentSession(): TableLoadingSession | null { return this.session; }
  get revision(): number { return this.generation; }

  setSession(session: TableLoadingSession | null): void {
    if (this.session?.id === session?.id && this.session?.path === session?.path) return;
    this.cancel();
    this.session = session;
  }

  cancel(): void {
    this.generation++;
    this.session = null;
    for (const request of this.requests.values()) request.reject(localizedError(message('grid.loading.projectChangedCancellation')));
    this.requests.clear();
    this.queue = [];
    // Issued IPC cannot be aborted. It still occupies a slot until it settles, and
    // expectedProjectSession fences it at the backend. Its result is never reused.
  }

  ensure(path: string, expectedSessionId: string): Promise<string> {
    const session = this.session;
    if (!session || session.id !== expectedSessionId) return Promise.reject(localizedError(message('grid.loading.sessionChanged')));
    const normalizedPath = normalizeTablePath(path, session.path);
    const key = `${session.id}\0${normalizedPath}`;
    const existing = this.requests.get(key);
    if (existing) return existing.promise;
    if (this.requests.size >= this.maxPending) return Promise.reject(localizedError(message('grid.loading.queueFull')));
    let resolve!: Request['resolve'];
    let reject!: Request['reject'];
    const promise = new Promise<string>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    const request = { key, path: normalizedPath, session, generation: this.generation, promise, resolve, reject };
    this.requests.set(key, request);
    this.queue.push(request);
    this.pump();
    return promise;
  }

  private finish(request: Request): void {
    this.running--;
    if (this.requests.get(request.key) === request) this.requests.delete(request.key);
    this.pump();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const request = this.queue.shift()!;
      this.running++;
      void Promise.resolve().then(() => {
        if (request.generation !== this.generation) throw localizedError(message('grid.loading.cancelled'));
        return this.load(request.path, request.session.id);
      }).then(result => {
        this.finish(request);
        if (request.generation === this.generation) request.resolve(result);
      }, error => {
        this.finish(request);
        if (request.generation === this.generation) request.reject(error);
      });
    }
  }
}
