#!/usr/bin/env node
'use strict';
// Real display/transpose modules; sparse Rust presentation is an explicit fixture.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const project = process.env.DEVCEL_TEST_PROJECT || path.resolve(__dirname, '..');
const { build } = Module.createRequire(path.join(project, 'package.json'))('esbuild');
(async () => {
  const result = await build({ absWorkingDir:project, stdin:{resolveDir:project, loader:'ts', contents:`
    export {createGridDisplayModel} from './src/app/pages/main_window/project_view/table_view/components/gridDisplayModel';
    export {createTransposedRows,resolveGridViewCell} from './src/app/pages/main_window/project_view/table_view/components/gridTransposeView';
  `},bundle:true,packages:'external',platform:'node',format:'cjs',write:false,define:{'import.meta.env.DEV':'false'},tsconfig:path.join(project,'tsconfig.json'),
    plugins: process.env.GRID_DISPLAY_MODEL_SOURCE ? [{name:'candidate',setup(b){b.onLoad({filter:/gridDisplayModel\.ts$/},()=>({contents:fs.readFileSync(process.env.GRID_DISPLAY_MODEL_SOURCE,'utf8'),loader:'ts'}));}}] : [] });
  const compiled = new Module(path.join(project,'inherited-display-test.cjs'));
  compiled.paths = Module._nodeModulePaths(project);compiled._compile(result.outputFiles[0].text,compiled.filename || path.join(project,'inherited-display-test.cjs'));
  const {createGridDisplayModel:create,createTransposedRows,resolveGridViewCell}=compiled.exports;
  const col={uuid:'reward-id',data_name:'reward',display_name:'Reward',data_type:'I32',default_value:'7',style:{font_size:12,width:100,color:'#fff'}};
  const row=(uuid,parent_uuid='',values={})=>({uuid,parent_uuid,label:uuid,min_version:0,tags:[],values,interface_values:{},memo_texts:{}});
  const make=()=>({uuid:'table',display_name:'Table',metadata:{interface_order:[]},schema:{columns:[col]},records:[row('slime','',{reward:'5'}),row('dragon','',{reward:'50'}),row('child','dragon'),row('grandchild','child'),row('local','child',{reward:'25'}),row('default'),row('empty','child',{reward:''}),row('other','slime')]});
  const sparse={table_uuid:'table',revision:'1',cells:{},definition_issues:[],issue_count:0};
  const clone=x=>JSON.parse(JSON.stringify(x));
  const by=(m,id)=>m.rows.find(r=>r.rowId===id);
  const checkViews=(m,expected)=>{
    assert.equal(by(m,'grandchild')['reward-id'],expected,'normal sparse descendant value');
    const columns=[{key:'reward-id',name:'Reward'}], view=createTransposedRows(columns)[0];
    const cell=resolveGridViewCell(view,'grandchild',true,new Map(m.rows.map(r=>[r.rowId,r])),new Map(columns.map(c=>[c.key,c])));
    assert.equal(cell.row[cell.column.key],expected,'transposed sparse descendant value');
  };
  for(const presentation of [sparse,null,{...sparse,cells:{grandchild:{}}}]) {
    const original=make();const first=create(undefined,original,presentation,'s');checkViews(first,'50');
    const changed=clone(original);changed.records.find(r=>r.uuid==='child').parent_uuid='slime';
    const next=create(first,changed,presentation,'s');checkViews(next,'5');assert.notEqual(by(next,'grandchild'),by(first,'grandchild'));
    for(const id of ['dragon','slime','local','default','other']) assert.equal(by(next,id),by(first,id),`unchanged ${id} identity`);
    const undo=create(next,clone(original),presentation,'s');checkViews(undo,'50');
    const edited=clone(original);edited.records.find(r=>r.uuid==='dragon').values.reward='99';
    const afterEdit=create(first,edited,presentation,'s');checkViews(afterEdit,'99');
    for(const id of ['slime','local','default','other']) assert.equal(by(afterEdit,id),by(first,id));
    assert.equal(by(afterEdit,'local')['reward-id'],'25');assert.equal(by(afterEdit,'default')['reward-id'],'7');assert.equal(by(afterEdit,'empty')['reward-id'],'99');
    assert.equal(create(afterEdit,clone(edited),presentation,'s').rows,afterEdit.rows,'identical snapshot shares entire row array');
  }
  const original=make();const first=create(undefined,original,sparse,'s');
  const local=clone(original);local.records.find(r=>r.uuid==='child').values.reward='81';
  const localModel=create(first,local,sparse,'s');checkViews(localModel,'81');
  const clear=clone(local);delete clear.records.find(r=>r.uuid==='child').values.reward;
  checkViews(create(localModel,clear,sparse,'s'),'50');
  // Root records depend only on their own unchanged DTO/columns/presentation.
  // Their fast path must not resolve every column on each snapshot.
  const roots=make();roots.records=roots.records.filter(r=>!r.parent_uuid);
  const rootModel=create(undefined,roots,sparse,'s');let rootReads=0;
  Object.defineProperty(roots.schema.columns[0],'data_name',{configurable:true,enumerable:true,get(){rootReads++;return 'reward';}});
  assert.equal(create(rootModel,roots,sparse,'s').rows,rootModel.rows);
  assert.equal(rootReads,0,'unchanged parentless rows retain no-fallback-resolution fast path');
  // Deep-chain work is counted rather than relying on noisy timing assertions.
  let reads=0;const n=20000;const columns=Array.from({length:5},(_,i)=>({...col,uuid:`c${i}`,data_name:`v${i}`}));
  const records=Array.from({length:n},(_,i)=>row(`r${i}`,i?`r${i-1}`:''));
  records[0].values=Object.fromEntries(columns.map(c=>[c.data_name,'1']));
  const table={metadata:{uuid:'large'},schema:{columns},records};const before=create(undefined,table,{...sparse,cells:{}},'s');
  const updated=clone(table);updated.records[0].values=Object.fromEntries(columns.map(c=>[c.data_name,'2']));
  for(const r of updated.records){const p=r.parent_uuid;Object.defineProperty(r,'parent_uuid',{enumerable:true,get(){reads++;return p;}});}
  const after=create(before,updated,{...sparse,cells:{}},'s');assert.equal(after.rows.at(-1).c4,'2');assert(reads<n*20,`bounded deep-chain parent reads: ${reads}`);
  console.log(`PASS sparse literal reparent/ancestor edit/Undo normal+transpose, stable unrelated/local identities and empty-input inheritance; ${n} rows x5 columns, ${reads} parent reads`);
})().catch(error=>{console.error(error);process.exitCode=1;});
