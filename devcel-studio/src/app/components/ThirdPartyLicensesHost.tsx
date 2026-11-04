import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '@/app/i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { closeThirdPartyLicenses, getLicensesOpen, subscribeLicenses, restoreLicensesFocus } from '@/app/utils/third_party_licenses';

type Entry = { id: number; title: string };
function LicenseContents() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState({ text: '', page: 0, count: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const worker = useRef<Worker | null>(null);
  const request = useRef(0);
  const text = useRef<HTMLPreElement>(null);
  const loadPage = (id: string, page = 0) => {
    const next = ++request.current;
    setResult({ text: '', page: 0, count: 0 });
    setLoading(!!id);
    if (id) worker.current?.postMessage({ kind: 'page', id: Number(id), page, request: next });
  };
  useEffect(() => {
    let active = true;
    let instance: Worker | undefined;
    try {
      instance = new Worker(new URL('../utils/third_party_licenses.worker.ts', import.meta.url), { type: 'module' });
      worker.current = instance;
      instance.onmessage = event => {
        if (!active) return;
        const data = event.data;
        if (data.kind === 'index') {
          setEntries(data.entries);
          const id = data.entries.length ? String(data.entries[0].id) : '';
          setSelected(id); loadPage(id);
        } else if (data.kind === 'page' && data.request === request.current) {
          setResult({ text: data.text, page: data.page, count: data.count }); setLoading(false);
          if (text.current) text.current.scrollTop = 0;
        } else if (data.kind === 'error') {
          setError(data.message); setLoading(false); instance?.terminate();
        }
      };
      instance.onerror = event => { if (active) { setError(event.message); setLoading(false); instance?.terminate(); } };
      instance.postMessage({ kind: 'load' });
    } catch (failure) { setError(String(failure)); setLoading(false); }
    return () => { active = false; instance?.terminate(); worker.current = null; };
  }, []);
  const filtered = entries.filter(entry => entry.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    <DialogHeader><DialogTitle>{t('menu.ossLicenses')}</DialogTitle></DialogHeader>
    <Input type="search" aria-label={t('common.search')} placeholder={t('common.searchPlaceholder')} value={query}
      onChange={event => {
        const value = event.target.value; setQuery(value);
        const matches = entries.filter(entry => entry.title.toLocaleLowerCase().includes(value.toLocaleLowerCase()));
        const id = matches.some(entry => String(entry.id) === selected) ? selected : (matches[0] ? String(matches[0].id) : '');
        setSelected(id); loadPage(id);
      }} />
    <select aria-label={t('menu.ossLicenses')} className="h-9 w-full min-w-0 shrink-0 rounded-md border border-input bg-background px-3 text-sm text-foreground" disabled={!filtered.length} value={selected}
      onChange={event => { setSelected(event.target.value); loadPage(event.target.value); }}>
      {filtered.map(entry => <option key={entry.id} value={String(entry.id)}>{entry.title}</option>)}
    </select>
    <div role="status" className="shrink-0 break-words text-sm text-muted-foreground">{error || (loading ? t('common.loading') : !filtered.length ? '0' : '')}</div>
    <pre ref={text} tabIndex={0} className="m-0 min-h-0 min-w-0 flex-1 select-text overflow-auto overscroll-contain whitespace-pre-wrap break-words font-mono text-sm leading-relaxed [overflow-wrap:anywhere]">{result.text}</pre>
    <DialogFooter className="shrink-0 items-center">
      <Button variant="outline" disabled={loading || result.page === 0} onClick={() => loadPage(selected, result.page - 1)}>{t('common.back')}</Button>
      <span className="text-sm" aria-live="polite">{result.count ? `${result.page + 1} / ${result.count}` : ''}</span>
      <Button variant="outline" disabled={loading || result.page + 1 >= result.count} onClick={() => loadPage(selected, result.page + 1)}>{t('common.next')}</Button>
      <Button onClick={closeThirdPartyLicenses}>{t('common.close')}</Button>
    </DialogFooter>
  </>;
}
export function ThirdPartyLicensesHost() {
  const open = useSyncExternalStore(subscribeLicenses, getLicensesOpen, getLicensesOpen);
  return <Dialog open={open} onOpenChange={value => { if (!value) closeThirdPartyLicenses(); }}>
    <DialogContent id="third-party-licenses" aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); restoreLicensesFocus(); }} className="flex h-[min(760px,90dvh)] max-w-4xl flex-col gap-3 overflow-hidden">
      {open && <LicenseContents />}
    </DialogContent>
  </Dialog>;
}
