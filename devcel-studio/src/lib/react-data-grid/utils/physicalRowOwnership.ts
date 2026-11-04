export interface OwnedPhysicalCell {
  cell: HTMLElement;
  row: HTMLElement;
  pane: HTMLElement;
  logical: HTMLElement;
}

/** Resolve only the physical cells owned by this grid, never a nested grid. */
export function getOwnedPhysicalCell(root: HTMLElement, element: Element): OwnedPhysicalCell | undefined {
  if (!root.matches('.rdg.rdg-physical-rows-viewport') || element.closest('.rdg') !== root) return;

  const cell = element.closest<HTMLElement>('.rdg-cell[role="gridcell"], .rdg-cell[role="columnheader"]');
  if (!cell || cell.closest('.rdg') !== root) return;
  const parent = cell.parentElement;
  const logical = parent?.classList.contains('rdg-cell-tooltip-wrapper') ? parent.parentElement : parent;
  const pane = logical?.parentElement;
  const row = pane?.parentElement;
  if (!logical?.classList.contains('rdg-physical-row-logical-grid')
    || !pane?.classList.contains('rdg-physical-row-pane')
    || pane.classList.contains('rdg-physical-row-frozen') === pane.classList.contains('rdg-physical-row-body')
    || !row || row.getAttribute('role') !== 'row') return;

  const isHeader = row.classList.contains('rdg-physical-semantic-header');
  const isBody = row.classList.contains('rdg-physical-semantic-row');
  if (isHeader === isBody) return;
  const rowParent = row.parentElement;
  if (isHeader) {
    if (rowParent !== root) return;
  } else if (root.classList.contains('rdg-stationary-rows-viewport')) {
    const groups = Array.from(root.children).filter(child =>
      child.classList.contains('rdg-stationary-rowgroup') && child.getAttribute('role') === 'rowgroup');
    if (groups.length !== 1 || rowParent !== groups[0]) return;
  } else if (rowParent !== root) return;

  return { cell, row, pane, logical };
}
