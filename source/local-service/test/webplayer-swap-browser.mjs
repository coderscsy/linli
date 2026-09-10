import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)(process.argv[2]);
const source=await readFile(new URL('../../tools/webplayer-pause.js',import.meta.url),'utf8');
const media=await readFile(process.argv[3]);
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
try{
 const page=await browser.newPage();
 await page.route('http://swap.test/**',route=>{
  if(!route.request().url().endsWith('.mp4'))return route.fulfill({contentType:'text/html',body:'<video id="one" muted></video><video id="two" muted></video>'});
  const range=route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
  if(!range)return route.fulfill({contentType:'video/mp4',headers:{'Accept-Ranges':'bytes'},body:media});
  const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),media.length-1):media.length-1;
  return route.fulfill({status:206,contentType:'video/mp4',headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${media.length}`},body:media.subarray(start,end+1)});
 });
 await page.goto('http://swap.test/');
 await page.evaluate(async()=>{const p=document.querySelector('#one');p.src='/blue.mp4';await p.play();p.pause();});
 await page.evaluate(source+`;window.G=0;window.u=null;window.r={value:0};window.a={value:0};window.h={muted:true};
 window.i={get value(){return document.querySelector(r.value?'#two':'#one')}};
 window.v={get value(){return document.querySelector(r.value?'#one':'#two')}};
 window.ie=()=>{};window.O=()=>{v.value.removeAttribute('src');v.value.load()};window.R=()=>{};window.A=()=>{};
 window.ready=0;window.doSwap=()=>OliviaSoulSwapPlayback('/blue.mp4',{offset:1.5},()=>window.ready++);window.doSwap();`);
 await page.waitForFunction(()=>window.ready===1);
 const state=await page.evaluate(()=>({active:r.value,time:i.value.currentTime,oldSrc:v.value.getAttribute('src'),opacity:i.value.style.opacity,muted:i.value.muted}));
 assert.equal(state.active,1);assert.ok(state.time>=1.45);assert.equal(state.oldSrc,null);assert.equal(state.opacity,'1');assert.equal(state.muted,true);
 console.log('PASS real Edge video decode/seek handoff and old source release');
}finally{await browser.close();}
