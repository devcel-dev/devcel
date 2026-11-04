// Production DataGridView + header/badge/toolbar integration. Native state/IPC are stubbed.
// This checks component wiring and displayed snapshot revisions, not native layout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { compileModule } = require('./compile-module.cjs');
const root = path.resolve(__dirname, '..');
(async () => {
  const { Window } = await import('happy-dom');
  const window = new Window({url:'http://version-integration.invalid'});
  for (const name of ['window','document','navigator','HTMLElement','HTMLInputElement','Element','Node','Event','MouseEvent','KeyboardEvent','MutationObserver']) Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?window:window[name]});
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const {createRoot} = require('react-dom/client');
  const {IntlMessageFormat} = require('intl-messageformat');
  const catalog = JSON.parse(fs.readFileSync(path.join(root,'src/app/i18n/generated/catalog.json'))).messages.ja;
  const t=(key,values)=>{ assert(Object.hasOwn(catalog,key),`missing ${key}`);return String(new IntlMessageFormat(catalog[key],'ja',undefined,{ignoreTag:true}).format(values)); };
  const i18n={getLocaleDirection:()=> 'ltr',matchLocale:()=>'ja',t,useI18n:()=>({t,locale:'ja'}),formatNumber:String,message:(key,values)=>({key,values}),localizeError:String,localizedError:value=>Error(String(value)),resolveMessage:value=>typeof value==='string'?value:t(value.key,value.values)};
  const cache=new Map();const mocks={};
  function load(relative){const filename=path.resolve(root,relative);if(cache.has(filename))return cache.get(filename);const m=new Module(filename);m.paths=Module._nodeModulePaths(root);m.require=id=>{if(id in mocks)return mocks[id];if(id==='@/app/i18n')return i18n;if(id.endsWith('.css'))return{};if(id.startsWith('.')||id.startsWith('@/')){let p=id.startsWith('@/')?path.join(root,'src',id.slice(2)):path.resolve(path.dirname(filename),id);for(const suffix of ['','.tsx','.ts','/index.ts'])if(fs.existsSync(p+suffix)&&fs.statSync(p+suffix).isFile())return load(p+suffix);throw Error(p);}return require(id);};m._compile(compileModule(fs.readFileSync(filename,'utf8'), filename),filename);cache.set(filename,m.exports);return m.exports;}
  const column=(uuid,min)=>({uuid,data_name:uuid,display_name:uuid,data_type:'F64',min_version:min,style:{width:100,color:'#FFFFFF',font_size:12},tags:[],read_only:false,default_value:''});
  let table={uuid:'table',display_name:'Items',description:'',metadata:{initial_transposed: false, edit_permissions: { add_columns: true, delete_columns: true, add_rows: true, delete_rows: true, edit_cells: true },data_name:'Items'},schema:{columns:[column('base',0),column('rate',3),column('price',2)]},records:[{uuid:'row',label:'row1',min_version:2,values:{base:'100',rate:'1.2',price:'=base*rate'},interface_values:{},tags:[]}]};
  let presentation={revision:'displayed-revision',definition_issues:[],issue_count:0,cells:{row:{price:{display_value:'120',style:{},issues:[]}}}};
  let runAccept;let captured;let grid;let fail=false;let busy=false;
  const getCurrent=()=>presentation;const noop=()=>{};
  mocks['@tauri-apps/api/core']={invoke:async command=>command==='get_interfaces'?'[]':undefined};
  mocks['./useTablePresentation']={useTablePresentation:()=>({presentation,ready:true,getCurrent,accept:(p)=>{presentation=p},setPaused:()=>false,refresh:async()=>{},error:null})};
  const run=async factory=>{captured=await factory();if(fail)return false;const next=structuredClone(table);for(const v of captured.versions)next.records.find(r=>r.uuid===v.record_uuid).min_version=Number(v.min_version);for(const v of captured.column_versions)next.schema.columns.find(c=>c.uuid===v.column_uuid).min_version=Number(v.min_version);table=next;runAccept({table,presentation});return true;};
  mocks['./useTableMutation']={useTableMutation:(uuid,session,accept)=>{assert.equal(uuid,'table');assert.equal(session,'session');runAccept=accept;return{run,busy,isBusy:()=>busy,error:null,clearError:noop,undo:noop,redo:noop};}};
  mocks['./useDataGridColumnWidth']={useDataGridColumnWidth:()=>({getColumnWidth:(_id,value)=>value,queueColumnWidth:noop,flushColumnWidths:noop})};
  mocks['./useDataGridRowHeight']={useDataGridRowHeight:()=>({getRowHeight:()=>30,setRowHeight:noop})};
  for(const [id,names] of Object.entries({'@/app/components/column-editor/ColumnEditor':['ColumnEditor'],'./DataGridContextMenu':['DataGridContextMenu'],'./DataGridInlineDialogs':['InlineEditDialog'],'./ReferenceCell':['ReferenceCellRenderer','ReferenceCellEditor'],'./TableRefCell':['TableRefCellRenderer','TableRefCellEditor'],'./CurveCell':['CurveCellRenderer','CurveCellEditor'],'@/app/components/interface/InterfaceDialog':['InterfaceDialog']}))mocks[id]=Object.fromEntries(names.map(n=>[n,()=>null]));
  mocks['@/app/utils/bulk_row_dialog']={showBulkRowDialog:async()=>null};
  // Real DataGrid rendering with deterministic geometry in the synthetic DOM.
  globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  for (const name of ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame','addEventListener','removeEventListener']) globalThis[name]=window[name].bind(window);
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth:{configurable:true,get(){return 900}},clientWidth:{configurable:true,get(){return 900}},
    offsetHeight:{configurable:true,get(){return 400}},clientHeight:{configurable:true,get(){return 400}}
  });
  window.HTMLElement.prototype.getBoundingClientRect=function(){return new window.DOMRect(0,0,900,400)};
  mocks['@linaria/core']={css:()=> 'synthetic-grid-style'};
  const NativeGrid=load('src/lib/react-data-grid/DataGrid.tsx').DataGrid;
  mocks['@/lib/react-data-grid']={DataGrid:React.forwardRef((p,ref)=>{grid=p;return React.createElement(NativeGrid,{...p,ref,enableVirtualization:false});})};
  const DataGridView=load('src/app/pages/main_window/project_view/table_view/components/DataGridView.tsx').default;
  const host=document.createElement('div');document.body.append(host);const mounted=createRoot(host);
  let props={projectSessionId:'session',tableData:table,tableName:'Items',versionEditMode:true,versionPreview:true,releaseVersion:2};
  const render=async extra=>{props={...props,...extra};await React.act(async()=>mounted.render(React.createElement(DataGridView,props)));};
  const click=async element=>React.act(async()=>element.click());
  const edit=async(input,value)=>React.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}));});
  const key=async(input,key)=>React.act(async()=>input.dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,key})));
  await render();
  assert.equal(grid.columns.length,3);assert(!grid.columns.some(c=>c.key==='version'));assert.equal(grid.rows.length,1);assert(!('version' in grid.rows[0]));
  // Header filters also name their column; select only the version control under test.
  const badge=(fragment)=>{const matches=[...host.querySelectorAll('[data-version-badge="true"] button')].filter(e=>e.getAttribute('aria-label')?.includes(fragment));assert(matches.length<=1,`ambiguous version badge ${fragment}`);return matches[0];};
  assert(badge('base'));assert(badge('rate'));assert(badge('price'));
  await click(badge('base'));let input=host.querySelector('input[aria-label*="base"]');assert(input);await edit(input,'2');await key(input,'Enter');
  assert.deepEqual(captured.column_versions,[{column_uuid:'base',min_version:'2'}]);assert.deepEqual(captured.versions,[]);assert.equal(captured.expected_revision,'displayed-revision');assert.equal(captured.table_uuid,'table');
  await click(badge('行 1'));input=host.querySelector('input[aria-label*="行 1"]');await edit(input,'3');await key(input,'Enter');assert.deepEqual(captured.versions,[{record_uuid:'row',min_version:'3'}]);assert.deepEqual(captured.column_versions,[]);
  await render({tableData:table,releaseVersion:2});assert(grid.columns.find(c=>c.key==='rate').headerCellClass.includes('rdg-version-excluded'));assert(!grid.columns.find(c=>c.key==='price').headerCellClass.includes('rdg-version-excluded'));assert.equal(grid.columns.find(c=>c.key==='rate').editable,true);assert.equal(grid.rows[0].price,'120');
  await render({releaseVersion:3});assert(!grid.columns.find(c=>c.key==='rate').headerCellClass.includes('rdg-version-excluded'));
  fail=true;await click(badge('base'));input=host.querySelector('input[aria-label*="base"]');await edit(input,'4');await key(input,'Enter');assert.equal(host.querySelector('input[aria-label*="base"]').value,'4');await render({releaseVersion:2});assert.equal(host.querySelector('input[aria-label*="base"]').value,'4');await key(input,'Escape');assert(!host.querySelector('input[aria-label*="base"]'));
  await render({versionEditMode:false,versionPreview:true});assert(!badge('base'));assert(!grid.columns.find(c=>c.key==='rate').headerCellClass.includes('rdg-version-excluded'));assert.equal(grid.headerRowHeight,35);
  // Production columns + Cell: host display must retain values,
  // diagnostics, styles, selection events or the exact 64-bit numeric display.
  const NativeCell=load('src/lib/react-data-grid/Cell.tsx').default;
  const cellHost=document.createElement('div');document.body.append(cellHost);const cellRoot=createRoot(cellHost);
  const sharedTooltip={onFocus:noop,onBlur:noop,onMouseEnter:noop,onMouseLeave:noop,onClick:noop};
  const calculated=source=>({...source,idx:0,frozen:false,renderEditCell:()=>null});
  const baseColumn=calculated(grid.columns.find(c=>c.key==='base')),baseRow=grid.rows[0];
  const emptyCell={display_value:'100',hint:'',formula_error:null,style:{},issues:[]};
  const withCell=cell=>({...baseRow,cellPresentations:cell===undefined?{}:{base:cell}});
  const drawCell=async(row,source=baseColumn,extra={})=>{await React.act(async()=>cellRoot.render(React.createElement(NativeCell,{
    row,rowIdx:0,column:source,isCellSelected:false,isRowSelected:false,isDraggedOver:false,
    onRowChange:noop,selectCell:noop,sharedTooltip,getCellBackgroundColor:grid.getCellBackgroundColor,...extra
  })));return cellHost.querySelector('[role="gridcell"]');};
  try {
    const absent=withCell(undefined),empty=withCell(emptyCell);
    for(const row of [absent,empty]){
      assert.equal(baseColumn.cellDescription(row),undefined);
      assert.equal(baseColumn.styleResolver(row.base,row),undefined);
    }
    let node=await drawCell(absent);const absentMarkup=cellHost.innerHTML;
    assert.equal(cellHost.querySelectorAll('*').length,1,'plain cell has only its semantic host');
    assert.equal(node.firstElementChild,null);assert.equal(node.textContent,'100');
    for(const attribute of ['title','aria-description','aria-invalid'])assert.equal(node.hasAttribute(attribute),false);
    await drawCell(empty);assert.equal(cellHost.innerHTML,absentMarkup);
    const hintRow=withCell({...emptyCell,hint:'Canonical input hint'});
    assert.deepEqual(baseColumn.cellDescription(hintRow),{title:'Canonical input hint',description:'Canonical input hint',invalid:undefined});
    node=await drawCell(hintRow);assert.equal(node.title,'Canonical input hint');assert.equal(node.getAttribute('aria-description'),'Canonical input hint');
    const formulaRow=withCell({...emptyCell,display_value:'#DIV/0!',formula_error:'Division by zero'});
    node=await drawCell(formulaRow);assert.equal(node.textContent,'#DIV/0!');assert.equal(node.title,'Division by zero');assert.equal(node.style.color,'#b91c1c');
    assert.deepEqual(baseColumn.styleResolver(formulaRow.base,formulaRow),{color:'#b91c1c'});
    for(const mode of ['warn','reject']){
      const row=withCell({...emptyCell,issues:[{mode}]}),expected=`inset 0 -2px ${mode==='reject'?'#dc2626':'#d97706'}`;
      assert.equal(baseColumn.cellDescription(row).invalid,true);assert.deepEqual(baseColumn.styleResolver(row.base,row),{boxShadow:expected});
      node=await drawCell(row);assert.equal(node.getAttribute('aria-invalid'),'true');assert.equal(node.style.boxShadow,expected);
    }
    for(const bold of [false,true]){
      const row=withCell({...emptyCell,style:{text_color:'#123456',bold}});
      assert.deepEqual(baseColumn.styleResolver(row.base,row),{color:'#123456',fontWeight:bold?700:400});
      node=await drawCell(row);assert.equal(node.style.color,'#123456');assert.equal(node.style.fontWeight,bold?'700':'400');assert.equal(node.firstElementChild,null);
    }
    await drawCell(empty);assert.equal(cellHost.innerHTML,absentMarkup,'removing metadata/styles clears stale DOM properties');
    const backgroundOnly=withCell({...emptyCell,style:{background_color:'#abcdef'}});
    assert.deepEqual(baseColumn.styleResolver(backgroundOnly.base,backgroundOnly),{color:'#000000'});
    node=await drawCell(backgroundOnly);assert.equal(node.style.backgroundColor,'#abcdef');
    // happy-dom does not parse color-mix: compare the exact production result directly.
    assert.equal(grid.getCellBackgroundColor(empty,baseColumn,{isSelected:false,isHovered:false,rowIdx:0,isEvenRow:true}),
      'color-mix(in srgb, hsl(var(--background)) 75%, #e3f2fd)');
    let selected;await drawCell(empty,baseColumn,{selectCell:(...args)=>{selected=args}});
    await React.act(async()=>cellHost.firstElementChild.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true})));
    assert.deepEqual(selected,[{rowIdx:0,idx:0},{enableEditor:false,isShiftPressed:false}]);
    const types=['U8','I8','U16','I16','U32','I32','U64','I64','F32','F64','String'];
    table={...table,schema:{columns:types.map((type,index)=>({...column(`typed${index}`,0),data_type:type,read_only: false, default_value:'',style:{width:100,color:'#FFFFFF',font_size:index===0?18:12}}))},
      records:[{...table.records[0],values:Object.fromEntries(types.map((type,index)=>[`typed${index}`,type==='String'?'first\nsecond':type.startsWith('F')?'1.25':type.endsWith('64')?'9007199254740993':'42']))}]};
    presentation={...presentation,cells:{},revision:'typed-revision'};await render({tableData:table,versionEditMode:false,versionPreview:false});
    for(const [index,type] of types.entries()){
      const source=calculated(grid.columns[index]),row=grid.rows[0],numeric=type!=='String';
      assert.equal(source.cellClass(row),(numeric?'rdg-cell-type-number':'rdg-cell-type-string')+' rdg-cell-plain-display');
      const element=source.renderCell({row,rowIdx:0,column:source,tabIndex:-1,onRowChange:noop});assert.equal(typeof element,'string');
      node=await drawCell(row,source);assert.equal(node.textContent,type==='String'?'↵ first':row[source.key]);
      assert.equal(cellHost.querySelectorAll('*').length,1);assert.equal(node.firstElementChild,null);
      if(index===0){assert.deepEqual(source.styleResolver(row[source.key],row),{fontSize:'18px'});assert.equal(node.style.fontSize,'18px');}
      else assert.equal(source.styleResolver(row[source.key],row),undefined);
    }
    await render({versionEditMode:true,versionPreview:true,releaseVersion:0});
    assert(grid.columns[0].cellClass(grid.rows[0]).includes('rdg-version-excluded'));
    await render({releaseVersion:3});assert(!grid.columns[0].cellClass(grid.rows[0]).includes('rdg-version-excluded'));
    // Settings-only snapshots must invalidate cached column definitions immediately.
    const editableNumericHost=host.querySelector('.rdg-cell-type-number');
    await React.act(async()=>editableNumericHost.dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true})));
    const revokedDraft=host.querySelector('.rdg-editor-container input');
    assert(revokedDraft,'numeric draft opens while editing is permitted');
    await edit(revokedDraft,'73');
    const storedBeforeProtection=JSON.stringify(table.records);
    const mutationBeforeProtection=captured;
    const beforeProtection=grid.columns;
    table={...table,metadata:{...table.metadata,edit_permissions:{...table.metadata.edit_permissions,edit_cells:false}}};
    await render({tableData:table});
    assert.notEqual(grid.columns,beforeProtection);
    assert.equal(host.querySelector('.rdg-editor-container'),null,'protection snapshot closes the active draft without committing');
    await key(revokedDraft,'Enter');
    assert.equal(captured,mutationBeforeProtection,'detached draft Enter does not submit a mutation');
    assert.equal(JSON.stringify(table.records),storedBeforeProtection,'protection never commits or clears the raw input');
    for(const source of grid.columns){
      assert.equal(source.editable,false);
      assert(source.cellDescription(grid.rows[0]).title.includes(t('table.edit.cellsBlocked')));
    }
    const lockedNumericHost=host.querySelector('.rdg-cell-type-number');
    assert(lockedNumericHost,'numeric direct host is rendered');
    await React.act(async()=>lockedNumericHost.dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true})));
    assert.equal(host.querySelector('.rdg-editor-container'),null,'locked numeric double click cannot open an editor');
    let lockedSource=calculated(grid.columns[0]);
    node=await drawCell(grid.rows[0],lockedSource);
    assert.equal(node.textContent,'42','locking preserves numeric host values');
    assert.equal(node.title,t('table.edit.cellsBlocked'));
    const stringSource=calculated(grid.columns.at(-1));
    await drawCell(grid.rows[0],stringSource,{isCellSelected:true});
    assert.equal(cellHost.querySelector('.rdg-string-expand')?.disabled,true);
    table={...table,metadata:{...table.metadata,edit_permissions:{...table.metadata.edit_permissions,edit_cells:true}},
      schema:{columns:table.schema.columns.map((c,i)=>({...c,read_only:i===0}))}};
    await render({tableData:table});
    assert.equal(grid.columns[0].editable,false);
    assert.equal(grid.columns[1].editable,true,'column protection does not disable siblings');
    table={...table,schema:{columns:table.schema.columns.map(c=>({...c,read_only:false}))}};
    await render({tableData:table});
    assert.equal(grid.columns[0].editable,true);
    assert.equal(grid.columns[0].cellDescription(grid.rows[0]),undefined,'unlock clears cached protection reason');
    await React.act(async()=>host.querySelector('.rdg-cell-type-number').dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true})));
    const reopenedDraft=host.querySelector('.rdg-editor-container input');
    assert(reopenedDraft,'unlock permits editing again');
    assert.equal(reopenedDraft.value,'42','reopened editor uses untouched stored input, not the discarded draft');
    await key(reopenedDraft,'Escape');

    const specialTypes=['Boolean','Reference','TableRef','Color32','ColorFloat','Curve'];
    table={...table,schema:{columns:specialTypes.map((type,index)=>({...column(`special${index}`,0),data_type:type,read_only: false, default_value:''}))},
      records:[{...table.records[0],values:Object.fromEntries(specialTypes.map((_,index)=>[`special${index}`, '']))}]};
    await render({tableData:table,versionEditMode:false,versionPreview:false});
    for(const source of grid.columns) assert(!source.cellClass(grid.rows[0]).includes('rdg-cell-plain-display'),`${source.dataType} retains dedicated layout`);

    table={...table,metadata:{...table.metadata,edit_permissions:{...table.metadata.edit_permissions,edit_cells:false}}};
    await render({tableData:table});
    for(const source of grid.columns) assert.equal(source.editable,false);
    await drawCell(grid.rows[0],calculated(grid.columns[0]));
    assert.equal(cellHost.querySelector('input[type=checkbox]')?.disabled,true);
    for(const index of [3,4]){
      const source=grid.columns[index];
      assert.equal(source.renderCell({row:grid.rows[0],column:source,tabIndex:0,onRowChange:noop}).props.readOnly,true);
    }
    table={...table,metadata:{...table.metadata,edit_permissions:{...table.metadata.edit_permissions,edit_cells:true}}};
    await render({tableData:table});
    await drawCell(grid.rows[0],calculated(grid.columns[0]));
    assert.equal(cellHost.querySelector('input[type=checkbox]')?.disabled,false);

  } finally {await React.act(async()=>cellRoot.unmount());cellHost.remove();}
  await React.act(async()=>mounted.unmount());await window.happyDOM.close();
  console.log('PASS production version integration: payload/revision/session, badge drafts and preview; empty metadata/style fast paths, diagnostic clearing, single-host Cell DOM and preserved events and fixed numeric/type classification');
})().catch(e=>{console.error(e);process.exitCode=1;});
