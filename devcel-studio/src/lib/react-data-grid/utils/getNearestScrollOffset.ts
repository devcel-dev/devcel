/** CSSOM nearest alignment, including oversized targets and coincident edges. */
export function getNearestScrollOffset(start: number, end: number, visibleStart: number, visibleEnd: number): number {
  if ((start >= visibleStart && end <= visibleEnd) || (start <= visibleStart && end >= visibleEnd)) return 0;
  const fits = end - start <= visibleEnd - visibleStart;
  if (start < visibleStart) return fits ? start - visibleStart : end - visibleEnd;
  if (end > visibleEnd) return fits ? end - visibleEnd : start - visibleStart;
  return 0;
}
