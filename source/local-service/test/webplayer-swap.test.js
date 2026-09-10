import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../tools/webplayer-pause.js',import.meta.url),'utf8');
function setup(){
 function video(src){const listeners=new Map();return {src,currentTime:0,duration:120,readyState:2,style:{},muted:false,paused:false,
  addEventListener(n,fn){if(!listeners.has(n))listeners.set(n,new Set());listeners.get(n).add(fn)},removeEventListener(n,fn){listeners.get(n)?.delete(fn)},
  emit(n){for(const fn of [...listeners.get(n)||[]])fn()},pause(){this.paused=true},load(){},removeAttribute(n){if(n==='src')this.src=''},
  play(){this.paused=false;return Promise.resolve()},requestVideoFrameCallback(fn){this.frame=fn;return 1},cancelVideoFrameCallback(){this.frame=null}};}
 const old=video('wallpaper.mp4'),next=video(''),timers=new Map();let id=0;
 const context={window:{},i:{value:old},v:{value:next},r:{value:0},a:{value:0},h:{muted:false},G:0,u:null,
  ie(){},O(){next.removeAttribute('src');next.load()},R(){},A(){},setTimeout(fn){timers.set(++id,fn);return id},clearTimeout(n){timers.delete(n)},console};
 vm.createContext(context);vm.runInContext(source,context);return {context,old,next,timers};
}
test('swap keeps old frame until target seek and decoded frame, then releases old media',async()=>{
 const {context:c,old,next,timers}=setup();let ready=0;
 c.OliviaSoulSwapPlayback('song.mp4',{offset:42.5},()=>ready++);
 assert.equal(old.src,'wallpaper.mp4');assert.notEqual(old.style.opacity,'0');assert.equal(c.r.value,0);
 next.emit('loadedmetadata');assert.equal(next.currentTime,42.5);assert.equal(old.src,'wallpaper.mp4');
 next.emit('seeked');next.emit('loadeddata');await Promise.resolve();
 assert.equal(ready,0);next.frame();
 assert.equal(c.r.value,1);assert.equal(ready,1);assert.equal(old.src,'');assert.equal(next.muted,false);assert.equal(timers.size,0);
});
test('superseded load and timeout cannot replace old frame or retain loading resources',async()=>{
 const {context:c,old,next,timers}=setup();
 c.OliviaSoulSwapPlayback('one.mp4',{offset:0});next.emit('loadedmetadata');next.emit('loadeddata');await Promise.resolve();const stale=next.frame;
 c.OliviaSoulSwapPlayback('two.mp4',{offset:0});stale();assert.equal(c.r.value,0);
 for(const fn of [...timers.values()])fn();
 assert.equal(old.src,'wallpaper.mp4');assert.equal(next.src,'');assert.equal(c.r.value,0);assert.equal(c.window.__OliviaSoulMediaSwap,null);
});
