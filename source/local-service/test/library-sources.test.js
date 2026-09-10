import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOliviaService} from '../server.js';

test('directory summaries include all active registered sources, not recent root or legacy cache paths',async t=>{
 const root=await mkdtemp(join(tmpdir(),'library-sources-'));
 const service=await createOliviaService({root,dataDir:join(root,'data'),appData:join(root,'app'),worker:false,runMemoryRefresh:false,midiDurationProbe:async()=>1000000,fetch:async()=>{throw Error('offline');}});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const {port}=await service.listen(0,'127.0.0.1');
 const json=async(path,body)=>(await fetch(`http://127.0.0.1:${port}`+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})).json();
 const roots=[join(root,'A'),join(root,'B')];
 for(const [index,folder] of roots.entries()){
  await mkdir(join(folder,'Song'+index),{recursive:true});await writeFile(join(folder,'Song'+index,'DEFAULT.mp4'),'media-'+index);
  const preview=await json('/admin/api/midi-library/preview',{root:folder});
  assert.equal((await json('/admin/api/midi-library/confirm',{previewId:preview.data.previewId})).code,0);
 }
 let state=(await json('/admin/api/midi')).data;
 assert.deepEqual(state.library.sources?.roots.map(item=>item.path),roots);
 assert.equal(state.library.root,roots[1]);
 const a=state.songs.find(song=>song.name==='Song0');
 // The same source on another work must not create a separate directory.
 service.midiStore.registerSongSource(state.songs.find(song=>song.name==='Song1').id,roots[1].toUpperCase());
 const cache=join(root,'.faststart-cache','old','DEFAULT.mp4');
 service.midiStore.upsertUserSong({id:'legacy',name:'legacy',sourceKind:'official-import',videoPath:cache,externalRoot:root});
 // Simulate legacy records which predate source registration, without changing real user data.
 service.midiStore.db.prepare('UPDATE user_songs SET source_roots=NULL WHERE id=?').run('legacy');
 state=(await json('/admin/api/midi')).data;
 assert.equal(state.library.sources.roots.length,2);assert.equal(state.library.sources.unconfirmedWorks,1);
 await json('/admin/api/media/songs/remove',{ids:[a.id]});
 const storage=(await json('/admin/api/storage')).data;
 assert.deepEqual(storage.librarySources.roots.map(item=>item.path),[roots[1]]);
 assert.equal(storage.librarySources.workCount,2);assert.equal(storage.librarySources.unconfirmedWorks,1);
 assert.equal((await json('/admin/api/midi')).data.library.sources.roots.length,1);
});
