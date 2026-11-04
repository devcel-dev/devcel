import { FormulaSuggestions } from '@/app/components/formula/FormulaSuggestions';
import { FormulaCompletionProvider } from '@/app/components/formula/FormulaCompletionProvider';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { WrapText, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import './ExpandedStringEditor.css';
import { useI18n } from '@/app/i18n';
import { columnDraftStore } from '@/app/utils/columnDraftLifecycle';
import { useRawTextInput } from '@/lib/react-data-grid/editors/useRawTextInput';

export interface StringEditorTarget {
  recordUuid: string;
  columnUuid: string;
  label: string;
  value: string;
  revision: string;
}
interface Props {
  target: StringEditorTarget;
  tableUuid: string;
  projectSessionId: string;
  currentRevision?: string;
  busy: boolean;
  error: string | null;
  onCommit: (value: string, revision: string) => Promise<boolean>;
  onClose: () => void;
  onCloseCancelled?: () => void;
  closeRequest?: number;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}
interface Draft { value: string; original: string; revision: string; blockedDisplay?: string }

/** Only the opened cell owns a textarea, raw-newline journal and recovery draft. */
export function ExpandedStringEditor({ target, tableUuid, projectSessionId, currentRevision, busy, error, onCommit, onClose, onCloseCancelled, closeRequest = 0, inputRef: suppliedInputRef }: Props) {
  const { t } = useI18n();
  const key = `${projectSessionId}:devcel:text-draft:${tableUuid}:${target.recordUuid}:${target.columnUuid}`;
  const [initial] = useState<Draft>(() => {
    try {
      const cached = JSON.parse(columnDraftStore.read(key) || 'null') as Draft | null;
      if (cached && typeof cached.value === 'string' && typeof cached.original === 'string' && typeof cached.revision === 'string') return cached;
    } catch { /* An unavailable recovery cache must not prevent ordinary editing. */ }
    return { value: target.value, original: target.value, revision: target.revision };
  });
  const localInputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = suppliedInputRef ?? localInputRef;
  const { value, displayValue, update, blocked, alertId, replaceRange } = useRawTextInput(initial.value, true, inputRef);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [wrapped, setWrapped] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const saving = useRef(false);
  const recoveredBlocked = typeof initial.blockedDisplay === 'string';
  const unsafe = blocked || recoveredBlocked;
  const locked = busy || isSaving;
  const dirty = !saved && (value !== initial.original || unsafe);
  const stale = currentRevision !== undefined && currentRevision !== initial.revision;

  useEffect(() => {
    if (dirty) columnDraftStore.write(key, JSON.stringify({ value, original: initial.original, revision: initial.revision, ...(unsafe ? { blockedDisplay: initial.blockedDisplay ?? displayValue } : {}) }));
    else columnDraftStore.remove(key);
  }, [key, dirty, value, initial, unsafe, displayValue]);
  useEffect(() => {
    if (confirmClose) cancelRef.current?.focus();
  }, [confirmClose]);

  const requestCloseRef = useRef<() => void>(() => {});
  requestCloseRef.current = requestClose;
  useEffect(() => { if (closeRequest) requestCloseRef.current(); }, [closeRequest]);
  useEffect(() => { inputRef.current?.focus(); }, [inputRef]);

  function finish() {
    if (saving.current) return;
    columnDraftStore.remove(key);
    onClose();
  }
  function requestClose() {
    if (busy || saving.current) { setConfirmClose(true); return; }
    if (dirty) setConfirmClose(true);
    else finish();
  }
  function keepEditing() {
    setConfirmClose(false);
    onCloseCancelled?.();
    inputRef.current?.focus();
  }
  async function save() {
    if (saved) { finish(); return; }
    if (busy || saving.current || composing.current || unsafe || stale) return;
    // Check native text too: WebKit may expose a changed DOM before React sees input.
    if (!inputRef.current?.dispatchEvent(new Event('rdg-editor-commit-check', { cancelable: true }))) return;
    if (!dirty) { finish(); return; }
    saving.current = true;
    setIsSaving(true);
    try {
      if (await onCommit(value, initial.revision)) {
        saving.current = false;
        setSaved(true);
        finish();
      }
    } finally { saving.current = false; setIsSaving(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open) requestClose(); }}>
    <DialogContent className="string-editor-dialog flex h-auto w-[min(560px,calc(100vw-24px))] max-w-none gap-2 overflow-auto p-3 [&>button]:hidden" aria-describedby={undefined}
      onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }}
      onCloseAutoFocus={event => event.preventDefault()}
      onPointerDownOutside={event => { event.preventDefault(); requestClose(); }}
      onInteractOutside={event => event.preventDefault()}
      onEscapeKeyDown={event => {
        event.preventDefault();
        // Radix sees Escape during document capture, before the input popup.
        // Let the focused completion consume it without closing this editor.
        if (inputRef.current?.getAttribute('aria-expanded') === 'true') return;
        event.stopPropagation();
        if (event.isComposing || event.keyCode === 229 || composing.current) return;
        if (confirmClose) keepEditing(); else requestClose();
      }}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
        }}
        onPaste={event => event.stopPropagation()} onCopy={event => event.stopPropagation()} onCut={event => event.stopPropagation()}>
        <header className="string-editor-header">
          <div className="string-editor-title"><DialogTitle>{t('grid.stringEditorTitle')}</DialogTitle><p>{target.label}</p></div>
          <button type="button" aria-label={t('grid.stringWrap')} title={t('grid.stringWrap')} aria-pressed={wrapped} onClick={() => setWrapped(v => !v)}><WrapText size={17} /></button>
          <button type="button" aria-label={t('common.close')} title={t('common.close')} disabled={locked} onClick={requestClose}><X size={18} /></button>
        </header>
        <div className="string-editor-input-area">
          <textarea ref={inputRef} rows={4} aria-label={t('grid.stringEditorTitle')} value={initial.blockedDisplay ?? displayValue} wrap={wrapped ? 'soft' : 'off'}
            readOnly={locked || recoveredBlocked || saved} spellCheck={false} data-rdg-raw-text-editor="true" data-rdg-editor-blocked={unsafe || undefined}
            aria-invalid={unsafe || undefined} aria-describedby={unsafe ? alertId : undefined}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onInput={event => { update(event); if (confirmClose) onCloseCancelled?.(); setConfirmClose(false); }} />
          <FormulaCompletionProvider session={projectSessionId} tableUuid={tableUuid}><FormulaSuggestions inputRef={inputRef} disabled={locked || unsafe || saved || stale || confirmClose} onAccept={(start, end, text, caret) => { replaceRange(start, end, text, caret); }} /></FormulaCompletionProvider>
        </div>
        {unsafe && <p id={alertId} role="alert" className="string-editor-error">{t('grid.newlinePreservationFailed')}</p>}
        {stale && <p role="alert" className="string-editor-error">{t('grid.stringEditorStale')}</p>}
        {error && <p role="alert" className="string-editor-error">{error}</p>}
        {confirmClose && <section role="alertdialog" aria-label={t('column.unsavedChanges')} className="string-editor-confirm">
          <p>{t('grid.stringEditorUnsaved')}</p>
          <div><button type="button" disabled={locked || unsafe || stale} onClick={() => void save()}>{t('common.save')}</button>
            <button type="button" disabled={locked} onClick={finish}>{t('column.discardAndClose')}</button>
            <button type="button" ref={cancelRef} disabled={locked} onClick={keepEditing}>{t('common.cancel')}</button></div>
        </section>}
    </DialogContent>
  </Dialog>;
}
