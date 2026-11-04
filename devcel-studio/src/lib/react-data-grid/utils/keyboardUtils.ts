/**
 * @file Utility functions for keyboard input
 * 
 * This file handles keyboard operations in the data grid.
 * - Classify input keys that trigger editing
 * - Handle navigation keys
 * - Handle arrow keys in right-to-left (RTL) layouts
 * - Control navigation within editors
 */

import type { Direction, Maybe } from '../types';

/**
 * Set of keys not treated as input
 * 
 * These keys do not put a cell into edit mode.
 * Defined using the MDN Key Values documentation.
 * https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/Key_Values
 */
const nonInputKeys = new Set([
  // Special keys
  'Unidentified',
  // Modifier keys (pressing these alone does not start editing)
  'Alt',
  'AltGraph',
  'CapsLock',
  'Control',
  'Fn',
  'FnLock',
  'Meta',
  'NumLock',
  'ScrollLock',
  'Shift',
  // Whitespace keys
  'Tab',
  // Navigation keys (used to move between cells)
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  // Editing keys
  'Insert',
  // UI keys
  'ContextMenu',
  'Escape',
  'Pause',
  'Play',
  // Device keys
  'PrintScreen',
  // Function keys
  'F1',
  // 'F2', /!\ Do not change this: F2 is explicitly allowed as the edit shortcut
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12'
]);

/**
 * Determine whether Ctrl (or Cmd) is pressed
 * 
 * @param e - Keyboard event
 * @returns True if Ctrl/Cmd is pressed
 * 
 * @note
 * - Detect Ctrl on Windows and Cmd (metaKey) on Mac
 * - Exclude events whose key is 'Control' (ignore Ctrl pressed alone)
 */
export function isCtrlKeyHeldDown(e: React.KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.key !== 'Control';
}

/**
 * Key code constant for the 'V' key
 * 
 * @note
 * - Use keyCode because event.key can vary with the keyboard input language
 * - event.nativeEvent.code also cannot be used because it breaks copy/paste on DVORAK layouts
 */
const vKey = 86;

/**
 * Determine whether a key press is default input that starts cell editing
 * 
 * @param event - Keyboard event
 * @param isUserHandlingPaste - Whether the user handles paste independently
 * @returns True if the input should start editing
 * 
 * @note
 * - For Ctrl/Cmd + V (paste), return false unless isUserHandlingPaste is true
 * - Return false for keys in nonInputKeys
 * - Other character input triggers editing
 */
export function isDefaultCellInput(
  event: React.KeyboardEvent<HTMLDivElement>,
  isUserHandlingPaste: boolean
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  // When Ctrl/Cmd is pressed, return false unless the key is V and paste is not user-handled
  if (isCtrlKeyHeldDown(event) && (event.keyCode !== vKey || isUserHandlingPaste)) return false;
  // Return true for input keys to start editing
  return !nonInputKeys.has(event.key);
}

/**
 * Determine how navigation keys are handled while an editor is open
 * 
 * @param param - key and target extracted from the keyboard event
 * @returns True if navigation is allowed
 * 
 * @note
 * By default, specific navigation keys are enabled under these conditions:
 * - Tab key:
 *   - The editor must be an <input>, <textarea>, or <select> element
 *   - The editor must be the sole direct child of its editor container or label
 * 
 * These conditions disable grid Tab navigation in custom editors with multiple inputs,
 * allowing Tab to move between inputs within the editor.
 */
export function onEditorNavigation({ key, target }: React.KeyboardEvent<HTMLDivElement>): boolean {
  if (
    key === 'Tab' &&
    (target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  ) {
    // Allow Tab navigation only when the editor container has a single input element
    return (
      target.closest('.rdg-editor-container')?.querySelectorAll('input, textarea, select')
        .length === 1
    );
  }
  return false;
}

/**
 * Get left and right keys accounting for right-to-left (RTL) layouts
 * 
 * @param direction - Text direction ('ltr' | 'rtl' | undefined)
 * @returns Physical key names corresponding to logical left and right
 * 
 * @note
 * - In RTL layouts (Arabic, Hebrew, etc.), logical "left" maps to physical "right"
 * - In LTR layouts (English, Japanese, etc.), logical and physical directions match
 * - This provides intuitive navigation in both layouts
 */
export function getLeftRightKey(direction: Maybe<Direction>) {
  const isRtl = direction === 'rtl';

  return {
    leftKey: isRtl ? 'ArrowRight' : 'ArrowLeft',
    rightKey: isRtl ? 'ArrowLeft' : 'ArrowRight'
  } as const;
}
