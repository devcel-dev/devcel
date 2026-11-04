import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const temp=await mkdtemp(resolve('.clipboard-payload-'));
try {
  const result=await build({stdin:{contents:"export * from './src/app/pages/main_window/project_view/table_view/components/gridClipboardPayload';",resolveDir:process.cwd()},bundle:true,format:'esm',write:false});
  const file=resolve(temp,'payload.mjs');await writeFile(file,result.outputFiles[0].text);
  const {writeGridClipboard,readGridClipboard,literalClipboardValue}=await import(pathToFileURL(file));
  let written,plainWrites=0;
  globalThis.ClipboardItem=class {constructor(data){this.data=data;}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{write:async(items)=>{written=items[0].data;},writeText:async()=>{plainWrites++;}}}});
  const payload={text:'=1+2\t日本語',cells:[[{raw:'=1+2',value:'3',type:'I32'},{raw:'日本語',value:'日本語',type:'String'}]]};
  await writeGridClipboard(payload);
  const text=await written['text/plain'].text(),html=await written['text/html'].text();
  assert.equal(text,payload.text);assert.deepEqual(readGridClipboard(text,html),payload);
  assert.equal(readGridClipboard(text+'changed',html),null,'OS text replacement invalidates metadata');
  assert.equal(readGridClipboard(text,''),null,'plain clipboard never reuses old metadata');
  assert.equal(readGridClipboard(text,html+html),null,'ambiguous metadata rejected');
  assert.equal(readGridClipboard(text,'<!--devcel-cells-v1:bad-->'),null);
  const encode=value=>'<!--devcel-cells-v1:'+Buffer.from(JSON.stringify(value)).toString('base64')+'-->';
  assert.equal(readGridClipboard(text,encode({...payload,cells:[[{raw:'wrong',value:'3',type:'I32'}]]})),null);
  assert.equal(readGridClipboard('x',encode({text:'x',cells:[[{raw:'x',value:'=danger()',type:'String'}]]})),null);
  assert.equal(literalClipboardValue('Reference','id'),null);assert.equal(literalClipboardValue('String','=value'),null);assert.equal(literalClipboardValue('I32','3',true),null);
  navigator.clipboard.write=async()=>{throw new DOMException('unsupported','NotSupportedError');};await writeGridClipboard(payload);assert.equal(plainWrites,1);
  navigator.clipboard.write=async()=>{throw new DOMException('denied','NotAllowedError');};await assert.rejects(writeGridClipboard(payload));assert.equal(plainWrites,1,'no permission bypass fallback');
  console.log('PASS rich clipboard snapshot roundtrip, external replacement, invalid/ambiguous metadata, unsupported types, permission boundaries');
}finally{await rm(temp,{recursive:true,force:true});}
