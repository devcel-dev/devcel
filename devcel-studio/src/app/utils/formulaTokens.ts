/** Tolerant editor tokens. Offsets are UTF-16, matching DOM selectionStart/End.
 * This does not evaluate expressions or replace the native formula parser.
 */
export interface FormulaToken {
  kind: 'name' | 'string' | 'quoted-name' | 'punctuation';
  text: string;
  start: number;
  end: number;
  closed: boolean;
  contentOffsets?: number[];
}

const separators = /[\s[\]{}(),:+\-*/<>=!?&|."`]/u;

export function quoteFormulaName(name: string): string {
  // Always quote schema names: native quoted names bypass local bindings and
  // literal interpretation (for example a column named TRUE or 123).
  return '`' + name.replace(/`/g, '``') + '`';
}

export function quoteFormulaString(value: string): string {
  // Literal strings use doubled quotes. Interpolation must remain literal too.
  return '"' + value.replace(/\$\{/g, () => '$${').replace(/"/g, '""') + '"';
}

export function tokenizeFormula(source: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    if (/\s/u.test(source[offset])) { offset++; continue; }
    const start = offset;
    const quote = source[offset];
    if (quote === '"' || quote === '`') {
      offset++;
      let text = '';
      let closed = false;
      const contentOffsets: number[] = [];
      while (offset < source.length) {
        if (source[offset] === quote) {
          if (source[offset + 1] === quote) {
            contentOffsets.push(offset);
            text += quote;
            offset += 2;
            continue;
          }
          contentOffsets.push(offset);
          offset++;
          closed = true;
          break;
        }
        contentOffsets.push(offset);
        text += source[offset++];
      }
      if (!closed) contentOffsets.push(offset);
      tokens.push({ kind: quote === '"' ? 'string' : 'quoted-name', text, start, end: offset, closed, contentOffsets });
    } else if (separators.test(source[offset])) {
      const pair = source.slice(offset, offset + 2);
      offset += ['=>', '&&', '||', '<=', '>=', '==', '!=', '<>'].includes(pair) ? 2 : 1;
      tokens.push({ kind: 'punctuation', text: source.slice(start, offset), start, end: offset, closed: true });
    } else {
      while (offset < source.length && !separators.test(source[offset])) offset++;
      tokens.push({ kind: 'name', text: source.slice(start, offset), start, end: offset, closed: true });
    }
  }
  return tokens;
}

/** Replace only the requested token/selection; keep both surrounding sides.
 * Reject stale or invalid ranges instead of silently corrupting the draft.
 */
export function insertFormulaCompletion(
  source: string, range: { start: number; end: number; expected: string }, insertion: string,
  caretOffset = insertion.length
): { value: string; caret: number } | null {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)
    || range.start < 0 || range.end < range.start || range.end > source.length
    || source.slice(range.start, range.end) !== range.expected
    || !Number.isInteger(caretOffset) || caretOffset < 0 || caretOffset > insertion.length) return null;
  // A DOM range must never split a supplementary Unicode character.
  const splitsPair = (at: number) => at > 0 && at < source.length
    && /[\uD800-\uDBFF]/u.test(source[at - 1]) && /[\uDC00-\uDFFF]/u.test(source[at]);
  if (splitsPair(range.start) || splitsPair(range.end)) return null;
  return { value: source.slice(0, range.start) + insertion + source.slice(range.end), caret: range.start + caretOffset };
}
