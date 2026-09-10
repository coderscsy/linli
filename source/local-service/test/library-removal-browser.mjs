import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOliviaService} from '../server.js';
const {chromium}=createRequire(import.meta.url)(process.argv[2]);
const root=await mkdtemp(join(tmpdir(),'remove-browser-'));
const service=await createOliviaService({root,dataDir:join(root,'data'),appData:join(root,'app'),worker:false,runMemoryRefresh:false,fetch:async()=>{throw Error('offline test');}});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const {port}=await service.listen(0,'127.0.0.1');
 await mkdir(service.midiStore.root,{recursive:true});
 for(const id of ['test-a','test-b']){const path=join(service.midiStore.root,id+'.mp4');await writeFile(path,'video');service.midiStore.upsertUserSong({id,name:id,sourceKind:'import',videoPath:path,videoByTodView:{DEFAULT:path}});}
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const game=await browser.newPage();
 await game.route('**/removal-test',route=>route.fulfill({contentType:'text/html',body:`<script>window.removed=[];window.addEventListener('oliviasoul-songs-removed',e=>window.removed.push(...e.detail.ids));const OriginalEventSource=EventSource;window.EventSource=class extends OriginalEventSource{constructor(url){super(url);this.addEventListener('open',()=>window.streamReady=true)}};</script><script src='/admin/game-lyrics.js'></script>`}));
 await game.goto(`http://127.0.0.1:${port}/removal-test`);await game.waitForFunction(()=>window.streamReady);
 await page.goto(`http://127.0.0.1:${port}/admin/`);
 await page.locator('[data-tab="performances"]').click();
 const row=page.locator('[data-song-id="test-a"]');await row.waitFor();
 assert.equal(await row.getByRole('button',{name:'移除',exact:true}).isVisible(),true);
 await row.getByRole('button',{name:'移除',exact:true}).click();
 await page.getByRole('dialog',{name:'从曲库移除'}).getByRole('button',{name:'取消',exact:true}).click();
 assert.ok(service.midiStore.getUserSong('test-a'));
 await row.getByRole('button',{name:'移除',exact:true}).click();
 await page.getByRole('dialog',{name:'从曲库移除'}).getByRole('button',{name:'移除',exact:true}).click();
 await row.waitFor({state:'detached'});assert.equal(service.midiStore.getUserSong('test-a'),null);
 await game.waitForFunction(()=>window.removed.includes('test-a'),null,{timeout:1500});
 const remaining=page.locator('[data-song-id="test-b"]');await remaining.locator('input[type=checkbox]').check();
 await page.locator('#removeSelectedSongs').click();
 await page.getByRole('dialog',{name:'从曲库移除'}).getByRole('button',{name:'移除',exact:true}).click();
 await remaining.waitFor({state:'detached'});
 await game.waitForFunction(()=>window.removed.includes('test-b'),null,{timeout:1500});
 assert.equal(service.midiStore.listPublishedUserSongs().length,0);
 console.log('PASS: visible outer-row actions, cancel, confirmed removal, immediate list disappearance, batch removal');
}finally{await browser.close();await service.close();await rm(root,{recursive:true,force:true});}
