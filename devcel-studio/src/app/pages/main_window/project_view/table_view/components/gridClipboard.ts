/** Clipboard transport only. Cell input interpretation and validation stay in Rust. */
export function serializeClipboardTsv(rows: readonly (readonly string[])[]): string {
  let text = rows.map(row => row.map(value => /["\t\r\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value).join('\t')).join('\n');
  // A final record terminator is ignored on paste. Keep an empty final record,
  // while retaining the existing empty single-cell clipboard no-op.
  const lastRow = rows[rows.length - 1];
  if (rows.length > 1 && lastRow?.length === 1 && lastRow[0] === '') text += '\n';
  return text;
}

/**
 * Excel-style quoted TSV. CR, LF and CRLF delimit records only outside quotes;
 * embedded line endings are preserved byte for byte. Only a leading quote opens
 * a quoted field, so quotes in unquoted formulas and ordinary text stay literal.
 * Invalid quoting or nonrectangular rows are rejected without partial results.
 */
export function parseClipboardTsv(text: string): string[][] | null {
  if (!text) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let index = 0;
  while (true) {
    let value: string;
    if (text[index] === '"') {
      let segmentStart = ++index;
      const segments: string[] = [];
      let closed = false;
      while (index < text.length) {
        if (text[index] !== '"') { index++; continue; }
        segments.push(text.slice(segmentStart, index));
        if (text[index + 1] === '"') {
          segments.push('"');
          index += 2;
          segmentStart = index;
        } else {
          index++;
          closed = true;
          break;
        }
      }
      if (!closed) return null;
      value = segments.join('');
      // Whitespace after a closing quote is data, not harmless padding.
      if (index < text.length && !/[\t\r\n]/.test(text[index])) return null;
    } else {
      const start = index;
      while (index < text.length && text[index] !== '\t' && text[index] !== '\r' && text[index] !== '\n') index++;
      value = text.slice(start, index);
    }
    row.push(value);
    if (index === text.length) { rows.push(row); break; }
    if (text[index] === '\t') { index++; continue; }
    rows.push(row);
    row = [];
    if (text[index] === '\r' && text[index + 1] === '\n') index++;
    index++;
    if (index === text.length) break;
  }
  const width = rows[0].length;
  return rows.every(row => row.length === width) ? rows : null;
}
