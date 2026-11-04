import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/app/i18n';

/** Header-only detail surface. Selection, not hovering a data cell, owns it. */
export function HeaderDescription({ text, selected, anchorRef, children }: { text?: string; selected: boolean; anchorRef?: RefObject<HTMLDivElement | null>; children?: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const { t } = useI18n();
  useLayoutEffect(() => {
    setDismissed(false);
    const rect = (anchorRef?.current ?? host.current?.firstElementChild)?.getBoundingClientRect();
    if (selected && rect) setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)), top: rect.bottom + 8 });
  }, [selected, text, anchorRef]);
  return <>{children && <div ref={host} style={{ display: 'contents' }}>{children}</div>}
    {selected && text && !dismissed && createPortal(<div role="dialog" aria-label={text}
      style={{ position: 'fixed', ...position, zIndex: 10001, width: 320, maxWidth: 'calc(100vw - 16px)', maxHeight: '40vh', overflow: 'auto', padding: '12px 32px 12px 12px', whiteSpace: 'pre-wrap', background: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
      onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      {text}<button type="button" aria-label={t('common.close')} style={{ position: 'absolute', right: 8, top: 8 }} onClick={() => setDismissed(true)}>×</button>
    </div>, document.body)}</>;
}
