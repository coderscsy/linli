import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOliviaService} from '../server.js';
const {chromium}=createRequire(import.meta.url)(process.argv[2]);
const root=await mkdtemp(join(tmpdir(),'library-live-'));
const service=await createOliviaService({root,dataDir:join(root,'data'),appData:join(root,'app'),worker:false,runMemoryRefresh:false,midiDurationProbe:async()=>1000000,fetch:async()=>{throw Error('offline');}});
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const {port}=await service.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${port}`;
 const oldPath=join(root,'old.mp4');await writeFile(oldPath,'old media');
 service.midiStore.upsertUserSong({id:'old',name:'天空旧歌',sourceKind:'official-import',videoPath:oldPath,externalRoot:root});
 const patch=await readFile(new URL('../../tools/patch-feapp-local.ps1',import.meta.url),'utf8');
 let search=patch.match(/^\$myUploadSearchHandlerTo = '([^\r\n]*)'\r?$/m)[1];
 for(const m of patch.matchAll(/^\$myUploadSearchHandlerTo = \$myUploadSearchHandlerTo\.Replace\('([^']*)', '([^']*)'\)/gm))search=search.split(m[1]).join(m[2]);
 const handlers=patch.match(/\$songUploadMetadata = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
 const game=await browser.newPage(),pages=[await browser.newPage(),await browser.newPage()],errors=[];
 for(const page of [game,...pages]) page.on('pageerror',e=>errors.push(e.message));
 await game.route('**/library-test',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<meta charset="utf-8"><script>
 const Q={value:true},he={value:[]},K={value:[]},m={value:'keep-playing'},OliviaSoulUploadSearch={value:'天空'};
 const dm=async query=>{const data=(await (await fetch('/toy/searchUserSongs?'+new URLSearchParams(query))).json()).data;return {...data,list:data.list.map(song=>({...song,id:song.userSongId}))};};
 const zt=async()=>{};
 ${search};${handlers};
 window.addEventListener('oliviasoul-library-changed',OliviaSoulLibraryChanged);
 window.gameState={he,m,OliviaSoulUploadSearch};
 </script><script src='/admin/game-lyrics.js'></script>`}));
 await game.goto(base+'/library-test');
 for(const page of pages){
  // Disable only the five-second fallback: this test must pass via the real SSE path.
  await page.addInitScript(()=>{const original=setInterval;window.setInterval=(fn,ms,...args)=>ms===5000?0:original(fn,ms,...args);});
  await page.goto(base+'/admin/');await page.locator('[data-tab="performances"]').click();
  await page.locator('[data-song-id="old"]').waitFor();
 }
 await game.waitForFunction(()=>window.gameState.he.value[0]?.id==='old');
 const folder=join(root,'曲库'),songFolder=join(folder,'天空之城');
 await mkdir(songFolder,{recursive:true});await writeFile(join(songFolder,'DEFAULT.mp4'),'media-one');
 await pages[0].locator('#midiLibraryRoot').fill(folder);
 await pages[0].locator('#previewMidiLibrary').click();
 await pages[0].locator('#confirmMidiLibrary').waitFor({state:'visible'});
 await pages[0].waitForFunction(()=>!document.querySelector('#confirmMidiLibrary').disabled);
 await pages[0].locator('#confirmMidiLibrary').click();
 for(const page of pages) await page.waitForFunction(()=>document.querySelectorAll('#midiSongList [data-song-id]').length===2,null,{timeout:2000});
 const importedId=service.midiStore.listPublishedUserSongs().find(song=>song.id!=='old')?.id;
 for(const page of pages) assert.equal(await page.locator('#midiSongList [data-song-id]').first().getAttribute('data-song-id'),importedId,'newly imported song must appear at the top of the already populated list');
 try { await game.waitForFunction(()=>window.gameState.he.value.length===2,null,{timeout:2000}); }
 catch(error){console.log({errors,state:await game.evaluate(()=>window.gameState),songs:service.midiStore.listPublishedUserSongs().map(s=>({id:s.id,name:s.name}))});throw error;}
 assert.equal(await game.evaluate(()=>window.gameState.m.value),'keep-playing');
 assert.equal(await game.evaluate(()=>window.gameState.OliviaSoulUploadSearch.value),'天空');
 assert.equal(await game.evaluate(()=>window.gameState.he.value[0].id),importedId,'game must place the new song ahead of existing entries');
 assert.equal(await pages[1].locator('#midiDataRoot').textContent(),'最近导入目录：'+folder);
 // Reimporting the same source must refresh source metadata without duplicating songs.
 const post=async(path,body)=>(await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
 const preview=await post('/admin/api/midi-library/preview',{root:folder});
 assert.equal((await post('/admin/api/midi-library/confirm',{previewId:preview.data.previewId})).code,0);
 assert.equal(service.midiStore.listPublishedUserSongs().length,2);
 const id=importedId;
 await post('/toy/media/songs/remove',{ids:[id]});
 for(const page of pages) await page.locator(`[data-song-id="${id}"]`).waitFor({state:'detached',timeout:2000});
 assert.deepEqual(errors,[]);
 console.log('PASS: actual import UI -> both management pages and game list within 2s, fallback disabled; search/playback preserved; no duplicate reimport; game removal refreshes management.');
} finally {await browser.close();await service.close();await rm(root,{recursive:true,force:true});}
