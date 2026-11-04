import { css } from '@linaria/core';

/**
 * Internal text editor styles
 * Configure the appearance of input fields during cell editing
 */
const textEditorInternalClassname = css`
  @layer rdg.TextEditor {
    /* Reset browser default styles */
    appearance: none;

    /* Size: Fill 100% of the parent */
    box-sizing: border-box;
    inline-size: 100%;
    block-size: 100%;
    /* Padding: 0 vertically, 6px horizontally */
    padding-block: 0;
    padding-inline: 6px;
    /* Border settings */
    border: 2px solid #ccc;
    vertical-align: top;
    /* Colors: Use CSS variables for theme support */
    color: var(--rdg-color);
    background-color: var(--rdg-background-color);

    /* Font: Inherit from the parent */
    font-family: inherit;
    font-size: var(--rdg-font-size);

    /* Multiline editing stays within the grid cell and scrolls with the caret. */
    &:is(textarea) {
      resize: none;
      overflow: auto;
      line-height: 1.4;
    }

    /* Focus styles */
    &:focus {
      border-color: var(--rdg-selection-color);
      outline: none;
    }

    /* Placeholder styles */
    &::placeholder {
      color: #999;
      opacity: 1;
    }
  }
`;

// Exported class name in BEM format
export const textEditorClassname = `rdg-text-editor ${textEditorInternalClassname}`;