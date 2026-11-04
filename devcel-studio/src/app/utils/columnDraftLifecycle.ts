import { ask } from '@/app/services/appDialogs';

import { t } from '@/app/i18n';

/** UI-only drafts remain scoped to one open project session, including hidden editors. */
export class ColumnDraftStore {
  private readonly memory = new Map<string, string | null>();

  constructor(private readonly storage: () => Storage = () => sessionStorage) {}

  read(key: string): string | null {
    if (this.memory.has(key)) return this.memory.get(key) ?? null;
    try { return this.storage().getItem(key); } catch { return null; }
  }

  write(key: string, value: string): void {
    this.memory.set(key, value);
    try { this.storage().setItem(key, value); } catch { /* Keep the draft in memory. */ }
  }

  remove(key: string): void {
    // A tombstone prevents a failed storage removal from resurrecting a discarded draft.
    this.memory.set(key, null);
    try { this.storage().removeItem(key); } catch { /* The tombstone remains authoritative. */ }
  }

  keys(expectedProjectSession: string): string[] {
    const prefixes = [`${expectedProjectSession}:devcel:column-draft:`, `${expectedProjectSession}:devcel:text-draft:`];
    const keys = new Set(this.memory.keys());
    try {
      const storage = this.storage();
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key !== null) keys.add(key);
      }
    } catch { /* In-memory drafts still participate in the transition guard. */ }
    return [...keys].filter(key => prefixes.some(prefix => key.startsWith(prefix)) && this.read(key) !== null);
  }

  discardSession(expectedProjectSession: string): void {
    for (const key of this.keys(expectedProjectSession)) this.remove(key);
  }
}

export const columnDraftStore = new ColumnDraftStore();

/** Approval never removes drafts: callers first verify that the transition took place. */
export async function confirmColumnDraftDiscard(expectedProjectSession: string): Promise<boolean> {
  if (columnDraftStore.keys(expectedProjectSession).length === 0) return true;
  return ask(t('project.discardColumnDrafts'), {
    title: t('column.unsavedChanges'), kind: 'warning',
    okLabel: t('project.discardDraftsContinue'), cancelLabel: t('column.keepEditing'),
  });
}
