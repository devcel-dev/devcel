import { WelcomeLightScene } from './WelcomeDetailMaterials';
import { Component, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { backgroundDpr, createBackgroundScheduler } from './backgroundRuntime';

class BackgroundBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

function BackgroundDriver() {
  const advance = useThree(state => state.advance);
  const gl = useThree(state => state.gl);
  const size = useThree(state => state.size);
  const dpr = useThree(state => state.viewport.dpr);
  const get = useThree(state => state.get);
  const refresh = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const scheduler = createBackgroundScheduler({
      draw: time => advance(time, false),
      request: callback => window.requestAnimationFrame(callback),
      cancel: id => window.cancelAnimationFrame(id),
    });
    let inViewport = true;
    let contextLost = false;
    const update = () => {
      const size = get().size;
      scheduler.configure(!document.hidden && inViewport && !contextLost && size.width > 0 && size.height > 0, media.matches);
    };
    refresh.current = update;
    const lost = () => { contextLost = true; update(); };
    const restored = () => { contextLost = false; update(); };
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      inViewport = entries.some(entry => entry.isIntersecting);
      update();
    });
    observer?.observe(gl.domElement);
    document.addEventListener('visibilitychange', update);
    media.addEventListener('change', update);
    window.addEventListener('resize', update);
    gl.domElement.addEventListener('webglcontextlost', lost);
    gl.domElement.addEventListener('webglcontextrestored', restored);
    update();
    return () => {
      refresh.current = undefined;
      scheduler.dispose();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
      media.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      gl.domElement.removeEventListener('webglcontextlost', lost);
      gl.domElement.removeEventListener('webglcontextrestored', restored);
    };
  }, [advance, gl, get]);
  useEffect(() => { refresh.current?.(); }, [size.width, size.height, dpr]);
  return null;
}

/** Keep the individual 3D scenes, but give every scene the same modest budget. */
export function BackgroundCanvas({ children, style, gl: _gl, ...props }: ComponentProps<typeof Canvas>) {
  const container = useRef<HTMLDivElement>(null);
  const [lightScene, setLightScene] = useState(() => !document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const update = () => setLightScene(!document.documentElement.classList.contains('dark'));
    const observer = new window.MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    update();
    return () => observer.disconnect();
  }, []);
  const [dpr, setDpr] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    let resolution: MediaQueryList | undefined;
    let watchedDpr: number | undefined;
    const update = () => {
      const deviceDpr = window.devicePixelRatio;
      // Moving between displays can change resolution without changing CSS size.
      if (watchedDpr !== deviceDpr) {
        resolution?.removeEventListener('change', update);
        watchedDpr = deviceDpr;
        resolution = window.matchMedia(`(resolution: ${deviceDpr}dppx)`);
        resolution.addEventListener('change', update);
      }
      const { width, height } = element.getBoundingClientRect();
      setDpr(backgroundDpr(width, height, deviceDpr));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      observer.disconnect();
      resolution?.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return (
    <div ref={container} className="welcome-background" aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <BackgroundBoundary>
        {dpr !== null && <Canvas {...props} className="welcome-scene" frameloop="never" dpr={dpr} gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
          style={{ ...style, position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <WelcomeLightScene.Provider value={lightScene}>{children}</WelcomeLightScene.Provider>
          <BackgroundDriver />
        </Canvas>}
      </BackgroundBoundary>
      <div className="welcome-atmosphere" style={{ position: 'absolute', inset: 0 }} />
    </div>
  );
}
