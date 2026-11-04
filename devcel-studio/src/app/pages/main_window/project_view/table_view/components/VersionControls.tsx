import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Check, Eye, SlidersHorizontal, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import './VersionControls.css';
import { usePhysicalViewport } from '@/lib/react-data-grid/DataGridViewportContext';
import { PhysicalGridNotice } from '@/lib/react-data-grid/PhysicalGridNotice';

const MAX_VERSION = 0xffffffff;

function parseVersion(draft: string): number | null {
  if (!/^\d+$/.test(draft)) return null;
  const value = Number(draft);
  return Number.isSafeInteger(value) && value <= MAX_VERSION ? value : null;
}

export interface VersionBadgeProps {
  value: number;
  onCommit: (value: number) => Promise<boolean>;
  disabled?: boolean;
  disabledReason?: string;
  label: string;
  messages: { invalid: string; saveFailed: string };
  /** Inherited metadata routes to its owner instead of creating a local override. */
  sourceReason?: string;
  onRequestSource?: () => void;
  /** Stable project/table/target identity; value changes also discard stale drafts. */
  contextKey?: string;
}

type BadgeEditor = { draft: string; error: 'invalid' | 'saveFailed' | null; saving: boolean };

/** A shared, controlled row/column badge. Callers mount it throughout edit + preview. */
export function VersionBadge({ value, onCommit, disabled = false, label, messages,
  sourceReason, onRequestSource, contextKey, disabledReason }: VersionBadgeProps) {
  const [editor, setEditor] = useState<BadgeEditor | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLSpanElement>(null);
  const requestFocus = usePhysicalViewport()?.requestFocus;
  const pendingFocusCancel = useRef<(() => void) | undefined>(undefined);
  const cancelFocus = useCallback(() => { pendingFocusCancel.current?.(); pendingFocusCancel.current = undefined; }, []);
  const focus = useCallback((element: HTMLElement | null, select = false) => {
    cancelFocus();
    if (!element?.isConnected) return;
    if (requestFocus) pendingFocusCancel.current = requestFocus(element, select);
    else {
      element.focus();
      if (select && element instanceof HTMLInputElement) element.select();
    }
  }, [cancelFocus, requestFocus]);
  const mounted = useRef(false);
  const operation = useRef(0);
  const phase = useRef<'closed' | 'editing' | 'saving'>('closed');
  const invalidateOperation = useCallback(() => {
    operation.current += 1;
    phase.current = 'closed';
  }, []);
  const draft = useRef(String(value));
  const restoreTrigger = useRef(false);
  const pendingFocus = useRef<{ identity: string; value: number; keyboard: boolean } | null>(null);
  const errorId = useId();
  const inherited = Boolean(sourceReason || onRequestSource);
  const identity = JSON.stringify([contextKey, inherited]);
  const context = JSON.stringify([identity, value]);
  const currentContext = useRef(context);
  currentContext.current = context;

  useLayoutEffect(() => {
    // The wrapper lives for the badge's whole lifetime, while its input changes.
    // Capture that stable owner and find its current input only at teardown.
    const element = wrapper.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelFocus();
      invalidateOperation();
      // WebKit must release native focus before the focused node disappears.
      element?.querySelector('input')?.blur();
    };
  }, [cancelFocus, invalidateOperation]);

  useLayoutEffect(() => {
    cancelFocus();
    invalidateOperation();
    const active = input.current?.ownerDocument.activeElement;
    // A successful parent's value echo may arrive before onCommit resolves.
    // Retain keyboard focus for that echo, but never for a different target.
    restoreTrigger.current = Boolean(pendingFocus.current?.keyboard
      && pendingFocus.current.identity === identity && pendingFocus.current.value === value
      && (!active || active === input.current?.ownerDocument.body || wrapper.current?.contains(active)));
    pendingFocus.current = null;
    input.current?.blur();
    setEditor(null);
  }, [identity, value, cancelFocus, invalidateOperation]);

  const isEditing = editor !== null;
  useLayoutEffect(() => {
    if (isEditing) {
      focus(input.current, true);
    } else if (restoreTrigger.current) {
      restoreTrigger.current = false;
      focus(trigger.current);
    }
    return cancelFocus;
  }, [isEditing, focus, cancelFocus]);

  const close = (restoreFocus: boolean) => {
    // Set the guard before blur: blur itself would otherwise try to commit again.
    cancelFocus();
    invalidateOperation();
    pendingFocus.current = null;
    restoreTrigger.current = restoreFocus;
    input.current?.blur();
    setEditor(null);
  };

  const canRestoreFocus = () => {
    const active = input.current?.ownerDocument.activeElement;
    return !active || active === input.current?.ownerDocument.body || Boolean(wrapper.current?.contains(active));
  };

  const commit = async (fromKeyboard: boolean) => {
    if (phase.current !== 'editing' || disabled || inherited) return;
    const next = parseVersion(draft.current);
    if (next === null) {
      setEditor(previous => previous && { ...previous, error: 'invalid' });
      return;
    }
    if (next === value) {
      close(fromKeyboard);
      return;
    }
    cancelFocus();
    const token = ++operation.current;
    phase.current = 'saving';
    pendingFocus.current = { identity, value: next, keyboard: fromKeyboard };
    input.current?.blur();
    setEditor(previous => previous && { ...previous, saving: true, error: null });
    let saved = false;
    try {
      saved = await onCommit(next);
    } catch {
      // Transport and validation failures both leave the user's draft recoverable.
    }
    if (!mounted.current || operation.current !== token || currentContext.current !== context) return;
    if (saved) {
      close(fromKeyboard && canRestoreFocus());
    } else {
      phase.current = 'editing';
      pendingFocus.current = null;
      setEditor(previous => previous && { ...previous, saving: false, error: 'saveFailed' });
      if (fromKeyboard && canRestoreFocus()) focus(input.current);
    }
  };

  const begin = () => {
    if (disabled || phase.current !== 'closed') return;
    if (inherited) {
      onRequestSource?.();
      return;
    }
    phase.current = 'editing';
    draft.current = String(value);
    setEditor({ draft: draft.current, error: null, saving: false });
  };
  const stop = (event: SyntheticEvent) => event.stopPropagation();
  const stopDrag = (event: SyntheticEvent) => { event.preventDefault(); event.stopPropagation(); };
  const error = editor?.error ? messages[editor.error] : null;

  return <span ref={wrapper} data-version-badge="true"
    className={`version-badge-wrap${isEditing ? ' is-editing' : ''}${inherited ? ' is-inherited' : ''}`}
    draggable={false} onPointerDown={stop} onPointerUp={stop} onMouseDown={stop} onMouseUp={stop}
    onClick={stop} onDoubleClick={stop} onAuxClick={stop} onContextMenu={stop}
    onDragStart={stopDrag} onDragEnd={stop} onDragOver={stop} onDrop={stopDrag}
    onKeyDown={stop} onKeyUp={stop}>
    {editor ? <span className={`version-badge-input${error ? ' is-invalid' : ''}${editor.saving ? ' is-saving' : ''}`}>
      <span aria-hidden="true">v</span>
      <input ref={input} type="text" inputMode="numeric" pattern="[0-9]*"
        aria-label={label} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
        aria-busy={editor.saving} readOnly={editor.saving || disabled} value={editor.draft}
        style={{ width: `${Math.max(3, Math.min(10, editor.draft.length))}ch` }}
        onChange={event => {
          if (phase.current !== 'editing' || disabled) return;
          draft.current = event.target.value;
          setEditor(previous => previous && { ...previous, draft: draft.current, error: null });
        }}
        onBlur={() => void commit(false)} onKeyDown={event => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); void commit(true); }
          if (event.key === 'Escape') {
            event.preventDefault();
            // An already submitted write is not cancellable through this UI.
            if (phase.current === 'editing') close(true);
          }
        }} />
    </span> : <button ref={trigger} type="button" className="version-badge"
      disabled={disabled || (inherited && !onRequestSource)} aria-label={`${label}: ${value}`}
      title={disabledReason || sourceReason || label} onClick={begin}>v{value}</button>}
    {error && <PhysicalGridNotice as="span" id={errorId} anchorRef={wrapper}
      align="right" offset={4} className="version-badge-error">{error}</PhysicalGridNotice>}
  </span>;
}

