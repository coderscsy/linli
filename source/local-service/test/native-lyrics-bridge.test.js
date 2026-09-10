import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
test('official pause retains placeholder and resume position without invoking native stop',async()=>{
 const window={};let stopped=0,next=0,prev=0;
 const context={window,crypto:{randomUUID:()=> 'page'},Date,m:{value:true},te:{value:{id:'a',name:'官方曲目',duration:20}},d:{value:3},
 S:()=>prev++,U:()=>next++,z:()=>{stopped++;context.m.value=false},N(){},fetch:async()=>({ok:true,json:async()=>({code:0,data:{currentTime:3,duration:20}})})};
 vm.runInNewContext(readFileSync(new URL('../../tools/feapp-native-lyrics.js',import.meta.url),'utf8'),context);
 assert.equal(window.OliviaSoulNativeLyricsState().playbackState,'stopped');
 window.__OliviaSoulNativeProgressAt=Date.now();
 assert.equal(window.OliviaSoulNativeLyricsState().playbackState,'playing');
 assert.equal(window.OliviaSoulNativeLyricsState().name,'官方曲目');
 window.OliviaSoulOfficialLyricsControl('next');window.OliviaSoulOfficialLyricsControl('previous');
 assert.equal(next,1);assert.equal(prev,1);
 await window.OliviaSoulOfficialLyricsControl('pause');assert.equal(stopped,0);
 assert.equal(window.OliviaSoulNativeLyricsState().playbackState,'paused');
 assert.equal(window.OliviaSoulNativeLyricsState().name,'官方曲目');
 await window.OliviaSoulOfficialLyricsControl('resume');
 assert.equal(window.OliviaSoulNativeLyricsState().playbackState,'playing');
 window.__OliviaSoulSongId='local';assert.equal(window.OliviaSoulNativeLyricsState(),null);
});
