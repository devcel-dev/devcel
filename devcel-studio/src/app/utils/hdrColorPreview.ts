/** Extended-range sRGB canvas presentation only. This never modifies the source color.
 * GPUCanvasConfiguration: https://gpuweb.github.io/types/interfaces/GPUCanvasConfiguration.html
 * The canvas is opaque: WebGPU leaves out-of-gamut premultiplied DOM compositing undefined.
 * Composite the checker in linear light, then encode the complete opaque image for presentation.
 */
export type HdrPreviewStatus = 'candidate' | 'unavailable' | 'lost';
export type LinearRgba = readonly [number, number, number, number];
interface Buffer { destroy(): void }
interface Pipeline { getBindGroupLayout(index: number): unknown }
interface Pass { setPipeline(pipeline: Pipeline): void; setBindGroup(index: number, group: unknown): void; draw(vertices: number): void; end(): void }
interface Encoder { beginRenderPass(descriptor: unknown): Pass; finish(): unknown }
interface Device {
  lost: Promise<unknown>;
  queue: { submit(commands: unknown[]): void; writeBuffer(buffer: Buffer, offset: number, data: Float32Array): void };
  createCommandEncoder(): Encoder;
  createShaderModule(descriptor: {code: string}): unknown;
  createRenderPipelineAsync(descriptor: unknown): Promise<Pipeline>;
  createBuffer(descriptor: unknown): Buffer;
  createBindGroup(descriptor: unknown): unknown;
  pushErrorScope(filter: string): void;
  popErrorScope(): Promise<unknown>;
  destroy(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}
interface Context {
  configure(configuration: unknown): void;
  getConfiguration(): { format?: string; alphaMode?: string; toneMapping?: {mode?: string} } | null;
  getCurrentTexture(): { createView(): unknown };
  unconfigure(): void;
}
interface Gpu { requestAdapter(): Promise<{requestDevice(): Promise<Device>} | null> }
export interface HdrColorPreview { draw(linear: LinearRgba): void; dispose(): void }

const maxEncoded = 65504;
const maxLinear = ((maxEncoded + 0.055) / 1.055) ** 2.4;
/** Transient rendering data only. Multiplying in f64 before bounded f32 upload avoids
 * overflow/underflow for very bright RGB paired with very small straight alpha. */
export function hdrPremultipliedLinear(linear: LinearRgba): [number, number, number, number] {
  const alpha = Math.max(0, Math.min(1, linear[3]));
  const component = (value: number) => Math.min(maxLinear, Math.max(0, value) * alpha);
  return [component(linear[0]), component(linear[1]), component(linear[2]), alpha];
}

const shader = /* wgsl */ `
struct Preview { premultiplied: vec4<f32>, pixelScale: vec4<f32> };
@group(0) @binding(0) var<uniform> preview: Preview;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}
@fragment fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let cell = vec2<u32>(floor(position.xy * preview.pixelScale.xy / 6.0));
  let checkerSrgb = select(vec3<f32>(1.0), vec3<f32>(203.0, 213.0, 209.0) / 255.0, ((cell.x + cell.y) & 1u) == 1u);
  let checkerLinear = pow((checkerSrgb + 0.055) / 1.055, vec3<f32>(2.4));
  let linear = preview.premultiplied.rgb + checkerLinear * (1.0 - preview.premultiplied.a);
  let encoded = select(12.92 * linear, 1.055 * pow(linear, vec3<f32>(1.0 / 2.4)) - 0.055, linear > vec3<f32>(0.0031308));
  return vec4<f32>(min(encoded, vec3<f32>(65504.0)), 1.0);
}`;

/** `candidate` means the browser accepted extended output, never a luminance measurement.
 * Abort on dialog close; destroy devices that arrive after asynchronous cancellation.
 */
export async function createHdrColorPreview(
  canvas: HTMLCanvasElement,
  onStatus: (status: HdrPreviewStatus) => void,
  signal?: AbortSignal,
): Promise<HdrColorPreview | null> {
  let device: Device | undefined;
  let context: Context | undefined;
  let uniform: Buffer | undefined;
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', cleanup);
    device?.removeEventListener('uncapturederror', fail);
    try { context?.unconfigure(); } catch { /* Context already lost. */ }
    uniform?.destroy();
    device?.destroy();
  };
  const fail: EventListener = () => {
    if (disposed) return;
    onStatus('lost');
    cleanup();
  };
  signal?.addEventListener('abort', cleanup, {once: true});
  const unavailable = () => {
    if (!signal?.aborted) onStatus('unavailable');
    cleanup();
    return null;
  };
  try {
    const gpu = (navigator as Navigator & {gpu?: Gpu}).gpu;
    if (signal?.aborted || !gpu || !window.matchMedia('(dynamic-range: high)').matches) return unavailable();
    const adapter = await gpu.requestAdapter();
    if (disposed || signal?.aborted || !adapter) return unavailable();
    const acquired = await adapter.requestDevice();
    if (disposed || signal?.aborted) { acquired.destroy(); return null; }
    device = acquired;
    context = canvas.getContext('webgpu') as unknown as Context | null ?? undefined;
    if (!context) return unavailable();
    device.pushErrorScope('validation');
    context.configure({device, format: 'rgba16float', colorSpace: 'srgb', alphaMode: 'opaque', toneMapping: {mode: 'extended'}});
    const module = device.createShaderModule({code: shader});
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto', vertex: {module, entryPoint: 'vertexMain'},
      fragment: {module, entryPoint: 'fragmentMain', targets: [{format: 'rgba16float'}]},
      primitive: {topology: 'triangle-list'},
    });
    if (disposed || signal?.aborted) return null;
    uniform = device.createBuffer({size: 32, usage: 0x40 | 0x08}); // UNIFORM | COPY_DST
    const bindGroup = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: uniform}}]});
    const validation = await device.popErrorScope();
    if (disposed || signal?.aborted) return null;
    const config = context.getConfiguration();
    if (validation || config?.format !== 'rgba16float' || config?.alphaMode !== 'opaque' || config?.toneMapping?.mode !== 'extended') return unavailable();
    device.addEventListener('uncapturederror', fail);
    void device.lost.then(() => { if (!disposed) fail(new Event('lost')); });
    onStatus('candidate');
    return {
      draw(linear) {
        if (disposed || !device || !context || !uniform) return;
        if (!linear.every(Number.isFinite)) { fail(new Event('invalid')); return; }
        try {
          const scaleX = (canvas.clientWidth || canvas.width) / canvas.width;
          const scaleY = (canvas.clientHeight || canvas.height) / canvas.height;
          device.queue.writeBuffer(uniform, 0, new Float32Array([...hdrPremultipliedLinear(linear), scaleX, scaleY, 0, 0]));
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({colorAttachments: [{view: context.getCurrentTexture().createView(), clearValue: {r: 1, g: 1, b: 1, a: 1}, loadOp: 'clear', storeOp: 'store'}]});
          pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
          device.queue.submit([encoder.finish()]);
        } catch { fail(new Event('render')); }
      },
      dispose: cleanup,
    };
  } catch { return unavailable(); }
}
