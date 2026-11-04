// Mock lifecycle checks for the real HDR output module. Does not certify HDR luminance.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'devcel-hdr-'));
try {
  const output = join(dir, 'hdr.mjs');
  await build({entryPoints:[resolve('src/app/utils/hdrColorPreview.ts')], outfile:output, bundle:true, platform:'node', format:'esm'});
  const {createHdrColorPreview, hdrPremultipliedLinear} = await import(pathToFileURL(output));
  assert.deepEqual(hdrPremultipliedLinear([4,-2,1,0.5]),[2,0,0.5,0.5]);
  assert.deepEqual(hdrPremultipliedLinear([4,2,1,0]),[0,0,0,0]);
  assert.deepEqual(hdrPremultipliedLinear([1e40,0,0,1e-40]),[1,0,0,1e-40]);
  assert(hdrPremultipliedLinear([3.4028234e38,0,0,1]).every(Number.isFinite));
  assert(new Float32Array(hdrPremultipliedLinear([1e100,0,0,1])).every(Number.isFinite));
  let high=true;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{matchMedia:()=>({matches:high})}});
  const setGpu=gpu=>Object.defineProperty(globalThis,'navigator',{configurable:true,value:{gpu}});
  function fixture(options={}) {
    const events=new Map();let resolveLost,resolvePipeline,resolveDevice;
    const state={statuses:[],destroyed:0,bufferDestroyed:0,unconfigured:0,submitted:0,draws:0,writes:[],configured:null,shader:null,pipeline:null,pass:null};
    const buffer={destroy(){state.bufferDestroyed++}};
    const pipeline={getBindGroupLayout:()=>({})};
    const device={
      lost:new Promise(resolve=>resolveLost=resolve),
      queue:{submit(){state.submitted++},writeBuffer(actual,offset,data){assert.equal(actual,buffer);assert.equal(offset,0);state.writes.push([...data])}},
      createCommandEncoder(){return {beginRenderPass(descriptor){state.pass=descriptor;return{setPipeline(actual){assert.equal(actual,pipeline)},setBindGroup(index){assert.equal(index,0)},draw(count){assert.equal(count,3);state.draws++},end(){}}},finish(){return {}}}},
      createShaderModule(descriptor){state.shader=descriptor.code;return{}},
      async createRenderPipelineAsync(descriptor){state.pipeline=descriptor;if(options.pipelineFailure)throw Error('shader rejected');if(options.deferPipeline)await new Promise(resolve=>resolvePipeline=resolve);return pipeline},
      createBuffer(descriptor){assert.equal(descriptor.size,32);assert.equal(descriptor.usage,0x48);return buffer},
      createBindGroup(){return{}},
      pushErrorScope(){},async popErrorScope(){return options.validationError?{}:null},
      destroy(){state.destroyed++},addEventListener(name,listener){events.set(name,listener)},removeEventListener(name){events.delete(name)},
    };
    const context={configure(c){state.configured=c},getConfiguration(){return options.ignoredExtended?{...state.configured,toneMapping:undefined}:state.configured},getCurrentTexture(){if(options.drawFailure)throw Error('lost');return{createView(){return{}}}},unconfigure(){state.unconfigured++}};
    const canvas={width:512,height:192,clientWidth:256,clientHeight:96,getContext:()=>context};
    const gpu={async requestAdapter(){return{async requestDevice(){if(options.deferDevice)await new Promise(resolve=>resolveDevice=resolve);return device}}}};
    return {...state,state,canvas,gpu,device,report:s=>state.statuses.push(s),lost:()=>resolveLost({}),error:()=>events.get('uncapturederror')?.(new Event('error')),resolvePipeline:()=>resolvePipeline?.(),resolveDevice:()=>resolveDevice?.()};
  }
  let f=fixture();setGpu(undefined);
  assert.equal(await createHdrColorPreview(f.canvas,f.report),null);assert.deepEqual(f.state.statuses,['unavailable']);
  f=fixture();setGpu(f.gpu);high=false;
  assert.equal(await createHdrColorPreview(f.canvas,f.report),null);assert.equal(f.state.destroyed,0);
  high=true;f=fixture();setGpu(f.gpu);
  const preview=await createHdrColorPreview(f.canvas,f.report);
  assert.deepEqual(f.state.statuses,['candidate']);
  assert.equal(f.state.configured.format,'rgba16float');assert.equal(f.state.configured.colorSpace,'srgb');assert.equal(f.state.configured.alphaMode,'opaque');
  assert.equal(f.state.pipeline.fragment.targets[0].format,'rgba16float');
  assert.match(f.state.shader,/checkerLinear/);assert.match(f.state.shader,/premultiplied\.rgb \+ checkerLinear/);assert.match(f.state.shader,/65504\.0\)\), 1\.0/);
  const source=[4,0.25,-1,0.5];preview.draw(source);
  assert.deepEqual(source,[4,0.25,-1,0.5]);assert.deepEqual(f.state.writes[0],[2,0.125,0,0.5,0.5,0.5,0,0]);
  assert.equal(f.state.submitted,1);assert.equal(f.state.draws,1);assert.equal(f.state.pass.colorAttachments[0].clearValue.a,1);
  preview.draw([4,2,1,0]);assert.deepEqual(f.state.writes[1].slice(0,4),[0,0,0,0]);
  f.lost();await Promise.resolve();assert.equal(f.state.statuses.at(-1),'lost');assert.equal(f.state.destroyed,1);assert.equal(f.state.bufferDestroyed,1);assert.equal(f.state.unconfigured,1);
  preview.draw(source);assert.equal(f.state.submitted,2);preview.dispose();assert.equal(f.state.destroyed,1);
  for(const options of [{ignoredExtended:true},{pipelineFailure:true},{validationError:true}]){
    f=fixture(options);setGpu(f.gpu);assert.equal(await createHdrColorPreview(f.canvas,f.report),null);assert.deepEqual(f.state.statuses,['unavailable']);assert.equal(f.state.destroyed,1);assert.equal(f.state.unconfigured,1);
  }
  for(const options of [{deferDevice:true},{deferPipeline:true}]){
    f=fixture(options);setGpu(f.gpu);const abort=new AbortController();const pending=createHdrColorPreview(f.canvas,f.report,abort.signal);
    for(let i=0;i<5;i++)await Promise.resolve();abort.abort();f.resolveDevice();f.resolvePipeline();assert.equal(await pending,null);assert.deepEqual(f.state.statuses,[]);assert.equal(f.state.destroyed,1);assert.equal(f.state.bufferDestroyed,0);
  }
  for(const action of ['error','drawFailure','nonfinite']){
    f=fixture({drawFailure:action==='drawFailure'});setGpu(f.gpu);const candidate=await createHdrColorPreview(f.canvas,f.report);
    if(action==='error')f.error();else candidate.draw(action==='nonfinite'?[Infinity,0,0,1]:[1,1,1,1]);
    assert.deepEqual(f.state.statuses,['candidate','lost']);assert.equal(f.state.destroyed,1);assert.equal(f.state.bufferDestroyed,1);
  }
  console.log('PASS opaque HDR canvas, linear checker shader, straight-source preservation, bounded float16 upload, shader/configuration rejection, device loss, cancel during device/pipeline creation, cleanup. Shader compilation and actual HDR luminance require GPU validation.');
} finally {await rm(dir,{recursive:true,force:true})}
