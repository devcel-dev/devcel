/**
 * useGridDimensions.ts
 * 
 * Custom hook managing grid dimensions
 * Watch grid resizing with ResizeObserver
 * and provide current dimensions and scrollbar height
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * Custom hook managing grid dimensions
 * 
 * Watch grid resizing with ResizeObserver
 * and track width, height, and horizontal scrollbar height.
 * Use logical properties, inline-size and block-size,
 * to support writing directions such as LTR and RTL.
 * 
 * @returns A tuple containing the grid reference and dimensions
 * - gridRef: Reference to the grid DOM element
 * - inlineSize: Inline dimension, usually width
 * - blockSize: Block dimension, usually height
 * - horizontalScrollbarHeight: Horizontal scrollbar height
 */
export function useGridDimensions(enabled = true) {
  const gridRef = useRef<HTMLDivElement>(null);
  // Inline dimension: Width in horizontal writing, height in vertical writing
  const [inlineSize, setInlineSize] = useState(1);
  // Block dimension: Height in horizontal writing, width in vertical writing
  const [blockSize, setBlockSize] = useState(1);
  // Horizontal scrollbar height in pixels
  const [horizontalScrollbarHeight, setHorizontalScrollbarHeight] = useState(0);

  useLayoutEffect(() => {
    if (!enabled) return;
    const { ResizeObserver } = window;

    // Avoid errors in Node.js SSR, jsdom, and browsers without ResizeObserver
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (ResizeObserver == null) return;

    // Calculate initial dimensions
    const { clientWidth, clientHeight, offsetWidth, offsetHeight } = gridRef.current!;
    const { width, height } = gridRef.current!.getBoundingClientRect();
    
    // Horizontal scrollbar height = Total height minus height excluding the scrollbar
    const initialHorizontalScrollbarHeight = offsetHeight - clientHeight;
    // Actual content width excluding borders
    const initialWidth = width - offsetWidth + clientWidth;
    // Actual content height excluding the scrollbar
    const initialHeight = height - initialHorizontalScrollbarHeight;

    // Set initial values
    setInlineSize(initialWidth);
    setBlockSize(initialHeight);
    setHorizontalScrollbarHeight(initialHorizontalScrollbarHeight);

    // Create a ResizeObserver to watch size changes
    const resizeObserver = new ResizeObserver((entries) => {
      // contentBoxSize supports logical properties and writing directions
      const size = entries[0].contentBoxSize[0];
      const { clientHeight, offsetHeight } = gridRef.current!;

      // Update synchronously with flushSync to prevent scrollbar flicker
      flushSync(() => {
        setInlineSize(size.inlineSize);
        setBlockSize(size.blockSize);
        // Recalculate scrollbar height
        setHorizontalScrollbarHeight(offsetHeight - clientHeight);
      });
    });
    
    // Start observing the grid element
    resizeObserver.observe(gridRef.current!);

    // Cleanup: Stop observing when the component unmounts
    return () => {
      resizeObserver.disconnect();
    };
  }, [enabled]);

  return [gridRef, inlineSize, blockSize, horizontalScrollbarHeight] as const;
}
