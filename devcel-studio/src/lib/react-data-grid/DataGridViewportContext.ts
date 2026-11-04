import { createContext, useContext, useEffect, type RefObject } from 'react';
import type { PartialPosition } from './ScrollToCell';

/** Every grid scrolls its physical owner using logical row and column metrics. */
export interface PhysicalViewportContextValue {
  ownerRef: RefObject<HTMLElement | null>;
  scale: number;
  layout: 'grid' | 'physical-rows' | 'stationary-rows';
  direction: 'ltr' | 'rtl';
  layoutReady: boolean;
  layoutVersion: object;
  scrollToPosition: (position: PartialPosition) => boolean;
  scrollToElement: (element: HTMLElement) => boolean;
  requestFocus: (element: HTMLElement, select?: boolean) => () => void;
}
export const DataGridViewportContext = createContext<PhysicalViewportContextValue | undefined>(undefined);
export const usePhysicalViewport = () => useContext(DataGridViewportContext);

/** Queue only the initial editor focus; readiness changes must not reselect a draft. */
export function useGridEditorFocus<T extends HTMLInputElement | HTMLTextAreaElement>(
  ref: RefObject<T | null>, select = true
) {
  const requestFocus = usePhysicalViewport()?.requestFocus;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (requestFocus) return requestFocus(element, select);
    element.focus();
    if (select) element.select();
  }, [ref, requestFocus, select]);
}
