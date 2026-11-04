const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const studio=path.resolve(__dirname,'..'), temp=fs.mkdtempSync(path.join(os.tmpdir(),'devcel-highlight-'));
try {
 const out=path.join(temp,'highlight.cjs'); require('esbuild').buildSync({entryPoints:[path.join(studio,'src/app/utils/formulaHighlight.ts')],outfile:out,bundle:true,platform:'node',format:'cjs'});
 const {highlightFormula,MAX_HIGHLIGHT_LENGTH,MAX_HIGHLIGHT_TOKENS}=require(out);
 const kinds=source=>highlightFormula(source).map(s=>[source.slice(s.start,s.end),s.kind]);
 assert.equal(highlightFormula('ordinary text'),null);
 assert.deepEqual(kinds('=SUM(1.25e-3,`参照名`.hp,"a""b",TRUE)'),[['=','operator'],['SUM','function'],['(','operator'],['1.25e-3','number'],[',','operator'],['`参照名`','reference'],['.','operator'],['hp','reference'],[',','operator'],['"a""b"','string'],[',','operator'],['TRUE','literal'],[')','operator']]);
 for(const source of [' =LET(x,1,x + .5)','=MAP(TABLE("Enemies"),r=>r.hp)','=SUM("unfinished','=LET(日本語,1,`日本語😀` + 日本語)','=SUM(1,\r\n 2)','=SUM(1,\n2)']) {
  const spans=highlightFormula(source); assert(spans);
  let end=0,reconstructed=''; for(const s of spans){assert(s.start>=end&&s.end>s.start);reconstructed+=source.slice(end,s.start)+source.slice(s.start,s.end);end=s.end;}
  reconstructed+=source.slice(end);assert.equal(reconstructed,source,'raw UTF16/whitespace/line endings remain unchanged');
 }
 assert.equal(highlightFormula('='+ 'x'.repeat(MAX_HIGHLIGHT_LENGTH)),null,'huge drafts keep native rendering');
 assert.equal(highlightFormula('='+ '+'.repeat(MAX_HIGHLIGHT_TOKENS)),null,'token DOM is bounded');
 const long='=SUM("'+'x'.repeat(30000);const start=performance.now();
 for(let i=0;i<25;i++) assert(highlightFormula(long).length<=MAX_HIGHLIGHT_TOKENS);
 console.log('PASS bounded lossless formula coloring, incomplete/Unicode/CRLF/exponent inputs; 25 long drafts ms='+Math.round(performance.now()-start));
 const css=fs.readFileSync(path.join(studio,'src/styles/formula-highlight.css'),'utf8');
 const luminance=rgb=>rgb.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const themes=fs.readFileSync(path.join(studio,'src/app/settings/generated/themes.css'),'utf8');
 const backgrounds=[...themes.matchAll(/--background: ([\d.]+) ([\d.]+)% ([\d.]+)%;/g)].map(v=>{const h=+v[1]/30,s=+v[2]/100,l=+v[3]/100,a=s*Math.min(l,1-l);return [0,8,4].map(n=>{const k=(n+h)%12;return l-a*Math.max(-1,Math.min(k-3,9-k,1))});});
 for(const rule of css.matchAll(/([^{}]+)\{[^{}]*color: (#[\da-f]{6});[^{}]*\}/g)) {
  const ink=[1,3,5].map(i=>parseInt(rule[2].slice(i,i+2),16)/255),bg=backgrounds[rule[1].includes('.dark')?1:0];
  const a=luminance(ink),b=luminance(bg);assert((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,rule[1]+' contrast');
 }
 console.log('PASS light/dark token text contrast against actual built-in theme backgrounds');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
