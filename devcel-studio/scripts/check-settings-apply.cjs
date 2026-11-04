const assert=require('node:assert/strict');const fs=require('node:fs');const Module=require('node:module');const path=require('node:path');const {compileModule}=require('./compile-module.cjs');
const file=path.resolve(__dirname,'../src/app/settings/settingsApplyTracker.ts');const mod=new Module(file);mod._compile(compileModule(fs.readFileSync(file,'utf8'),file),file);const {createSettingsApplyTracker}=mod.exports;
(async()=>{
 const pending=[];const tracker=createSettingsApplyTracker(()=>new Promise((resolve,reject)=>pending.push({resolve,reject})));
 const ready={generation:'g1',revision:'r1',source:'project',warning:null,migrationFailed:false};
 const a=tracker.begin('g1');assert.equal(tracker.get().phase,'saving');const p=a.committed();assert.equal(tracker.get().phase,'applying');pending.shift().resolve(ready);await p;assert.equal(tracker.get().phase,'applied');assert.equal(tracker.get().revision,'r1');
 const cancelled=tracker.begin('g1');cancelled.cancel();assert.equal(tracker.get().phase,'applied');
 const old=tracker.begin('g1');const oldP=old.committed();const latest=tracker.begin('g1');pending.shift().resolve(ready);await oldP;assert.equal(tracker.get().phase,'saving');latest.fail(Error('disk full'));assert.equal(tracker.get().phase,'error');
 for(const result of [{...ready,generation:'g2'},{...ready,source:'lastValid',warning:['invalid']},{...ready,migrationFailed:true}]){const op=tracker.begin('g1');const wait=op.committed();pending.shift().resolve(result);await wait;assert.equal(tracker.get().phase,'error');}
 const rejected=tracker.begin('g1');const rp=rejected.committed();pending.shift().reject(Error('IPC'));await rp;assert.equal(tracker.get().phase,'error');
 const welcome=fs.readFileSync(path.resolve(__dirname,'../src/app/pages/main_window/welcome_view/WelcomeView.tsx'),'utf8');const classes=[...welcome.matchAll(/className="(welcome-action [^"]+)"/g)].map(m=>m[1]);assert.equal(classes.length,2);assert(classes[0].includes('welcome-action-primary'));assert(!classes[1].includes('welcome-action-primary'));assert.equal(classes[0].replace('welcome-action-primary ',''),classes[1]);
 const css=fs.readFileSync(path.resolve(__dirname,'../src/app/pages/main_window/welcome_view/welcome.css'),'utf8');
 const rules=[...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
 const rule=selector=>{const found=rules.find(m=>m[1].trim()===selector);assert(found,selector);return found[2]};
 const themes=fs.readFileSync(path.resolve(__dirname,'../src/app/settings/generated/themes.css'),'utf8');
 const palettes=[...themes.matchAll(/\{([^{}]*--accent:[^{}]+)\}/g)].map(m=>Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*([\d.]+) ([\d.]+)% ([\d.]+)%;/g)].map(v=>{
   const h=+v[2]/30,s=+v[3]/100,l=+v[4]/100,a=s*Math.min(l,1-l);
   return [v[1],[0,8,4].map(n=>{const k=(n+h)%12;return l-a*Math.max(-1,Math.min(k-3,9-k,1))})];
 })));assert.equal(palettes.length,2);
 const luminance=rgb=>rgb.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
 const readable=(body,tokens,label)=>{
   const bg=[...body.matchAll(/background: hsl\(var\(--([\w-]+)\)(?: \/ ([\d.]+))?\)/g)].at(-1),fg=[...body.matchAll(/(?:^|;)\s*color: hsl\(var\(--([\w-]+)\)\)/g)].at(-1);assert(bg,label+' background token');assert(fg,label+' foreground token');
   const alpha=bg[2]===undefined?1:+bg[2];const mixed=tokens[bg[1]].map((v,i)=>alpha*v+(1-alpha)*tokens.background[i]);
   const a=luminance(mixed),b=luminance(tokens[fg[1]]);assert((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,label+' text remains readable');
 };
 for(const [i,tokens] of palettes.entries()) for(const state of ['',':hover',':focus-visible',':active']) {
   const selector=i===1&&state!==':active'?`.dark .welcome-card .welcome-action${state?':is(:hover,:focus-visible)':''}`:`.welcome-card .welcome-action${state}`;
   readable(rule(selector),tokens,`${i} secondary ${state}`);
   const primary='.welcome-card .welcome-action.welcome-action-primary';
   const primaryState=state===':hover'||state===':focus-visible'?':is(:hover,:focus-visible)':state;
   readable(rule(primary)+(state?rule(primary+primaryState):''),tokens,`${i} primary ${state}`);
 }
 assert.match(css,/\.welcome-background \.welcome-scene\s*\{ opacity: \.3;/);assert.match(css,/\.dark \.welcome-background \.welcome-scene\s*\{ opacity: \.8;/);
 console.log('PASS 8 settings apply lifecycle cases and Welcome semantic color-state pairing (source contract; native pending)');
})().catch(e=>{console.error(e);process.exitCode=1});
