import {readFile} from 'node:fs/promises';
import {DevcelDatabase} from './devcel-runtime.js';
/** Node-only adapter; browser/engine readers inject their own readText function. */
export async function openFile(path) {
  const database=new DevcelDatabase();
  const readText=()=>readFile(path,'utf8');
  await database.reload(readText);
  return {database,reload:()=>database.reload(readText),watch:options=>database.watch(readText,options)};
}
