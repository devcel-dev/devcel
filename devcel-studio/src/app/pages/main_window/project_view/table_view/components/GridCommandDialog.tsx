import { useRef, useState } from 'react';
import { isComposingKey } from '@/app/utils/shortcutGuards';
import { useI18n } from '@/app/i18n';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { parseClipboardTsv } from './gridClipboard';
import { readGridClipboard, type ClipboardPayload } from './gridClipboardPayload';

export interface ReplaceCell { recordUuid: string; columnUuid: string; raw: string; selected: boolean }
export interface GridCommandRequest {
  kind: 'replace' | 'goto' | 'paste';
  rowCount: number; columnCount: number; row: number; column: number;
  transposed: boolean; tableName: string; cells: ReplaceCell[];
  goTo: (row: number, column: number) => boolean;
  replace: (cells: ReplaceCell[], query: string, replacement: string) => Promise<boolean>;
  paste: (rows: string[][], types?: string[][]) => Promise<boolean>;
}

export function matchingReplacementCells(cells: ReplaceCell[], scope: 'selection' | 'visible', query: string): ReplaceCell[] {
  return query ? cells.filter(cell => (scope === 'visible' || cell.selected) && cell.raw.includes(query)) : [];
}

export function GridCommandDialog({ request, onClose }: { request: GridCommandRequest; onClose: () => void }) {
  const { t } = useI18n();
  const composing = useRef(false);
  const [row, setRow] = useState(String(request.row + 1));
  const [column, setColumn] = useState(String(request.column + 1));
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [scope, setScope] = useState<'selection' | 'visible'>('selection');
  const [clipboard, setClipboard] = useState('');
  const [payload, setPayload] = useState<ClipboardPayload | null>(null);
  const [pasteValues, setPasteValues] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const matches = matchingReplacementCells(request.cells, scope, query);
  const parsed = parseClipboardTsv(clipboard);
  const valuesAvailable = !!payload && payload.cells.every(cells => cells.every(cell => cell.value !== null));
  const validCoordinate = /^\d+$/.test(row) && /^\d+$/.test(column)
    && Number(row) >= 1 && Number(row) <= request.rowCount && Number(column) >= 1 && Number(column) <= request.columnCount;
  const valid = request.kind === 'goto' ? validCoordinate : request.kind === 'replace' ? matches.length > 0 && query !== replacement
    : !!parsed?.length && (!pasteValues || valuesAvailable);
  const apply = async () => {
    if (!valid || busy) return;
    setBusy(true); setFailed(false);
    try {
      const success = request.kind === 'goto' ? request.goTo(Number(row) - 1, Number(column) - 1)
        : request.kind === 'replace' ? await request.replace(matches, query, replacement)
          : await request.paste(pasteValues ? payload!.cells.map(cells => cells.map(cell => cell.value!)) : parsed!,
            pasteValues ? payload!.cells.map(cells => cells.map(cell => cell.type)) : undefined);
      if (success) onClose(); else setFailed(true);
    } finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy} onCloseAutoFocus={event => event.preventDefault()}
      onCompositionStartCapture={() => { composing.current = true; }}
      onCompositionEndCapture={() => { composing.current = false; }}
      onEscapeKeyDown={event => { if (composing.current || isComposingKey(event)) event.preventDefault(); }}
      onKeyDownCapture={event => {
        if (event.key === 'Enter' && (composing.current || isComposingKey(event.nativeEvent))) {
          event.preventDefault(); event.stopPropagation();
        }
      }}>
      <DialogTitle>{t(`grid.commands.${request.kind}`)}</DialogTitle>
      <DialogDescription>{request.tableName} — {t('grid.commands.visibleCoordinates')}
        {request.transposed ? ` · ${t('grid.transpose')}` : ''} ({request.rowCount} × {request.columnCount})</DialogDescription>
      <form onSubmit={event => { event.preventDefault(); if (!composing.current) void apply(); }} className="grid gap-3">
        <fieldset disabled={busy} className="grid gap-3">
          {request.kind === 'goto' && <>
            <label>{t('grid.commands.row')}<input autoFocus inputMode="numeric" value={row} onChange={event => setRow(event.target.value)} className="ms-2 border p-2" /></label>
            <label>{t('grid.commands.column')}<input inputMode="numeric" value={column} onChange={event => setColumn(event.target.value)} className="ms-2 border p-2" /></label>
          </>}
          {request.kind === 'replace' && <>
            <label>{t('grid.commands.scope')}<select value={scope} onChange={event => setScope(event.target.value as 'selection' | 'visible')} className="ms-2 border p-2">
              <option value="selection">{t('grid.commands.selection')}</option><option value="visible">{t('grid.commands.visible')}</option>
            </select></label>
            <label>{t('common.search')}<input autoFocus value={query} onChange={event => setQuery(event.target.value)} className="ms-2 border p-2" /></label>
            <label>{t('grid.commands.replacement')}<input value={replacement} onChange={event => setReplacement(event.target.value)} className="ms-2 border p-2" /></label>
            <p>{t('grid.commands.literalMatch')} · {t('grid.commands.matchCount', { count: String(matches.length) })}</p>
          </>}
          {request.kind === 'paste' && <>
            <label>{t('grid.commands.pasteHere')}<textarea autoFocus value={clipboard} className="block w-full border p-2"
              onChange={event => { setClipboard(event.target.value); setPayload(null); setPasteValues(false); }}
              onPaste={event => {
                event.preventDefault(); event.stopPropagation();
                const text = event.clipboardData.getData('text/plain');
                setClipboard(text); setPayload(readGridClipboard(text, event.clipboardData.getData('text/html'))); setPasteValues(false);
              }} /></label>
            <label><input type="radio" checked={!pasteValues} onChange={() => setPasteValues(false)} /> {t('grid.commands.raw')}</label>
            {valuesAvailable && <label><input type="radio" checked={pasteValues} onChange={() => setPasteValues(true)} /> {t('grid.commands.values')}</label>}
            {!valuesAvailable && <p>{t('grid.commands.rawOnly')}</p>}
            <p>{parsed ? `${parsed.length} × ${parsed[0]?.length ?? 0}` : t('grid.invalidClipboardText')}</p>
          </>}
        </fieldset>
        {failed && <p role="alert">{t('grid.commands.notApplied')}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" disabled={!valid || busy}>{t('common.apply')}</button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