export interface VersionViewControlsLabels {
  view: string;
  viewSettings: string;
  zoom: string;
  adjustZoom: string;
  versionEdit: string;
  exitVersionEdit: string;
  preview: string;
  releaseVersion: string;
  invalidVersion: string;
  transpose?: string;
}

export interface VersionViewControlsProps {
  edit: boolean;
  preview: boolean;
  releaseVersion: number;
  onEditChange: (edit: boolean) => void;
  onPreviewChange: (preview: boolean) => void;
  onReleaseVersionChange: (value: number) => void;
  zoomLevel: number;
  setZoomLevel: (level: number) => void;
  transposed?: boolean;
  onTransposeChange?: (transposed: boolean) => void;
  disabled?: boolean;
  labels: VersionViewControlsLabels;
}

/** Table view options are optional; preview remains nested in version edit. */
export function VersionViewControls({ edit, preview, releaseVersion, onEditChange,
  onPreviewChange, onReleaseVersionChange, zoomLevel, setZoomLevel, disabled = false,
  transposed = false, onTransposeChange, labels }: VersionViewControlsProps) {
  const [open, setOpen] = useState(false);
  const lastValid = useRef(parseVersion(String(releaseVersion)) ?? 0);
  const [releaseDraft, setReleaseDraft] = useState(String(lastValid.current));
  const [releaseInvalid, setReleaseInvalid] = useState(false);
  const releaseInput = useRef<HTMLInputElement>(null);
  const releaseErrorId = useId();

  useLayoutEffect(() => {
    const next = parseVersion(String(releaseVersion));
    if (next === null) return;
    // Do not move the caret for the parent's echo of this input's own valid edit.
    if (next !== lastValid.current || document.activeElement !== releaseInput.current) {
      setReleaseDraft(String(next));
      setReleaseInvalid(false);
    }
    lastValid.current = next;
  }, [releaseVersion]);

  useLayoutEffect(() => {
    if (!edit || !preview) {
      setReleaseDraft(String(lastValid.current));
      setReleaseInvalid(false);
    }
  }, [edit, preview]);

  const resetRelease = () => {
    setReleaseDraft(String(lastValid.current));
    setReleaseInvalid(false);
  };
  const changeEdit = (next: boolean) => {
    if (disabled) return;
    if (!next) {
      releaseInput.current?.blur();
      resetRelease();
      onPreviewChange(false);
    }
    onEditChange(next);
    setOpen(false);
  };
  const changePreview = () => {
    if (disabled) return;
    if (preview) {
      releaseInput.current?.blur();
      resetRelease();
    }
    onPreviewChange(!preview);
  };

  return <div className={`version-view-controls${edit ? ' is-version-editing' : ''}`}>
    {edit && <>
      <button type="button" className="version-mode-button" disabled={disabled}
        aria-label={labels.exitVersionEdit} onClick={() => changeEdit(false)}>
        {labels.versionEdit}<X size={14} aria-hidden="true" />
      </button>
      <div className="version-preview-controls">
        <button type="button" className={`version-mode-button${preview ? '' : ' version-preview-off'}`}
          disabled={disabled} aria-pressed={preview} onClick={changePreview}>
          <Eye size={14} aria-hidden="true" />{labels.preview}
        </button>
        {preview && <span className="version-release-wrap">
          <input ref={releaseInput} className="version-release" type="text" inputMode="numeric" pattern="[0-9]*"
            style={{ width: `${Math.max(62, Math.min(100, releaseDraft.length * 8 + 20))}px` }}
            aria-label={labels.releaseVersion} aria-invalid={releaseInvalid}
            aria-describedby={releaseInvalid ? releaseErrorId : undefined}
            title={releaseInvalid ? labels.invalidVersion : labels.releaseVersion}
            disabled={disabled} value={releaseDraft} onChange={event => {
              const nextDraft = event.target.value;
              setReleaseDraft(nextDraft);
              const next = parseVersion(nextDraft);
              setReleaseInvalid(next === null);
              if (next !== null && next !== lastValid.current) {
                lastValid.current = next;
                onReleaseVersionChange(next);
              }
            }} onBlur={resetRelease} onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation(); resetRelease();
              } else if (event.key === 'Enter') {
                event.preventDefault(); event.stopPropagation();
                if (parseVersion(releaseDraft) === null) setReleaseInvalid(true);
                else { resetRelease(); releaseInput.current?.blur(); }
              }
            }} />
          {releaseInvalid && <span id={releaseErrorId} role="alert" className="version-release-error">{labels.invalidVersion}</span>}
        </span>}
      </div>
    </>}
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="version-view-button" aria-label={labels.viewSettings}>
          <SlidersHorizontal size={16} aria-hidden="true" />{labels.view}
          <span className="version-zoom-value">{zoomLevel}%</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="version-view-popover">
        <div className="version-zoom-label"><span>{labels.zoom}</span><span>{zoomLevel}%</span></div>
        <input className="version-zoom-slider" aria-label={labels.adjustZoom} type="range"
          min="10" max="200" step="10" value={zoomLevel}
          onChange={event => setZoomLevel(Number(event.target.value))} />
        <div className="version-menu-separator" />
        {onTransposeChange && <button type="button" className="version-menu-item"
          disabled={disabled} aria-pressed={transposed} onClick={() => {
            if (disabled) return;
            onTransposeChange(!transposed);
            setOpen(false);
          }}>
          <span>{labels.transpose}</span>{transposed && <Check size={16} aria-hidden="true" />}
        </button>}
        <button type="button" className="version-menu-item" disabled={disabled} aria-pressed={edit}
          onClick={() => changeEdit(!edit)}>
          <span>{labels.versionEdit}</span>{edit && <Check size={16} aria-hidden="true" />}
        </button>
      </PopoverContent>
    </Popover>
  </div>;
}
