import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOliviaService } from '../server.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('lyrics HTTP routes consume only accepted actual playback and never control music', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lyrics-api-'));
  const frames = [];
  const service = await createOliviaService({ root, dataDir: join(root, 'data'), appData: join(root, 'app-data'),
    runtimeDir: join(root, 'runtime'), worker: false, runMemoryRefresh: false,
    onLyricsFrame: frame => frames.push(frame), midiDurationProbe: async () => 120_000_000,
    fetch: async () => { throw new Error('No external requests allowed'); } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const { port } = await service.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const json = async (url, body, method = 'POST') => {
    const response = await fetch(base + url, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return response.json();
  };
  await mkdir(service.midiStore.root, { recursive: true });
  const path = join(service.midiStore.root, 'song.mp4'); await writeFile(path, 'video fixture');
  service.midiStore.upsertUserSong({ id: 'stable-work', name: 'Original', sourceKind: 'official-import',
    videoPath: path, videoByTodView: { DEFAULT: path }, durationUs: 120_000_000 });
  const binding = '/toy/media/songs/stable-work/lyrics';
  const stylesheet = await fetch(base + '/admin/lyrics-settings.css');
  assert.equal(stylesheet.status, 200); assert.match(stylesheet.headers.get('content-type'), /text\/css/);
  assert.equal((await json('/admin/api/lyrics/settings')).data.settings.enabled, false);
  assert.equal((await fetch(base + '/admin/game-lyrics.js')).status, 200);
  assert.equal((await json('/toy/lyrics/settings', {enabled:true})).data.settings.enabled, true);
  assert.equal((await json('/admin/api/lyrics/settings')).data.settings.enabled, true);
  assert.notEqual((await json('/toy/lyrics/settings', {enabled:false, opacity:10})).code, 0);
  await json('/toy/lyrics/settings', {enabled:false});
  assert.equal((await json(binding, { variant: 'DEFAULT', filename: 'test.lrc', offsetMs: 0,
    contentBase64: Buffer.from('[00:01]First\n[00:10]Second\n[00:20]Third').toString('base64') })).code, 0);
  assert.equal((await json('/admin/api/media/songs/stable-work/lyrics')).data.variants[0].bound, true);
  assert.equal((await json('/admin/api/media/songs/stable-work/metadata', { permanentName: 'Corrected' })).code, 0);
  assert.equal((await json(binding)).data.variants[0].bound, true);
  const play = (await json('/toy/player-command', { cmd: 'play', songId: 'stable-work', url: base + '/toy/midi/songs/stable-work/video.mp4' })).data;
  const report = { songId: 'stable-work', commandRevision: play.revision, sessionId: play.command.sessionId,
    mediaUrl: play.command.url, event: 'timeupdate', currentTime: 12, duration: 120 };
  await json('/toy/player-state', report);
  const before = (await json('/toy/player-state')).data;
  await json('/admin/api/lyrics/settings', { enabled: true });
  assert.equal(frames.at(-1).current, 'Second', 'enable midway uses actual progress immediately');
  assert.deepEqual((await json('/toy/player-state')).data, before, 'lyrics does not write player state');
  assert.equal((await json('/admin/api/lyrics/settings', {opacity:40, fontWeight:'bold'})).data.settings.opacity, 40);
  assert.equal((await json('/admin/api/lyrics/settings', {resetAppearance:true})).data.settings.opacity, 100);
  assert.deepEqual((await json('/toy/player-state')).data, before, 'appearance reset cannot control music');
  const count = frames.length;
  await json('/toy/player-state', { ...report, sessionId: 'old-session', currentTime: 2 });
  assert.equal(frames.length, count, 'rejected WebPlayer report never reaches lyrics');
  await json('/admin/api/lyrics/settings', { enabled: false });
  assert.equal(frames.at(-1).visible, false);
  assert.deepEqual((await json('/toy/player-state')).data, before, 'disable does not pause');
  await json('/admin/api/lyrics/settings', { enabled: true });
  const replay = (await json('/toy/player-command', { cmd: 'play', songId: 'stable-work', url: play.command.url })).data;
  assert.equal(frames.at(-1).visible, false, 'clear on replay command until actual media confirms');
  const replayReport = { ...report, commandRevision: replay.revision, sessionId: replay.command.sessionId, mediaUrl: replay.command.url, currentTime: 2 };
  await json('/toy/player-state', replayReport);
  assert.equal(frames.at(-1).current, 'First');
  const suspended = (await json('/toy/player-command', {cmd:'suspend',songId:'stable-work',sessionId:replay.command.sessionId})).data;
  assert.equal(suspended.command.cmd,'pause');
  assert.equal(suspended.command.preserveSession,true);
  await json('/toy/player-state',{...replayReport,commandRevision:suspended.revision,paused:true});
  assert.equal(frames.at(-1).visible,true);
  assert.equal(frames.at(-1).playbackState,'paused');
  assert.equal((await json('/toy/player-state')).data.currentTime,2);
  const resumed = await json('/toy/player-command',{cmd:'resume',songId:'stable-work',sessionId:replay.command.sessionId});
  assert.equal(resumed.code,0);
  assert.equal((await json('/toy/player-state')).data.currentTime,2);
  assert.equal((await json('/toy/player-command', { cmd: 'pause', songId: 'stable-work', sessionId: replay.command.sessionId })).code, 0);
  assert.equal(frames.at(-1).visible, false);
  assert.equal((await json('/admin/api/lyrics/settings')).data.settings.enabled, true);
  assert.equal((await json(binding, { variant: 'DEFAULT' }, 'DELETE')).code, 0);
  assert.equal((await json(binding)).data.variants[0].bound, false);
  assert.notEqual((await json(binding, { variant: 'DEFAULT', filename: 'bad.lrc', contentBase64: '!!!' })).code, 0);
  const native={pageId:'page',sequence:1,songId:'official:a',sessionId:'native:a',name:'官方曲目',playbackState:'playing',currentTime:4,duration:50};
  assert.equal((await json('/toy/lyrics/native-state',native)).data.ok,true);
  assert.equal(frames.at(-1).current,'官方曲目');
  assert.equal(frames.at(-1).visible,true);
  assert.equal((await json('/toy/player-state')).data.songId,'stable-work','native display does not rewrite local playback');
  await json('/toy/lyrics/native-state',{...native,sequence:2,playbackState:'stopped'});
  assert.equal(frames.at(-1).visible,false);

  // Exercise the same HTTP handoff and real FE adapter used by stress/toolbar.
  const fresh=(await json('/toy/player-command',{cmd:'play',songId:'stable-work',url:play.command.url})).data;
  const window={__OliviaSoulSongId:'stable-work',__OliviaSoulSessionId:fresh.command.sessionId,__OliviaSoulCommandRevision:fresh.revision};
  const line=readFileSync(new URL('../../tools/patch-feapp-local.ps1',import.meta.url),'utf8').split(/\r?\n/).find(l=>l.startsWith('$playerStateStoreTo = '));
  const fragment=line.slice(line.indexOf('window.OliviaSoulLyricsPlayback='),line.indexOf(';return{isSongAvailable:a')).replace(/' \+ \$playerCommandUrl \+ '/g,base+'/toy/player-command');
  vm.runInNewContext(fragment,{window,fetch});
  await json('/toy/lyrics/playback');
  for(const action of ['pause','resume']) {
    const pending=json('/toy/lyrics/playback',{action,songId:window.__OliviaSoulSongId,sessionId:window.__OliviaSoulSessionId});
    let command;
    for(let attempt=0;attempt<30&&!command;attempt++) {
      command=(await json('/toy/lyrics/playback')).data.command;
      if(!command)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(command.action,action);
    await window.OliviaSoulLyricsPlayback(command.action);
    await json('/toy/lyrics/playback',{id:command.id,ok:true});
    assert.equal((await pending).code,0);
    assert.equal(window.__OliviaSoulCommandRevision,(await json('/toy/player-state')).data.commandRevision);
  }
  await json('/toy/player-state',{songId:'stable-work',sessionId:fresh.command.sessionId,commandRevision:window.__OliviaSoulCommandRevision,mediaUrl:fresh.command.url,event:'ended',currentTime:120,duration:120});
  assert.equal((await json('/toy/player-state')).data.playbackState,'ended');
});
