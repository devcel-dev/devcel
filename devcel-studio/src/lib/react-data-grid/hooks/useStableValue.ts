import { useRef } from 'react';

/** Preserve only semantically equal immutable values. Never suppress new inputs. */
export function useStableValue<T>(value: T, equal: (previous: T, next: T) => boolean): T {
  const previous = useRef(value);
  if (!equal(previous.current, value)) previous.current = value;
  return previous.current;
}

export function sameArray<T>(previous: readonly T[], next: readonly T[]): boolean {
  return previous === next || previous.length === next.length
    && previous.every((value, index) => Object.is(value, next[index]));
}
