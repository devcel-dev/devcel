import { createContext, useContext, type ReactNode } from 'react';
import clsx from 'clsx';

import type { PhysicalBodyWindow } from './types';
import { getPhysicalBodyWindowStyle } from './utils/physicalBodyWindow';

/** Private to the grid: ordinary layouts reset this to undefined at every root. */
export const StationaryScrollXContext = createContext<number | undefined>(undefined);

interface PhysicalRowBodyProps {
  physicalBodyWindow: PhysicalBodyWindow | undefined;
  physicalBodyFallback: string | undefined;
  isEditing?: boolean;
  children: ReactNode;
}

/** Subscribe only the existing moving pane, without rerendering its row/cells. */
export default function PhysicalRowBody({
  physicalBodyWindow, physicalBodyFallback, isEditing, children
}: PhysicalRowBodyProps) {
  const scrollX = useContext(StationaryScrollXContext);
  const windowStyle = getPhysicalBodyWindowStyle(physicalBodyWindow);

  return (
    <div className={clsx('rdg-physical-row-pane rdg-physical-row-body', isEditing && 'rdg-physical-row-editing')}
      data-row-pane="body"
      data-rdg-bounded-body={physicalBodyWindow ? '' : undefined}
      data-rdg-body-fallback={physicalBodyWindow ? undefined : physicalBodyFallback}
      style={scrollX === undefined ? windowStyle : {
        ...windowStyle,
        // Header and body use the same committed physical snapshot, including fallbacks.
        insetInlineStart: (physicalBodyWindow?.physicalOffset ?? 0) - scrollX
      }}>
      {children}
    </div>
  );
}
