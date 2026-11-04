// Display-only gradient integration checks; backend remains the input authority.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const project = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'devcel-color-tracks-'));
try {
  const path = join(temporary, 'tracks.mjs');
  await build({absWorkingDir:project,entryPoints:['src/app/components/color/colorTrack.ts'],outfile:path,bundle:true,platform:'node',format:'esm'});
  const {colorTrackGradient: gradient, colorTrackStyle} = await import(pathToFileURL(path));
  const stops = value => [...value.matchAll(/(rgba\([^)]*\)) ([\d.]+)%/g)].map(([,color,position])=>({color,position:Number(position)}));
  const get = (channels,type,interpretation,exposure,track) => {
    const before=JSON.stringify(channels), samples=stops(gradient(channels,type,interpretation,exposure,track));
    assert.equal(JSON.stringify(channels),before,'source RGBA is immutable');assert(samples.length>=65 && samples.length<=257);assert.equal(samples[0].position,0);assert.equal(samples.at(-1).position,100);return samples;
  };
  const rgba=(channel,min,max)=>({kind:'rgba',channel,min,max});
  const at = (samples,index) => samples.find(sample => sample.position === index / 64 * 100);
  let samples=get([0,0,0,1],'ColorFloat','linear',0,rgba(0,0,1));
  assert.equal(at(samples,0).color,'rgba(0,0,0,1)');assert.equal(at(samples,32).color,'rgba(188,0,0,1)');assert.equal(at(samples,64).color,'rgba(255,0,0,1)');
  samples=get([0,0,0,1],'ColorFloat','srgb',0,rgba(0,0,1));assert.equal(at(samples,32).color,'rgba(128,0,0,1)');
  samples=get([0,64,128,255],'Color32','linear',0,rgba(0,0,255));assert.equal(at(samples,32).color,'rgba(188,137,188,1)');
  samples=get([0,0,0,1],'ColorFloat','linear',-2,rgba(0,0,8));assert.equal(at(samples,16).color,'rgba(188,0,0,1)');assert.equal(at(samples,32).color,'rgba(255,0,0,1)');
  samples=get([4,-0.5,0.25,0.5],'ColorFloat','linear',-2,rgba(2,0,8));assert.equal(at(samples,0).color,'rgba(255,0,0,0.5)');assert.equal(at(samples,16).color,'rgba(255,0,188,0.5)');
  samples=get([255,128,0,0],'Color32','srgb',0,rgba(3,0,255));assert.equal(at(samples,0).color,'rgba(255,128,0,0)');assert.equal(at(samples,32).color,`rgba(255,128,0,${128/255})`);assert.equal(at(samples,64).color,'rgba(255,128,0,1)');
  samples=get([4,0.25,0,0.7],'ColorFloat','linear',-2,{kind:'hsv',channel:0,min:0,max:360,hsv:[0,1,4]});assert.equal(at(samples,0).color,'rgba(255,0,0,0.7)');assert.equal(at(samples,32).color,'rgba(0,255,255,0.7)');assert.equal(at(samples,64).color,'rgba(255,0,0,0.7)');
  samples=get([1,1,1,1],'ColorFloat','linear',0,{kind:'hsv',channel:1,min:0,max:1,hsv:[240,0,1]});assert.equal(at(samples,64).color,'rgba(0,0,255,1)','latent hue colors a white value');
  samples=get([0,0,0,1],'ColorFloat','linear',0,{kind:'hsv',channel:2,min:0,max:8,hsv:[120,1,0]});assert.equal(at(samples,1).color,'rgba(0,99,0,1)','latent hue/saturation colors a black value');
  samples=get([1,0,0,0.5],'ColorFloat','linear',0,{kind:'exposure',min:-2,max:2});assert.equal(at(samples,0).color,'rgba(137,0,0,0.5)');assert.equal(at(samples,32).color,'rgba(255,0,0,0.5)');
  samples=get([0,0,0,255],'UiColor','linear',8,rgba(0,0,255));assert.equal(at(samples,32).color,'rgba(128,0,0,1)','decorative UI ignores numeric interpretation and EV');
  assert.equal(gradient([NaN,0,0,1],'ColorFloat','linear',0,rgba(0,0,1)),'none');
  assert.equal(gradient([1,1,1,1],'ColorFloat','linear',0,rgba(0,2,1)),'none');
  const style=colorTrackStyle('linear-gradient(to right, transparent, red)');assert(style.backgroundImage.startsWith('linear-gradient'));assert(style.backgroundImage.includes('conic-gradient'));assert.equal(style.backgroundSize,'100% 100%, 12px 12px');
  const aligned=colorTrackStyle(gradient([0,0,0,1],'ColorFloat','linear',0,rgba(0,0,1))).backgroundImage;
  assert(aligned.includes('rgba(0,0,0,1) calc(0% + 8px)'));
  assert(aligned.includes('rgba(188,0,0,1) 50%'));
  assert(aligned.includes('rgba(255,0,0,1) calc(100% - 8px)'));
  // A 200px track and 16px thumb must agree at every stop, including both ends.
  const positions=[...aligned.matchAll(/rgba\([^)]*\) (?:calc\(([^)]+)\)|(\d+(?:\.\d+)?)%)/g)];
  assert(positions.length>=65);
  positions.forEach(match=>{
    const terms=match[1]?.match(/([\d.]+)% ([+-]) ([\d.]+)px/);
    const x=terms ? Number(terms[1])*2+(terms[2]==='+'?1:-1)*Number(terms[3]) : Number(match[2])*2;
    const percentage=terms ? Number(terms[1]) : Number(match[2]);
    assert(Math.abs(x-(8+(200-16)*percentage/100))<1e-9);
  });
  samples=get([0,0,0,1],'ColorFloat','linear',12,rgba(0,0,8));
  assert(samples.length>65,'strong EV clipping receives extra samples');
  assert(samples.some(sample=>sample.position>0 && sample.position<0.01 && sample.color==='rgba(255,0,0,1)'), 'near-black edge clips at its true exposed position');
  console.log('PASS thumb-center aligned, adaptive 65-base-stop RGBA/HSV/EV result-color gradients, nonlinear linear-light preview, byte precision, current EV/HDR clipping, negative and straight-alpha preservation, latent hue, decorative SDR, checker transparency, immutable source.');
} finally {await rm(temporary,{recursive:true,force:true})}
