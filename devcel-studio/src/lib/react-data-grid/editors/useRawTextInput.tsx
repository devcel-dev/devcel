import { useI18n } from '@/app/i18n';
import { PhysicalGridNotice } from '../PhysicalGridNotice';
import { useEffect, useRef, useState, useId, type FormEvent, type RefObject } from 'react';

type TextInput = HTMLInputElement | HTMLTextAreaElement;
type Edit = { start: number; removed: string; inserted: string };
const MAX_EDITS = 128;
const MAX_HISTORY_UNITS = 262144;

type Selection = { start: number; end: number; inputType: string };

export function normalizeTextNewlines(raw: string): string {
  return raw.replace(/\r\n?/g, '\n');
}

function rawOffset(raw: string, displayOffset: number): number {
  let index = 0;
  for (let offset = 0; offset < displayOffset && index < raw.length; offset++, index++) {
    if (raw[index] === '\r' && raw[index + 1] === '\n') index++;
  }
  return index;
}

/** Keep raw line endings outside the edit, although textarea.value exposes only LF. */
export class RawTextInputValue {
  raw: string;
  private selection: Selection | null = null;
  // Store changed fragments, not a complete copy of a possibly large cell per key.
  private edits: Edit[] = [];
  private index = 0;
  private historyUnits = 0;
  private readonly initialRaw: string;
  private initialJump: { raw: string; index: number } | null = null;
  private composition: { start: number; end: number } | null = null;
  blocked = false;

  constructor(raw: string) { this.raw = raw; this.initialRaw = raw; }

  capture(start: number, end: number, inputType: string) {
    this.selection = inputType === 'insertCompositionText' && this.composition
      ? { ...this.composition, inputType }
      : { start, end, inputType };
  }

  startComposition(start: number, end: number) { this.composition = { start, end }; }
  endComposition() { this.composition = null; }

  reset(raw: string) {
    this.raw = raw;
    this.selection = null;
    this.edits = [];
    this.index = 0;
    this.historyUnits = 0;
    this.initialJump = null;
    this.composition = null;
    this.blocked = false;
  }

