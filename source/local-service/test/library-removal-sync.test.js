import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const patch=readFileSync(new URL('../../tools/patch-feapp-local.ps1',import.meta.url),'utf8');
const source=patch.match(/\$songTitleSync = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
function replacement(key){
 let text=patch.match(new RegExp('^\\$'+key+" = '([^\\r\\n]*)'\\r?$",'m'))[1];
 for(const match of patch.matchAll(new RegExp('^\\$'+key+' = \\$'+key+"\\.Replace\\('([^']*)', '([^']*)'\\)",'gm')))text=text.split(match[1]).join(match[2]);
 return text.replaceAll("' + $playerCommandUrl + '",'http://test/command').replaceAll("' + $playerStateUrl + '",'http://test/state');
}
function fixture(){
 const listeners={},toasts=[];
 const song={id:'a',videoUrl:'/toy/midi/songs/a/video.mp4'};
 const window={__OliviaSoulSongId:'a',__OliviaSoulSessionEpoch:4,__OliviaSoulPendingPlay:{},
  addEventListener:(event,fn)=>listeners[event]=fn,
  OliviaSoulSongEditor:{stableId:item=>item.id,applyMetadata(){},notify:message=>toasts.push(message),playbackMessage:()=> '歌曲暂时无法播放'}};
 const state={window,x:{value:[song]},u:{value:song},f:{value:null},m:{value:true},d:{value:12},queueMicrotask,setInterval(){}};
 state.G=()=>{state.m.value=false;state.u.value=state.f.value=null;state.d.value=0};
 vm.runInNewContext(source,state);
 return {state,window,listeners,toasts};
}

test('removing the playing upload advances from its old position to the following official song at zero',()=>{
 const f=fixture(),first={id:'first',itemId:'first'},next={id:'official',itemId:'official'};
 f.state.x.value=[first,f.state.u.value,next];
 f.state.a=()=>true;
 f.state.M=song=>{f.state.u.value=song;f.state.m.value=true;assert.equal(f.state.d.value,0);};
 f.listeners['oliviasoul-songs-removed']({detail:{ids:['a']}});
 assert.equal(f.state.u.value,next);assert.equal(f.state.m.value,true);
 f.listeners['oliviasoul-songs-removed']({detail:{ids:['a']}});
 assert.equal(f.state.u.value,next);
});
test('batch removal skips removed or unavailable successors and can continue with another upload',()=>{
 const f=fixture(),removed={id:'b',videoUrl:'/toy/midi/songs/b/video.mp4'},unavailable={id:'missing'},next={id:'c',videoUrl:'/toy/midi/songs/c/video.mp4'};
 f.state.x.value=[f.state.u.value,removed,unavailable,next];f.state.a=song=>song.id!=='missing';
 f.state.M=song=>{f.state.u.value=song;f.state.m.value=true;};
 f.listeners['oliviasoul-songs-removed']({detail:{ids:['a','b']}});
 assert.equal(f.state.u.value,next);assert.deepEqual(f.state.x.value.map(s=>s.id),['missing','c']);
});
test('a stopped-state poll arriving before removal does not lose the intent to continue playback',()=>{
 const f=fixture(),next={id:'official'};f.state.x.value.push(next);f.state.a=()=>true;
 f.state.M=song=>{f.state.u.value=song;f.state.m.value=true;};
 const apply=replacement('playerStateStoreTo').match(/OliviaSoulApplyPlayerState=(B=>\{[\s\S]*?\}),OliviaSoulEnsurePlayerPoll=/)[1];
 vm.runInNewContext(`(${apply})({songId:'a',playbackState:'stopped'})`,f.state);
 assert.equal(f.state.m.value,false);
 vm.runInNewContext(`(${apply})({songId:'a',playbackState:'stopped'})`,f.state);
 f.listeners['oliviasoul-songs-removed']({detail:{ids:['a']}});
 assert.equal(f.state.u.value,next);assert.equal(f.state.m.value,true);
 assert.equal(f.window.__OliviaSoulStoppedPlayback,null);
});
test('removing a different song leaves playback untouched; removing a paused song does not start music',()=>{
 const f=fixture(),next={id:'official'};f.state.x.value.push(next);f.state.a=()=>true;
 f.state.M=()=>{throw Error('unexpected playback');};
 f.listeners['oliviasoul-songs-removed']({detail:{ids:['other']}});
 assert.equal(f.state.u.value.id,'a');assert.equal(f.state.d.value,12);
 f.state.m.value=false;f.listeners['oliviasoul-songs-removed']({detail:{ids:['a']}});
 assert.equal(f.state.u.value,null);assert.equal(f.state.m.value,false);
});
test('failed local play clears optimistic playing state but preserves the library entry',()=>{
 const f=fixture();f.window.OliviaSoulLocalPlaybackFailed?.({songId:'a',epoch:4,error:Error('local player session unavailable')});
 assert.equal(f.state.m.value,false);
 assert.equal(f.state.u.value,null);assert.equal(f.state.d.value,0);
 assert.equal(f.window.__OliviaSoulPendingPlay,null);
 assert.equal(f.state.x.value.length,1);assert.equal(f.toasts.length,1);
});
test('failure from the previous generation cannot stop a replacement play',()=>{
 const f=fixture();f.window.__OliviaSoulSessionEpoch=5;
 f.window.OliviaSoulLocalPlaybackFailed?.({songId:'a',epoch:4,error:Error('failed')});
 assert.equal(f.state.m.value,true);assert.equal(f.toasts.length,0);
});
test('removing active song immediately clears pending play and playback state',()=>{
 const f=fixture();f.listeners['oliviasoul-songs-removed']({detail:{ids:['a']}});
 assert.equal(f.state.m.value,false);assert.equal(f.state.x.value.length,0);
 assert.equal(f.window.__OliviaSoulPendingPlay,null);
});

const nativeProgress=patch.match(/\$text = \$text.Replace\(\$nativeProgressFrom, '([^']*)'\)/)[1];
function sendNativeProgress(f,seconds){
 f.state.te={get value(){return f.state.f.value||f.state.u.value;}};
 f.state.B={currentTime:seconds};
 vm.runInNewContext(`switch('timeupdate'){${nativeProgress}}`,f.state);
}
test('late wallpaper progress after removing the active song cannot refill an empty progress bar',()=>{
 const f=fixture();f.listeners['oliviasoul-songs-removed']({detail:{ids:['a']}});
 sendNativeProgress(f,1);
 assert.equal(f.state.d.value,0);
 assert.equal(f.state.u.value,null);
 assert.equal(f.state.m.value,false);
});
test('native progress cannot overwrite local progress, but works for the next official song',()=>{
 const f=fixture();sendNativeProgress(f,1);assert.equal(f.state.d.value,12);
 f.listeners['oliviasoul-songs-removed']({detail:{ids:['a']}});
 f.state.f.value={id:'official',duration:106};f.state.m.value=true;
 sendNativeProgress(f,5);assert.equal(f.state.d.value,5);
 f.state.m.value=false;sendNativeProgress(f,6);assert.equal(f.state.d.value,5);
 f.state.m.value=true;sendNativeProgress(f,7);assert.equal(f.state.d.value,7);
});
test('clearing a removed song suppresses programmatic seek feedback to the native player',()=>{
 const f=fixture(),native=[],microtasks=[];
 Object.assign(f.state,{setTimeout,clearTimeout,queueMicrotask:fn=>microtasks.push(fn),We:async command=>native.push(command)});
 vm.runInNewContext(replacement('directControlTo'),f.state);
 f.state.G=()=>{f.state.m.value=false;f.state.u.value=f.state.f.value=null;f.state.d.value=0;f.state.Ct({cmd:'timeupdate',position:0});};
 f.listeners['oliviasoul-songs-removed']({detail:{ids:['a']}});
 assert.equal(native.length,0);
 microtasks.forEach(fn=>fn());assert.equal(f.window.__OliviaSoulApplyingProgress,false);
});
test('a rejected play actually reaches the state-reset hook through the production control bridge',async()=>{
 const f=fixture();Object.assign(f.state,{setTimeout,clearTimeout,We:async()=>{},fetch:async()=>({ok:false,json:async()=>({code:404,message:'视频文件不存在'})})});
 vm.runInNewContext(replacement('directControlTo'),f.state);
 await assert.rejects(f.state.Ct({cmd:'play',song:{id:'a',videoUrl:'/toy/midi/songs/a/video.mp4'}}));
 assert.equal(f.state.m.value,false);assert.equal(f.toasts.length,1);
});
test('a list response started before removal cannot put the removed song back',async()=>{
 let resolve;const he={value:[{id:'a'}]},K={value:[]};
 const context={Q:{value:true},he,K,m:{value:'a'},OliviaSoulUploadSearch:{value:''},dm:()=>new Promise(done=>resolve=done),zt:async()=>{},window:{OliviaSoulSongEditor:{stableId:item=>item.id}}};
 const handlers=patch.match(/\$songUploadMetadata = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
 vm.createContext(context);vm.runInContext(replacement('myUploadSearchHandlerTo')+';'+handlers+';globalThis.refresh=OliviaSoulSilentRefresh;',context);
 const pending=context.refresh();context.OliviaSoulUploadRemoved({detail:{ids:['a']}});
 resolve({revision:'old',list:[{id:'a'}],hasMore:false});await pending;
 assert.equal(he.value.length,0);assert.equal(context.m.value,null);
});
test('removal uses the authoritative playlist total even for unloaded songs and duplicate notifications',()=>{
 const handlers=patch.match(/\$songUploadMetadata = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
 const context={he:{value:[]},K:{value:[]},Ee:{value:230},m:{value:null},OliviaSoulUploadGeneration:0,OliviaSoulUploadRevision:null,window:{OliviaSoulSongEditor:{stableId:item=>item.id}}};
 vm.createContext(context);vm.runInContext(handlers,context);
 const event={detail:{ids:['unloaded'],counts:{playlistTotal:229,libraryTotal:400,revision:8}}};
 context.OliviaSoulUploadRemoved(event);context.OliviaSoulUploadRemoved(event);
 assert.equal(context.Ee.value,229);
 context.OliviaSoulUploadRemoved({detail:{ids:['older'],counts:{playlistTotal:230,libraryTotal:401,revision:7}}});
 assert.equal(context.Ee.value,229);
});
