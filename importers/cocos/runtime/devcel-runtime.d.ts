export type DataType = 'None'|'String'|'Select'|'DateTime'|'Reference'|'TableRef'|'I8'|'U8'|'I16'|'U16'|'I32'|'U32'|'I64'|'U64'|'F32'|'F64'|'Boolean'|'Color32'|'ColorFloat'|'Curve';
export interface Manifest { readonly schema_version:1; readonly content_hash:string; readonly content_version?:number|null; readonly data_revision:number; readonly generated_at:string; readonly mode:'full'|'minimal'; }
export interface Column { readonly name:string; readonly data_type:DataType; readonly default_value?:string|null; readonly reference_config?:{readonly target_table_uuid?:string}; readonly table_ref_config?:{readonly interface_uuid?:string}; readonly curve_config?:{readonly start_value:number;readonly end_value:number}; }
export class Color32 { private readonly __color32Brand:void; constructor(r:number,g:number,b:number,a:number); readonly r:number; readonly g:number; readonly b:number; readonly a:number; toArray():number[]; toFloat():ColorFloat; }
export class ColorFloat { private readonly __colorFloatBrand:void; constructor(r:number,g:number,b:number,a:number); readonly r:number; readonly g:number; readonly b:number; readonly a:number; toArray():number[]; }
export interface CurvePoint { readonly x:number;readonly y:number;readonly mode:'constant'|'linear'|'auto'|'autoLength'|'free';readonly inSlope?:number;readonly outSlope?:number;readonly inLen?:number;readonly outLen?:number; }
export class DevcelCurve { constructor(text?:string,config?:{start_value:number;end_value:number}); readonly points:readonly CurvePoint[]; sample(x:number):number; }
export type TypedValue = string|number|bigint|boolean|Color32|ColorFloat|DevcelCurve;
export class DevcelRow {
  private constructor(); readonly id:string;readonly index:number;readonly tableName:string;
  columnInfo(column:string):Column; raw(column:string):string;get(column:string):TypedValue;
  getString(column:string):string;getI64(column:string):bigint;getU64(column:string):bigint;getNumber(column:string):number;getBoolean(column:string):boolean;
  getColor32(column:string):Color32;getColorFloat(column:string):ColorFloat;getCurve(column:string):DevcelCurve;
  reference(column:string,targetTableName?:string):DevcelRow|undefined;tableReference(column:string,requiredInterface?:string):DevcelTable|undefined;
}
export class DevcelTable {
  private constructor();readonly name:string;readonly uuid:string;readonly count:number;readonly rowCount:number;readonly interfaces:readonly string[];
  columns():string[];columnInfo(name:string):Column|undefined;implementsInterface(uuid:string):boolean;
  byId(id:string):DevcelRow|undefined;rowById(id:string):DevcelRow|undefined;at(index:number):DevcelRow|undefined;rows():DevcelRow[];
}
export class DevcelDatabase {
  constructor(text?:string);static fromJson(text:string):DevcelDatabase;
  readonly isLoaded:boolean;readonly manifest:Manifest|undefined;readonly projectName:string;
  tables():string[];table(name:string):DevcelTable|undefined;tableByUuid(uuid:string):DevcelTable|undefined;
  loadJson(text:string):boolean;reload(readText:()=>Promise<string>|string):Promise<boolean>;
  subscribe(listener:(db:DevcelDatabase)=>void):()=>void;
  watch(readText:()=>Promise<string>|string,options?:{intervalMs?:number;onError?:(error:unknown)=>void}):()=>void;
}
export class DevcelProjectSet { register(id:string,namespace:string,database:DevcelDatabase):DevcelDatabase;get(id:string):DevcelDatabase|undefined;remove(id:string):boolean; }
export { DevcelDatabase as DevcelRuntimeDatabase, DevcelTable as DevcelRuntimeTable, DevcelRow as DevcelRuntimeRow };
