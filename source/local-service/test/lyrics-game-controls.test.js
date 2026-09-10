import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {setImmediate as turn} from 'node:timers/promises';
function fragment(file,key) {
  const line=readFileSync(new URL('../../tools/'+file,import.meta.url),'utf8').split(/\r?\n/).find(l=>l.startsWith('$'+key+' = '));
  return line.slice(line.indexOf("'")+1,-1).replace(/' \+ \$player(?:Command|State)Url \+ '/g,'http://127.0.0.1:1234/toy/player-command');
}

test('WebPlayer notification fetches immediately without waiting for the one-second fallback',async()=>{
  let interval,stream,requests=0;
  const window={};const context={window,f:null,y:null,l:{value:[]},i:{value:null},
    ke:fn=>fn(),qe:()=>null,Je:()=>null,OliviaSoulNativeControl(){},me(){},
    sessionStorage:{getItem:()=>null},setInterval:fn=>{interval=fn;return 1},clearInterval(){},
    EventSource:class {constructor(){stream=this}close(){}},AbortController,queueMicrotask,
    fetch:async()=>{requests++;return {json:async()=>({data:{revision:0,command:null}})}},OliviaSoulReportPausedPlayback(){}};
  vm.runInNewContext(fragment('patch-webplayer-local.ps1','mountedTo'),context);
  assert.equal(requests,0);assert.equal(typeof interval,'function');
  stream.onmessage();await turn();assert.equal(requests,1);
});
test('game adapter invokes existing previous/next and preserves session in pause/resume requests',async()=>{
  const store=fragment('patch-feapp-local.ps1','playerStateStoreTo');
  const source=store.slice(store.indexOf('window.OliviaSoulLyricsPlayback='),store.indexOf(';return{isSongAvailable:a'));
  let prev=0,next=0;const requests=[];
  const window={__OliviaSoulSongId:'a',__OliviaSoulSessionId:'s'};
  vm.runInNewContext(source,{window,S:()=>prev++,U:()=>next++,fetch:async(url,options)=>{
    requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({code:0,data:{revision:7}})};
  }});
  await window.OliviaSoulLyricsPlayback('previous');await window.OliviaSoulLyricsPlayback('next');
  assert.equal(prev,1);assert.equal(next,1);
  await window.OliviaSoulLyricsPlayback('pause');await window.OliviaSoulLyricsPlayback('resume');
  assert.deepEqual(requests,[{cmd:'suspend',songId:'a',sessionId:'s'},{cmd:'resume',songId:'a',sessionId:'s'}]);
  assert.equal(window.__OliviaSoulCommandRevision,7);
});
test('WebPlayer pause retains media identity and stop retains wallpaper restoration',()=>{
  const source=fragment('patch-webplayer-local.ps1','stopTo');
  let pauses=0,restores=0,aborts=0;
  const window={__OliviaSoulActiveSessionId:'s',__OliviaSoulActiveSongId:'a',__OliviaSoulActivePlayerRevision:8,
    __OliviaSoulAbortPlayerRequests:()=>aborts++,__OliviaSoulRestoreDefaultPlayback:()=>restores++};
  const context={window,i:{value:{pause:()=>pauses++,currentSrc:'song.mp4',currentTime:42.5,duration:120}}};
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../../tools/webplayer-pause.js',import.meta.url),'utf8'),context);
  const run=command=>{context.e=command;vm.runInNewContext('switch(e.cmd){'+source+'}',context)};
  run({cmd:'pause',preserveSession:true,songId:'a',sessionId:'s'});
  assert.equal(pauses,1);assert.equal(restores,1);assert.equal(aborts,0);
  assert.equal(window.__OliviaSoulActiveSessionId,'s');
  assert.equal(window.__OliviaSoulSuspendedPlayback.offset,42.5);
  context.i.value.currentSrc='wallpaper.mp4';context.i.value.currentTime=9;
  run({cmd:'pause',preserveSession:true,songId:'a',sessionId:'s'});
  assert.equal(window.__OliviaSoulSuspendedPlayback.offset,42.5);
  assert.equal(restores,1);
  run({cmd:'pause',preserveSession:true,songId:'b',sessionId:'other'});assert.equal(pauses,1);
  run({cmd:'stop',songId:'a',sessionId:'s'});assert.equal(restores,2);assert.equal(window.__OliviaSoulActiveSessionId,null);
  assert.equal(window.__OliviaSoulSuspendedPlayback,null);
  new vm.Script(fragment('patch-webplayer-local.ps1','mountedTo'));
});

