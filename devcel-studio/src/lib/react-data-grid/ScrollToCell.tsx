import { useLayoutEffect } from 'react';
import { usePhysicalViewport } from './DataGridViewportContext';

/** A logical grid position resolved by the shared physical scroll owner. */
export interface PartialPosition {
  readonly idx?: number | undefined;
  readonly rowIdx?: number | undefined;
  readonly scrollPosition?: 'nearest' | 'top-left' | undefined;
}

/** Resolve the request from committed metrics, including virtualized cells. */
export default function ScrollToCell({ scrollToPosition, setScrollToCellPosition }: {
  scrollToPosition: PartialPosition;
  setScrollToCellPosition: (cell: null) => void;
}) {
  const { layoutReady, layoutVersion, scrollToPosition: scrollViewportToPosition } = usePhysicalViewport()!;
  useLayoutEffect(() => {
    if (layoutReady && scrollViewportToPosition(scrollToPosition)) setScrollToCellPosition(null);
  }, [layoutReady, layoutVersion, scrollViewportToPosition, scrollToPosition, setScrollToCellPosition]);
  return null;
}
