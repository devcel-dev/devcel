/** Canonical Devcel schema-v1 reader. No Node, DOM or engine dependencies. */
const integerBounds = { I8: [-128n,127n], U8:[0n,255n], I16:[-32768n,32767n], U16:[0n,65535n], I32:[-2147483648n,2147483647n], U32:[0n,4294967295n], I64:[-9223372036854775808n,9223372036854775807n], U64:[0n,18446744073709551615n] };
const textTypes = new Set(['None','String','Select','DateTime','Reference','TableRef']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const name = x => typeof x === 'string' && x.length > 0;
const finite = x => typeof x === 'number' && Number.isFinite(x);
function requireThat(ok, message) { if (!ok) throw new Error(`Devcel: ${message}`); }
function freeze(x) { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
export class Color32 {
  constructor(r,g,b,a) { Object.assign(this,{r,g,b,a}); freeze(this); }
  toArray() { return [this.r,this.g,this.b,this.a]; }
  toFloat() { return new ColorFloat(this.r/255,this.g/255,this.b/255,this.a/255); }
}
/** Straight-alpha float channels: no RGB clamp, gamma conversion or premultiplication. */
export class ColorFloat {
  constructor(r,g,b,a) { Object.assign(this,{r,g,b,a}); freeze(this); }
  toArray() { return [this.r,this.g,this.b,this.a]; }
}
export class DevcelCurve {
  constructor(text = '', config = {}) {
    if (Object.keys(config).length) requireThat(finite(config.start_value) && finite(config.end_value), 'curve_config endpoints must be finite');
    const input = text ? JSON.parse(text) : {points:[{x:0,y:config.start_value??0,mode:'auto'},{x:1,y:config.end_value??1,mode:'auto'}]};
    requireThat(object(input) && Array.isArray(input.points) && input.points.length >= 2, 'Curve.points requires at least two points');
    const points = clone(input.points); let previous = -1;
    for (const p of points) {
      requireThat(object(p) && finite(p.x) && finite(p.y) && p.x >= 0 && p.x <= 1 && p.x > previous, 'Curve x/y invalid'); previous=p.x;
      requireThat(['constant','linear','auto','autoLength','free'].includes(p.mode), 'Curve mode invalid');
      for (const key of ['inSlope','outSlope','inLen','outLen']) if (p[key] !== undefined) requireThat(finite(p[key]),`Curve ${key} invalid`);
      for (const key of ['inLen','outLen']) if (p[key] !== undefined) requireThat(p[key]>=0&&p[key]<=3,`Curve ${key} outside 0..3`);
    }
    requireThat(points[0].x === 0 && points[points.length-1].x === 1,'Curve endpoints must be 0 and 1');
    if (Object.keys(config).length) { points[0].y=config.start_value; points[points.length-1].y=config.end_value; }
    this.points=freeze(points); freeze(this);
  }
  sample(x) {
    const p=this.points; if (Number.isNaN(x)) return 0;
    if(x<=0)return p[0].y; if(x>=1)return p[p.length-1].y;
    let i=0; while(i<p.length-2 && p[i+1].x<=x)i++;
    const a=p[i],b=p[i+1]; if(a.mode==='constant'||x===a.x)return a.y;
    const handle=(index,outgoing)=>{
      const q=p[index],prefix=outgoing?'out':'in';
      if(q.mode==='constant')return [0,1];
      if(q.mode==='linear'){const other=p[index+(outgoing?1:-1)];return [(other.y-q.y)/(other.x-q.x),1];}
      const left=p[Math.max(0,index-1)],right=p[Math.min(p.length-1,index+1)];
      const slope=(right.y-left.y)/Math.max(1e-9,right.x-left.x);
      return [q.mode==='free'?(q[prefix+'Slope']??slope):slope,q[prefix+'Len']??1];
    };
    const o=handle(i,true),n=handle(i+1,false),span=(b.x-a.x)/3,ol=span*o[1],il=span*n[1];
    const bez=(a,b,c,d,t)=>{const u=1-t;return u*u*u*a+3*u*u*t*b+3*u*t*t*c+t*t*t*d;};
    let low=0,high=1;
    for(let k=0;k<40;k++){const t=(low+high)/2;const sx=bez(a.x,a.x+ol,b.x-il,b.x,t); if(sx===x)return bez(a.y,a.y+o[0]*ol,b.y-n[0]*il,b.y,t);if(sx<x)low=t;else high=t;}
    return bez(a.y,a.y+o[0]*ol,b.y-n[0]*il,b.y,(low+high)/2);
  }
}
const colorPatterns = Object.fromEntries(['Color32','ColorFloat'].map(type => {
    const token=type==='Color32'?'(?:0|[1-9][0-9]*)':'-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?';
  return [type,new RegExp('^\\s*\\[\\s*'+token+'(?:\\s*,\\s*'+token+'){3}\\s*\\]\\s*$')];
}));
function decode(raw,column) {
  const type=column.data_type;
  if(integerBounds[type]) {
    const v=raw===''?'0':raw.trim(); requireThat(/^[+-]?\d+$/.test(v),`${type} requires integer text`);
    const n=BigInt(v),[min,max]=integerBounds[type];requireThat(n>=min&&n<=max,`${type} out of range`);
    return type==='I64'||type==='U64'?n:Number(n);
  }
  if(type==='F32'||type==='F64'){
    const v=raw===''?'0':raw.trim();requireThat(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v),`${type} requires decimal text`);
    const n=type==='F32'?Math.fround(Number(v)):Number(v);requireThat(finite(n),`${type} out of range`);return n;
  }
  if(type==='Boolean'){const v=(raw||'false').trim().toLowerCase();requireThat(v==='true'||v==='false','Boolean requires true/false');return v==='true';}
  if(type==='Color32'||type==='ColorFloat'){
    requireThat(colorPatterns[type].test(raw),`${type} requires four JSON numbers`);
    const values=JSON.parse(raw); requireThat(values.every(finite),`${type} requires finite channels`);
    if(type==='Color32'){requireThat(values.every(v=>Number.isInteger(v)&&v>=0&&v<=255),'Color32 outside 0..255');return new Color32(...values);}
    requireThat(values[3]>=0&&values[3]<=1,'ColorFloat alpha outside 0..1');const f=values.map(Math.fround);requireThat(f.every(finite),'ColorFloat exceeds F32');return new ColorFloat(...f);
  }
  if(type==='Curve')return new DevcelCurve(raw,column.curve_config??{});
  requireThat(textTypes.has(type),`unknown data type ${type}`);return raw;
}
// A decoder belongs to one column in one candidate snapshot; never a live cache.
function columnDecoder(column) {
  if(textTypes.has(column.data_type))return raw=>raw;
  const cache=new Map();
  return raw=>{
    if(cache.has(raw))return cache.get(raw);
    const value=decode(raw,column);
    // Scalars and the deeply frozen Color/Curve objects are safe to reuse.
    if(cache.size<256)cache.set(raw,value);
    return value;
  };
}
function parse(text) {
  const data=JSON.parse(text); requireThat(object(data)&&object(data.manifest)&&Array.isArray(data.tables),'manifest and tables required');
  const m=data.manifest;
  requireThat(m.schema_version===1&&name(m.content_hash)&&['full','minimal'].includes(m.mode),'unsupported/invalid manifest');
  requireThat(Number.isSafeInteger(m.data_revision)&&m.data_revision>=0&&name(m.generated_at),'invalid manifest revision/timestamp');
  if(m.content_version!=null)requireThat(Number.isInteger(m.content_version)&&m.content_version>=0&&m.content_version<=4294967295,'invalid content_version');
  requireThat(typeof data.project_name==='string','project_name required');
  const snapshot={manifest:freeze(clone(m)),projectName:data.project_name,tables:new Map(),uuids:new Map()};
  for(const t of data.tables){
    requireThat(object(t)&&name(t.name)&&name(t.uuid)&&Array.isArray(t.columns)&&Array.isArray(t.records),'invalid table');
    requireThat(!snapshot.tables.has(t.name)&&!snapshot.uuids.has(t.uuid),'duplicate table name/UUID');
    const interfaces=t.interfaces??[];requireThat(Array.isArray(interfaces)&&interfaces.every(name),'invalid interfaces');
    const table={name:t.name,uuid:t.uuid,interfaces:freeze([...interfaces]),columns:new Map(),records:new Map()};
    const plans=[];
    for(const c of t.columns){
      requireThat(object(c)&&name(c.name)&&!table.columns.has(c.name),'invalid/duplicate column');
      requireThat(textTypes.has(c.data_type)||integerBounds[c.data_type]||['F32','F64','Boolean','Color32','ColorFloat','Curve'].includes(c.data_type),'unknown column data type');
      requireThat(c.default_value==null||typeof c.default_value==='string','default_value requires string');
      for(const key of ['reference_config','table_ref_config','curve_config'])requireThat(c[key]==null||object(c[key]),`${key} requires object`);
      if(c.reference_config)requireThat(c.reference_config.target_table_uuid===undefined||typeof c.reference_config.target_table_uuid==='string','invalid reference UUID');
      if(c.table_ref_config)requireThat(c.table_ref_config.interface_uuid===undefined||typeof c.table_ref_config.interface_uuid==='string','invalid interface UUID');
      if(c.curve_config)new DevcelCurve('',c.curve_config);
      const decodeCell=columnDecoder(c);
      if(c.default_value!=null)decodeCell(c.default_value);
      plans.push({name:c.name,raw:c.default_value??(c.data_type==='Color32'?'[255,255,255,255]':c.data_type==='ColorFloat'?'[1,1,1,1]':''),decode:decodeCell});
      table.columns.set(c.name,freeze(clone(c)));
    }
    for(const r of t.records){
      requireThat(object(r)&&name(r.id)&&object(r.values)&&!table.records.has(r.id),'invalid/duplicate record');
      requireThat(Object.values(r.values).every(v=>typeof v==='string'),'all wire values must be strings');
      requireThat(Object.keys(r.values).every(key=>table.columns.has(key)),'record contains an unknown column');
      const raw=Object.create(null),typed=Object.create(null);
      for(const plan of plans){const n=plan.name,v=Object.prototype.hasOwnProperty.call(r.values,n)?r.values[n]:plan.raw;raw[n]=v;typed[n]=plan.decode(v);}
      // Decoders return primitives or deeply frozen values; only the row containers remain mutable.
      table.records.set(r.id,{raw:Object.freeze(raw),typed:Object.freeze(typed)});
    }
    snapshot.tables.set(t.name,table);snapshot.uuids.set(t.uuid,table);
  }
  return snapshot;
}
export class DevcelRow {
  constructor(snapshot,table,id){this._snapshot=snapshot;this._table=table;this.id=id;Object.freeze(this);}
  get tableName(){return this._table.name;}
  get index(){return [...this._table.records.keys()].indexOf(this.id);}
  columnInfo(column){const c=this._table.columns.get(column);requireThat(c,`missing column ${column}`);return c;}
  raw(column){this.columnInfo(column);return this._table.records.get(this.id).raw[column];}
  get(column){this.columnInfo(column);return this._table.records.get(this.id).typed[column];}
  _typed(column,type){requireThat(this.columnInfo(column).data_type===type,`expected ${type}: ${column}`);return this.get(column);}
  getString(column){return this.raw(column);}
  getI64(column){return this._typed(column,'I64');}
  getU64(column){return this._typed(column,'U64');}
  getNumber(column){const v=this.get(column);requireThat(typeof v==='number',`expected number: ${column}`);return v;}
  getBoolean(column){return this._typed(column,'Boolean');}
  getColor32(column){return this._typed(column,'Color32');}
  getColorFloat(column){return this._typed(column,'ColorFloat');}
  getCurve(column){return this._typed(column,'Curve');}
  reference(column,targetTableName){const c=this.columnInfo(column);requireThat(c.data_type==='Reference','expected Reference');const t=targetTableName?this._snapshot.tables.get(targetTableName):this._snapshot.uuids.get(c.reference_config?.target_table_uuid);return t?new DevcelTable(this._snapshot,t).byId(this.raw(column)):undefined;}
  tableReference(column,requiredInterface){const c=this.columnInfo(column);requireThat(c.data_type==='TableRef','expected TableRef');const t=this._snapshot.uuids.get(this.raw(column));if(!t)return undefined;const required=c.table_ref_config?.interface_uuid;return (required&&!t.interfaces.includes(required))||(requiredInterface&&!t.interfaces.includes(requiredInterface))?undefined:new DevcelTable(this._snapshot,t);}
}
export class DevcelTable {
  constructor(snapshot,table){this._snapshot=snapshot;this._table=table;Object.freeze(this);}
  get name(){return this._table.name;} get uuid(){return this._table.uuid;}
  get count(){return this._table.records.size;} get rowCount(){return this.count;}
  get interfaces(){return this._table.interfaces;}
  columns(){return [...this._table.columns.keys()];}
  columnInfo(name){return this._table.columns.get(name);}
  implementsInterface(uuid){return this.interfaces.includes(uuid);}
  byId(id){return this._table.records.has(id)?new DevcelRow(this._snapshot,this._table,id):undefined;}
  rowById(id){return this.byId(id);}
  at(index){return Number.isInteger(index)&&index>=0?this.byId([...this._table.records.keys()][index]):undefined;}
  rows(){return [...this._table.records.keys()].map(id=>this.byId(id));}
}
export class DevcelDatabase {
  constructor(text){this._snapshot=undefined;this._text=undefined;this._listeners=new Set();this._pending=undefined;if(text!==undefined)this.loadJson(text);}
  static fromJson(text){return new DevcelDatabase(text);}
  get isLoaded(){return !!this._snapshot;}
  get manifest(){return this._snapshot?.manifest;}
  get projectName(){return this._snapshot?.projectName??'';}
  tables(){return [...(this._snapshot?.tables.keys()??[])];}
  table(name){const t=this._snapshot?.tables.get(name);return t?new DevcelTable(this._snapshot,t):undefined;}
  tableByUuid(uuid){const t=this._snapshot?.uuids.get(uuid);return t?new DevcelTable(this._snapshot,t):undefined;}
  /** Validate every table/value first. Existing row handles retain their snapshot. */
  loadJson(text){requireThat(typeof text==='string','JSON text required');if(text===this._text)return false;const candidate=parse(text);this._snapshot=candidate;this._text=text;for(const listener of this._listeners){try{listener(this);}catch(error){console.error('Devcel reload listener failed',error);}}return true;}
  subscribe(listener){this._listeners.add(listener);return ()=>this._listeners.delete(listener);}
  /** readText is injected by browser, Node or engine. Overlapping reads are coalesced. */
  async reload(readText){if(this._pending)return this._pending;this._pending=(async()=>this.loadJson(await readText()))();try{return await this._pending;}finally{this._pending=undefined;}}
  /** Serialized polling catches atomic rename replacements and same-size edits. */
  watch(readText,{intervalMs=1000,onError=console.error}={}){requireThat(Number.isFinite(intervalMs)&&intervalMs>=100,'intervalMs must be >=100');let stopped=false,timer;const tick=async()=>{try{await this.reload(readText);}catch(error){onError(error);}finally{if(!stopped)timer=setTimeout(tick,intervalMs);}};void tick();return ()=>{stopped=true;clearTimeout(timer);};}
}
export class DevcelProjectSet {
  constructor(){this._sources=new Map();}
  register(id,namespace,database){requireThat(name(id)&&name(namespace)&&database instanceof DevcelDatabase,'source ID, namespace and database required');const normalized=namespace.split('::').join('.').toLowerCase();for(const [other,s]of this._sources){const n=s.namespace.split('::').join('.').toLowerCase();requireThat(other===id||!(n===normalized||n.startsWith(normalized+'.')||normalized.startsWith(n+'.')),'namespace collision');}this._sources.set(id,{namespace,database});return database;}
  get(id){return this._sources.get(id)?.database;}
  remove(id){return this._sources.delete(id);}
}
export {DevcelDatabase as DevcelRuntimeDatabase,DevcelTable as DevcelRuntimeTable,DevcelRow as DevcelRuntimeRow};
