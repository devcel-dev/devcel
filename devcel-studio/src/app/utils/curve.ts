import { t } from '@/app/i18n';
// Curve data model and mathematics.
// x is always between 0 and 1. Endpoint y values at x=0 and x=1 are fixed by start_value/end_value settings.
// Each point has a tangent mode; segments use cubic Bezier interpolation or constant steps.

export type TangentMode =
  | 'constant'   // Constant: Hold the value until the next point (step)
  | 'linear'     // Linear: Straight line to the neighboring point
  | 'auto'       // Automatic slope and length
  | 'autoLength' // Automatic slope with manual length
  | 'free';      // Free: Manual slope and length, for handle dragging and presets

export interface CurvePoint {
  x: number;
  y: number;
  mode: TangentMode;
  // Explicit handles used in free / autoLength modes.
  // slope is dy/dx; len scales the automatic length h/3, where 1 matches automatic length.
  outSlope?: number;
  outLen?: number;
  inSlope?: number;
  inLen?: number;
}

export interface CurveData {
  points: CurvePoint[];
}

const EPS = 1e-9;

export function defaultCurve(startValue: number, endValue: number): CurveData {
  return {
    points: [
      { x: 0, y: startValue, mode: 'auto' },
      { x: 1, y: endValue, mode: 'auto' },
    ],
  };
}

export function parseCurve(s: string | null | undefined): CurveData | null {
  if (!s) return null;
  try {
    const d: unknown = JSON.parse(s);
    if (!d || typeof d !== 'object' || !('points' in d) || !Array.isArray(d.points) || d.points.length < 2) return null;
    const modes = ['constant', 'linear', 'auto', 'autoLength', 'free'];
    const points: CurvePoint[] = [];
    for (const value of d.points) {
      if (!value || typeof value !== 'object') return null;
      const p = value as CurvePoint;
      const mode = p.mode;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || !modes.includes(mode)) return null;
      if (points.length && p.x <= points[points.length - 1].x) return null;
      for (const field of ['inSlope', 'outSlope', 'inLen', 'outLen'] as const) {
        const n = p[field];
        if (n !== undefined && (!Number.isFinite(n) || (field.endsWith('Len') && (n < 0 || n > 3)))) return null;
      }
      points.push({ ...p, mode });
    }
    if (points[0].x !== 0 || points[points.length - 1].x !== 1) return null;
    return { points };
  } catch { return null; }
}

export function serializeCurve(data: CurveData): string {
  return JSON.stringify(data);
}

/** Fix endpoint y values to their configured values, clamp x to 0..1, and sort ascending */
export function normalizeCurve(data: CurveData, startValue: number, endValue: number): CurveData {
  const pts = [...data.points].sort((a, b) => a.x - b.x);
  pts[0] = { ...pts[0], x: 0, y: startValue };
  pts[pts.length - 1] = { ...pts[pts.length - 1], x: 1, y: endValue };
  for (let i = 1; i < pts.length - 1; i++) {
    pts[i] = { ...pts[i], x: Math.min(1, Math.max(0, pts[i].x)) };
  }
  return { points: pts };
}

function autoSlope(pts: CurvePoint[], i: number): number {
  if (pts.length < 2) return 0;
  if (i <= 0) return (pts[1].y - pts[0].y) / Math.max(EPS, pts[1].x - pts[0].x);
  if (i >= pts.length - 1) return (pts[i].y - pts[i - 1].y) / Math.max(EPS, pts[i].x - pts[i - 1].x);
  return (pts[i + 1].y - pts[i - 1].y) / Math.max(EPS, pts[i + 1].x - pts[i - 1].x);
}
function chordRight(pts: CurvePoint[], i: number): number {
  return (pts[i + 1].y - pts[i].y) / Math.max(EPS, pts[i + 1].x - pts[i].x);
}
function chordLeft(pts: CurvePoint[], i: number): number {
  return (pts[i].y - pts[i - 1].y) / Math.max(EPS, pts[i].x - pts[i - 1].x);
}

// Represent tangents as slope and length, with length scaling the automatic h/3.
// - linear: Chord slope and length=1 for a straight line
// - auto / autoLength: Slope is always automatic; length uses the saved value, defaulting to 1.
//   Dragging in auto changes both handle lengths; autoLength changes only the dragged side.
// - free: Both slope and length use saved values, such as preset values.
export function outHandle(pts: CurvePoint[], i: number): { slope: number; len: number } {
  const a = pts[i];
  if (a.mode === 'linear') return { slope: chordRight(pts, i), len: 1 };
  if (a.mode === 'constant') return { slope: 0, len: 1 };
  const slope = a.mode === 'free' ? a.outSlope ?? autoSlope(pts, i) : autoSlope(pts, i);
  return { slope, len: a.outLen ?? 1 };
}

export function inHandle(pts: CurvePoint[], i: number): { slope: number; len: number } {
  const a = pts[i];
  if (a.mode === 'linear') return { slope: chordLeft(pts, i), len: 1 };
  if (a.mode === 'constant') return { slope: 0, len: 1 };
  const slope = a.mode === 'free' ? a.inSlope ?? autoSlope(pts, i) : autoSlope(pts, i);
  return { slope, len: a.inLen ?? 1 };
}

