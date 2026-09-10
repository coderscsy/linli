import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLrc, lyricPair, MAX_LRC_BYTES } from '../lyrics/lrc.js';
import { createLyricsService } from '../lyrics/service.js';

const lrc = '[ar:演奏者]\n[ti:测试]\n[00:01.5]第一句\n[00:04.00][00:08.125]第二句\n[00:06.000]\n[00:10]尾句';
test('LRC metadata, fractions, repeated stamps, blank marker and random seek', () => {
  const parsed = parseLrc(Buffer.from(lrc));
  assert.equal(parsed.metadata.ti, '测试');
  assert.deepEqual(parsed.lines.map(l => l.at), [1500, 4000, 6000, 8125, 10000]);
  assert.deepEqual(lyricPair(parsed.lines, 0), { current: '', next: '第一句' });
  assert.deepEqual(lyricPair(parsed.lines, 4.1), { current: '第二句', next: '' });
  assert.equal(lyricPair(parsed.lines, 6.5).current, '');
  assert.equal(lyricPair(parsed.lines, 2).current, '第一句');
  assert.equal(lyricPair(parsed.lines, 11).next, '');
  assert.equal(lyricPair(parsed.lines, 4.1, 1000).current, '第一句');
  assert.equal(lyricPair(parsed.lines, 3.1, -1000).current, '第二句');
});
test('LRC encoding, file offset and same timestamp grouping', () => {
  const parsed = parseLrc(Buffer.concat([Buffer.from([255, 254]), Buffer.from('[offset:1000]\n[00:02]甲\n[00:02]乙', 'utf16le')]));
  assert.deepEqual(parsed.lines, [{ at: 1000, text: '甲 / 乙' }]);
});
test('invalid LRC is rejected without unbounded parsing', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_LRC_BYTES + 1), Buffer.from('没有时间'), Buffer.from('[00:99]错'), Buffer.from([0xff]), Buffer.from('[00:01]\n[00:02]')])
    assert.throws(() => parseLrc(bytes));
  assert.throws(() => parseLrc(Buffer.from('[00:01]' + '字'.repeat(1001))), /过长/);
  assert.throws(() => parseLrc(Buffer.from('[00:01]一\n'.repeat(4001))), /过多/);
});

