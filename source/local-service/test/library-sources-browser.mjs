import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOliviaService} from '../server.js';
const {chromium}=createRequire(import.meta.url)(process.argv[2]);
const root=await mkdtemp(join(tmpdir(),'source-ui-'));
const service=await createOliviaService({root,dataDir:join(root,'data'),appData:join(root,'app'),worker:false,runMemoryRefresh:false,midiDurationProbe:async()=>1000000,fetch:async()=>{throw Error('offline');}});
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const {port}=await service.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${port}`;
 const post=async(path,body)=>(await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
 const roots=[join(root,'来源甲'.repeat(20)),join(root,'来源乙')];
 for(const [i,folder] of roots.entries()){
  await mkdir(join(folder,'歌曲'+i),{recursive:true});await writeFile(join(folder,'歌曲'+i,'DEFAULT.mp4'),'media-'+i);
  const preview=await post('/admin/api/midi-library/preview',{root:folder});
  assert.equal((await post('/admin/api/midi-library/confirm',{previewId:preview.data.previewId})).code,0);
 }
 service.midiStore.upsertUserSong({id:'legacy',name:'旧作品',sourceKind:'official-import',videoPath:join(root,'.faststart-cache','old.mp4'),externalRoot:root});
 service.midiStore.db.prepare('UPDATE user_songs SET source_roots=NULL WHERE id=?').run('legacy');
 const page=await browser.newPage({viewport:{width:640,height:650}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/admin/');await page.locator('[data-tab="performances"]').click();
 await page.waitForFunction(()=>document.querySelector('#midiReferencedSummary').textContent==='已引用目录（2 个）');
 assert.equal(await page.locator('#midiDataRoot').textContent(),'最近导入目录：'+roots[1]);
 assert.equal(await page.locator('#midiReferencedDetails').evaluate(el=>el.open),false);
 await page.locator('#midiReferencedSummary').click();
 assert.equal(await page.locator('#midiReferencedRoots li').count(),2);
 assert.ok((await page.locator('#midiSourceNotice').textContent()).includes('1 首旧作品来源待确认'));
 assert.ok((await page.locator('#midiWatchNotice').textContent()).includes('仅针对最近导入目录'));
 for(const item of await page.locator('#midiReferencedRoots li').all()) assert.equal(await item.evaluate(el=>el.scrollWidth>el.clientWidth),false);
 const song=service.midiStore.listPublishedUserSongs().find(song=>song.name==='歌曲0');
 await page.locator(`[data-song-id="${song.id}"] button`).filter({hasText:'移除'}).click();
 await page.getByRole('dialog',{name:'从曲库移除'}).getByRole('button',{name:'移除',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#midiReferencedSummary').textContent==='已引用目录（1 个）');
 assert.equal(await page.locator('#midiReferencedRoots li').getAttribute('title'),roots[1]);
 assert.equal(await page.locator('#midiDataRoot').textContent(),'最近导入目录：'+roots[1]);
 await page.locator('#refreshStorage').evaluate(el=>el.click());
 await page.waitForFunction(()=>document.querySelector('#storageReferenceSummary').textContent==='2 个作品 · 1 个来源目录 · 1 个来源待确认');
 assert.ok((await page.locator('#storageReferencedRoots').textContent()).includes(roots[1]));
 assert.equal((await page.locator('#storageReferencedRoots').textContent()).includes('.faststart-cache'),false);
 assert.deepEqual(errors,[]);
 console.log('PASS multi-directory display, latest root, unknown legacy source, long path wrapping, removal refresh, storage summary');
}finally{await browser.close();await service.close();await rm(root,{recursive:true,force:true});}
