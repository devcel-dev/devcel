/** Lossless, bounded editor coloring; never evaluates or validates an expression. */
export type FormulaHighlightKind = 'function' | 'name' | 'reference' | 'string' | 'number' | 'operator' | 'literal';
export interface FormulaHighlightSpan { start: number; end: number; kind: FormulaHighlightKind }
export const MAX_HIGHLIGHT_LENGTH = 32768;
export const MAX_HIGHLIGHT_TOKENS = 1024;
const delimiter = /[\s[\]{}(),:+\-*/^%<>=!?&|."`]/u;
export function highlightFormula(source: string): FormulaHighlightSpan[] | null {
  if (source.length > MAX_HIGHLIGHT_LENGTH || !source.trimStart().startsWith('=')) return null;
  const spans: FormulaHighlightSpan[] = [];
  let i = 0, previous = '';
  while (i < source.length) {
    if (/\s/u.test(source[i])) { i++; continue; }
    if (spans.length >= MAX_HIGHLIGHT_TOKENS) return null;
    const start = i, char = source[i];
    let kind: FormulaHighlightKind;
    if (char === '"' || char === '`') {
      i++;
      while (i < source.length) {
        if (source[i++] !== char) continue;
        if (source[i] === char) { i++; continue; }
        break;
      }
      kind = char === '"' ? 'string' : 'reference';
    } else {
      const number = /[\d.]/.test(char) ? source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/) : null;
      if (number && previous !== '.') { i += number[0].length; kind = 'number'; }
      else if (delimiter.test(char)) {
        i += ['=>', '&&', '||', '<=', '>=', '==', '!=', '<>'].includes(source.slice(i, i + 2)) ? 2 : 1;
        kind = 'operator';
      } else {
        while (i < source.length && !delimiter.test(source[i])) i++;
        let next = i;
        while (next < source.length && /\s/u.test(source[next])) next++;
        const name = source.slice(start, i);
        kind = previous === '.' ? 'reference' : source[next] === '(' ? 'function' : /^(true|false)$/i.test(name) ? 'literal' : 'name';
      }
    }
    spans.push({ start, end: i, kind }); previous = source.slice(start, i);
  }
  return spans;
}
