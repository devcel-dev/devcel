import type { Diagnostic } from './tableRules';

/** Canonical swatch wire model shared by user settings and column metadata. */
export interface SavedColorSwatch {
  id: string;
  name: string;
  data_type: 'Color32' | 'ColorFloat';
  value: string;
}

export interface UserColorSwatchSnapshot {
  revision: string;
  swatches: SavedColorSwatch[];
  /** A warning after a confirmed save is not a rejected mutation. */
  warning: Diagnostic | null;
  /** False until a strict reload returns a usable revision; never replay the save. */
  writable: boolean;
}

export interface ColorSwatchColumnContext {
  tableUuid: string;
  columnUuid: string;
}
