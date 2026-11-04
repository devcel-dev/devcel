// Production ColorCell + display formatter. Core presentation is fixture data; no GPU/native authority is claimed.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import { compile } from 'tailwindcss';
import { Window } from 'happy-dom';
const project=resolve(import.meta.dirname,'..'),temporary=await mkdtemp(resolve(project,'.color-cell-check-'));
const browser=new Window({url:'http://color-cell.invalid'});
for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','localStorage'])Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?browser:browser[name]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let root;
globalThis.__colorCellSnapshot=undefined;
try{
  const bundled=await build({absWorkingDir:project,stdin:{contents:`export * from './src/app/components/color/colorCellDisplay';export * from './src/app/components/color/colorDisplay';export {ColorCell} from './src/app/pages/main_window/project_view/table_view/components/ColorCell';export {createGridDisplayModel} from './src/app/pages/main_window/project_view/table_view/components/gridDisplayModel';export {serializeClipboardTsv} from './src/app/pages/main_window/project_view/table_view/components/gridClipboard';export {t} from './src/app/i18n';export * as settings from './src/app/settings';`,resolveDir:project,loader:'ts'},bundle:true,format:'esm',platform:'node',packages:'external',jsx:'automatic',write:false,loader:{'.css':'empty'},alias:{'@':resolve(project,'src')},plugins:[{name:'settings-native-snapshot',setup(plugin){plugin.onResolve({filter:/^@tauri-apps\/api\/core$/},args=>({path:args.path,namespace:'settings-native'}));plugin.onLoad({filter:/.*/,namespace:'settings-native'},()=>({contents:'export const isTauri=()=>true;export const invoke=async(name)=>{if(name!=="get_app_settings")throw Error("Unexpected native command: "+name);return globalThis.__colorCellSnapshot};'}));}}]});
  const path=resolve(temporary,'check.mjs');await writeFile(path,bundled.outputFiles[0].text);const ui=await import(pathToFileURL(path));const React=await import('react'),{createRoot}=await import('react-dom/client');
  const host=document.createElement('div');document.body.append(host);root=createRoot(host);const reports=[];const check=async(name,body)=>{await body();reports.push(name);};
  const column=(type='Color32')=>({ min_version: 0,uuid:'color',data_name:'color',display_name:'Color',data_type:type,read_only: false, default_value:'',tags:[],tooltip:'',memo_text:'',color_swatches:[],style:{width:190}});
  const row=(value,raw=value,error=null)=>({rowId:'row',rowLabel:'Row',rowIndex:0,color:value,cellPresentations:{color:{display_value:value,raw_value:raw,formula_error:error,style:{}}}});
  let opened=[];
  const render=async(r,c)=>React.act(async()=>{root.render(React.createElement(ui.ColorCell,{row:r,column:c,onOpen:(...args)=>opened.push(args)}));});
  let settingsRevision=0;
  const applyDisplay=async(type,interpretation)=>{
    const current=ui.settings.getSettingsSnapshot(),bundle=structuredClone(current.bundle);
    bundle.values[type==='Color32'?'color32Display':'colorFloatDisplay']=interpretation;
    globalThis.__colorCellSnapshot={...current,bundle,revision:`cell:${++settingsRevision}`,generation:`cell:${settingsRevision}`,source:'project',warning:null,resolvedLocale:'ja'};
    await ui.settings.refreshAppSettings();
  };
  const visible=()=>host.querySelector('[data-color-cell-value]').textContent;
  const noAlpha=()=>{assert.equal(host.querySelector('[data-color-cell-alpha]'),null);assert(!host.textContent.includes('α'));};
  await check('Byte cells show only six-digit uppercase RGB HEX regardless of alpha',async()=>{
    for(const alpha of [0,1,128,254,255])assert.equal(ui.colorCellText([10,20,255,alpha],'Color32','srgb'),'#0A14FF');
    await render(row('[10,20,255,128]'),column());assert.equal(visible(),'#0A14FF');noAlpha();assert.equal(host.querySelector('[data-color-cell-value]').title,'[10,20,255,128]');
    assert.equal(ui.colorCellText([10,20,255,128],'Color32','linear'),'#0A14FF');
  });
  await check('Float HEX reuses the shared SDR preview conversion for both interpretations without mutating channels',async()=>{
    for(const interpretation of ['linear','srgb'])for(const channels of [[0.5,0.25,0.125,1],[8,-0.25,0.2,0.5],[1.401298464324817e-45,-1.401298464324817e-45,-0,0],[3.4028234663852886e38,Math.fround(1+1e-7),Math.fround(1-1e-7),0.99999988]]){
      const before=[...channels],preview=ui.colorPreviewRgba(channels,'ColorFloat',interpretation),expected='#'+preview.slice(0,3).map(value=>value.toString(16).padStart(2,'0')).join('').toUpperCase();
      assert.equal(ui.colorCellText(channels,'ColorFloat',interpretation),expected);assert.match(expected,/^#[0-9A-F]{6}$/);assert(channels.every((value,index)=>Object.is(value,before[index])));
    }
    assert.equal(ui.colorCellText([0.5,0.25,0.125,1],'ColorFloat','linear'),'#BC8963');assert.equal(ui.colorCellText([0.5,0.25,0.125,1],'ColorFloat','srgb'),'#804020');
    await React.act(async()=>applyDisplay('ColorFloat','linear'));const value='[8,0.20000000298023224,-0.0000001,0.5]';await render(row(value),column('ColorFloat'));assert.equal(visible(),'#FF7C00');noAlpha();assert.equal(host.querySelector('[data-color-cell-value]').title,value);
  });
  await check('Alpha changes only checker compositing and canonical tooltip, never HEX or extra text',async()=>{
    for(const [type,rgb,alphas] of [['Color32',[10,20,30],[0,128,255]],['ColorFloat',[8,-0.5,0.2],[0,1.401298464324817e-45,0.5,0.99999988,1]]]){
      let shown;for(const alpha of alphas){const value=JSON.stringify([...rgb,alpha]);await render(row(value),column(type));shown??=visible();assert.equal(visible(),shown);noAlpha();assert.equal(host.querySelector('.color-cell-container').title,value);const preview=host.querySelector('button span.absolute');assert(preview);const expected=document.createElement('span');expected.style.backgroundColor=ui.colorPreviewCss([...rgb,alpha],type,ui.getColorInterpretation(type));assert.equal(preview.style.backgroundColor,expected.style.backgroundColor);assert(host.querySelector('button > span').style.backgroundImage.includes('conic-gradient'));}
    }
  });
  await check('Formula results share HEX view while errors, source formulas and preview click remain authoritative',async()=>{
    for(const [type,value,hex] of [['Color32','[1,2,3,128]','#010203'],['ColorFloat','[8,0.5,-0.25,0.5]','#FFBC00']]){
      const raw='=COLOR_RESULT()',r=row(value,raw),c=column(type);await render(r,c);assert.equal(visible(),hex);noAlpha();assert(host.textContent.includes(ui.t('color.formulaSymbol')));assert.equal(host.querySelector('button').getAttribute('aria-label'),ui.t('color.openFormula'));
      await React.act(async()=>host.querySelector('button').click());assert.equal(opened.at(-1)[0],r);assert.equal(opened.at(-1)[1],c);assert.equal(r.cellPresentations.color.raw_value,raw);
      await render(row('#FORMULA!',raw,'failed'),c);assert.equal(visible(),'#FORMULA!');noAlpha();assert(host.querySelector('[data-color-cell-value]').classList.contains('text-red-700'));assert.equal(host.querySelector('button span.absolute'),null);
      await render(row('[malformed]'),c);assert.equal(visible(),'[malformed]');noAlpha();
    }
  });
  await check('Mouse swatch opening focuses the clicked opener before the owner captures dialog focus',async()=>{
    const previous=document.createElement('button');document.body.append(previous);previous.focus();assert.equal(document.activeElement,previous);
    let captured;const r=row('[1,2,3,255]'),c=column();await React.act(async()=>root.render(React.createElement(ui.ColorCell,{row:r,column:c,onOpen:()=>{captured=document.activeElement;}})));
    const swatch=host.querySelector('button');let bubbled=false;host.onmousedown=()=>{bubbled=true;};
    const down=new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true});await React.act(async()=>swatch.dispatchEvent(down));assert(down.defaultPrevented);assert(bubbled,'grid selection still receives mousedown');
    await React.act(async()=>swatch.click());assert.equal(captured,swatch);assert.equal(document.activeElement,swatch);host.onmousedown=null;previous.remove();
  });
  await check('Narrow cells truncate only HEX while retaining swatch, formula mark, canonical tooltip and click',async()=>{
    for(const width of [50,80,110]){host.style.width=`${width}px`;const canonical='[8,-0.25,0.000001,0.5]';await render(row(canonical,'=HDR()'),column('ColorFloat'));const container=host.querySelector('.color-cell-content'),value=host.querySelector('[data-color-cell-value]');
      assert(container.classList.contains('min-w-0')&&container.classList.contains('overflow-hidden'));assert(value.classList.contains('min-w-0')&&value.classList.contains('truncate'));assert(host.querySelector('button').classList.contains('shrink-0'));assert(container.lastElementChild.classList.contains('shrink-0'));assert.equal(host.querySelector('.color-cell-container').title,canonical);noAlpha();
      const before=opened.length;await React.act(async()=>host.querySelector('button').click());assert.equal(opened.length,before+1);
    }host.style.width='';
  });
  await check('Compiled narrow CSS beats later Tailwind utilities and contains no alpha or forced HEX hiding rules',async()=>{
    const css=await readFile(resolve(project,'src/app/pages/main_window/project_view/table_view/components/ColorCell.css'),'utf8');assert.match(css,/container: devcel-color-cell \/ inline-size/);assert(!css.includes('alpha'));assert(!css.includes('display: none'));
    const theme=await readFile(new URL(import.meta.resolve('tailwindcss/theme.css')),'utf8');
    const compiler=await compile(`${theme}\n${css}\n@tailwind utilities;`);
    const compiled=postcss.parse(compiler.build(['gap-2','px-2','w-5']));
    let spacing;compiled.walkDecls('--spacing',declaration=>{spacing=declaration.value;});assert.equal(spacing,'0.25rem');
    const rules=[];compiled.walkRules(rule=>rules.push(rule));const declaration=(rule,prop)=>rule.nodes.find(node=>node.type==='decl'&&node.prop===prop)?.value;
    const gaps=rules.filter(rule=>rule.selector==='.color-cell-container .color-cell-content');assert.equal(gaps.length,2);assert.equal(declaration(gaps[0],'gap'),'4px');assert.equal(declaration(gaps[1],'gap'),'2px');assert.equal(declaration(gaps[1],'padding-inline'),'4px');
    const gapUtility=rules.find(rule=>rule.selector==='.gap-2'),paddingUtility=rules.find(rule=>rule.selector==='.px-2'),widthUtility=rules.find(rule=>rule.selector==='.w-5');assert(gapUtility&&paddingUtility&&widthUtility);assert(rules.indexOf(gapUtility)>rules.indexOf(gaps[1]),'worst-case later utility order');assert.equal(declaration(gapUtility,'gap'),'calc(var(--spacing) * 2)');assert.equal(declaration(paddingUtility,'padding-inline'),'calc(var(--spacing) * 2)');
    assert(gaps.every(rule=>(rule.selector.match(/\./g)??[]).length===2));const preview=rules.find(rule=>rule.selector==='.color-cell-content .color-cell-preview');assert.equal(declaration(preview,'width'),'16px');assert.equal(declaration(widthUtility,'width'),'calc(var(--spacing) * 5)');
  });
  await check('Interpretation updates float HEX and swatch together but preserves canonical data and byte RGB HEX',async()=>{
    for(const [type,value] of [['ColorFloat','[0.5,0.25,-0.1,0]'],['Color32','[128,64,32,128]']]){
      const r=row(value),c=column(type),before=JSON.stringify(r);await React.act(async()=>applyDisplay(type,'linear'));await render(r,c);const shown=visible(),style=host.querySelector('button span.absolute').style.backgroundColor;
      await React.act(async()=>applyDisplay(type,'srgb'));assert.notEqual(host.querySelector('button span.absolute').style.backgroundColor,style);if(type==='ColorFloat')assert.notEqual(visible(),shown);else assert.equal(visible(),shown);noAlpha();assert.equal(host.querySelector('[data-color-cell-value]').title,value);assert.equal(JSON.stringify(r),before);
    }
  });
  await check('Grid display and clipboard retain canonical evaluated RGBA rather than preview HEX',async()=>{
    await React.act(async()=>applyDisplay('ColorFloat','linear'));const c=column('ColorFloat'),value='[8,0.20000000298023224,-0.0000001,0.5]',raw='=HDR()',record={ min_version: 0,uuid:'row',label:'Row',values:{color:raw}};
    const table={metadata:{initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true }, uuid:'table'},schema:{columns:[c]},records:[record]},before=JSON.stringify(table);const presentation={cells:{row:{color:{display_value:value,raw_value:raw,formula_error:null,style:{}}}}};
    const model=ui.createGridDisplayModel(undefined,table,presentation,'session');await render(model.rows[0],model.columns[0]);assert.equal(visible(),'#FF7C00');assert.equal(model.rows[0].color,value);assert.equal(model.rows[0].cellPresentations.color.raw_value,raw);assert.equal(ui.serializeClipboardTsv([[model.rows[0].color]]),value);assert.equal(JSON.stringify(table),before);
    const grid=await readFile(resolve(project,'src/app/pages/main_window/project_view/table_view/components/DataGridView.tsx'),'utf8');assert.match(grid,/isColorType\(dataType\)[\s\S]*?renderCell = props => <ColorCell row=\{props.row\} column=\{column\} onOpen=\{expandColorCell\}/);
  });
  console.log(JSON.stringify({passed:reports.length,checks:reports,scope:'Production formatter, ColorCell and grid display DTOs; synthetic DOM layout. Native pixels and Rust storage/export validated separately.'},null,2));
}finally{if(root)await(await import('react')).act(async()=>root.unmount());delete globalThis.__colorCellSnapshot;await browser.happyDOM.abort();await rm(temporary,{recursive:true,force:true});}
