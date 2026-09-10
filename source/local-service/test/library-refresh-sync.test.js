import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createCommandEvents} from '../lyrics/command-events.js';
const patch=readFileSync(new URL('../../tools/patch-feapp-local.ps1',import.meta.url),'utf8');
function replacement(key){
 let text=patch.match(new RegExp('^\\$'+key+" = '([^\\r\\n]*)'\\r?$",'m'))?.[1];
 for(const match of patch.matchAll(new RegExp('^\\$'+key+' = \\$'+key+"\\.Replace\\('([^']*)', '([^']*)'\\)",'gm')))text=text.split(match[1]).join(match[2]);
 return text;
}
test('removed locally added song can be added again exactly once despite stale fetch dedup cache',()=>{
 const original='addItem:(E,M=0)=>{x(E)||(f.add(E.id),s.value.splice(M,0,E),c.value+=1)}';
 const add=replacement('playlistVisibleAddTo')||original;
 const ctx={s:{value:[]},c:{value:0},f:new Set()};
 vm.createContext(ctx);
 vm.runInContext('const x=E=>f.has(E.id)||s.value.find(M=>M.id===E.id);globalThis.add=({'+add+'}).addItem;',ctx);
 ctx.add({id:'a'});ctx.s.value=[];ctx.c.value=0;
 ctx.add({id:'a'});ctx.add({id:'a'});
 assert.equal(ctx.s.value.length,1);assert.equal(ctx.c.value,1);
});
test('management subscriptions do not evict game streams and receive named library invalidations',()=>{
 const events=createCommandEvents(),frames=[];
 const response=()=>({writeHead(status){this.status=status},on(){},end(){this.ended=true},write(frame){frames.push(frame)}});
 const games=[response(),response()];games.forEach(res=>events.subscribe({},res,'lyrics',{}));
 const admin=response();events.subscribe({},admin,'library',{});
 assert.equal(admin.status,200);assert.ok(games.every(res=>!res.ended));
 events.notify('library',{type:'library-changed'});
 assert.ok(frames.some(frame=>frame.startsWith('event: library-changed\n')));
 events.close();
});
test('management refresh discards an old response and coalesces notifications into one fresh request',async()=>{
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const start=app.indexOf('let midiRefresh');
 const snippet=start<0?app.slice(app.indexOf('async function refreshMidiStatus()'),app.indexOf('function renderMidiLibraryPreview')):app.slice(start,app.indexOf('function renderMidiLibraryPreview'));
 const requests=[],rendered=[];
 const ctx={api:()=>new Promise(resolve=>requests.push(resolve)),renderMidiStatus:data=>rendered.push(data)};
 vm.createContext(ctx);vm.runInContext(snippet,ctx);
 const first=ctx.refreshMidiStatus();const second=ctx.refreshMidiStatus();const third=ctx.refreshMidiStatus();
 assert.equal(requests.length,1,'parallel refreshes must not race');
 requests.shift()({songs:['old']});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(rendered.length,0,'stale response cannot overwrite the new import');
 assert.equal(requests.length,1);requests.shift()({songs:['new']});
 await Promise.all([first,second,third]);assert.deepEqual(rendered,[{songs:['new']}]);
});
test('game import notification during refresh queues a new fetch and preserves search and playback',async()=>{
 const requests=[],he={value:[]},playing={value:'playing-song'};
 const ctx={Q:{value:true},he,K:{value:[]},m:playing,OliviaSoulUploadSearch:{value:'天空'},dm:query=>new Promise(resolve=>requests.push({query,resolve})),zt:async()=>{},window:{}};
 const handlers=patch.match(/\$songUploadMetadata = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
 vm.createContext(ctx);vm.runInContext(replacement('myUploadSearchHandlerTo')+';'+handlers+';globalThis.refresh=OliviaSoulSilentRefresh;',ctx);
 const pending=ctx.refresh();ctx.OliviaSoulLibraryChanged?.();
 requests.shift().resolve({revision:1,list:[],hasMore:false});await pending;
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests.length,1,'import cannot be lost while an earlier fetch is running');
 assert.equal(requests[0].query.query,'天空');requests.shift().resolve({revision:2,list:[{id:'new'}],hasMore:false});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(he.value[0].id,'new');assert.equal(playing.value,'playing-song');
});
