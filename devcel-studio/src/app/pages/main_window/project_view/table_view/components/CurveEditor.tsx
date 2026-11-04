import { useI18n, formatNumber } from '@/app/i18n';
import React, { useMemo, useRef, useState } from 'react';
import {
  CurveData,
  TangentMode,
  buildSvgPath,
  segmentControlPoints,
  normalizeCurve,
  EASING_PRESETS,
  TANGENT_MODE_LABELS,
} from '@/app/utils/curve';

interface CurveEditorProps {
  data: CurveData;
  startValue: number;
  endValue: number;
  onChange: (data: CurveData) => void;
  width?: number;
  height?: number;
}

const PAD = 28;

type DragState =
  | { kind: 'point'; index: number }
  | { kind: 'handle'; index: number; side: 'in' | 'out' }
  | null;

export const CurveEditor: React.FC<CurveEditorProps> = ({
  data,
  startValue,
  endValue,
  onChange,
  width = 360,
  height = 240,
}) => {
  const { t } = useI18n();
  const [isDragging, setIsDragging] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const dragRef = useRef<DragState>(null);
  const dragRange = useRef<{ minY: number; maxY: number } | null>(null);

  const pts = data.points;

  // Calculate the y range automatically from the points, with no explicit range. Add some padding.
  const { minY, maxY } = useMemo(() => {
    // Freeze the range only during a drag; release recalculates it even when
    // the last pointer event did not replace the points array.
    if (isDragging && dragRange.current) return dragRange.current;
    let lo = Math.min(startValue, endValue);
    let hi = Math.max(startValue, endValue);
    for (const p of pts) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
    if (hi - lo < 1e-6) { hi = lo + 1; }
    const m = (hi - lo) * 0.15;
    return { minY: lo - m, maxY: hi + m };
  }, [pts, startValue, endValue, isDragging]);

  const W = width - PAD * 2;
  const H = height - PAD * 2;
  const xPix = (x: number) => PAD + x * W;
  const yPix = (y: number) => PAD + (1 - (y - minY) / (maxY - minY)) * H;
  const xVal = (px: number) => (px - PAD) / W;
  const yVal = (py: number) => {
    const range = dragRange.current ?? { minY, maxY };
    return range.minY + (1 - (py - PAD) / H) * (range.maxY - range.minY);
  };

  const toLocal = (e: React.MouseEvent | MouseEvent): { px: number; py: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { px: (e.clientX - rect.left) * width / rect.width, py: (e.clientY - rect.top) * height / rect.height };
  };

  const commit = (next: CurveData) => onChange(normalizeCurve(next, startValue, endValue));

  // --- Dragging ---
  // Use Pointer Events with setPointerCapture. Even inside a popover portal,
  // all subsequent pointer events reach the capturing SVG, so dragging
  // outside the region remains reliable without missed window-listener events.
  const beginDrag = (e: React.PointerEvent, ds: DragState) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = ds;
    dragRange.current = { minY, maxY };
    setIsDragging(true);
    svgRef.current?.setPointerCapture(e.pointerId);
  };
  const onSvgPointerMove = (e: React.PointerEvent) => {
    const ds = dragRef.current;
    if (!ds) return;
    const { px, py } = toLocal(e);
    const next = { points: pts.map((p) => ({ ...p })) };
    if (ds.kind === 'point') {
      const i = ds.index;
      const isEnd = i === 0 || i === pts.length - 1;
      if (!isEnd) {
        // Interior points: Clamp x between neighboring points; leave y unrestricted
        const minX = pts[i - 1].x + 1e-3;
        const maxX = pts[i + 1].x - 1e-3;
        next.points[i].x = Math.min(maxX, Math.max(minX, xVal(px)));
        next.points[i].y = yVal(py);
      }
      // Endpoints are fixed by config and restored through normalize
    } else {
      // Handles: Update only length (scale), leaving mode and slope unchanged.
      // - auto: Extend or shorten both handles to the same length together
      // - autoLength / free: Adjust only the dragged handle's length
      const i = ds.index;
      const p = next.points[i];
      const cx = xVal(px);
      const setBoth = p.mode === 'auto';
      if (ds.side === 'out' && i < pts.length - 1) {
        const h = pts[i + 1].x - pts[i].x;
        const len = Math.min(3, Math.max(0, (cx - p.x) / (h / 3)));
        p.outLen = len;
        if (setBoth) p.inLen = len;
      } else if (ds.side === 'in' && i > 0) {
        const h = pts[i].x - pts[i - 1].x;
        const len = Math.min(3, Math.max(0, (p.x - cx) / (h / 3)));
        p.inLen = len;
        if (setBoth) p.outLen = len;
      }
    }
    commit(next);
  };
  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current && svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    dragRange.current = null;
    setIsDragging(false);
  };

  // Add a point when clicking empty space
  const onBgDoubleClick = (e: React.MouseEvent) => {
    const { px, py } = toLocal(e);
    const x = Math.min(0.999, Math.max(0.001, xVal(px)));
    const y = yVal(py);
    if (pts.some((p) => Math.abs(p.x - x) < 1e-3)) return;
    const newPts = pts.map((p) => ({ ...p }));
    let idx = newPts.findIndex((p) => p.x > x);
    if (idx === -1) idx = newPts.length - 1;
    newPts.splice(idx, 0, { x, y, mode: 'auto' });
    commit({ points: newPts });
    setSelected(idx);
  };

  const deletePoint = (i: number) => {
    if (i === 0 || i === pts.length - 1) return; // Endpoints cannot be deleted
    const newPts = pts.filter((_, k) => k !== i);
    setSelected(null);
    commit({ points: newPts });
  };

  const setMode = (i: number, mode: TangentMode) => {
    const newPts = pts.map((p, k) => (k === i ? { ...p, mode } : { ...p }));
    commit({ points: newPts });
  };

  const path = buildSvgPath(data, xPix, yPix);

  // Selected point handle positions (control points). Display only in modes where length adjustment matters.
  const handleFor = (i: number): { out?: { x: number; y: number }; in?: { x: number; y: number } } => {
    const res: { out?: { x: number; y: number }; in?: { x: number; y: number } } = {};
    const m = pts[i].mode;
    if (m !== 'auto' && m !== 'autoLength' && m !== 'free') return res;
    if (i < pts.length - 1) {
      const cp = segmentControlPoints(pts, i);
      if (cp) res.out = cp.c1;
    }
    if (i > 0 && pts[i - 1].mode !== 'constant') {
      const cp = segmentControlPoints(pts, i - 1);
      if (cp) res.in = cp.c2;
    }
    return res;
  };

  return (
    <div className="select-none">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="bg-gray-50 border border-gray-200 rounded touch-none max-w-full h-auto"
        onDoubleClick={onBgDoubleClick}
        onPointerMove={onSvgPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        aria-label={t('curve.editorDescription')}
      >
        {/* Grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <line key={'v' + t} x1={xPix(t)} y1={PAD} x2={xPix(t)} y2={PAD + H} stroke="#e5e7eb" strokeWidth={1} />
        ))}
        {[0, 0.5, 1].map((t) => {
          const yv = minY + t * (maxY - minY);
          return (
            <g key={'h' + t}>
              <line x1={PAD} y1={yPix(yv)} x2={PAD + W} y2={yPix(yv)} stroke="#e5e7eb" strokeWidth={1} />
              <text x={4} y={yPix(yv) + 3} fontSize={9} fill="#9ca3af">{formatNumber(yv, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</text>
            </g>
          );
        })}
        <text x={PAD} y={height - 4} fontSize={9} fill="#9ca3af">{formatNumber(0)}</text>
        <text x={PAD + W - 6} y={height - 4} fontSize={9} fill="#9ca3af">{formatNumber(1)}</text>

        {/* Curve */}
        <path d={path} fill="none" stroke="#2563eb" strokeWidth={2} />

        {/* Selected point handles */}
        {selected !== null && (() => {
          const h = handleFor(selected);
          const p = pts[selected];
          return (
            <g>
              {h.out && (
                <>
                  <line x1={xPix(p.x)} y1={yPix(p.y)} x2={xPix(h.out.x)} y2={yPix(h.out.y)} stroke="#f59e0b" strokeWidth={1} />
                  <circle
                    cx={xPix(h.out.x)} cy={yPix(h.out.y)} r={6} fill="#f59e0b" className="cursor-move"
                    onPointerDown={(e) => beginDrag(e, { kind: 'handle', index: selected, side: 'out' })}
                  />
                </>
              )}
              {h.in && (
                <>
                  <line x1={xPix(p.x)} y1={yPix(p.y)} x2={xPix(h.in.x)} y2={yPix(h.in.y)} stroke="#f59e0b" strokeWidth={1} />
                  <circle
                    cx={xPix(h.in.x)} cy={yPix(h.in.y)} r={6} fill="#f59e0b" className="cursor-move"
                    onPointerDown={(e) => beginDrag(e, { kind: 'handle', index: selected, side: 'in' })}
                  />
                </>
              )}
            </g>
          );
        })()}

        {/* Points */}
        {pts.map((p, i) => {
          const isEnd = i === 0 || i === pts.length - 1;
          return (
            <circle
              key={i}
              cx={xPix(p.x)} cy={yPix(p.y)} r={6}
              fill={selected === i ? '#2563eb' : isEnd ? '#9ca3af' : '#fff'}
              stroke="#2563eb" strokeWidth={2}
              className={isEnd ? 'cursor-pointer' : 'cursor-move'}
              onPointerDown={(e) => {
                setSelected(i);
                if (!isEnd) beginDrag(e, { kind: 'point', index: i });
                else e.stopPropagation();
              }}
              onDoubleClick={(e) => { e.stopPropagation(); deletePoint(i); }}
            />
          );
        })}
      </svg>

      {/* Control panel */}
      <div className="mt-2 space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-gray-500 mr-1">{t('curve.tangent')}</span>
          {/* Slope is always automatic and follows point movement. Users choose only automatic or manual length.
              'free' (manual slope) is an internal preset representation and is not shown as a button. */}
          {(['constant', 'linear', 'auto', 'autoLength'] as TangentMode[]).map((m) => (
            <button
              key={m}
              type="button"
              disabled={selected === null}
              onClick={() => selected !== null && setMode(selected, m)}
              className={`px-2 py-0.5 text-xs rounded border ${
                selected !== null && pts[selected]?.mode === m
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-white border-gray-300 hover:bg-gray-50 disabled:opacity-40'
              }`}
            >
              {TANGENT_MODE_LABELS[m]}
            </button>
          ))}
          {selected !== null && selected !== 0 && selected !== pts.length - 1 && (
            <button type="button" onClick={() => deletePoint(selected)} className="px-2 py-0.5 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 ml-1">
              {t('curve.deletePoint')}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-gray-500 mr-1">{t('curve.presets')}</span>
          {EASING_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => { setSelected(null); commit(preset.build(startValue, endValue)); }}
              className="px-2 py-0.5 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-gray-400">
          {t('curve.editInstructions', { start: startValue, end: endValue })}
        </p>
      </div>
    </div>
  );
};
