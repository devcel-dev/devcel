import { isComposingKey, isModalTarget, isTextInputTarget, hasBlockingShortcutSurface } from './shortcutGuards';

type Owner = { root: HTMLElement; selectAll: () => void; find?: () => void };
const owners = new Set<Owner>();
let lastOwner: Owner | undefined;

function ownerAt(target: EventTarget | null) {
  if (!(target instanceof Node)) return undefined;
  // Prefer the innermost registered region, independent of mount order.
  return [...owners].filter(owner => owner.root.isConnected && owner.root.contains(target))
    .sort((a, b) => a.root.contains(b.root) ? 1 : b.root.contains(a.root) ? -1 : 0)[0];
}

function remember(event: Event) {
  if (isModalTarget(event.target)) return;
  const owner = ownerAt(event.target);
  if (owner) lastOwner = owner;
}

function key(event: KeyboardEvent) {
  if (event.defaultPrevented || isComposingKey(event) || event.altKey || event.shiftKey
    || !(event.ctrlKey || event.metaKey) || !['a', 'f'].includes(event.key.toLowerCase())
    || (event.key.toLowerCase() === 'a' && isTextInputTarget(event.target)) || isModalTarget(event.target)) return;
  // Modal portals may retain focus outside while opening: never select behind them.
  if (hasBlockingShortcutSurface()) return;
  const owner = ownerAt(event.target) ?? (lastOwner?.root.isConnected ? lastOwner : undefined);
  if (!owner || (event.key.toLowerCase() === 'f' && !owner.find)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) { if (event.key.toLowerCase() === 'f') owner.find?.(); else owner.selectAll(); }
}

/** One capture listener prevents local grid and tree handlers firing twice. */
export function registerSelectAll(root: HTMLElement, selectAll: () => void, find?: () => void) {
  const owner = { root, selectAll, find };
  if (!owners.size) {
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('focusin', remember, true);
    document.addEventListener('keydown', key, true);
  }
  owners.add(owner);
  return () => {
    owners.delete(owner);
    if (lastOwner === owner) lastOwner = undefined;
    if (!owners.size) {
      document.removeEventListener('pointerdown', remember, true);
      document.removeEventListener('focusin', remember, true);
      document.removeEventListener('keydown', key, true);
    }
  };
}
