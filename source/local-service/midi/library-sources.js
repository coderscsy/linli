import {isAbsolute,resolve} from 'node:path';

// Registered, content-verified import roots only. A stale media/cache path is not
// evidence of its original import directory; never substitute the latest root.
export function summarizeLibrarySources(songs) {
  const roots=new Map();let workCount=0,unconfirmedWorks=0;
  for(const song of songs){
    if(song.removed||song.jobId||song.sourceKind==='upload')continue;
    workCount++;
    const own=new Map();
    for(const value of Array.isArray(song.sourceRoots)?song.sourceRoots:[]){
      if(typeof value!=='string'||!isAbsolute(value))continue;
      const path=resolve(value),key=process.platform==='win32'?path.toLowerCase():path;
      own.set(key,path);
    }
    if(!own.size)unconfirmedWorks++;
    for(const [key,path] of own){const item=roots.get(key)||{path,works:0};item.works++;roots.set(key,item);}
  }
  return {roots:[...roots.values()].sort((a,b)=>a.path.localeCompare(b.path)),workCount,unconfirmedWorks};
}
