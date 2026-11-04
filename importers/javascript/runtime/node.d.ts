import {DevcelDatabase} from './devcel-runtime.js';
export interface DevcelFile {database:DevcelDatabase;reload():Promise<boolean>;watch(options?:Parameters<DevcelDatabase['watch']>[1]):()=>void;}
export function openFile(path:string):Promise<DevcelFile>;
