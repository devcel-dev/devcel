const path = require('path');
const assert = require('node:assert/strict');
const fs = require('fs');
const studio = path.resolve(__dirname, '..');
const esbuild = require(path.join(studio, 'node_modules/esbuild'));
const work = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'devcel-plugin-contracts-'));
const out = path.join(work, 'plugin-contracts.cjs');
const fixtureArgument = process.argv.indexOf('--bundled-fixtures');
const bundledFixtures = fixtureArgument < 0 ? [] : JSON.parse(fs.readFileSync(process.argv[fixtureArgument + 1], 'utf8'));
assert(Array.isArray(bundledFixtures), 'release fixtures must be an array');
if (fixtureArgument >= 0) assert.deepEqual(bundledFixtures.map(fixture => fixture.version),
 ['0.0.3-rc.1', '0.0.3-rc.2', '0.0.3', '0.0.4-beta.1', '0.0.4'],
 'every release transition must execute exactly once in order');
const semver = require(path.join(studio, 'node_modules/semver'));
const currentVersion = require('../src-tauri/tauri.conf.json').version;
const compatibilityRange = (version, minimum) => `${minimum === '0.0.0' && semver.prerelease(version) ? '>=0.0.0 <1.0.0 || >=1.0.0' : `>=${minimum}`}${semver.prerelease(version) ? ` || =${version}` : ''}`;
const sourcePaths = {
 csv: path.join(studio, 'src/app/plugins/examples/CSVExporterPlugin.ts'),
 template: path.join(studio, 'templates/plugin-template/src/index.ts')
};
const memory = new Map();
global.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k,v) => memory.set(k,v), removeItem:k=>memory.delete(k), key:i=>[...memory.keys()][i], get length(){return memory.size} };
global.window = { addEventListener(){},removeEventListener(){} };
const calls=[];
global.__appVersion='2.3.4-beta.1+qa';
let session='session-A', revision='revision-A', failWarning=false;
const columnDefaults={min_version:0,tooltip:'',tags:[],read_only: false, default_value:'',style:{color:'#FFFFFF',font_size:12,width:100},memo_text:'',reference_config:null};
const recordDefaults={parent_uuid:'',tags:[],memo_texts:{}};
const table={uuid: 'table-A', display_name: 'Test', metadata: { interface_order: [], initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true },parent_uuid:'',data_name:'test' },description:'before',schema:{columns:[{ min_version: 0,...columnDefaults,uuid:'column-A',display_name:'Text',data_name:'text',data_type:'String'},{ min_version: 0,...columnDefaults,uuid:'interface-column',display_name:'Inherited',data_name:'inherited',data_type:'String',interface_origin:'interface-A'}]},records:[{...recordDefaults,uuid:'record-A',label:'one',min_version:0,values:{text:'日本語,"\ntext',inherited:'OLD NAME MUST NOT LEAK'},interface_values:{'interface-column':'canonical'}}],interface_implementations:{},};
global.__invoke=async (name,args={})=>{
 calls.push({name,args:structuredClone(args)});
 if(name==='get_project_session')return {id:session,path:'/project',name:'p',description:'',header_color:''};
 if(name==='get_plugin_projects')return [{sessionId:session,path:'/project',name:'p',description:'',headerColor:''}];
 if(name==='list_installed_plugin_packages')return [];
 if(args.expectedProjectSession!==session)throw new Error('stale session');
 if(name==='get_table_data')return table;
 if(name==='prepare_table_rule_snapshot')return 'plugin-evaluation';
 if(name==='cancel_table_rule_snapshot')return false;
 if(name==='get_table_rule_snapshot')return {kind:'snapshot',snapshot_token:null,retained_bytes:1024,table:structuredClone(table),presentation:{table_uuid:table.uuid,revision,cells:{},definition_issues:[],issue_count:0}};
 if(name==='update_plugin_table'){
  if(args.expectedRevision!==revision)throw new Error('stale revision');
  if(failWarning&&!args.acknowledgement){failWarning=false;throw {kind:'input_validation',report:{acknowledgement:'approved',issues:[{mode:'warn',diagnostic:{kind:'text',text:'warning'}}]}};}
  return;
 }
 if(name==='delete_plugin_table'){if(args.tableUuid!=='new-table-uuid')throw new Error('table not found');return;}
 if(name==='get_table_catalog')return [{uuid:'new-table-uuid',path:'new.table.toml'}];
 if(name==='file_operation')return args.operation.type==='Create'?{type:'Created',entry:{path:'new_1.table.toml',file_type:'Table',uuid:'new-table-uuid'}}:{type:'Completed'};
 throw new Error(`Unexpected invoke ${name}`);
};
async function bundleContracts(outfile, fixture, hostVersion) {
 await esbuild.build({stdin:{contents:`export {version as testedHostVersion} from './src-tauri/tauri.conf.json'; export {PluginManager} from './src/app/services/PluginManager'; export * as InteractionScope from './src/app/services/tableInteractionScope'; export {PluginLoader} from './src/app/services/PluginLoader'; export {PluginVersionManager} from './src/app/services/PluginVersionManager'; export {default as csv} from './src/app/plugins/examples/CSVExporterPlugin'; export {default as template} from './templates/plugin-template/src/index';`,resolveDir:studio},bundle:true,platform:'node',format:'cjs',outfile,tsconfig:path.join(studio,'tsconfig.json'),plugins:[{name:'native-boundary',setup(b){
 if (fixture) {
  b.onLoad({filter:/[\\/]tauri\.conf\.json$/}, args => {
   if (args.path === path.join(studio, 'src-tauri/tauri.conf.json')) return {contents: JSON.stringify({...require('../src-tauri/tauri.conf.json'), version:hostVersion}), loader:'json'};
  });
  b.onLoad({filter:/\.ts$/}, args => {
   const key = Object.keys(sourcePaths).find(name => sourcePaths[name] === args.path);
   if (key) return {contents:fixture.sources[key], loader:'ts', resolveDir:path.dirname(args.path)};
  });
 }
 b.onResolve({filter:/^@tauri-apps\/api\/event$/},()=>({path:'events',namespace:'mock'}));
 b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'invoke',namespace:'mock'}));
 b.onResolve({filter:/^@\/app\/settings$/},()=>({path:'settings',namespace:'mock'}));
 b.onResolve({filter:/^@\/app\/i18n$/},()=>({path:'i18n',namespace:'mock'}));
 b.onResolve({filter:/AdvancedCSVExportDialog$/},()=>({path:'modal',namespace:'mock'}));
 b.onResolve({filter:/table_rule_dialogs$/},()=>({path:'warnings',namespace:'mock'}));
 b.onResolve({filter:/projectCommands$/},()=>({path:'project',namespace:'mock'}));
 b.onResolve({filter:/tableCommands$/},()=>({path:'tables',namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:({
 settings:`export const getSettingsSnapshot=()=>({appVersion:globalThis.__appVersion,generation:'g',revision:'r',bundle:{pluginStates:{'csv-exporter':true,'contract-test':true},pluginSettings:{'csv-exporter':{settings:{defaultDelimiter:',',defaultEncoding:'utf-8'}}}}});export const initializeAppSettings=async()=>{};export const refreshAppSettings=async()=>{};export const subscribeSettings=()=>()=>{};`,
 events:'export const listen=async()=>()=>{};',
 invoke:'export const invoke=(...args)=>globalThis.__invoke(...args); export class Resource{}; export class Channel{};',
 i18n:`export const localizeError=e=>e?.text??e?.message??JSON.stringify(e); export const toAppError=e=>e?.kind?e:({kind:'text',text:localizeError(e)}); export const appErrorException=e=>Object.assign(new Error(localizeError(e)),{appError:toAppError(e)}); export const t=k=>k; export const message=(key,args)=>({key,args}); export const localizedError=d=>Object.assign(new Error(d.key), {details:d.args}); export const getLocale=()=>"en"; export const subscribeLocale=()=>()=>{}; export const registerPluginMessages=()=>()=>{}; export const translatePluginMessage=(_,key)=>key;`,
 modal:'export const AdvancedCSVExportDialog=()=>null;',
 warnings:'export const confirmInputWarnings=async()=>true;',
 project:'export const getProjectInfo=async()=>{const x=await globalThis.__invoke("get_project_session");return {...x,sessionId:x.id}}; export const saveProject=async()=>{}; export const closeProject=async()=>{}; export const createProject=async()=>{}; export const openProject=async()=>{};',
 tables:'export const loadTableByUuid=async(tableUuid,expectedProjectSession)=>{await globalThis.__invoke("get_table_data",{uuid:tableUuid,expectedProjectSession})}; export const invalidateTableCatalog=()=>{}; export const getTableCatalog=expectedProjectSession=>globalThis.__invoke("get_table_catalog",{expectedProjectSession});'
 })[a.path],loader:'js'}));
 }}]});
}
(async()=>{
 await bundleContracts(out);
 const {PluginManager,PluginLoader,PluginVersionManager,csv,template,InteractionScope}=require(out);
 const manager=PluginManager.getInstance();const api=manager.getAPI();
 assert.equal(api.app.version,'2.3.4-beta.1+qa');
 global.__appVersion='3.0.0';assert.equal(api.app.version,'3.0.0','plugin app version follows authoritative settings snapshot');
 global.__appVersion='0.1.0';
 manager.setActiveTable({uuid:'table-A',projectSession:'session-A'}); const bound=api.app.getState().activeTable; assert.equal(bound.projectSession,'session-A'); bound.uuid='mutated'; assert.equal(api.app.getState().activeTable.uuid,'table-A');
 InteractionScope.setTableInteractionTarget(session,'table-A');
 const writesBeforeImport=calls.filter(call=>call.name==='update_plugin_table').length;
 const importPausedWrite=api.data.updateTable('table-A',table,session,revision);
 InteractionScope.setTableInteractionTarget(session,null,true);
 await assert.rejects(importPausedWrite,/grid.waitForPresentation/);
 assert.equal(calls.filter(call=>call.name==='update_plugin_table').length,writesBeforeImport,'navigation during dynamic import prevents the native write');
 InteractionScope.setTableInteractionTarget(session,'table-A');
 let releaseCommand;const commandGate=new Promise(resolve=>releaseCommand=resolve);
 api.ui.registerCommand('navigation-stale',async()=>{await commandGate;await api.data.updateTable('table-A',table,session,revision);});
 const lateCommand=api.ui.executeCommand('navigation-stale');
 InteractionScope.setTableInteractionTarget(session,null,true);InteractionScope.setTableInteractionTarget(session,'table-B');
 releaseCommand();await assert.rejects(lateCommand,/grid.waitForPresentation/);
 assert.equal(calls.filter(call=>call.name==='update_plugin_table').length,writesBeforeImport,'a command resumed after a completed table switch retains its old scope');
 InteractionScope.setTableInteractionTarget(session,'table-A');
 const project=await api.project.getCurrent();assert.equal(project.sessionId,'session-A');
 const snapshot=await api.data.getTableSnapshot('table-A',project.sessionId);assert.equal(snapshot.revision,revision);
 await api.data.updateTable('table-A',snapshot.table,project.sessionId,snapshot.revision);
 const update=calls.find(x=>x.name==='update_plugin_table');assert.equal(update.args.expectedRevision,'revision-A');assert.equal(update.args.expectedProjectSession,'session-A');
 failWarning=true; await api.data.updateTable('table-A',snapshot.table,project.sessionId,snapshot.revision); const warningRetry=calls.filter(x=>x.name==='update_plugin_table').at(-1); assert.equal(warningRetry.args.acknowledgement,'approved'); assert.equal(warningRetry.args.expectedRevision,snapshot.revision); assert.equal(warningRetry.args.expectedProjectSession,project.sessionId);
 revision='revision-B';await assert.rejects(api.data.updateTable('table-A',snapshot.table,project.sessionId,snapshot.revision),/stale revision/);
 session='session-B';await assert.rejects(api.data.updateTable('table-A',snapshot.table,project.sessionId,revision),/stale session/);await assert.rejects(api.data.getTable('table-A',project.sessionId),/stale session/);
 assert.equal(await api.data.createTable({path:'new.table.toml'},session),'new-table-uuid'); assert.equal(calls.at(-1).name,'file_operation'); assert.equal(calls.at(-1).args.operation.type,'Create'); assert.equal(calls.at(-1).args.expectedProjectSession,session); await api.data.deleteTable('new-table-uuid',session);
 await assert.rejects(api.data.deleteTable('new.table.toml',session));
 const generated=await csv.extensions.exporters[0].export(table,{delimiter:',',includeHeaders:true});assert.match(generated,/canonical/);assert.doesNotMatch(generated,/OLD NAME/);assert.match(generated,/日本語/);
 await assert.rejects(csv.extensions.exporters[0].export({columns:[],rows:[]}));
 const dateTime='2030-01-02T12:34:56Z';
 const dates={...table,schema:{columns:[{ min_version: 0,...columnDefaults,uuid:'date-column',display_name:'When',data_name:'when',data_type:'DateTime'}]},records:[dateTime,'not-a-date',''].map((value,index)=>({...recordDefaults,uuid:`date-record-${index}`,label:'',min_version:0,values:{when:value},interface_values:{}}))};
 assert.equal(await csv.extensions.exporters[0].export(dates,{includeHeaders:false}),`${dateTime}\nnot-a-date\n`,'Basic CSV must preserve raw current DateTime values');
 const expectedDates={ISO:'2030-01-02',US:new Date(dateTime).toLocaleDateString('en-US'),EU:new Date(dateTime).toLocaleDateString('en-GB'),JP:new Date(dateTime).toLocaleDateString('ja-JP')};
 for(const [dateFormat,formatted] of Object.entries(expectedDates)){
  assert.equal(await csv.extensions.exporters[1].export(dates,{includeHeaders:false,dateFormat}),`${formatted}\nnot-a-date\n`,`Advanced CSV must format current DateTime (${dateFormat}) and preserve invalid/empty input`);
 }

 assert.equal(typeof PluginLoader.getInstance().loadFromDirectory,'undefined');assert.equal(typeof PluginVersionManager.getInstance().createAdapter,'undefined');
 for (const apiVersion of [undefined, '1.0.0', '1.0.0-alpha', '1.0.0+build', '1.0']) assert.throws(()=>PluginVersionManager.getInstance().validateMetadata({version:'1.0.0',apiVersion}));
 PluginVersionManager.getInstance().validateMetadata({version:'1.0.0',apiVersion:'2.0.0'});
 const manual=fs.readFileSync(path.join(studio,'../docs/manual/plugin-development.md'),'utf8');
 const documentedRanges=[...manual.matchAll(/devcelVersion["']?\s*:\s*["']([^"']+)["']/g)].map(match=>match[1]);
 assert.equal(documentedRanges.length,3,'All documented plugin host-version examples are tested');
 for(const devcelVersion of documentedRanges) PluginVersionManager.getInstance().validateMetadata({version:'1.0.0',apiVersion:'2.0.0',devcelVersion});
 // First-party ranges follow the current release; third-party semver stays strict.
 for (const [plugin, minimum] of [[csv, '0.0.0'], [template, '0.0.0']]) {
   assert.equal(plugin.metadata.devcelVersion, plugin === template ? `>=${minimum}` : compatibilityRange(currentVersion, minimum));
   if (plugin === template && semver.prerelease(currentVersion)) assert.throws(() => PluginVersionManager.getInstance().validateMetadata(plugin.metadata), /plugin.version.devcelRequired/);
   else PluginVersionManager.getInstance().validateMetadata(plugin.metadata);
   for (const host of [minimum, '1.0.0', ...(plugin === template && semver.prerelease(currentVersion) ? [] : [currentVersion])]) assert(semver.satisfies(host, plugin.metadata.devcelVersion), host);
   for (const host of ['0.0.99-unrelated.1']) assert(!semver.satisfies(host, plugin.metadata.devcelVersion), host);
 }
 if (semver.prerelease(require('../src-tauri/tauri.conf.json').version)) {
   assert.throws(() => PluginVersionManager.getInstance().validateMetadata({version:'1.0.0',apiVersion:'2.0.0',devcelVersion:'>=0.0.2'}), /plugin.version.devcelRequired/);
 }
 assert.throws(() => PluginVersionManager.getInstance().validateMetadata({version:'1.0.0',apiVersion:'2.0.0',devcelVersion:'>999.0.0'}), /plugin.version.devcelRequired/);
 console.log('PASS explicit bundled RC opt-in and unchanged strict third-party host compatibility');
 assert.equal((await PluginLoader.getInstance().loadFromCode('throw new Error("must not run")','untrusted')).success,false);
 let hook=0;const commands=new Set();const templateApi={...api,ui:{...api.ui,registerCommand:id=>{assert(!commands.has(id));commands.add(id)},showNotification(){}},events:{...api.events,on:()=>()=>{}},settings:{...api.settings,get:()=>undefined}};
 await template.activate(templateApi);assert.equal(commands.size,0);await template.hooks.onActivate(templateApi);assert.equal(commands.size,2);
 const plugin={metadata:{id:'contract-test',apiVersion:'2.0.0',name:'Contract',version:'1.0.0',description:'test',author:'test'},activate:async()=>{},deactivate:async()=>{},hooks:{onActivate:async scoped=>{assert(scoped.i18n);hook++}}};
 await assert.rejects(manager.registerPlugin({...plugin,metadata:{...plugin.metadata,id:'incomplete-theme'},extensions:{themes:[{id:'partial',name:'Partial',description:'Incomplete tokens',type:'light',colors:{primary:'160 50% 50%'}}]}}),/plugin.manager.error.invalidDefinition/);
 await manager.registerPlugin(plugin,{trustedSession:true});await manager.activatePlugin('contract-test');assert.equal(hook,1);await manager.deactivatePlugin('contract-test');
 // These are actual sources emitted by the release synchronizer, not hand-made metadata.
 for (const [index, fixture] of bundledFixtures.entries()) {
   assert(semver.valid(fixture.version), 'fixture has a valid release version');
   for (const key of ['csv', 'template']) assert.equal(typeof fixture.sources[key], 'string', 'fixture contains actual generated TypeScript');
   for (const [hostIndex, host] of [fixture.version, '99.0.0-unrelated.1'].entries()) {
     const fixtureOut = path.join(work, `bundled-${index}-${hostIndex}.cjs`);
     await bundleContracts(fixtureOut, fixture, host);
     const compiled = require(fixtureOut);
     assert.equal(compiled.testedHostVersion, host, 'The fixture must use the canonical host-version input');
     const registration = compiled.PluginManager.getInstance();
     for (const [kind, minimum] of [['csv', '0.0.0'], ['template', '0.0.0']]) {
       const actual = compiled[kind];
       assert.equal(actual.metadata.devcelVersion, kind === 'template' ? `>=${minimum}` : compatibilityRange(fixture.version, minimum));
       if (hostIndex === 0 && !(kind === 'template' && semver.prerelease(host))) await registration.registerPlugin(actual, {trustedSession:true});
       else await assert.rejects(registration.registerPlugin(actual, {trustedSession:true}), /plugin.version.devcelRequired/);
       if (semver.prerelease(host)) {
         const thirdParty = {...actual, metadata:{...actual.metadata, id:`third-party-${kind}`, devcelVersion:`>=${minimum}`}};
         await assert.rejects(registration.registerPlugin(thirdParty, {trustedSession:true}), /plugin.version.devcelRequired/);
       }
     }
   }
 }
 if (bundledFixtures.length) console.log(`PASS ${bundledFixtures.length} generated release transitions through production plugin registration`);
 console.log('PASS: plugin session/revision forwarding, stale rejection, UUID-only targets, current CSV and DateTime formats, trust, host version gate, scoped i18n, template/host single activation');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(work,{recursive:true,force:true}));
