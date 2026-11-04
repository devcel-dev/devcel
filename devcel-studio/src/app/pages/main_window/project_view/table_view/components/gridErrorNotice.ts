import { t, localizeError, resolveMessage, type LocalizedMessage } from '@/app/i18n';

interface GridErrorNotice {
  readonly kind: 'grid-error-notice';
  readonly summary: LocalizedMessage;
  readonly cause?: unknown;
}

/** Keep the original error and the translated notice separate until rendering. */
export function gridErrorNotice(summary: LocalizedMessage, cause?: unknown): GridErrorNotice {
  return { kind: 'grid-error-notice', summary, cause };
}

export function resolveGridError(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'object' && error !== null && 'kind' in error && error.kind === 'grid-error-notice') {
    const notice = error as GridErrorNotice;
    return notice.cause == null
      ? resolveMessage(notice.summary)
      : t('grid.errorWithCause', { summary: resolveMessage(notice.summary), error: resolveGridError(notice.cause) });
  }
  return localizeError(error);
}
