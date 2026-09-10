import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { setImmediate as turn } from 'node:timers/promises';
const source = await readFile(new URL('../public/lyrics-settings.js', import.meta.url), 'utf8');
test('lyrics settings has its own sidebar page and native settings shortcut', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-tab="lyrics">歌词设置<\/button>/);
  const pages = html.split(/<section class="panel tabPage"/);
  const lyrics = pages.find(page => /^ data-page="lyrics"/.test(page));
  const desktop = pages.find(page => /^ data-page="desktop"/.test(page));
  assert.ok(lyrics?.includes('id="lyricsSettings"'));
  assert.ok(!desktop.includes('id="lyricsSettings"'));
  assert.match(source, /sideTab\[data-tab="lyrics"\]/);
});
function target() {
  const events = new Map();
  return { checked: false, value: '', textContent: '', style: {}, hidden:false, addEventListener(k, f) { events.set(k, f); }, removeEventListener(k) { events.delete(k); }, emit(k, data) { events.get(k)?.(data); } };
}
function setup() {
  const fields = Object.fromEntries(['lyricsEnabled', 'lyricsLocked', 'lyricsFontSize', 'lyricsStatus', 'lyricsFontFamily', 'lyricsFontWeight', 'lyricsOpacity', 'lyricsOpacityValue', 'lyricsLineMode', 'lyricsCurrentColor', 'lyricsNextColor', 'lyricsAnimate', 'lyricsPreset', 'lyricsReset', 'lyricsPreview', 'lyricsPreviewCurrent', 'lyricsPreviewNext'].map(id => [id, target()]));
  const window = target(); window.chrome = { webview: target() };
  const calls = [];
  vm.runInNewContext(source, { document: { querySelector: selector => fields[selector.slice(1)] }, window, AbortController, setTimeout, clearTimeout,
    fetch: (url, options) => new Promise(resolve => calls.push({ url, ...options, reply(data) { resolve({ ok: true, json: async () => ({ code: 0, data }) }); } })) });
  const data = (enabled, locked = false) => ({ settings: { enabled, locked, fontSize: 28, fontFamily:'auto', fontWeight:'normal', opacity:100, lineMode:'double', currentColor:'#ffebaa', nextColor:'#ffffff', animate:true }, status: 'ok' });
  return { fields, window, calls, data };
}
test('management reads once, tray push syncs, stale focus GET cannot overwrite newer push', async () => {
  const f = setup();
  f.window.chrome.webview.emit('message', { data: { type: 'lyrics-settings', data: f.data(true, true) } });
  assert.equal(f.fields.lyricsEnabled.checked, true); assert.equal(f.fields.lyricsLocked.checked, true);
  f.calls[0].reply(f.data(false)); await turn();
  assert.equal(f.fields.lyricsEnabled.checked, true);
  f.window.emit('focus'); f.window.emit('focus');
  assert.equal(f.calls.length, 2, 'one read in flight');
  f.calls[1].reply(f.data(true)); await turn(); f.window.emit('pagehide');
});

test('friendly automatic font label round trips as auto, not as a literal font family', async () => {
  const f = setup(); f.calls[0].reply(f.data(false)); await turn();
  assert.equal(f.fields.lyricsFontFamily.value, 'auto');
  f.fields.lyricsFontFamily.emit('change'); await turn();
  assert.deepEqual(JSON.parse(f.calls[1].body), {fontFamily:'auto'});
  f.calls[1].reply(f.data(false)); await turn();
  f.window.emit('pagehide');
});

test('preview updates locally during opacity input and saves on change; reset sends no binding or position data', async () => {
  const f = setup(); f.calls[0].reply(f.data(true, true)); await turn();
  f.fields.lyricsOpacity.value = '40'; f.fields.lyricsOpacity.emit('input');
  assert.equal(f.fields.lyricsPreview.style.opacity, '0.4');
  assert.equal(f.calls.length, 1, 'slider drag does not flood backend');
  f.fields.lyricsOpacity.emit('change'); await turn();
  assert.deepEqual(JSON.parse(f.calls[1].body), {opacity:40});
  f.calls[1].reply({...f.data(true, true), settings:{...f.data(true, true).settings, opacity:40}}); await turn();
  f.fields.lyricsLineMode.value = 'single'; f.fields.lyricsLineMode.emit('input');
  assert.equal(f.fields.lyricsPreviewNext.hidden, true);
  f.fields.lyricsReset.emit('click'); await turn();
  assert.deepEqual(JSON.parse(f.calls[2].body), {resetAppearance:true});
  f.calls[2].reply(f.data(true, true)); await turn();
  assert.equal(f.fields.lyricsEnabled.checked, true); assert.equal(f.fields.lyricsLocked.checked, true);
  assert.equal(f.fields.lyricsOpacity.value, 100);
  f.window.emit('pagehide');
});
test('management rapid toggles serialize with last action winning; close aborts and drops queued writes', async () => {
  const f = setup(); f.calls[0].reply(f.data(false)); await turn();
  for (const value of [true, false, true]) { f.fields.lyricsEnabled.checked = value; f.fields.lyricsEnabled.emit('change'); }
  await turn(); assert.equal(f.calls.length, 2);
  for (const [index, value] of [[1, true], [2, false], [3, true]]) {
    assert.equal(JSON.parse(f.calls[index].body).enabled, value);
    f.calls[index].reply(f.data(value)); await turn();
  }
  assert.equal(f.fields.lyricsEnabled.checked, true);
  f.fields.lyricsEnabled.emit('change'); f.fields.lyricsEnabled.emit('change'); await turn();
  const pending = f.calls.at(-1); f.window.emit('pagehide');
  assert.equal(pending.signal.aborted, true);
  pending.reply(f.data(true)); await turn(); await turn();
  assert.equal(f.calls.length, 5, 'queued write must not start after page closes');
});
