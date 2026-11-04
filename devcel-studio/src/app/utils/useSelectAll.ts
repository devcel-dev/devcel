import { useLayoutEffect, useRef, type RefObject } from 'react';
import { registerSelectAll } from './selectAllRouting';

export function useSelectAll(root: RefObject<HTMLElement | null>, selectAll: () => void, find?: () => void) {
  const current = useRef({ selectAll, find });
  useLayoutEffect(() => { current.current = { selectAll, find }; });
  useLayoutEffect(() => {
    if (root.current) return registerSelectAll(root.current, () => current.current.selectAll(), () => current.current.find?.());
  }, [root]);
}
