import { invoke } from '@tauri-apps/api/core';
import { message } from '@/app/services/appDialogs';

import { localizeError, t } from '@/app/i18n';

export type MarkdownIdentity = Readonly<{ filePath: string; expectedProjectSession: string }>;
export type MarkdownSnapshot = Readonly<{
  content: string | null;
  isLoading: boolean;
  isSaving: boolean;
  isDirty: boolean;
  loadError: unknown;
  saveError: unknown;
}>;

type MarkdownStorage = {
  read: (identity: MarkdownIdentity) => Promise<string>;
  write: (identity: MarkdownIdentity, content: string, expectedContent: string) => Promise<void>;
};

/** A draft belongs to one document in one open project, never to a mounted editor. */
export class MarkdownDocument {
  references = 0;
  private content: string | null = null;
  private savedContent: string | null = null;
  private loadError: unknown = null;
  private saveError: unknown = null;
  private captureError: unknown = null;
  private reading: Promise<void> | null = null;
  private writing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(snapshot: MarkdownSnapshot) => void>();

  constructor(readonly identity: MarkdownIdentity, private readonly storage: MarkdownStorage) {}

  get snapshot(): MarkdownSnapshot {
    return {
      content: this.content,
      isLoading: this.content === null && !this.loadError,
      isSaving: this.writing !== null,
      isDirty: this.content !== this.savedContent,
      loadError: this.loadError,
      saveError: this.saveError,
    };
  }

  get pending(): boolean { return this.content !== this.savedContent || this.writing !== null || this.captureError !== null; }

  subscribe(listener: (snapshot: MarkdownSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  async load(): Promise<void> {
    // Reopening during a save or after a failure must reuse the draft, not read stale disk data.
    if (this.content !== null) return;
    if (this.reading) return this.reading;
    this.loadError = null;
    this.notify();
    const reading = Promise.resolve().then(async () => {
      try {
        const content = await this.storage.read(this.identity);
        this.content = content;
        this.savedContent = content;
      } catch (error) {
        this.loadError = error;
      } finally {
        this.reading = null;
        this.notify();
      }
    });
    this.reading = reading;
    return reading;
  }

  update(content: string): void {
    if (this.content === null) return;
    if (this.captureError !== null) {
      this.captureError = null;
      this.saveError = null;
      this.notify();
    }
    if (content === this.content) return;
    // Capture the string synchronously. A deferred callback must never touch a destroyed editor.
    this.content = content;
    this.saveError = null;
    this.clearTimer();
    if (this.pending) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch(() => { /* The draft and error remain visible for retry. */ });
      }, 500);
    }
    this.notify();
  }

  discard(): void {
    if (this.writing) return;
    this.clearTimer();
    this.content = this.savedContent;
    this.captureError = null;
    this.saveError = null;
    this.notify();
  }

  setCaptureError(error: unknown): void {
    this.captureError = error;
    this.saveError = error;
    this.notify();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  async flush(): Promise<void> {
    this.clearTimer();
    while (this.pending) {
      if (this.captureError !== null) throw this.captureError;
      if (!this.writing) {
        this.saveError = null;
        // Deferring the drain until the promise is installed also handles synchronous writers.
        this.writing = Promise.resolve().then(async () => {
          while (this.content !== this.savedContent && this.content !== null) {
            const content = this.content;
            const expectedContent = this.savedContent;
            if (expectedContent === null) throw new Error('Markdown has no saved baseline');
            // Rust compares disk bytes under its write lock. A file replaced at the same path
            // or changed externally must not be overwritten by this editor's old draft.
            await this.storage.write(this.identity, content, expectedContent);
            // An older completion only acknowledges the exact text that was written.
            this.savedContent = content;
          }
        }).catch(error => {
          this.saveError = error;
          throw error;
        }).finally(() => {
          this.writing = null;
          this.notify();
        });
        this.notify();
      }
      await this.writing;
      // An edit can arrive while the preceding write settles; include it in this flush.
      this.clearTimer();
    }
  }
}

/** Serializes saves even if a tab is closed/reopened while its previous write is in flight. */
export type MarkdownRecoveryDraft = Readonly<{
  key: string;
  identity: MarkdownIdentity;
  content: string;
  error: unknown;
}>;

