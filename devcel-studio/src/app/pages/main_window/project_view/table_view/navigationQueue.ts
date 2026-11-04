/** Process each user history intent against the last committed display. */
export function createNavigationQueue() {
  let epoch = 0;
  let tail: Promise<void> = Promise.resolve();
  return {
    cancel() { epoch++; tail = Promise.resolve(); },
    enqueue(step: () => Promise<boolean>) {
      const token = epoch;
      tail = tail.then(async () => {
        if (token !== epoch) return;
        try {
          if (!await step() && token === epoch) epoch++;
        } catch {
          // A failed/cancelled transition must not replay queued navigation later.
          if (token === epoch) epoch++;
        }
      });
      return tail;
    }
  };
}
