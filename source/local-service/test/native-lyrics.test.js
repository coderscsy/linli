import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeLyricsObserver} from '../lyrics/native.js';
test('native reports are bounded, ordered, expire and cannot displace local playback',()=>{
 let time=1000,local=false;const frames=[];
 const observer=createNativeLyricsObserver({now:()=>time,localActive:()=>local,observe:s=>frames.push(s)});
 const body={pageId:'page',sequence:1,songId:'official:1',sessionId:'native:1',name:'曲目',currentTime:3,duration:10,playbackState:'playing'};
 observer.report(body); assert.equal(observer.state().name,'曲目');
 observer.report({...body,sequence:0,name:'旧'});assert.equal(frames.length,1);
 observer.report({...body,pageId:'old',sequence:2});assert.equal(frames.length,1);
 time+=4000;assert.equal(observer.state(),null);
 local=true;observer.report({...body,sequence:2});assert.equal(frames.length,1);
 local=false;observer.report({...body,sequence:3,playbackState:'stopped'});assert.equal(frames.at(-1).playbackState,'stopped');
 observer.report({...body,sequence:4,currentTime:NaN});assert.equal(frames.length,2);
});
