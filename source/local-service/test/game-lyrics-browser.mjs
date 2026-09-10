// Real production script in Edge; isolated footer fixture and HTTP transport.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const {chromium} = createRequire(import.meta.url)(process.argv[2]);
const browser = await chromium.launch({channel:'msedge',headless:true});
let enabled = false, writes = 0, acknowledgments = 0;
let command = null;
try {
  const page = await browser.newPage();
  const failures = []; page.on('pageerror', e => failures.push(e.message));
  await page.route('http://lyrics.test/**', async route => {
    if (route.request().url().endsWith('/admin/game-lyrics.js')) return route.fulfill({contentType:'text/javascript', body:readFileSync(new URL('../public/game-lyrics.js',import.meta.url),'utf8')});
    if (route.request().url().endsWith('/toy/lyrics/settings')) {
      if (route.request().method() === 'POST') { enabled = route.request().postDataJSON().enabled; writes++; }
      return route.fulfill({json:{code:0,data:{settings:{enabled}}}});
    }
    if (route.request().url().endsWith('/toy/lyrics/playback')) {
      if(route.request().method()==='POST') {acknowledgments++;return route.fulfill({json:{code:0,data:{ok:true}}});}
      return route.fulfill({json:{code:0,data:{command}}});
    }
    return route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><div class="lite-playback-control"><div class="flex gap-2 items-center"><button>音量</button></div></div><script src="/admin/game-lyrics.js"></script>'});
  });
  await page.goto('http://lyrics.test/');
  const button = page.getByRole('button',{name:'词',exact:true});
  await button.click(); assert.equal(enabled,true); assert.equal(writes,1);
  await page.waitForFunction(() => document.querySelector('button[aria-pressed="true"]'));
  enabled = false;
  await page.waitForFunction(() => document.querySelector('button[aria-pressed="false"]'));
  assert.equal(await button.count(),1); assert.deepEqual(failures,[]);
  await page.evaluate(()=>{
    window.__OliviaSoulSongId='a';window.__OliviaSoulSessionId='s';window.actions=[];
    window.OliviaSoulLyricsPlayback=async action=>window.actions.push(action);
  });
  command={id:'one',songId:'a',sessionId:'s',action:'next',expiresAt:Date.now()+15000};
  await page.waitForFunction(()=>window.actions.length===1);
  await new Promise(resolve=>setTimeout(resolve,2500));
  assert.equal(await page.evaluate(()=>window.actions.length),1,'repeated delivery must not skip two songs');
  assert.ok(acknowledgments>=2,'duplicate result acknowledged without executing again');
  command={id:'stale',songId:'a',sessionId:'old',action:'previous',expiresAt:Date.now()+15000};
  await new Promise(resolve=>setTimeout(resolve,2500));
  assert.deepEqual(await page.evaluate(()=>window.actions),['next']);
  console.log('PASS game lyrics button mounts once, writes shared toggle, syncs external changes');
  console.log('PASS playback bridge executes once and rejects stale session');
} finally { await browser.close(); }
