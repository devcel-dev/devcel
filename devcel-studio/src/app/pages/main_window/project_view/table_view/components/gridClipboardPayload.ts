import { parseClipboardTsv } from './gridClipboard';

// Metadata travels WITH the OS clipboard, never in a process-local last-copy cache.
// Copying in another app therefore cannot accidentally reuse an old Devcel value.
const marker = 'devcel-cells-v1:';
const limit = 4 * 1024 * 1024;
export interface ClipboardCell { raw: string; value: string | null; type: string }
export interface ClipboardPayload { text: string; cells: ClipboardCell[][] }

export async function writeGridClipboard(payload: ClipboardPayload): Promise<void> {
  const plain = new Blob([payload.text], { type: 'text/plain' });
  const encoded = JSON.stringify(payload);
  if (encoded.length <= limit && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
    const bytes = new TextEncoder().encode(encoded);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    // No HTML supplied by a cell is interpreted as markup.
    const html = new Blob([`<!--${marker}${btoa(binary)}-->`], { type: 'text/html' });
    try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': plain, 'text/html': html })]); return; }
    catch (error) {
      // Unsupported rich formats may fall back; permission denial is not retried.
      if (!(error instanceof DOMException) || error.name !== 'NotSupportedError') throw error;
    }
  }
  await navigator.clipboard.writeText(payload.text);
}

export function readGridClipboard(text: string, html: string): ClipboardPayload | null {
  if (text.length > limit || html.length > limit * 2) return null;
  const match = /<!--devcel-cells-v1:([A-Za-z0-9+/=]+)-->/g;
  const found = [...html.matchAll(match)];
  if (found.length !== 1) return null;
  try {
    const bytes = Uint8Array.from(atob(found[0][1]), char => char.charCodeAt(0));
    const candidate: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!candidate || typeof candidate !== 'object') return null;
    const value = candidate as ClipboardPayload;
    const rows = parseClipboardTsv(text);
    if (value.text !== text || !rows?.length || !Array.isArray(value.cells) || value.cells.length !== rows.length) return null;
    for (let r = 0; r < rows.length; r++) {
      if (!Array.isArray(value.cells[r]) || value.cells[r].length !== rows[r].length) return null;
      for (let c = 0; c < rows[r].length; c++) {
        const cell = value.cells[r][c];
        if (!cell || typeof cell.raw !== 'string' || typeof cell.type !== 'string'
          || !(cell.value === null || typeof cell.value === 'string') || cell.raw !== rows[r][c]) return null;
        if (cell.value !== null && literalClipboardValue(cell.type, cell.value) === null) return null;
      }
    }
    return value;
  } catch { return null; }
}

/** Only canonical primitive strings are safe as direct inputs. No formula guessing. */
export function literalClipboardValue(type: string, value: string, failed = false): string | null {
  // Empty raw input means inheritance, so it cannot represent a literal empty value.
  if (failed || value === '' || value.startsWith('=') || !/^(String|Bool|Boolean|[UI](8|16|32|64)|F(32|64)|DateTime)$/.test(type)) return null;
  return value;
}
