# Welcome backgrounds

The welcome screen provides 23 3D themes and opens with Northern Lights by default. Development builds can preview every theme with Left/Right arrows or R. Preview shortcuts do not consume text entry, sliders, or modified navigation.

## Visual direction

The scenes use quiet-luxury central composition, coordinated slate/pearl/jade palettes, fine light and material detail rather than oversized glow, and unhurried motion.

| Theme | Refined treatment |
| --- | --- |
| Cosmic Orb | Layered wire orb, pearl/steel highlights and diagonal stars |
| Particle Wave | Bounded, coherent ribbons around a quiet center |
| Geometric Tunnel | Receding hexagonal frames and aligned depth rails |
| Neural Network | Batched nodes/connections with deterministic traveling pulses |
| Abstract Mandala | Dimensional petal filigree rather than solid confetti-like facets |
| Crystal Cave | Rooted hexagonal quartz clusters with restrained moving highlights |
| DNA Helix | Two sculpted helices framing the welcome card |
| Fractal Tree | Four branching silhouettes with subtle sway and sparse spores |
| Galaxy Swirl | Clear spiral arms, oriented disk and soft nebula atmosphere |
| Holographic Grid | Antialiased perspective grids and a slow scanning highlight |
| Infinity Mirror | Fine pearl and smoked-steel apertures with deliberate depth |
| Northern Lights | Fine pearl/jade curtains, sparse stars and irregular layered ridges |
| Ocean Waves | Deep blue-green waves, shaded moonlight and a quiet horizon |
| Quantum Field | Instanced nodes and synchronized connections, without random flicker |
| Ribbon Dance | Four satin-like strips, soft lighting and coordinated rotation |
| Terrain Mesh | Shader-displaced contours and muted elevation colors |
| Vortex Spiral | Three-dimensional triple helix and a restrained core |
| Wormhole | Fine flowing filaments on an edge-feathered 3D funnel |
| X-Ray Pulse | Clean ground rings, radial structure and gentle pulses |
| Yin-Yang Flow | Complementary pearl/jade arcs and opposing particle flow |
| Atomic Orbital | Precise orbital paths, attached electron trails and a stable cloud |
| Binary Stars | Shaded pearl/ice star pair, stable orbital disk and a subtle warped grid |
| Three-Body Problem | Bounded figure-eight simulation and preallocated fading trails |

## Shared rendering budget

`BackgroundCanvas` uses the React Three Fiber/Three.js renderer without runtime asset downloads, postprocessing passes, bloom, or shadow maps.

- Decorative scenes render at a maximum of approximately 30 frames per second rather than every display refresh.
- DPR is capped at 1.5 and reduced further to keep the drawing buffer at or below 2 million pixels. Foreground DOM text and controls retain the display's native sharpness.
- Hidden documents, offscreen canvases, and lost WebGL contexts stop scheduling animation frames. Resume does not advance the scene by the time spent hidden.
- Reduced-motion preference draws a composed static frame, including after resizing or a DPR change. Preference changes are handled without reloading.
- A shared error boundary retains a static atmospheric background if WebGL initialization fails. It does not remove the project controls.
- Geometries and materials are declarative children so React Three Fiber owns disposal. Large collections use point buffers, line segments or instancing instead of one mesh per particle/branch.
- Terrain and particle deformation are evaluated in vertex shaders where appropriate; there is no per-frame terrain normal recomputation. The three-body simulation uses a bounded fixed step and preallocated trail buffers.

The pixel limit describes the drawing buffer, not total GPU memory or multisampling storage. Power preference is a browser hint, not a guarantee. Hardware-specific GPU time, energy use, and native WebView behavior still require testing on the target device.

## Regression checks

Run from `devcel-studio`:

```sh
npm run check:welcome-backgrounds
npm run typecheck
npm run check:tauri-contracts
npm run check:brand-theme
npm run check:localization-coverage
npm run build
```

The focused check covers the frame clock and pixel budget, pause/resume, reduced motion, all 23 registered themes, repeated preview switching, keyboard isolation, DPR-only repaint, fallback and cleanup. Its mocked renderer checks do not claim visual correctness or hardware-GPU timing.

For visual QA, compare every theme at a fixed viewport and seed, then exercise repeated switches, small/large windows, high DPR, reduced motion, hidden/resume, context loss/restoration and WebGL-disabled fallback. Verify left-to-right and right-to-left foreground layout. A browser-only gallery verifies the scene rendering, not native project persistence or platform packaging.
