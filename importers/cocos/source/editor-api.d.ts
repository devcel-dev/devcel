/** Minimal published API boundary for static checking. Creator's native types remain authoritative. */
declare const require:(id:string)=>any;
declare const __dirname:string;
declare const module:{exports:any};
declare const Editor:{Project:{path:string};Panel:{open(name:string):void;define(options:any):any};Message:{request(target:string,message:string,...args:any[]):Promise<any>;broadcast(message:string,...args:any[]):void};Dialog:{select(options:any):Promise<{canceled:boolean;filePaths:string[]}>}};
