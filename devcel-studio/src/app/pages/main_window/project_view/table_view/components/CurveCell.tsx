import { useI18n } from '@/app/i18n';
import { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ChevronDown } from 'lucide-react';
import type { Column } from '@/app/types/tableTypes';
import type { RenderCellProps, RenderEditCellProps } from '@/lib/react-data-grid';
import type { GridRow } from './DataGridView';
import { CurveData, defaultCurve, parseCurve, serializeCurve, buildSvgPath, normalizeCurve } from '@/app/utils/curve';
import { CurveEditor } from './CurveEditor';

function configOf(column: Column): { start: number; end: number } {
  const c = column.curve_config;
  return { start: c?.start_value ?? 0, end: c?.end_value ?? 1 };
}

function curveOf(value: any, start: number, end: number): CurveData {
  return normalizeCurve(parseCurve(typeof value === 'string' ? value : null) ?? defaultCurve(start, end), start, end);
}

/** Small preview (sparkline) */
function Sparkline({ data, w = 56, h = 22 }: { data: CurveData; w?: number; h?: number }) {
  const pad = 2;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of data.points) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
  if (!isFinite(lo) || hi - lo < 1e-6) { lo = (lo === Infinity ? 0 : lo) - 0.5; hi = lo + 1; }
  const mx = (x: number) => pad + x * (w - pad * 2);
  const my = (y: number) => pad + (1 - (y - lo) / (hi - lo)) * (h - pad * 2);
  const d = buildSvgPath(data, mx, my);
  return (
    <svg width={w} height={h} className="shrink-0">
      <path d={d} fill="none" stroke="#2563eb" strokeWidth={1.5} />
    </svg>
  );
}

export function CurveCellRenderer(
  props: RenderCellProps<GridRow> & {
    columnData: Column;
    selectCell?: (position: { rowIdx: number; idx: number }, options?: { enableEditor?: boolean }) => void;
  }
) {
  const { t } = useI18n();
  const { start, end } = configOf(props.columnData);
  const value = props.row[props.column.key];
  const data = curveOf(value, start, end);
  const invalid = typeof value === 'string' && value !== '' && parseCurve(value) === null;
  return (
    <div
      className="h-full flex items-center justify-between px-2"
    >
      {invalid ? <span className="text-xs text-red-600" title={t('curve.invalidHint')}>{t('curve.invalid')}</span> : <Sparkline data={data} />}
      <ChevronDown
        className="h-4 w-4 opacity-50 flex-shrink-0 ml-1 cursor-pointer hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          if (props.selectCell && props.rowIdx !== undefined) {
            props.selectCell({ rowIdx: props.rowIdx, idx: props.column.idx }, { enableEditor: true });
          }
        }}
      />
    </div>
  );
}

export function CurveCellEditor(
  props: RenderEditCellProps<GridRow> & { columnData: Column }
) {
  const { t } = useI18n();
  const { start, end } = configOf(props.columnData);
  const [open, setOpen] = useState(true);
  const [data, setData] = useState<CurveData>(() => curveOf(props.row[props.column.key], start, end));

  const finished = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    setOpen(false);
    if (commit) props.onRowChange({ ...props.row, [props.column.key]: serializeCurve(data) }, true);
    else props.onClose(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) finish(false);
      }}
    >
      <DialogTrigger asChild>
        <div className="h-full w-full px-2 flex items-center justify-between cursor-pointer">
          <Sparkline data={data} />
          <ChevronDown className="h-4 w-4 opacity-50" />
        </div>
      </DialogTrigger>
      <DialogContent ref={contentRef} tabIndex={-1} aria-describedby={undefined} className="p-3 gap-2 w-[410px] max-w-[calc(100vw-24px)] whitespace-normal max-h-[calc(100dvh-24px)] overflow-auto"
        onOpenAutoFocus={(event) => { event.preventDefault(); contentRef.current?.focus(); }}
        onKeyDown={(e) => e.stopPropagation()}
        onEscapeKeyDown={(e) => { e.preventDefault(); e.stopPropagation(); finish(false); }}>
        <DialogTitle className="text-sm pr-6">{t('curve.title')}</DialogTitle>
        {props.row[props.column.key] && !parseCurve(props.row[props.column.key]) && (
          <p className="text-xs text-red-600 mb-2 max-w-[360px]">{t('curve.replaceInvalidWarning')}</p>
        )}
        <CurveEditor data={data} startValue={start} endValue={end} onChange={setData} />
        <div className="flex justify-end gap-2 mt-3">
          <button type="button" className="px-3 py-1 rounded border" onClick={() => finish(false)}>{t('common.cancel')}</button>
          <button type="button" className="px-3 py-1 rounded bg-primary text-primary-foreground" onClick={() => finish(true)}>{t('curve.apply')}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
