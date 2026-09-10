import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)(process.argv[2]);
const base=new URL('../public/',import.meta.url);
const html=(await readFile(new URL('index.html',base),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
const settings={enabled:false,locked:false,fontFamily:'auto',fontSize:28,fontWeight:'normal',opacity:100,lineMode:'double',currentColor:'#ffebaa',nextColor:'#ffffff',animate:true};
const writes=[];const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1000,height:650}});const errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(()=>window.oliviaDesktop={getLyricsFontInfo:async()=>({fonts:['Arial','Microsoft YaHei','楷体'],defaultFont:'楷体'})});
 await page.route('**/*',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:html+'<script type="module" src="/admin/lyrics-settings.js"></script>'});
  if(path==='/admin/api/lyrics/settings'){
   if(route.request().method()==='POST'){const patch=route.request().postDataJSON();writes.push(patch);Object.assign(settings,patch);}
   return route.fulfill({json:{code:0,data:{settings,status:'ok'}}});
  }
  const name=path.split('/').at(-1);
  if(['styles.css','lyrics-settings.css','lyrics-settings.js'].includes(name))return route.fulfill({body:await readFile(new URL(name,base)),contentType:name.endsWith('.css')?'text/css':'text/javascript'});
  return route.fulfill({status:404,body:''});
 });
 await page.goto('http://management.test/');
 await page.waitForFunction(()=>document.querySelector('#lyricsStatus').textContent==='ok');
 assert.equal(await page.locator('#lyricsFontFamily').evaluate(e=>e.tagName),'SELECT','use a complete font selector, not a filtered datalist');
 assert.equal(await page.locator('#lyricsFontFamily option').count(),4);
 await page.evaluate(()=>{document.querySelectorAll('.tabPage').forEach(e=>e.hidden=e.dataset.page!=='lyrics');});
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/lyrics/settings')&&r.request().method()==='POST'),page.locator('#lyricsFontFamily').selectOption('Arial')]);
 await page.waitForFunction(()=>document.querySelector('#lyricsResolvedFont').textContent.includes('Arial'),{},{timeout:2000});
 assert.equal(writes.at(-1).fontFamily,'Arial');
 assert.match(await page.locator('#lyricsPreview').evaluate(e=>e.style.fontFamily),/Arial/);
 assert.equal(await page.locator('#lyricsFontFamily').evaluate(e=>getComputedStyle(e).colorScheme),'dark');
 await page.locator('#lyricsFontFamily').selectOption('auto');
 await page.waitForFunction(()=>document.querySelector('#lyricsResolvedFont').textContent.includes('楷体'));
 for(const width of [1000,760]){
  await page.setViewportSize({width,height:650});
  await page.evaluate(()=>{document.querySelectorAll('.tabPage').forEach(e=>e.hidden=e.dataset.page!=='desktop');document.querySelector('#serviceMountSettings').hidden=false;document.querySelector('#restoreClient').hidden=false;document.querySelector('.content').scrollTop=0;});
  for(const id of ['mountService','restoreClient']){const box=await page.locator('#'+id).boundingBox();assert.ok(box.y>=0&&box.y+box.height<=650,`${id} visible without scrolling at ${width}`);}
  assert.equal(await page.locator('.sideTitle').count(),0);
  assert.equal(await page.locator('#serviceMountSettings').evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');
 }
 assert.deepEqual(errors,[]);
 console.log('PASS full font list, persistence/preview, dark dropdown, service actions visible at 1000/760 x 650');
} finally {await browser.close();}
