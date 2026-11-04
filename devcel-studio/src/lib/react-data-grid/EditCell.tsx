import { useI18n } from '@/app/i18n';
import { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { css } from '@linaria/core';

import { useLatestFunc } from './hooks';
import { canCommitEditor, createCellEvent, getCellClassname, getCellStyle, onEditorNavigation } from './utils';
import type {
  CellKeyboardEvent,
  CellRendererProps,
  EditCellKeyDownArgs,
  Maybe,
  Omit,
  RenderEditCellProps
} from './types';

/*
 * How outside-click detection works
 * 
 * To detect mousedown events outside the cell being edited,
 * listen at the window level in both the capture and bubble phases.
 *
 * 1. Capture phase: Record the event when it begins
 * 2. Inside the cell: Cancel the check when the event reaches the cell
 * 3. Bubble phase: Treat the event as an outside click when it returns to window
 *
 * Because propagation may be stopped along the way,
 * use postTask/requestAnimationFrame to perform an alternative check.
 * This gives parent event handlers access to the latest committed value.
 */

// Check whether the Scheduler API is available
const canUsePostTask = typeof scheduler === 'object' && typeof scheduler.postTask === 'function';

/**
 * Styles for the cell being edited
 * Remove padding so the editor fills the entire cell
 */
const cellEditing = css`
  @layer rdg.EditCell {
    padding: 0;

    &:has([data-rdg-editor-blocked="true"]) {
      overflow: visible !important;
      z-index: 200 !important;
    }
  }
`;

// Shared cell renderer property type
type SharedCellRendererProps<R, SR> = Pick<CellRendererProps<R, SR>, 'colSpan'>;

/**
 * EditCell component property definition
 * Include additional properties required in edit mode
 */
interface EditCellProps<R, SR>
  extends Omit<RenderEditCellProps<R, SR>, 'onRowChange' | 'onClose'>,
    SharedCellRendererProps<R, SR> {
  busy?: boolean;
  rowIdx: number;                                                              // Row index
  onRowChange: (row: R, commitChanges: boolean, shouldFocusCell: boolean) => void;  // Row change handler
  closeEditor: (shouldFocusCell: boolean) => void;                           // Function closing the editor
  navigate: (event: React.KeyboardEvent<HTMLDivElement>) => void;            // Navigation function
  onKeyDown: Maybe<(args: EditCellKeyDownArgs<R, SR>, event: CellKeyboardEvent) => void>;  // Key down handler
}

/**
 * Component representing an editable cell
 * Manage editing, committing or canceling changes, and outside-click detection
 * 
 * @template R - Row data type
 * @template SR - Summary row data type
 */
export default function EditCell<R, SR>({
  busy = false,
  column,
  colSpan,
  row,
  rowIdx,
  onRowChange,
  closeEditor,
  onKeyDown,
  navigate
}: EditCellProps<R, SR>) {
  useI18n();
  const editorRef = useRef<HTMLDivElement>(null);
  // Store the captured mouse event
  const captureEventRef = useRef<MouseEvent | undefined>(undefined);
  // Controller for canceling postTask
  const abortControllerRef = useRef<AbortController>(undefined);
  // Store the requestAnimationFrame ID
  const frameRequestRef = useRef<number>(undefined);
  // Whether to commit on an outside click (default: true)
  const commitOnOutsideClick = column.editorOptions?.commitOnOutsideClick ?? true;

  // To prevent useLayoutEffect cleanup between renders,
  // use useLatestFunc to access the latest props
  const commitOnOutsideMouseDown = useLatestFunc(() => {
    // Only pointer events/their scheduled fallback enter here, never autofocus
    // effects. Preserve the latest rendered value before a parent's click runs.
    flushSync(() => onClose(true, false));
  });

  // Set up outside-click detection
  useLayoutEffect(() => {
    if (!commitOnOutsideClick) return;

    /**
     * Capture-phase mousedown handler
     * Record the event and schedule a task to check it later
     */
    function onWindowCaptureMouseDown(event: MouseEvent) {
      captureEventRef.current = event;

      if (canUsePostTask) {
        // If the Scheduler API is available
        const abortController = new AbortController();
        const { signal } = abortController;
        abortControllerRef.current = abortController;
        // Schedule execution before the next paint to avoid running during React rendering
        scheduler
          .postTask(commitOnOutsideMouseDown, {
            priority: 'user-blocking',
            signal
          })
          // Ignore abort errors
          .catch(() => {});
      } else {
        // Fallback: Use requestAnimationFrame
        frameRequestRef.current = requestAnimationFrame(commitOnOutsideMouseDown);
      }
    }

    /**
     * Bubble-phase mousedown handler
     * Treat it as an outside click if it matches the captured event
     */
    function onWindowMouseDown(event: MouseEvent) {
      if (captureEventRef.current === event) {
        commitOnOutsideMouseDown();
      }
    }

    // Register event listeners
    addEventListener('mousedown', onWindowCaptureMouseDown, { capture: true });
    addEventListener('mousedown', onWindowMouseDown);

    // Cleanup function
    return () => {
      removeEventListener('mousedown', onWindowCaptureMouseDown, { capture: true });
      removeEventListener('mousedown', onWindowMouseDown);
      cancelTask();
    };
  }, [commitOnOutsideClick, commitOnOutsideMouseDown]);

  /**
   * Cancel the scheduled task
   * Cancel postTask or requestAnimationFrame execution
   */
  function cancelTask() {
    captureEventRef.current = undefined;
    if (abortControllerRef.current !== undefined) {
      abortControllerRef.current.abort();
      abortControllerRef.current = undefined;
    }
    if (frameRequestRef.current !== undefined) {
      cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = undefined;
    }
  }

  /**
   * Keyboard event handler
   * Escape: Discard changes
   * Enter: Commit changes
   * Other navigation keys: Move between cells
   */
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (busy) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    // Run the custom key down handler if provided
    if (onKeyDown) {
      const cellEvent = createCellEvent(event);
      onKeyDown(
        {
          mode: 'EDIT',
          row,
          column,
          rowIdx,
          navigate() {
            navigate(event);
          },
          onClose: (...args) => { flushSync(() => onClose(...args)); }
        },
        cellEvent
      );
      if (cellEvent.isGridDefaultPrevented()) return;
    }

    // Default keyboard behavior
    if (event.key === 'Escape') {
      // Discard changes and exit edit mode
      flushSync(() => onClose());
    } else if (event.key === 'Enter') {
      if (!canCommitEditor(editorRef.current)) { event.preventDefault(); return; }
      // Plain one-input cell editors commit and move; compound editors own their keys.
      if ((event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) && editorRef.current?.querySelectorAll('input, textarea, select').length === 1) {
        event.preventDefault(); navigate(event);
      } else { flushSync(() => onClose(true)); }
    } else if (onEditorNavigation(event)) {
      if (!canCommitEditor(editorRef.current)) { event.preventDefault(); return; }
      // Move when a navigation key is pressed
      navigate(event);
    }
  }

  /**
   * Close the editor
   * @param commitChanges - Whether to commit changes
   * @param shouldFocusCell - Whether to return focus to the cell
   */
  function onClose(commitChanges = false, shouldFocusCell = true) {
    if (busy) return;
    if (commitChanges) {
      if (!canCommitEditor(editorRef.current)) return;
      onRowChange(row, true, shouldFocusCell);
    } else {
      closeEditor(shouldFocusCell);
    }
  }

  /**
   * Row data change handler within the editor
   * @param row - New row data
   * @param commitChangesAndFocus - Whether to commit changes and set focus
   */
  function onEditorRowChange(row: R, commitChangesAndFocus = false) {
    if (!busy) onRowChange(row, commitChangesAndFocus, commitChangesAndFocus);
  }

  // Calculate the cell class name
  const { cellClass } = column;
  const className = getCellClassname(
    column,
    'rdg-editor-container',
    !column.editorOptions?.displayCellContent && cellEditing,  // Remove padding when cell content is not displayed
    typeof cellClass === 'function' ? cellClass(row) : cellClass
  );

  return (
    <div
      inert={busy}
      aria-busy={busy || undefined}
      role="gridcell"
      ref={editorRef}
      aria-colindex={column.idx + 1} // aria-colindex is 1-based
      aria-colspan={colSpan}
      aria-selected
      className={className}
      style={getCellStyle(column, colSpan)}
      onKeyDown={handleKeyDown}
      // Native paste belongs to the editor, never the grid's bulk-paste handler.
      onPaste={event => event.stopPropagation()}
      onMouseDownCapture={cancelTask}  // Cancel the task on mousedown inside the cell
    >
      {column.renderEditCell != null && (
        <>
          {/* Render the custom editor component */}
          {column.renderEditCell({
            column,
            row,
            rowIdx,
            onRowChange: onEditorRowChange,
            onClose
          })}
          {/* If displayCellContent is enabled, display regular cell content while editing */}
          {column.editorOptions?.displayCellContent &&
            column.renderCell({
              column,
              row,
              rowIdx,
              isCellEditable: true,
              tabIndex: -1,  // The cell is not focusable because the editor has focus
              onRowChange: onEditorRowChange
            })}
        </>
      )}
    </div>
  );
}