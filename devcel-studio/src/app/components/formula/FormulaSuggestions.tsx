import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { completeFormula, type FormulaCompletion } from '@/app/utils/formulaCompletion';
import { insertFormulaCompletion } from '@/app/utils/formulaTokens';
import { useFormulaCompletionSource } from './FormulaCompletionProvider';
import { useI18n } from '@/app/i18n';
import { FormulaHighlight } from './FormulaHighlight';

type Input = HTMLInputElement | HTMLTextAreaElement;
export function FormulaSuggestions({ inputRef, disabled = false, onAccept }: {
  inputRef: RefObject<Input | null>; disabled?: boolean;
  onAccept: (start: number, end: number, text: string, caretOffset: number) => void;
}) {
  const context = useFormulaCompletionSource();
  const { t } = useI18n();
  const id = useId();
  const [result, setResult] = useState<FormulaCompletion | null>(null);
  const [selected, setSelected] = useState(0);
  const [position, setPosition] = useState({ position: 'fixed' as 'fixed' | 'absolute', left: 0, top: 0, width: 280, maxHeight: 240 });
  const state = useRef({ result, selected, onAccept });
  state.current = { result, selected, onAccept };
  const acceptRef = useRef<(index: number) => void>(() => {});
  useEffect(() => {
    const input = inputRef.current;
    if (!input || !context || disabled) { setResult(null); return; }
    let live = true, composing = false, dismissed = false, request = 0;
    let snapshot: { value: string; caret: number } | null = null;
    const close = () => { request++; snapshot = null; state.current.result = null; setResult(null); };
    const refresh = () => {
      if (!live || composing || dismissed || document.activeElement !== input || input.disabled || input.readOnly
        || input.selectionStart !== input.selectionEnd || !input.value.trimStart().startsWith('=')) { close(); return; }
      // Never pair a previous candidate range with a newer draft/caret while
      // metadata is in flight. Invalidate synchronously, before React renders.
      close();
      const value = input.value, caret = input.selectionStart ?? 0, ticket = ++request;
      void (async () => {
        let catalog = await context.getCatalog();
        let completion = completeFormula(value, caret, catalog);
        const requested = new Set<string>();
        for (let step = 0; step < 8 && completion?.neededTables.length; step++) {
          const next = completion.neededTables.filter(uuid => !requested.has(uuid));
          if (!next.length) break;
          for (const uuid of next) requested.add(uuid);
          catalog = await context.getCatalog([...requested]);
          completion = completeFormula(value, caret, catalog);
        }
        if (!live || request !== ticket || document.activeElement !== input || input.value !== value || input.selectionStart !== caret || input.selectionEnd !== caret || composing) return;
        const rect = input.getBoundingClientRect();
        const modal = input.closest<HTMLElement>('[role="dialog"]');
        const bounds = modal?.getBoundingClientRect();
        const left = bounds?.left ?? 0, top = bounds?.top ?? 0;
        const right = bounds?.right ?? window.innerWidth, bottom = bounds?.bottom ?? window.innerHeight;
        const width = Math.max(80, Math.min(360, Math.max(260, rect.width), right - left - 16));
        let height = Math.max(16, Math.min(240, bottom - top - 16));
        const x = Math.max(left + 8, Math.min(rect.left, right - width - 8));
        let y = rect.bottom + height + 8 < bottom ? rect.bottom + 3 : Math.max(top + 8, rect.top - height - 3);
        if (modal) {
          // Keep suggestions below the dialog header. A textarea can fill the
          // entire content area, so anchor inside it at the visible caret line
          // rather than moving the list above the whole textarea over its title.
          const style = getComputedStyle(input);
          const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2 || 20;
          const line = value.slice(0, caret).split('\n').length - 1;
          const caretBottom = rect.top + (Number.parseFloat(style.paddingTop) || 0) + (line + 1) * lineHeight - input.scrollTop;
          const safeTop = Math.max(top + 8, rect.top + 3);
          y = Math.max(safeTop, Math.min(caretBottom + 3, bottom - 32));
          height = Math.max(16, Math.min(240, bottom - y - 8));
        }
        // DialogContent has a CSS transform. A fixed descendant would use that
        // transformed containing block while our input rect is viewport based.
        const scale = modal && bounds?.width && modal.offsetWidth ? bounds.width / modal.offsetWidth : 1;
        setPosition({ position: modal ? 'absolute' : 'fixed', left: (x - left) / scale + (modal?.scrollLeft ?? 0),
          top: (y - top) / scale + (modal?.scrollTop ?? 0), width: width / scale, maxHeight: height / scale });
        snapshot = { value, caret };
        setSelected(0);
        setResult(completion?.candidates.length ? completion : null);
      })().catch(() => { if (live && ticket === request) close(); });
    };
    acceptRef.current = index => {
      const current = state.current.result;
      const candidate = current?.candidates[index];
      if (!current || !candidate || composing || input.disabled || input.readOnly) return;
      if (!snapshot || input.value !== snapshot.value || input.selectionStart !== snapshot.caret || input.selectionEnd !== snapshot.caret) { close(); return; }
      const inserted = insertFormulaCompletion(input.value, current, candidate.insert, candidate.caretOffset);
      if (!inserted) { close(); return; }
      const before = input.value;
      input.setSelectionRange(current.start, current.end);
      // Chromium/WebView's editing command emits the normal input events and
      // retains its native Undo transaction. Programmatic .value alone cannot.
      try { document.execCommand('insertText', false, candidate.insert); } catch { /* Non-editing DOM/test environments use the explicit adapter below. */ }
      if (input.value === inserted.value && input.value !== before) input.setSelectionRange(inserted.caret, inserted.caret);
      else if (input.value === before) state.current.onAccept(current.start, current.end, candidate.insert, candidate.caretOffset ?? candidate.insert.length);
      // Unexpected browser-owned edits must never be followed by a second write.
      dismissed = true;
      close();
    };
    const keydown = (rawEvent: Event) => {
      const event = rawEvent as KeyboardEvent;
      if (composing || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) || event.shiftKey && event.key.startsWith('Arrow')) { close(); return; }
      const current = state.current.result;
      if (!current?.candidates.length) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) || (event.shiftKey && event.key === 'Tab')) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { dismissed = true; close(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setSelected(i => Math.max(0, Math.min(current.candidates.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1))));
      else acceptRef.current(state.current.selected);
    };
    const inputChanged = () => { dismissed = false; refresh(); };
    const compositionStart = () => { composing = true; close(); };
    const compositionEnd = () => { composing = false; dismissed = false; refresh(); };
    const selectionChanged = () => {
      if (document.activeElement === input && snapshot && (input.value !== snapshot.value || input.selectionStart !== snapshot.caret || input.selectionEnd !== snapshot.caret)) close();
    };
    const scrolled = (event: Event) => {
      // The browser scrolls the editor itself to expose a long draft's caret.
      // Its anchor is still valid; refresh for textarea caret-line placement.
      if (event.target === input) { refresh(); return; }
      if (!(event.target instanceof Node) || !document.getElementById(id)?.contains(event.target)) close();
    };
    input.addEventListener('keydown', keydown, true);
    input.addEventListener('input', inputChanged);
    input.addEventListener('click', inputChanged);
    input.addEventListener('focus', refresh);
    input.addEventListener('blur', close);
    input.addEventListener('compositionstart', compositionStart);
    input.addEventListener('compositionend', compositionEnd);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scrolled, true);
    document.addEventListener('selectionchange', selectionChanged);
    refresh();
    return () => {
      live = false; request++;
      input.removeEventListener('keydown', keydown, true);
      input.removeEventListener('input', inputChanged);
      input.removeEventListener('click', inputChanged);
      input.removeEventListener('focus', refresh);
      input.removeEventListener('blur', close);
      input.removeEventListener('compositionstart', compositionStart);
      input.removeEventListener('compositionend', compositionEnd);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', scrolled, true);
      document.removeEventListener('selectionchange', selectionChanged);
    };
  }, [context, disabled, inputRef, id]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input || !result) return;
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', id);
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', `${id}-${selected}`);
    document.getElementById(`${id}-${selected}`)?.scrollIntoView?.({ block: 'nearest' });
    return () => { for (const name of ['aria-autocomplete', 'aria-controls', 'aria-expanded', 'aria-activedescendant']) input.removeAttribute(name); };
  }, [inputRef, result, selected, id]);
  return <><FormulaHighlight inputRef={inputRef} disabled={disabled} />{result && createPortal(<div id={id} role="listbox" aria-label={t('grid.completion.suggestions')} style={{ ...position, overflowY: 'auto', zIndex: 10000,
    border: '1px solid hsl(var(--border, 0 0% 50%))', borderRadius: 5, background: 'hsl(var(--background, 0 0% 100%))', color: 'hsl(var(--foreground, 0 0% 7%))', boxShadow: '0 3px 12px #0003', padding: 4 }}>
    {result.candidates.map((candidate, index) => <div key={`${candidate.kind}:${candidate.insert}`} id={`${id}-${index}`} role="option" aria-selected={selected === index}
      onMouseDown={event => event.preventDefault()} onClick={() => acceptRef.current(index)}
      style={{ padding: '5px 8px', background: selected === index ? 'hsl(var(--accent, 224 100% 95%))' : undefined, cursor: 'pointer', display: 'flex', gap: 10 }}>
      <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{candidate.label}{candidate.detail && candidate.detail !== candidate.label && <small style={{ display: 'block', opacity: 0.7 }}>{candidate.detail}</small>}</span>
      <small style={{ opacity: 0.7 }}>{t(`grid.completion.${candidate.kind}`)}</small>
    </div>)}
  </div>, inputRef.current?.closest('[role="dialog"]') ?? document.body)}</>;
}