  update(value: string, inputType = ''): string {
    this.blocked = false;
    const next = normalizeTextNewlines(value);
    const before = normalizeTextNewlines(this.raw);
    const selection = this.selection;
    this.selection = null;
    inputType ||= selection?.inputType ?? '';

    // A native undo can group several input events. Replay raw fragments until
    // its displayed result is reached, restoring deleted CR/CRLF exactly.
    if (inputType === 'historyUndo' || inputType === 'historyRedo') {
      if (this.initialJump) {
        if (inputType === 'historyRedo' && normalizeTextNewlines(this.initialJump.raw) === next) {
          this.raw = this.initialJump.raw;
          this.index = this.initialJump.index;
          this.initialJump = null;
          return this.raw;
        }
        if (next === before) return this.raw;
        this.blocked = true;
        return this.raw;
      }
      let candidate = this.raw;
      let match: { raw: string; index: number } | undefined;
      const backward = inputType === 'historyUndo';
      for (let index = this.index; backward ? index > 0 : index < this.edits.length;) {
        const edit = this.edits[backward ? --index : index++];
        const removed = backward ? edit.inserted : edit.removed;
        const inserted = backward ? edit.removed : edit.inserted;
        candidate = candidate.slice(0, edit.start) + inserted + candidate.slice(edit.start + removed.length);
        if (normalizeTextNewlines(candidate) === next) {
          if (match && match.raw !== candidate) {
            this.blocked = true;
            return this.raw;
          }
          match ??= { raw: candidate, index };
        }
      }
      const matchesInitial = backward && normalizeTextNewlines(this.initialRaw) === next;
      if (matchesInitial && match && match.raw !== this.initialRaw) {
        this.blocked = true;
        return this.raw;
      }
      if (match) {
        this.raw = match.raw;
        this.index = match.index;
        return this.raw;
      }
      if (matchesInitial) {
        this.initialJump = { raw: this.raw, index: this.index };
        this.raw = this.initialRaw;
        return this.raw;
      }
      if (!this.initialRaw.includes('\r')) {
        this.reset(next);
        return next;
      }
      // Native history may outlive our bounded journal. Never guess the CR/CRLF
      // distribution of an unknown historical value; keep the current raw value.
      this.blocked = true;
      return this.raw;
    }

    let start = 0;
    let end = before.length;
    let insertedEnd = next.length;
    let anchored = false;
    if (selection) {
      start = selection.start;
      end = selection.end;
      if (start === end && inputType.startsWith('delete')) {
        const count = before.length - next.length;
        if (inputType.endsWith('Backward')) start -= count;
        else if (inputType.endsWith('Forward')) end += count;
      }
      insertedEnd = next.length - (before.length - end);
      anchored = start >= 0 && end <= before.length && insertedEnd >= start
        && before.slice(0, start) === next.slice(0, start)
        && before.slice(end) === next.slice(insertedEnd);
    }
    if (!anchored) {
      start = 0;
      while (start < before.length && start < next.length && before[start] === next[start]) start++;
      if (next === before) return this.raw;
      let suffix = 0;
      while (suffix < before.length && suffix < next.length
        && before[before.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
      const earliest = Math.min(before.length, next.length) - suffix;
      if (earliest < start && this.raw.slice(rawOffset(this.raw, earliest),
        rawOffset(this.raw, start + Math.max(0, before.length - next.length))).includes('\r')) {
        // Repeated visible text can admit edits at different mixed-newline
        // boundaries. Without a reliable beforeinput range, do not choose one.
        this.blocked = true;
        return this.raw;
      }
      end = before.length;
      insertedEnd = next.length;
      while (end > start && insertedEnd > start && before[end - 1] === next[insertedEnd - 1]) {
        end--;
        insertedEnd--;
      }
    }

    const rawStart = rawOffset(this.raw, start);
    const rawEnd = rawOffset(this.raw, end);
    const inserted = next.slice(start, insertedEnd); // New line breaks always use LF.
    const removed = this.raw.slice(rawStart, rawEnd);
    if (removed !== inserted) {
      if (this.initialJump) {
        this.edits = [];
        this.index = 0;
        this.historyUnits = 0;
        this.initialJump = null;
      }
      for (const edit of this.edits.splice(this.index)) this.historyUnits -= edit.removed.length + edit.inserted.length;
      this.edits.push({ start: rawStart, removed, inserted });
      this.historyUnits += removed.length + inserted.length;
      this.index++;
      while (this.edits.length > MAX_EDITS || this.historyUnits > MAX_HISTORY_UNITS) {
        const edit = this.edits.shift()!;
        this.historyUnits -= edit.removed.length + edit.inserted.length;
        this.index--;
      }
      this.raw = this.raw.slice(0, rawStart) + inserted + this.raw.slice(rawEnd);
    }
    if (this.composition && inputType === 'insertCompositionText') this.composition = { start, end: insertedEnd };
    return this.raw;
  }
}

export function useRawTextInput(
  initialValue: string,
  multiline: boolean,
  inputRef: RefObject<TextInput | null>
) {
  const modelRef = useRef<RawTextInputValue | null>(null);
  modelRef.current ??= new RawTextInputValue(initialValue);
  const [value, setValue] = useState(initialValue);
  const [blocked, setBlocked] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const blockedRef = useRef(false);
  const replacementRef = useRef(false);
  const alertId = useId();

  useEffect(() => {
    const input = inputRef.current;
    if (!multiline || !input) return;
    // Native beforeinput is used because React's compatibility event can omit
    // inputType/selection for deletion, history, and composition operations.
    const capture = (event: Event) => {
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      replacementRef.current = blockedRef.current && start === 0 && end === input.value.length;
      modelRef.current!.capture(start, replacementRef.current ? normalizeTextNewlines(modelRef.current!.raw).length : end,
        (event as InputEvent).inputType);
    };
    const startComposition = () => modelRef.current!.startComposition(input.selectionStart ?? 0, input.selectionEnd ?? 0);
    const endComposition = () => modelRef.current!.endComposition();
    const checkCommit = (event: Event) => {
      if (blockedRef.current || input.value !== normalizeTextNewlines(modelRef.current!.raw)) {
        event.preventDefault();
        blockedRef.current = true;
        input.setAttribute('data-rdg-editor-blocked', 'true');
        setBlocked(true);
        setDraft(input.value);
      }
    };
    input.addEventListener('rdg-editor-commit-check', checkCommit);
    input.addEventListener('beforeinput', capture);
    input.addEventListener('compositionstart', startComposition);
    input.addEventListener('compositionend', endComposition);
    return () => {
      input.removeEventListener('rdg-editor-commit-check', checkCommit);
      input.removeEventListener('beforeinput', capture);
      input.removeEventListener('compositionstart', startComposition);
      input.removeEventListener('compositionend', endComposition);
    };
  }, [inputRef, multiline]);

  function update(event: FormEvent<TextInput>): string | null {
    const input = event.currentTarget;
    const inputType = (event.nativeEvent as InputEvent).inputType ?? '';
    const displayed = normalizeTextNewlines(input.value);
    if (blockedRef.current && !replacementRef.current && !inputType.startsWith('history')
      && displayed !== normalizeTextNewlines(modelRef.current!.raw)) {
      setDraft(displayed);
      return null;
    }
    const next = multiline ? modelRef.current!.update(displayed, inputType) : input.value;
    blockedRef.current = modelRef.current!.blocked;
    replacementRef.current = false;
    setBlocked(blockedRef.current);
    // Set synchronously so outside-click/toolbar handlers in this event cannot
    // commit the last accepted row while an unsafe draft is being displayed.
    if (blockedRef.current) {
      input.setAttribute('data-rdg-editor-blocked', 'true');
      setDraft(displayed);
      return null;
    }
    input.removeAttribute('data-rdg-editor-blocked');
    setDraft(null);
    setValue(next);
    return next;
  }

  function reset(next: string) {
    modelRef.current!.reset(next);
    setBlocked(false);
    blockedRef.current = false;
    inputRef.current?.removeAttribute('data-rdg-editor-blocked');
    setDraft(null);
    setValue(next);
  }

  function replaceRange(start: number, end: number, text: string, caretOffset = text.length): string | null {
    const input = inputRef.current;
    if (!input || blockedRef.current || input.readOnly || input.disabled
      || start < 0 || end < start || end > input.value.length) return null;
    if (multiline && input.value !== normalizeTextNewlines(modelRef.current!.raw)) return null;
    const displayed = input.value.slice(0, start) + text + input.value.slice(end);
    modelRef.current!.capture(start, end, 'insertReplacementText');
    const next = multiline ? modelRef.current!.update(displayed, 'insertReplacementText') : displayed;
    if (modelRef.current!.blocked) return null;
    setValue(next);
    setDraft(null);
    input.value = displayed;
    input.setSelectionRange(start + caretOffset, start + caretOffset);
    return next;
  }

  return { value, blocked, alertId, displayValue: draft ?? (multiline ? normalizeTextNewlines(value) : value), update, reset, replaceRange };
}

export function RawTextInputNotice({ id, anchorRef }: { id: string; anchorRef: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  return <PhysicalGridNotice id={id} anchorRef={anchorRef} style={{ position: 'absolute', top: '100%', left: 0, zIndex: 1000,
    padding: '6px 12px', color: '#991b1b', background: '#fee2e2', border: '1px solid #dc2626',
    whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 220, maxWidth: 'min(360px, 90vw)' }}>
    {t('grid.newlinePreservationFailed')}
  </PhysicalGridNotice>;
}
