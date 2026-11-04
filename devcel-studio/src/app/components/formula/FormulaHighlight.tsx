import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { highlightFormula, type FormulaHighlightSpan } from '@/app/utils/formulaHighlight';
type Input = HTMLInputElement | HTMLTextAreaElement;
interface Paint { input: Input; value: string; revision: number; spans: FormulaHighlightSpan[]; host: HTMLElement; frame: CSSProperties; text: CSSProperties }

/** Paint only: the native input owns caret, selection, IME, clipboard and Undo. */
export function FormulaHighlight({ inputRef, disabled = false }: { inputRef: RefObject<Input | null>; disabled?: boolean }) {
  const [paint, setPaint] = useState<Paint | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const syncRef = useRef<(() => void) | null>(null);
  const revisionRef = useRef(0);
  useEffect(() => {
    const input = inputRef.current;
    if (!input || disabled) { setPaint(null); return; }
    let composing = false, imeKey = false, live = true, frame = 0;
    let cached: { value: string; spans: FormulaHighlightSpan[] | null } | null = null;
    const hide = () => {
      revisionRef.current++;
      input.removeAttribute('data-formula-highlighted');
      if (overlayRef.current) overlayRef.current.style.visibility = 'hidden';
    };
    const sync = () => {
      if (!live) return;
      hide();
      if (composing || imeKey || document.activeElement !== input || input.disabled || input.readOnly || input.selectionStart !== input.selectionEnd) { setPaint(null); return; }
      const value = input.value;
      if (!cached || cached.value !== value) cached = { value, spans: highlightFormula(value) };
      const spans = cached.spans, rect = input.getBoundingClientRect();
      if (!spans || !rect.width || !rect.height) { setPaint(null); return; }
      const style = window.getComputedStyle(input);
      // Stay inside the editor's stacking context: a scrolled cell must never
      // paint above sticky grid headers or an unrelated dialog.
      let host: HTMLElement = input.closest<HTMLElement>('[role="dialog"]') ?? document.body;
      for (let parent = input.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const position = window.getComputedStyle(parent).position;
        if (position && position !== 'static') { host = parent; break; }
      }
      const bounds = host === document.body ? null : host.getBoundingClientRect();
      const hostScale = bounds && host.offsetWidth ? bounds.width / host.offsetWidth : 1;
      const width = input.offsetWidth || rect.width, height = input.offsetHeight || rect.height, scale = rect.width / width;
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
      for (let parent = input.parentElement, depth = 0; parent && parent !== document.body && depth < 32; parent = parent.parentElement, depth++) {
        const css = window.getComputedStyle(parent), clip = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(css.overflowX || css.overflow)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
        if (/(auto|scroll|hidden|clip)/.test(css.overflowY || css.overflow)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
      }
      if (right <= left || bottom <= top) { setPaint(null); return; }
      const borderLeft = parseFloat(style.borderLeftWidth) || 0, borderTop = parseFloat(style.borderTopWidth) || 0;
      const borderRight = parseFloat(style.borderRightWidth) || 0, borderBottom = parseFloat(style.borderBottomWidth) || 0;
      const verticalBar = input.clientWidth ? Math.max(0, width - input.clientWidth - borderLeft - borderRight) : 0;
      const horizontalBar = input.clientHeight ? Math.max(0, height - input.clientHeight - borderTop - borderBottom) : 0;
      const leftBar = input.clientLeft - borderLeft > 2 ? verticalBar : 0;
      const multiline = input instanceof window.HTMLTextAreaElement;
      setPaint({ input, value, revision: revisionRef.current, spans, host, frame: {
        position: bounds ? 'absolute' : 'fixed', left: (left - (bounds?.left ?? 0)) / hostScale + (bounds ? host.scrollLeft - host.clientLeft : 0),
        top: (top - (bounds?.top ?? 0)) / hostScale + (bounds ? host.scrollTop - host.clientTop : 0), width: (right - left) / hostScale, height: (bottom - top) / hostScale,
        overflow: 'hidden', pointerEvents: 'none', zIndex: 0, visibility: 'hidden',
      }, text: {
        position: 'absolute', left: (rect.left - left) / hostScale, top: (rect.top - top) / hostScale, width, height, boxSizing: 'border-box',
        transform: `scale(${scale / hostScale})`, transformOrigin: 'top left', borderStyle: 'solid', borderColor: 'transparent',
        borderWidth: `${borderTop}px ${borderRight + verticalBar - leftBar}px ${borderBottom + horizontalBar}px ${borderLeft + leftBar}px`, padding: style.padding,
        font: style.font, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
        fontFeatureSettings: style.fontFeatureSettings, fontVariantLigatures: style.fontVariantLigatures, wordSpacing: style.wordSpacing, textTransform: style.textTransform as CSSProperties['textTransform'],
        textAlign: style.textAlign as CSSProperties['textAlign'], textIndent: style.textIndent, direction: style.direction as CSSProperties['direction'], tabSize: style.tabSize,
        whiteSpace: multiline && input.wrap !== 'off' ? 'pre-wrap' : 'pre', overflowWrap: style.overflowWrap as CSSProperties['overflowWrap'],
        overflow: 'hidden', display: multiline ? 'block' : 'flex', alignItems: multiline ? undefined : 'center',
        '--formula-scroll-x': `${-input.scrollLeft}px`, '--formula-scroll-y': `${-input.scrollTop}px`,
      } as CSSProperties });
    };
    const schedule = () => { hide(); window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(sync); };
    const changed = (event: Event) => { imeKey = (event as InputEvent).isComposing === true; sync(); };
    const start = () => { composing = true; hide(); setPaint(null); };
    const end = () => { composing = false; imeKey = false; schedule(); };
    const key = (raw: Event) => { const event = raw as KeyboardEvent; if (event.isComposing || event.keyCode === 229) { imeKey = true; hide(); } else imeKey = false; };
    const blur = () => { composing = false; imeKey = false; hide(); setPaint(null); };
    input.addEventListener('input', changed); input.addEventListener('focus', sync); input.addEventListener('blur', blur);
    input.addEventListener('compositionstart', start); input.addEventListener('compositionend', end); input.addEventListener('keydown', key);
    window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule); document.addEventListener('selectionchange', schedule);
    const resize = typeof window.ResizeObserver === 'undefined' ? null : new window.ResizeObserver(schedule); resize?.observe(input);
    const mutation = new window.MutationObserver(schedule);
    for (let parent: HTMLElement | null = input, depth = 0; parent && depth < 32; parent = parent.parentElement, depth++) mutation.observe(parent, { attributes: true, attributeFilter: ['class', 'style', 'wrap', 'dir', 'disabled', 'readonly'] });
    syncRef.current = sync;
    sync();
    return () => {
      live = false; syncRef.current = null; hide(); window.cancelAnimationFrame(frame); resize?.disconnect(); mutation.disconnect();
      input.removeEventListener('input', changed); input.removeEventListener('focus', sync); input.removeEventListener('blur', blur);
      input.removeEventListener('compositionstart', start); input.removeEventListener('compositionend', end); input.removeEventListener('keydown', key);
      window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); document.removeEventListener('selectionchange', schedule);
    };
  }, [inputRef, disabled]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (disabled || input.disabled || input.readOnly || document.activeElement !== input || input.selectionStart !== input.selectionEnd) {
      input.removeAttribute('data-formula-highlighted');
      if (overlayRef.current) overlayRef.current.style.visibility = 'hidden';
      return;
    }
    if (!paint || input.value !== paint.value) { syncRef.current?.(); return; }
    if (paint.revision !== revisionRef.current) {
      input.removeAttribute('data-formula-highlighted');
      if (overlayRef.current) overlayRef.current.style.visibility = 'hidden';
      return;
    }
    paint.input.setAttribute('data-formula-highlighted', 'true');
    if (overlayRef.current) overlayRef.current.style.visibility = 'visible';
  });
  if (!paint) return null;
  let end = 0;
  const content = paint.spans.map(span => {
    const space = paint.value.slice(end, span.start); end = span.end;
    return <span key={span.start}>{space}<span className={`formula-token-${span.kind}`}>{paint.value.slice(span.start, span.end)}</span></span>;
  });
  return createPortal(<div ref={overlayRef} aria-hidden="true" className="formula-highlight" style={paint.frame}>
    <div style={paint.text}><div style={{ width: '100%', flexShrink: 0, transform: 'translate(var(--formula-scroll-x),var(--formula-scroll-y))' }}>{content}{paint.value.slice(end)}</div></div>
  </div>, paint.host);
}
