import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOliviaService} from '../server.js';
const {chromium}=createRequire(import.meta.url)(process.argv[2]);
const root=await mkdtemp(join(tmpdir(),'removal-names-'));
const service=await createOliviaService({root,dataDir:join(root,'data'),appData:join(root,'app'),worker:false,runMemoryRefresh:false,fetch:async()=>{throw Error('offline test');}});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const {port}=await service.listen(0,'127.0.0.1');
 await mkdir(service.midiStore.root,{recursive:true});
 const longName='很长的曲名'.repeat(38)+'<img onerror=alert(1)>';
 for(const [id,name] of [['a',longName],['b','重复曲名'],['c','重复曲名']]){
  const path=join(service.midiStore.root,id+'.mp4');await writeFile(path,'video');
  service.midiStore.upsertUserSong({id,name,sourceKind:'import',videoPath:path,videoByTodView:{DEFAULT:path}});
 }
 const page=await browser.newPage({viewport:{width:640,height:480}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}/admin/`);await page.locator('[data-tab="performances"]').click();
 await page.locator('[data-song-id="a"]').waitFor();
 const summary=page.locator('#midiSelectionSummary'),batch=page.locator('#removeSelectedSongs');
 assert.equal(await summary.textContent(),'共 3 首 · 已选 0 首');assert.equal(await batch.isDisabled(),true);
 await page.locator('[data-song-id="a"] input[type=checkbox]').check();
 assert.equal(await summary.textContent(),'共 3 首 · 已选 1 首');
 await page.locator('#midiSongSearch').fill('重复');assert.equal(await batch.isDisabled(),true);
 await page.locator('#midiSongSearch').fill('');
 for(const id of ['a','b','c'])await page.locator(`[data-song-id="${id}"] input[type=checkbox]`).check();
 assert.equal(await batch.textContent(),'移除所选（3）');
 await batch.click();
 assert.equal(await page.getByRole('dialog',{name:'从曲库移除'}).locator('.ose-remove-names li').count(),3);
 await page.getByRole('dialog',{name:'从曲库移除'}).getByRole('button',{name:'取消',exact:true}).click();
 assert.equal(await summary.textContent(),'共 3 首 · 已选 3 首');
 await page.locator('[data-song-id="a"] button').filter({hasText:'移除'}).click();
 const dialog=page.getByRole('dialog',{name:'从曲库移除'});
 assert.equal(await dialog.locator('.ose-remove-names li').count(),3);
 assert.ok((await dialog.locator('.ose-remove-names li').allTextContents()).includes(longName));
 assert.equal(await dialog.locator('img').count(),0);
 async function checkLayout(){
  const bounds=await dialog.evaluate(el=>{const list=el.querySelector('.ose-remove-names'),actions=el.querySelector('.ose-actions');return {overflow:el.scrollWidth>el.clientWidth,top:actions.getBoundingClientRect().top,bottom:actions.getBoundingClientRect().bottom,height:innerHeight,listScroll:list.scrollHeight>list.clientHeight}});
  assert.equal(bounds.overflow,false);assert.ok(bounds.top>=0&&bounds.bottom<=bounds.height);
 }
 await checkLayout();
 await dialog.getByRole('button',{name:'移除',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#midiSelectionSummary').textContent==='共 0 首 · 已选 0 首');
 assert.equal(await batch.isDisabled(),true);
 assert.equal(await page.getByRole('status').filter({hasText:'已移除 3 首'}).count(),1);
 await page.evaluate(()=>{void window.OliviaSoulSongEditor.remove({baseUrl:'/admin/api',ids:Array.from({length:30},(_,i)=>String(i)),names:Array.from({length:30},(_,i)=>`${i} `+'超长曲名'.repeat(48))});});
 await checkLayout();assert.equal(await dialog.locator('.ose-remove-names').evaluate(el=>el.scrollHeight>el.clientHeight),true);
 if(process.argv[3])await page.screenshot({path:process.argv[3]});
 await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.deepEqual(errors,[]);
 console.log('PASS counts, selection/search, duplicate and long names, scrolling footer, success notice');
}finally{await browser.close();await service.close();await rm(root,{recursive:true,force:true});}
