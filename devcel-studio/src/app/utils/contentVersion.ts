import { message, resolveMessage } from '@/app/i18n';
/** Decimal content versions used by row and column editing. */
export const MAX_CONTENT_VERSION = 4294967295;
export const CONTENT_VERSION_ERROR = message('column.validation.contentVersion');

export function parseContentVersion(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const version = Number(text);
  return Number.isSafeInteger(version) && version <= MAX_CONTENT_VERSION ? version : null;
}

export function validateContentVersion(value: unknown) {
  return parseContentVersion(value) === null
    ? { isValid: false, errorMessage: resolveMessage(CONTENT_VERSION_ERROR), localizedMessage: CONTENT_VERSION_ERROR }
    : { isValid: true };
}
