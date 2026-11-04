#!/usr/bin/env node
'use strict';
const http=require('node:http');const fs=require('node:fs/promises');const path=require('node:path');const {randomBytes,timingSafeEqual}=require('node:crypto');
const {Importer}=require('./importer.cjs');
/** Local-only wizard. Fixed config path, authenticated JSON mutations, no directory-serving endpoint. */
async function start({configPath=path.resolve('devcel.import.json'),packageRoot=path.resolve(__dirname,'..'),port=0}={}){
  const token=randomBytes(32).toString('hex');const importer=new Importer({configPath,packageRoot});let lastWatch=null;
  const ui=await fs.readFile(path.join(__dirname,'ui.html'));const tagUi=await fs.readFile(path.join(__dirname,'tag-filters.js'));
  const server=http.createServer(async(req,res)=>{
    const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    const expectedHost=`127.0.0.1:${server.address().port}`;
    if(req.headers.host!==expectedHost){send(403,{error:'Invalid Host'});return;}
    if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});res.end(ui);return;}
    if(req.method==='GET'&&req.url==='/tag-filters.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(tagUi);return;}
    if(req.method!=='POST'||req.url!=='/api'){send(404,{error:'Not found'});return;}
    const given=Buffer.from(String(req.headers['x-devcel-token']??'')),expected=Buffer.from(token);if(given.length!==expected.length||!timingSafeEqual(given,expected)||req.headers.origin&&req.headers.origin!==`http://${expectedHost}`){send(403,{error:'Unauthorized local request'});return;}
    if(!String(req.headers['content-type']).startsWith('application/json')){send(415,{error:'JSON required'});return;}
    try{
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw new Error('Request exceeds 1 MiB');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());let result;
      if(body.action==='config')result={...(await importer.configState()),path:importer.configPath};
      else if(body.action==='tags')result={presets:await importer.tagPresets(body.project)};
      else if(body.action==='save'){await importer.save(body.config,body.revision);result=await importer.configState();}
      else if(body.action==='import')result=await importer.import(body.sourceId??'');
      else if(body.action==='status')result={...(await importer.import('',true)),watch:lastWatch};
      else if(body.action==='watch'){if(body.enabled)importer.watch(s=>{lastWatch=s;});else importer.stopWatch();result={watching:!!body.enabled};}
      else throw new Error('Unknown action');send(200,result);
    }catch(e){send(400,{error:e.message});}
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/#token=${token}`;
  server.on('close',()=>importer.stopWatch());return {server,importer,url};
}
if(require.main===module){const index=process.argv.indexOf('--config');start({configPath:index>=0?path.resolve(process.argv[index+1]):undefined}).then(({server,url})=>{console.log(`Devcel Import: ${url}\nClose with Ctrl+C. This local URL grants access to the import settings; do not share it.`);for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());}).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={start};
