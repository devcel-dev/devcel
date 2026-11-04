import { useEffect, useRef, useState } from 'react';
import { createHdrColorPreview, type HdrColorPreview, type HdrPreviewStatus } from '@/app/utils/hdrColorPreview';
import type { ColorChannels } from './colorDisplay';
import { ColorSwatch } from './ColorSwatch';

/** GPU resources exist only while the picker is mounted, never in virtualized grid cells. */
export function HdrColorSwatch({ linear, fallbackCss, enabled, showHdr, onStatus }: {
  linear: ColorChannels | null; fallbackCss: string | null; enabled: boolean; showHdr: boolean;
  onStatus: (status: HdrPreviewStatus) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<HdrColorPreview | null>(null);
  const currentLinear = useRef(linear); currentLinear.current = linear;
  const report = useRef(onStatus); report.current = onStatus;
  const [status, setStatus] = useState<HdrPreviewStatus>('unavailable');
  useEffect(() => {
    if (!enabled || !canvas.current) { setStatus('unavailable'); report.current('unavailable'); return; }
    const media = window.matchMedia('(dynamic-range: high)');
    let controller: AbortController | null = null;
    let active = true;
    const updateStatus = (next: HdrPreviewStatus) => { if (active) { setStatus(next); report.current(next); } };
    const stop = () => { controller?.abort(); renderer.current?.dispose(); renderer.current = null; };
    const start = () => {
      stop(); updateStatus('unavailable');
      if (!active || document.visibilityState === 'hidden' || !canvas.current) return;
      const operation = new AbortController(); controller = operation;
      void createHdrColorPreview(canvas.current, updateStatus, operation.signal).then(value => {
        if (!active || operation.signal.aborted) { value?.dispose(); return; }
        renderer.current = value;
        if (value && currentLinear.current) value.draw(currentLinear.current);
      });
    };
    start();
    media.addEventListener('change', start);
    document.addEventListener('visibilitychange', start);
    return () => { active = false; media.removeEventListener('change', start); document.removeEventListener('visibilitychange', start); stop(); };
  }, [enabled]);
  useEffect(() => { if (linear) renderer.current?.draw(linear); }, [linear]);
  return <div className="relative h-24 overflow-hidden rounded">
    <ColorSwatch color={showHdr && status === 'candidate' && linear ? null : fallbackCss} className="h-24 w-full" />
    {enabled && <canvas ref={canvas} width={512} height={192} aria-hidden="true"
      className="absolute inset-0 h-full w-full rounded border border-border" style={{ visibility: showHdr && status === 'candidate' && linear ? 'visible' : 'hidden' }} />}
  </div>;
}