/** Return Bezier control points in curve space. Return null for a.mode==='constant' segments, treated as steps. */
export function segmentControlPoints(
  pts: CurvePoint[],
  i: number
): { c1: { x: number; y: number }; c2: { x: number; y: number } } | null {
  const a = pts[i];
  const b = pts[i + 1];
  if (a.mode === 'constant') return null;
  const h = b.x - a.x;
  const oh = outHandle(pts, i);
  const ih = inHandle(pts, i + 1);
  const oLen = (h / 3) * Math.min(3, Math.max(0, oh.len));
  const iLen = (h / 3) * Math.min(3, Math.max(0, ih.len));
  return {
    c1: { x: a.x + oLen, y: a.y + oh.slope * oLen },
    c2: { x: b.x - iLen, y: b.y - ih.slope * iLen },
  };
}

/** Generate the SVG path d string. mx/my map curve space to pixels. */
export function buildSvgPath(
  data: CurveData,
  mx: (x: number) => number,
  my: (y: number) => number
): string {
  const pts = data.points;
  if (pts.length === 0) return '';
  let d = `M ${mx(pts[0].x)} ${my(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const cp = segmentControlPoints(pts, i);
    if (!cp) {
      // Constant: Hold a.y, then switch to b.y at b.x
      d += ` L ${mx(b.x)} ${my(a.y)} L ${mx(b.x)} ${my(b.y)}`;
    } else {
      d += ` C ${mx(cp.c1.x)} ${my(cp.c1.y)}, ${mx(cp.c2.x)} ${my(cp.c2.y)}, ${mx(b.x)} ${my(b.y)}`;
    }
  }
  return d;
}

/** Evaluate the curve's y at the specified x for consumers and previews. */
export function evaluateCurve(data: CurveData, x: number): number {
  const pts = data.points;
  if (pts.length === 0) return 0;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1].x <= x) i++;
  const a = pts[i];
  const b = pts[i + 1];
  if (a.mode === 'constant' || x === a.x) return a.y;
  const cp = segmentControlPoints(pts, i)!;
  // Solve Bx(t)=x by bisection and return By(t)
  const bx = (t: number) => {
    const u = 1 - t;
    return u * u * u * a.x + 3 * u * u * t * cp.c1.x + 3 * u * t * t * cp.c2.x + t * t * t * b.x;
  };
  const by = (t: number) => {
    const u = 1 - t;
    return u * u * u * a.y + 3 * u * u * t * cp.c1.y + 3 * u * t * t * cp.c2.y + t * t * t * b.y;
  };
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    const sampleX = bx(mid);
    if (sampleX === x) return by(mid);
    if (sampleX < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

// --- Easing presets ---

export interface EasingPreset {
  id: string;
  label: string;
  build: (start: number, end: number) => CurveData;
}

/** Generate a curve equivalent to CSS cubic-bezier(x1,y1,x2,y2), scaling y to start..end */
function cubicBezierEasing(x1: number, y1: number, x2: number, y2: number) {
  return (start: number, end: number): CurveData => {
    const d = end - start;
    const outLen = 3 * x1;
    const inLen = 3 * (1 - x2);
    const outSlope = x1 > EPS ? d * (y1 / x1) : 0;
    const inSlope = 1 - x2 > EPS ? d * ((1 - y2) / (1 - x2)) : 0;
    return {
      points: [
        { x: 0, y: start, mode: 'free', outSlope, outLen },
        { x: 1, y: end, mode: 'free', inSlope, inLen },
      ],
    };
  };
}

export const EASING_PRESETS: EasingPreset[] = [
  { id: 'linear', get label() { return t('curve.linear'); }, build: (s, e) => ({ points: [{ x: 0, y: s, mode: 'linear' }, { x: 1, y: e, mode: 'linear' }] }) },
  { id: 'ease', get label() { return t('curve.preset.ease'); }, build: cubicBezierEasing(0.25, 0.1, 0.25, 1) },
  { id: 'easeIn', get label() { return t('curve.preset.easeIn'); }, build: cubicBezierEasing(0.42, 0, 1, 1) },
  { id: 'easeOut', get label() { return t('curve.preset.easeOut'); }, build: cubicBezierEasing(0, 0, 0.58, 1) },
  { id: 'easeInOut', get label() { return t('curve.preset.easeInOut'); }, build: cubicBezierEasing(0.42, 0, 0.58, 1) },
  { id: 'easeInOutSine', get label() { return t('curve.preset.easeInOutSine'); }, build: cubicBezierEasing(0.37, 0, 0.63, 1) },
  { id: 'easeInCubic', get label() { return t('curve.preset.easeInCubic'); }, build: cubicBezierEasing(0.32, 0, 0.67, 0) },
  { id: 'easeOutCubic', get label() { return t('curve.preset.easeOutCubic'); }, build: cubicBezierEasing(0.33, 1, 0.68, 1) },
  { id: 'smoothstep', get label() { return t('curve.smooth'); }, build: cubicBezierEasing(1 / 3, 0, 2 / 3, 1) },
  { id: 'step', get label() { return t('curve.constantStep'); }, build: (s, e) => ({ points: [{ x: 0, y: s, mode: 'constant' }, { x: 1, y: e, mode: 'auto' }] }) },
];

export const TANGENT_MODE_LABELS: Record<TangentMode, string> = {
  get constant() { return t('curve.constant'); },
  get linear() { return t('curve.linear'); },
  get auto() { return t('curve.smoothTangent'); },
  get autoLength() { return t('curve.smoothManualLength'); },
  get free() { return t('curve.free'); },
};
