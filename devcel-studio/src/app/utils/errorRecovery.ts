/** Recovery actions must follow typed app-owned errors, never translated text.
 * Unrecognized, validation, permission and I/O failures retain the draft and
 * their diagnostic; reloading cannot repair those failures.
 */
export function errorHasCode(error: unknown, codes: readonly string[]): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { kind?: string; code?: unknown; key?: unknown; diagnostics?: unknown[]; summary?: unknown };
  if (value.kind === 'code' && typeof value.code === 'string') return codes.includes(value.code);
  if (typeof value.key === 'string') return codes.includes(value.key);
  if (value.kind === 'diagnostics' && Array.isArray(value.diagnostics)) {
    return value.diagnostics.length > 0 && value.diagnostics.every(item => errorHasCode(item, codes));
  }
  if (value.kind === 'grid-error-notice') return errorHasCode(value.summary, codes);
  return false;
}
export const canReloadDefinition = (error: unknown) => errorHasCode(error, ['error.staleData', 'column.staleNotice']);
export const canRefreshGridError = (error: unknown) => canReloadDefinition(error)
  || errorHasCode(error, ['grid.committedDisplayFailed']);
