/** One active target, two timers and one subscription per mounted grid. */
export type GridTooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface GridTooltipCell {
  rowKey: unknown;
  columnKey: string;
  tooltip?: string | null;
  memoText?: string | null;
  placement?: GridTooltipPlacement | null;
}

export interface GridTooltipView {
  host: HTMLElement;
  mode: 'tooltip' | 'memo';
  text: string;
  placement: GridTooltipPlacement;
  top: number;
  left: number;
}

interface HostEvent {
  currentTarget: HTMLElement;
  relatedTarget?: EventTarget | null;
}
interface ClickEvent extends HostEvent {
  isPropagationStopped(): boolean;
  stopPropagation(): void;
}
interface ActiveTarget {
  root: HTMLElement;
  host: HTMLElement;
  rowKey: unknown;
  columnKey: string;
  hovered: boolean;
  focused: boolean;
}
interface Options {
  id: string;
  getRoot(): HTMLElement | null;
  resolveCell(host: HTMLElement): GridTooltipCell | undefined;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export function createGridSharedTooltipController(options: Options) {
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  let active: ActiveTarget | undefined;
  let suppressed: { rowKey: unknown; columnKey: string } | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let memoTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  let view: GridTooltipView | null = null;
  const listeners = new Set<() => void>();

  function clearTimers() {
    if (hoverTimer !== undefined) cancel(hoverTimer);
    if (memoTimer !== undefined) cancel(memoTimer);
    hoverTimer = memoTimer = undefined;
  }
  function removeDescription(host: HTMLElement) {
    const remaining = (host.getAttribute('aria-describedby') ?? '').split(/\s+/)
      .filter(token => token && token !== options.id);
    if (remaining.length) host.setAttribute('aria-describedby', remaining.join(' '));
    else host.removeAttribute('aria-describedby');
  }
  function addDescription(host: HTMLElement) {
    const tokens = (host.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (!tokens.includes(options.id)) host.setAttribute('aria-describedby', [...tokens, options.id].join(' '));
  }
  function publish(next: GridTooltipView | null) {
    if (view?.host && view.host !== next?.host) removeDescription(view.host);
    if (next) addDescription(next.host);
    if (view === null && next === null) return;
    if (view && next && view.host === next.host && view.mode === next.mode && view.text === next.text
      && view.placement === next.placement && view.top === next.top && view.left === next.left) return;
    view = next;
    for (const listener of listeners) listener();
  }
  function dismiss() {
    active = undefined;
    clearTimers();
    observer?.disconnect();
    observer = undefined;
    publish(null);
  }
  function currentCell() {
    if (!active) return;
    const { host, root } = active;
    if (options.getRoot() !== root || !root.isConnected || !host.isConnected || !root.contains(host)
      || host.closest('[role="grid"], [role="treegrid"]') !== root) return;
    const cell = options.resolveCell(host);
    if (!cell || cell.rowKey !== active.rowKey || cell.columnKey !== active.columnKey
      || (!cell.tooltip && !cell.memoText)) return;
    return cell;
  }
  function inPortal(target: EventTarget | null | undefined) {
    const element = target as Element | null | undefined;
    return element?.nodeType === 1 && element.closest?.('[data-grid-tooltip-id]')?.getAttribute('data-grid-tooltip-id') === options.id;
  }
  function show(mode: GridTooltipView['mode']) {
    const cell = currentCell();
    if (!active || !cell) { dismiss(); return; }
    const text = mode === 'memo' ? cell.memoText : cell.tooltip;
    if (!text) return;
    const rect = active.host.getBoundingClientRect();
    const placement = cell.placement ?? 'top';
    const margin = 8;
    const vertical = placement === 'top' || placement === 'bottom';
    publish({ host: active.host, mode, text, placement,
      top: vertical ? placement === 'top' ? rect.top - margin : rect.bottom + margin : rect.top + rect.height / 2,
      left: vertical ? rect.left + rect.width / 2 : placement === 'left' ? rect.left - margin : rect.right + margin });
  }
  function reconcile() {
    if (!active) return;
    const cell = currentCell();
    if (!cell) { if (view?.mode !== 'memo') dismiss(); return; }
    if (view) {
      const text = view.mode === 'memo' ? cell.memoText : cell.tooltip;
      if (!text) { dismiss(); return; }
      if (view.placement !== (cell.placement ?? 'top')) { dismiss(); return; }
      // Metadata changes update content without reading geometry again.
      publish({ ...view, text, placement: cell.placement ?? 'top' });
    }
  }
  function activate(host: HTMLElement, source: 'hovered' | 'focused') {
    const candidate = options.resolveCell(host);
    if (suppressed && candidate?.rowKey === suppressed.rowKey && candidate?.columnKey === suppressed.columnKey) return;
    if (view?.mode === 'memo') return;
    if (active?.host === host && currentCell()) {
      active[source] = true;
      return;
    }
    dismiss();
    const root = options.getRoot();
    const cell = root?.isConnected && host.isConnected && root.contains(host)
      && host.closest('[role="grid"], [role="treegrid"]') === root ? options.resolveCell(host) : undefined;
    if (!root || !cell || (!cell.tooltip && !cell.memoText)) return;
    active = { root, host, rowKey: cell.rowKey, columnKey: cell.columnKey,
      hovered: source === 'hovered', focused: source === 'focused' };
    const Observer = root.ownerDocument.defaultView?.MutationObserver;
    if (Observer) {
      observer = new Observer(records => {
        // A removed/reinserted virtualized host is a new lifetime, even if its key matches.
        if (records.some(record => Array.from(record.removedNodes).some(node => node === host || node.contains(host)))) {
          if (view?.mode !== 'memo') dismiss();
        } else reconcile();
      });
      observer.observe(root.ownerDocument.documentElement, { childList: true, subtree: true,
        attributes: true, attributeFilter: ['data-row-index', 'data-column-index'] });
    }
    const target = active;
    hoverTimer = schedule(() => {
      if (active !== target) return;
      hoverTimer = undefined;
      show('tooltip');
    }, 500);
    if (cell.memoText) memoTimer = schedule(() => {
      if (active !== target) return;
      memoTimer = undefined;
      if (hoverTimer !== undefined) cancel(hoverTimer);
      hoverTimer = undefined;
      show('memo');
    }, 2000);
  }
  function leave(event: HostEvent, source: 'hovered' | 'focused') {
    if (!active || active.host !== event.currentTarget) return;
    const related = event.relatedTarget as Node | null | undefined;
    if (related?.nodeType && active.host.contains(related)) return;
    active[source] = false;
    if (view?.mode === 'memo') return;
    // Pointer leave keeps the established hover dismissal contract even if a click focused the cell.
    // Focus-only targets remain open until blur/Escape; blur within a hovered cell does not close it.
    if (source === 'hovered' || !active.hovered && !active.focused) dismiss();
  }

  return {
    id: options.id,
    getSnapshot: () => view,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reconcile,
    dismiss,
    closeMemo() {
      if (active) suppressed = { rowKey: active.rowKey, columnKey: active.columnKey };
      dismiss();
    },
    onSelection(cell?: { rowKey: unknown; columnKey: string }) {
      if (suppressed && (!cell || cell.rowKey !== suppressed.rowKey || cell.columnKey !== suppressed.columnKey)) suppressed = undefined;
      if (active && (!cell || cell.rowKey !== active.rowKey || cell.columnKey !== active.columnKey)) dismiss();
    },
    onMouseEnter: (event: HostEvent) => activate(event.currentTarget, 'hovered'),
    onMouseLeave: (event: HostEvent) => leave(event, 'hovered'),
    onFocus: (event: HostEvent) => activate(event.currentTarget, 'focused'),
    onBlur: (event: HostEvent) => leave(event, 'focused'),
    onClick(event: ClickEvent) {
      if (event.isPropagationStopped()) return;
      const cell = options.resolveCell(event.currentTarget);
      if (!cell?.memoText) return;
      if (active?.host !== event.currentTarget || !currentCell()) activate(event.currentTarget, 'hovered');
      if (!active || view?.mode === 'memo') return;
      // Invoked by Cell after its child handler, before React ancestor bubbling.
      event.stopPropagation();
      clearTimers();
      show('memo');
    },
    onScroll(event: Event) {
      const target = event.target as Node | null;
      const root = active?.root;
      if (!root || inPortal(event.target)) return;
      if (!target?.nodeType || target === root.ownerDocument || root.contains(target) || target.contains(root)) {
        if (view?.mode === 'memo') { if (currentCell()) show('memo'); }
        else dismiss();
      }
    },
    onEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && view?.mode !== 'memo') dismiss();
    },
    onPortalLeave(event: HostEvent) {
      if (view?.mode === 'memo') return;
      if (!active) return;
      const related = event.relatedTarget as Node | null | undefined;
      if (related?.nodeType && active.host.contains(related) || inPortal(event.relatedTarget)) return;
      const focused = active.root.ownerDocument.activeElement;
      if (inPortal(focused)) return;
      dismiss();
    },
    onPortalBlur(event: HostEvent) {
      if (view?.mode === 'memo') return;
      if (inPortal(event.relatedTarget)) return;
      const related = event.relatedTarget as Node | null | undefined;
      if (active && related?.nodeType && active.host.contains(related)) return;
      dismiss();
    }
  };
}

export type GridSharedTooltipController = ReturnType<typeof createGridSharedTooltipController>;
