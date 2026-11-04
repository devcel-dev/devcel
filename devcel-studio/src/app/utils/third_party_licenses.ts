/** Window-local state; the common React dialog host owns focus and dismissal. */
let open = false;
let opener: HTMLElement | null = null;
export function restoreLicensesFocus() {
  if (!open && opener?.isConnected) opener.focus({ preventScroll: true });
}
const listeners = new Set<() => void>();
export const getLicensesOpen = () => open;
export function subscribeLicenses(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function closeThirdPartyLicenses() {
  open = false;
  for (const listener of listeners) listener();
}
export async function showThirdPartyLicenses(): Promise<void> {
  if (open) return;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  open = true;
  for (const listener of listeners) listener();
}