async function fixture(t, extras = {}) {
  const root = await mkdtemp(join(tmpdir(), 'olivia-lyrics-'));
  const db = new DatabaseSync(join(root, 'test.sqlite'));
  const songs = { a: { id: 'a', name: '旧名', videoPath: 'day.mp4', videoByTodView: { day: 'day.mp4', night: 'night.mp4' } }, b: { id: 'b', videoPath: 'b.mp4' } };
  const frames = []; let clock = 1000;
  const options = { db, root, getSong: id => songs[id], now: () => clock, onFrame: frame => frames.push(frame), ...extras };
  let service = await createLyricsService(options);
  t.after(async () => { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, songs, frames, get service() { return service; }, advance: ms => clock += ms,
    restart: async () => { await service.close(); service = await createLyricsService(options); },
    import: (id = 'a', variant = 'day', offsetMs = 0, content = lrc) => service.save(id, { variant, offsetMs, filename: '测试.lrc', contentBase64: Buffer.from(content).toString('base64') }),
  };
}

test('one import fills unbound variants with same LRC and independent offsets', async t => {
  const f = await fixture(t); await f.import('a', 'day', 80);
  const rows = f.service.info('a').variants;
  assert.equal(rows.find(v => v.key === 'night').bound, true);
  assert.equal(rows.find(v => v.key === 'night').offsetMs, 0);
  await f.service.save('a', { variant: 'night', offsetMs: -90 });
  assert.equal(f.service.info('a').variants.find(v => v.key === 'day').offsetMs, 80);
  await f.restart();
  assert.equal(f.service.info('a').variants.find(v => v.key === 'night').offsetMs, -90);
});

test('horizontal and vertical positions are restored separately', async t => {
  const f = await fixture(t);
  f.service.updateSettings({x:100,y:200});
  assert.equal(f.service.updateSettings({orientation:'vertical'}).settings.x, null);
  f.service.updateSettings({x:500,y:50});
  const horizontal = f.service.updateSettings({orientation:'horizontal'}).settings;
  assert.equal(horizontal.x, 100); assert.equal(horizontal.y, 200);
  await f.restart();
  const vertical = f.service.updateSettings({orientation:'vertical'}).settings;
  assert.equal(vertical.x, 500); assert.equal(vertical.y, 50);
});

test('orientation persists, rejects invalid directions and resets without disabling lyrics', async t => {
  const f = await fixture(t);
  assert.equal(f.service.updateSettings({ orientation: 'vertical', enabled: true }).settings.orientation, 'vertical');
  await f.restart();
  assert.equal(f.service.updateSettings({}).settings.orientation, 'vertical');
  assert.throws(() => f.service.updateSettings({ orientation: 'diagonal' }), /横排或竖排/);
  const reset = f.service.updateSettings({ resetAppearance: true }).settings;
  assert.equal(reset.orientation, 'horizontal'); assert.equal(reset.enabled, true);
});
const state = (overrides = {}) => ({ songId: 'a', sessionId: 'one', mediaUrl: '/a?session=one', name: '曲目', playbackState: 'playing', event: 'timeupdate', currentTime: 4.5, duration: 11, ...overrides });
test('unbound playback shows a placeholder, expires and never borrows previous lyrics', async t => {
  const f = await fixture(t); f.service.updateSettings({enabled:true});
  f.service.observe(state(), {key:'day'}, true);
  assert.equal(f.frames.at(-1).visible,true);
  assert.equal(f.frames.at(-1).current,'曲目');
  assert.equal(f.frames.at(-1).next,'暂无歌词，尽情欣赏音乐');
  f.advance(4000); assert.equal(f.service.snapshot().visible,false);
  f.service.observe(state({songId:'official:a',sessionId:'native:one',name:''}), {official:true}, true);
  assert.equal(f.frames.at(-1).current,'正在播放');
  assert.equal(f.frames.at(-1).visible,true);
  f.service.observe(state({playbackState:'stopped'}),null);
  assert.equal(f.frames.at(-1).visible,false);
});
test('appearance preferences persist and reject invalid values without changing saved state', async t => {
  const f = await fixture(t);
  const patch = { fontFamily: '楷体', currentColor: '#abcdef', nextColor: '#123456', lineMode: 'single', animate: false };
  f.service.updateSettings(patch); await f.restart();
  for (const [key, value] of Object.entries(patch)) assert.equal(f.service.settings().settings[key], value);
  for (const bad of [{currentColor:'transparent'}, {lineMode:'triple'}, {fontFamily:'x'.repeat(101)}, {animate:1}]) assert.throws(() => f.service.updateSettings(bad));
  assert.equal(f.service.settings().settings.fontFamily, '楷体');
});
test('quick offset uses current variant, adds in order, and rejects old session or enable epoch', async t => {
  const f = await fixture(t); await f.import(); f.service.updateSettings({ enabled: true });
  f.service.observe(state(), {key:'day'}, true);
  const frame = f.frames.at(-1);
  const request = { songId: frame.songId, sessionId: frame.sessionId, mediaUrl: frame.mediaUrl, variant: frame.variant, controlEpoch: frame.controlEpoch, deltaMs: 500 };
  assert.equal(typeof f.service.adjustOffset, 'function');
  await Promise.all([f.service.adjustOffset(request), f.service.adjustOffset(request)]);
  assert.equal(f.service.info('a').variants[0].offsetMs, 1000);
  await f.service.adjustOffset({...request, reset:true}); assert.equal(f.service.info('a').variants[0].offsetMs, 0);
  f.service.updateSettings({enabled:false}); f.service.updateSettings({enabled:true});
  await assert.rejects(f.service.adjustOffset(request));
  const fresh = {...request, controlEpoch:f.frames.at(-1).controlEpoch};
  f.service.observe(state({sessionId:'new'}), {key:'day'}, true);
  await assert.rejects(f.service.adjustOffset(fresh));
  assert.equal(f.service.info('a').variants[0].offsetMs, 0);
});

test('opacity and weight persist; resetting appearance preserves enable, position, bindings and offsets', async t => {
  const f = await fixture(t); await f.import('a', 'day', 1500);
  f.service.updateSettings({enabled:true, locked:true, x:20, y:30, opacity:45, fontWeight:'bold', fontSize:40, currentColor:'#112233'});
  await f.restart();
  assert.equal(f.service.settings().settings.opacity, 45);
  assert.equal(f.service.settings().settings.fontWeight, 'bold');
  for (const bad of [{opacity:0}, {opacity:101}, {opacity:20.5}, {opacity:'50'}, {fontWeight:'heavy'}, {resetAppearance:false}])
    assert.throws(() => f.service.updateSettings(bad));
  f.service.updateSettings({resetAppearance:true});
  const settings = f.service.settings().settings;
  assert.equal(settings.opacity, 100); assert.equal(settings.fontWeight, 'normal');
  assert.equal(settings.fontSize, 28); assert.equal(settings.currentColor, '#ffebaa');
  assert.equal(settings.enabled, true); assert.equal(settings.locked, true);
  assert.equal(settings.x, 20); assert.equal(settings.y, 30);
  assert.equal(f.service.info('a').variants[0].bound, true);
  assert.equal(f.service.info('a').variants[0].offsetMs, 1500);
});
test('default off; enable mid-play uses actual report; stop hides without disabling; persistence', async t => {
  const f = await fixture(t); await f.import();
  assert.equal(f.service.settings().settings.enabled, false);
  f.service.observe(state(), { key: 'day' }, true);
  assert.equal(f.frames.length, 0);
  f.service.updateSettings({ enabled: true, locked: true, fontSize: 32, x: -100, y: 200 });
  assert.equal(f.frames.at(-1).current, '第二句');
  f.service.observe(state({ playbackState: 'stopped', event: 'stop' }), null);
  assert.equal(f.frames.at(-1).visible, false);
  assert.equal(f.service.settings().settings.enabled, true);
  await f.restart();
  assert.equal(f.service.settings().settings.enabled, true);
  assert.equal(f.service.settings().settings.x, -100);
  assert.equal(f.service.snapshot().visible, false);
  assert.equal((await readdir(join(f.root, 'lyrics'))).length, 1);
  assert.equal(await readFile(join(f.root, 'lyrics', (await readdir(join(f.root, 'lyrics')))[0]), 'utf8'), lrc);
});
test('paused playback retains lyrics while confirmed heartbeats are fresh; stop still hides', async t => {
  const f = await fixture(t); await f.import(); f.service.updateSettings({enabled:true});
  f.service.observe(state(), {key:'day'}, true);
  f.service.observe(state({event:'pause',playbackState:'paused'}), {key:'day'});
  assert.equal(f.frames.at(-1).visible,true);
  assert.equal(f.frames.at(-1).playbackState,'paused');
  f.advance(1000); f.service.observe(state({playbackState:'paused'}), {key:'day'},true);
  assert.equal(f.frames.at(-1).current,'第二句');
  f.advance(4000); assert.equal(f.service.snapshot().visible,false);
  f.service.observe(state({event:'stop',playbackState:'stopped'}),null);
  assert.equal(f.frames.at(-1).visible,false);
});
test('switch, seek, replay and ended isolate old content; no command-time extrapolation', async t => {
  const f = await fixture(t); await f.import(); f.service.updateSettings({ enabled: true });
  f.service.observe(state({ event: 'play' }), { key: 'day' });
  assert.equal(f.frames.at(-1).visible, false);
  f.service.observe(state(), { key: 'day' }, true); assert.equal(f.frames.at(-1).current, '第二句');
  f.service.observe(state({ currentTime: 2, event: 'seek' }), { key: 'day' }); assert.equal(f.frames.at(-1).visible, false);
  f.service.observe(state({ currentTime: 2 }), { key: 'day' }, true); assert.equal(f.frames.at(-1).current, '第一句');
  f.service.observe(state({ sessionId: 'two', event: 'play', currentTime: 0 }), { key: 'day' }); assert.equal(f.frames.at(-1).current, '');
  f.service.observe(state({ sessionId: 'two', currentTime: 0 }), { key: 'day' }, true); assert.equal(f.frames.at(-1).next, '第一句');
  f.service.observe(state({ playbackState: 'ended', event: 'ended' }), { key: 'day' }, true); assert.equal(f.frames.at(-1).visible, false);
  f.service.observe(state({ songId: 'b', sessionId: 'three', mediaUrl: '/b' }), { key: 'default' }, true); assert.equal(f.frames.at(-1).current, '曲目');
});
test('offsets and bindings are per variant and stable through rename', async t => {
  const f = await fixture(t); await f.import('a', 'day', 1000); await f.import('a', 'night', -1000);
  f.songs.a.name = '永久纠正后的名称'; f.songs.a.correctedName = '新名称';
  f.service.updateSettings({ enabled: true });
  f.service.observe(state({ currentTime: 3.2 }), { key: 'day' }, true); assert.equal(f.frames.at(-1).current, '第一句');
  f.service.observe(state({ currentTime: 3.2, mediaUrl: '/night' }), { key: 'night' }, true); assert.equal(f.frames.at(-1).current, '第二句');
  assert.equal((await readdir(join(f.root, 'lyrics'))).length, 1, 'identical copies are content-addressed');
  f.songs.a.videoByTodView.night = 'other.mp4';
  f.service.observe(state({ mediaUrl: '/other' }), { key: 'night' }, true); assert.equal(f.frames.at(-1).current, '曲目');
});
test('rapid enable/disable, stale progress, missing lyrics, and close cannot revive overlay', async t => {
  const f = await fixture(t, { staleMs: 40 }); await f.import();
  f.service.observe(state(), { key: 'day' }, true);
  for (let i = 0; i < 30; i++) f.service.updateSettings({ enabled: i % 2 === 0 });
  const count = f.frames.length;
  await new Promise(resolve => setTimeout(resolve, 65)); assert.equal(f.frames.length, count, 'disabled timer cancelled');
  f.advance(100); f.service.updateSettings({ enabled: true }); assert.equal(f.frames.at(-1).visible, false);
  f.service.observe(state(), { key: 'day' }, true); assert.equal(f.frames.at(-1).visible, true);
  await new Promise(resolve => setTimeout(resolve, 65)); assert.equal(f.frames.at(-1).visible, false);
  await f.service.close(); const closedCount = f.frames.length;
  f.service.observe(state(), { key: 'day' }, true); assert.equal(f.frames.length, closedCount);
});
test('failed replace keeps prior binding; queued changes use last operation; invalid settings rejected', async t => {
  const f = await fixture(t); await f.import();
  await assert.rejects(f.import('a', 'day', 0, 'invalid'), /时间戳/);
  assert.equal(f.service.info('a').variants[0].bound, true);
  await Promise.all([f.service.save('a', { variant: 'day', offsetMs: 500 }), f.service.save('a', { variant: 'day', offsetMs: -500 })]);
  assert.equal(f.service.info('a').variants[0].offsetMs, -500);
  assert.throws(() => f.service.updateSettings({ enabled: 'yes' }));
  assert.throws(() => f.service.updateSettings({ fontSize: 100000 }));
  await f.service.save('a', { variant: 'day' }, true); assert.equal(f.service.info('a').variants[0].bound, false);
});
test('broken lyrics storage degrades without taking down playback service', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lyrics-unavailable-')); await writeFile(join(root, 'lyrics'), 'not a directory');
  const db = new DatabaseSync(':memory:'); t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const service = await createLyricsService({ db, root, getSong: () => null });
  assert.equal(service.snapshot().visible, false); assert.match(service.settings().status, /不可用/);
  service.observe(state(), {}, true); await service.close();
});
