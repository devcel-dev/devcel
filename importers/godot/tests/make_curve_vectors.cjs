// Read-only differential fixture generator against the actual Studio curve implementation.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../../../devcel-studio/node_modules/typescript');
const sourcePath = path.resolve(__dirname, '../../../devcel-studio/src/app/utils/curve.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const moduleObject = {exports:{}};
new Function('exports','module','require',compiled)(moduleObject.exports,moduleObject,id=>id==='@/app/i18n'?{t:key=>key}:require(id));
const api = moduleObject.exports;
const curves = api.EASING_PRESETS.map(p=>({name:p.id,data:p.build(0,10)}));
curves.push({name:'step-middle',data:{points:[{x:0,y:0,mode:'constant'},{x:.5,y:5,mode:'constant'},{x:1,y:10,mode:'linear'}]}});
curves.push({name:'asymmetric-autoLength',data:{points:[{x:0,y:0,mode:'autoLength',outLen:2.5},{x:.3,y:6,mode:'autoLength',inLen:.1,outLen:0},{x:.7,y:3,mode:'free',inSlope:-8,outSlope:15,inLen:3,outLen:1},{x:1,y:10,mode:'auto'}]}});
curves.push({name:'explicit-auto',data:{points:[{x:0,y:0,mode:'auto'},{x:1,y:10,mode:'auto'}]}});
const xs=[-.2,0,.01,.1,.25,.3,.499999,.5,.500001,.7,.75,.9,.99,1,1.2];
const vectors = curves.map(c=>({...c,samples:xs.map(x=>({x,y:api.evaluateCurve(c.data,x)}))}));
fs.writeFileSync(path.resolve(__dirname,'curve_vectors.json'),JSON.stringify({source:'devcel-studio/src/app/utils/curve.ts',curves:vectors},null,2)+'\n');
console.log(`Generated ${vectors.length} curves / ${vectors.length*xs.length} sample comparisons`);
