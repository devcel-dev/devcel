/** Keyboard ownership shared by document shortcuts; editors keep native input. */
export function isTextInputTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || !!target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
}

export function isModalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tree"]:not([data-file-navigation-tree]), [role="combobox"]');
}

export function isComposingKey(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function isMarkdownSaveKey(event: KeyboardEvent): boolean {
  return !event.defaultPrevented && !isComposingKey(event) && !event.repeat
    && !event.altKey && !event.shiftKey && (event.ctrlKey || event.metaKey)
    && event.key.toLowerCase() === 's' && !isModalTarget(event.target) && !hasBlockingShortcutSurface();
}

/** Open modal/selection portals own navigation even during focus handoff. */
export function hasBlockingShortcutSurface(): boolean {
  return [...document.querySelectorAll('[aria-modal="true"], [role="listbox"], [role="menu"]')]
    .some(element => {
      if (element.closest('[hidden], [data-state="closed"], [aria-hidden="true"]')) return false;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    });
}
