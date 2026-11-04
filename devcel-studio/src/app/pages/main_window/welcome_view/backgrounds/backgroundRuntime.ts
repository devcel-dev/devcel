/** Shared limits for decorative (never interactive) welcome scenes. */
export const BACKGROUND_FPS = 30;
export const BACKGROUND_PIXEL_BUDGET = 2_000_000;

export function backgroundDpr(width: number, height: number, deviceDpr: number): number {
  return Math.min(Math.max(deviceDpr || 1, 0.1), 1.5,
    Math.sqrt(BACKGROUND_PIXEL_BUDGET / Math.max(1, width * height)));
}

interface BackgroundSchedulerOptions {
  draw: (elapsedSeconds: number) => void;
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
}

/** A paused clock never catches up on hidden time or spins for reduced motion. */
export function createBackgroundScheduler({ draw, request, cancel }: BackgroundSchedulerOptions) {
  let frame: number | undefined;
  let active = false;
  let reduced = false;
  let disposed = false;
  let elapsed = 0;
  let previous: number | undefined;
  let pending = 0;
  const interval = 1000 / BACKGROUND_FPS;

  const stop = () => {
    if (frame !== undefined) cancel(frame);
    frame = undefined;
    previous = undefined;
    pending = 0;
  };
  const tick: FrameRequestCallback = (timestamp) => {
    frame = undefined;
    if (!active || reduced || disposed) return;
    if (previous === undefined) previous = timestamp;
    const delta = Math.max(0, timestamp - previous);
    previous = timestamp;
    elapsed += Math.min(delta / 1000, 0.1);
    pending += delta;
    if (pending >= interval - 0.5) {
      pending = Math.max(0, pending - interval);
      if (pending >= interval) pending %= interval;
      draw(elapsed);
    }
    frame = request(tick);
  };
  return {
    configure(nextActive: boolean, nextReduced: boolean) {
      if (disposed) return;
      stop();
      active = nextActive;
      reduced = nextReduced;
      if (!active) return;
      draw(elapsed);
      if (!reduced) frame = request(tick);
    },
    repaint() {
      if (active && !disposed) draw(elapsed);
    },
    dispose() {
      disposed = true;
      active = false;
      stop();
    },
  };
}
