/**
 * useLatestFunc.ts
 * 
 * Custom hook that always retains the latest function reference
 * Used to resolve callback dependency array issues
 */

import { useCallback, useLayoutEffect, useRef } from 'react';

import type { Maybe } from '../types';

/**
 * Custom hook retaining the latest function reference
 * 
 * Return the same callback even when the function reference changes,
 * avoiding unnecessary renders while always invoking the latest implementation.
 * 
 * Use cases:
 * - Event handlers are recreated frequently
 * - A function is used in a useEffect dependency array
 * - Callbacks passed to child components need stable references
 * 
 * Reference: https://reactjs.org/docs/hooks-faq.html#what-can-i-do-if-my-effect-dependencies-change-too-often
 * 
 * @template T - Function type (nullable allowed)
 * @param fn - Function to wrap
 * @returns A function with a stable reference, or null when fn is null
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useLatestFunc<T extends Maybe<(...args: any[]) => any>>(fn: T): T {
  // Ref retaining the latest function reference
  const ref = useRef(fn);

  // Update the latest function reference on each render
  // Use useLayoutEffect to ensure the update before painting
  useLayoutEffect(() => {
    ref.current = fn;
  });

  // Callback with a stable reference
  // This callback keeps the same reference and invokes the latest function internally
  const callbackFn = useCallback((...args: Parameters<NonNullable<T>>) => {
    ref.current!(...args);
  }, []); // The empty dependency array creates this callback only once

  // Return fn unchanged if it is null or undefined;
  // otherwise return the stable callback
  // @ts-expect-error Work around the type compatibility issue
  return fn ? callbackFn : fn;
}