test('resume restores saved media and offset, not the wallpaper position; old sessions cannot resume',()=>{
  const loads=[];const posts=[];
  const window={__OliviaSoulActiveSessionId:'s',__OliviaSoulActiveSongId:'a',__OliviaSoulActivePlayerRevision:9,
    __OliviaSoulSuspendedPlayback:{url:'song.mp4',offset:42.5,duration:120,songId:'a',sessionId:'s'},
    __OliviaSoulRememberDefaultPlayback(){},__OliviaSoulPlayerPost:frame=>posts.push(frame)};
  const context={window,i:{value:{currentSrc:'wallpaper.mp4',currentTime:5,pause(){},removeAttribute(){},load(){}}},
    le:(url,options)=>loads.push({url,offset:options.offset}),ce:()=>assert.fail('must reload the performance, not play wallpaper')};
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../../tools/webplayer-pause.js',import.meta.url),'utf8')+
    'function pe(e){switch(e.cmd){'+fragment('patch-webplayer-local.ps1','playTo')+'}}',context);
  // Media loading is exercised separately by webplayer-swap.test.js.
  context.OliviaSoulSwapPlayback=(url,options)=>loads.push({url,offset:options.offset});
  context.OliviaSoulReportPausedPlayback();
  assert.equal(posts[0].currentTime,42.5);assert.equal(posts[0].mediaUrl,'song.mp4');assert.equal(posts[0].paused,true);
  context.OliviaSoulResumeLocalPlayback({songId:'b',sessionId:'old'});assert.equal(loads.length,0);
  context.OliviaSoulResumeLocalPlayback({songId:'a',sessionId:'s'});
  assert.deepEqual(loads,[{url:'song.mp4',offset:42.5}]);
  assert.equal(window.__OliviaSoulSuspendedPlayback,null);
  assert.equal(window.__OliviaSoulActiveSessionId,'s');assert.equal(window.__OliviaSoulActivePlayerRevision,9);
});

test('wallpaper progress and end cannot overwrite or finish a paused performance',()=>{
  const posts=[];let defaultUpdates=0;
  const window={__OliviaSoulSuspendedPlayback:{offset:42.5},__OliviaSoulActivePlayerRevision:9,
    __OliviaSoulActiveSongId:'a',__OliviaSoulActiveSessionId:'s',__OliviaSoulPlayerPost:frame=>posts.push(frame),
    __OliviaSoulRememberDefaultPlayback:()=>defaultUpdates++};
  const player={currentSrc:'wallpaper.mp4',currentTime:5,duration:30};
  const context={window,i:{value:player},a:{value:120},m:false,v:{value:null},Z:()=>assert.fail('no native song event'),console};
  vm.createContext(context);
  vm.runInContext(fragment('patch-webplayer-local.ps1','timeUpdateTo')+';'+fragment('patch-webplayer-local.ps1','endedTo'),context);
  context.z({target:player});context.q({target:player});
  assert.equal(defaultUpdates,1);assert.equal(posts.length,0);assert.equal(context.a.value,120);
  window.__OliviaSoulSuspendedPlayback=null;window.__OliviaSoulMediaSwap={};
  context.z({target:player});context.q({target:player});assert.equal(posts.length,0);
});