export class MarkdownSaveCoordinator {
  private readonly listeners = new Set<() => void>();
  private readonly documents = new Map<string, MarkdownDocument>();

  constructor(
    private readonly storage: MarkdownStorage,
    private readonly onDetachedFailure: (document: MarkdownDocument, error: unknown) => void = () => {},
  ) {}

  private key(identity: MarkdownIdentity): string {
    return JSON.stringify([identity.expectedProjectSession, identity.filePath]);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  getRecoveryDrafts(): MarkdownRecoveryDraft[] {
    return [...this.documents.values()].flatMap(document => {
      const snapshot = document.snapshot;
      return document.references === 0 && document.pending && snapshot.content !== null && snapshot.saveError
        ? [{ key: this.key(document.identity), identity: document.identity, content: snapshot.content, error: snapshot.saveError }]
        : [];
    });
  }

  discardRecoveryDraft(draft: MarkdownRecoveryDraft): boolean {
    const document = this.documents.get(draft.key);
    // A confirmation for an old snapshot cannot discard a reopened or newly edited document.
    if (!document || document.references !== 0 || document.snapshot.isSaving || document.snapshot.content !== draft.content) return false;
    document.discard();
    this.documents.delete(draft.key);
    this.notify();
    return true;
  }

  open(identity: MarkdownIdentity): MarkdownDocument {
    const key = this.key(identity);
    let document = this.documents.get(key);
    if (!document) {
      document = new MarkdownDocument(Object.freeze({ ...identity }), this.storage);
      this.documents.set(key, document);
      document.subscribe(() => this.notify());
    }
    document.references++;
    this.notify();
    return document;
  }

  release(document: MarkdownDocument): void {
    document.references = Math.max(0, document.references - 1);
    this.notify();
    if (document.references > 0) return;
    // Cleanup is the fallback for navigation outside the guarded tab/project controls.
    void document.flush().then(() => {
      if (document.references === 0 && !document.pending && this.documents.get(this.key(document.identity)) === document) {
        this.documents.delete(this.key(document.identity));
        this.notify();
      }
    }).catch(error => {
      // Keep failed drafts available when their original tab is reopened.
      if (document.references === 0) this.onDetachedFailure(document, error);
    });
  }

  private matching(expectedProjectSession?: string, filePath?: string): MarkdownDocument[] {
    return [...this.documents.values()].filter(document =>
      (expectedProjectSession === undefined || document.identity.expectedProjectSession === expectedProjectSession) &&
      (filePath === undefined || document.identity.filePath === filePath));
  }

  hasPending(expectedProjectSession?: string, filePath?: string): boolean {
    return this.matching(expectedProjectSession, filePath).some(document => document.pending);
  }

  async flush(expectedProjectSession?: string, filePath?: string): Promise<void> {
    // Start every flush before awaiting, so one failure does not strand another document's timer.
    const results = await Promise.allSettled(this.matching(expectedProjectSession, filePath).map(document => document.flush()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

export const markdownSaveCoordinator = new MarkdownSaveCoordinator({
  read: identity => invoke<string>('read_markdown_file', {
    filePath: identity.filePath, expectedProjectSession: identity.expectedProjectSession,
  }),
  write: async (identity, content, expectedContent) => {
    const result = await invoke<string>('write_markdown_file', {
      filePath: identity.filePath, expectedProjectSession: identity.expectedProjectSession,
      content, expectedContent,
    });
    if (result !== 'ok') throw new Error(result);
  },
}, (document, error) => {
  void message(t('project.saveFailed', { error: `${document.identity.filePath}: ${localizeError(error)}` }), {
    title: t('common.error'), kind: 'error',
  }).catch(console.error);
});

/** Throws on failure. Call before removing a tab, replacing a project, or closing a window. */
export const flushMarkdownEdits = (expectedProjectSession?: string, filePath?: string): Promise<void> =>
  markdownSaveCoordinator.flush(expectedProjectSession, filePath);
export const hasPendingMarkdownEdits = (expectedProjectSession?: string, filePath?: string): boolean =>
  markdownSaveCoordinator.hasPending(expectedProjectSession, filePath);
