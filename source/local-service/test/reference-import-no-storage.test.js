import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOliviaService} from '../server.js';

test('reference library import succeeds without game storage path and never moves source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reference-no-storage-'));
  const service = await createOliviaService({root, dataDir:join(root,'data'), appData:join(root,'app'), runtimeDir:join(root,'runtime'), worker:false, runMemoryRefresh:false, midiDurationProbe:async()=>120000000, fetch:async()=>{throw Error('no network');}});
  t.after(async()=>{await service.close(); await rm(root,{recursive:true,force:true});});
  const {port} = await service.listen(0,'127.0.0.1');
  const json = async (path,body) => (await fetch(`http://127.0.0.1:${port}${path}`, body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})).json();
  const library=join(root,'library'), song=join(library,'Song'); await mkdir(song,{recursive:true});
  const video=join(song,'DEFAULT.mp4'); await writeFile(video,'fixture');
  assert.equal((await json('/admin/api/storage')).data.activePath, '');
  const preview=await json('/admin/api/midi-library/preview',{root:library});
  assert.equal(preview.code,0);
  const result=await json('/admin/api/midi-library/confirm',{previewId:preview.data.previewId});
  assert.equal(result.code,0,JSON.stringify(result)); assert.equal(result.data.imported,1);
  assert.equal(await readFile(video,'utf8'),'fixture');
  assert.notEqual((await json('/admin/api/storage/migration/preview',{})).code,0,'migration still requires target');
});
