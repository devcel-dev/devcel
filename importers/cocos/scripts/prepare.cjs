'use strict';
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');
const js=path.resolve(root,'../javascript');
// Distribution assembly only. Does not write to consumer projects.
for(const dir of ['runtime','editor','assets/runtime'])fs.mkdirSync(path.join(root,dir),{recursive:true});
for(const file of ['devcel-runtime.js','devcel-runtime.d.ts'])for(const dir of ['runtime','assets/runtime'])fs.copyFileSync(path.join(js,'runtime',file),path.join(root,dir,file));
for(const file of ['cli.cjs','importer.cjs'])fs.copyFileSync(path.join(js,'editor',file),path.join(root,'editor',file));
fs.copyFileSync(path.join(root,'assets/runtime/DevcelCocos.ts'),path.join(root,'runtime/DevcelCocos.ts'));
