import { useCallback, useEffect, useRef, type CompositionEvent, type FocusEvent } from 'react';
import { flushSync } from 'react-dom';

/** Keep IME text alive and publish blur-owned fields before reading a settings draft. */
export function useSettingsCloseGuard() {
  const composing = useRef<EventTarget | null>(null);
  const focused = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isComposing = useCallback(() => composing.current !== null, []);
  const prepareClose = useCallback(async () => {
    if (!mounted.current || composing.current) return false;
    const owner = generation.current;
    // compositionend can precede the final input event. Leave its event turn,
    // without depending on animation frames in hidden native windows.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!mounted.current || composing.current || generation.current !== owner) return false;
    flushSync(() => {
      // React focus capture includes portalled child editors as well.
      if (document.activeElement === focused.current) focused.current?.blur();
    });
    return mounted.current && !composing.current && generation.current === owner;
  }, []);
  return {
    isComposing, prepareClose,
    captureProps: {
      onFocusCapture: (event: FocusEvent<HTMLElement>) => { focused.current = event.target; },
      onCompositionStartCapture: (event: CompositionEvent<HTMLElement>) => {
        composing.current = event.target;
        generation.current += 1;
      },
      onCompositionEndCapture: (event: CompositionEvent<HTMLElement>) => {
        if (composing.current === event.target) composing.current = null;
      },
    },
  };
}
