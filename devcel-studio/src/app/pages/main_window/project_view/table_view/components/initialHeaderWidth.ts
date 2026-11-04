// Widths are logical CSS pixels: the grid transform applies zoom exactly once.
export function boundedHeaderWidth(measured: number, minimum: number, maximum = 420): number {
  return Math.max(minimum, Math.min(maximum, Math.ceil(measured + 48)));
}
let canvas: HTMLCanvasElement | undefined;
export function initialHeaderWidth(title: string, minimum: number, maximum = 420): number {
  if (typeof document === 'undefined') return minimum;
  canvas ??= document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return minimum;
  const header = document.querySelector<HTMLElement>('.rdg-header-labels, .rdg-transpose-field-label');
  const style = header ? getComputedStyle(header) : null;
  context.font = style?.font || '700 13px "Segoe UI", sans-serif';
  return boundedHeaderWidth(context.measureText(title).width, minimum, maximum);
}
