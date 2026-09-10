// Isolated visual check: real markup/CSS/JS, fake settings transport, no live app.
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2]);
const output = resolve(process.argv[3]); await mkdir(output, {recursive:true});
const base = new URL('../local-service/public/', import.meta.url);
const html = await readFile(new URL('index.html', base), 'utf8');
const section = html.slice(html.indexOf('<section id="lyricsSettings"'), html.indexOf('<section class="settingsBlock storageSection"'));
const settings = {enabled:false, locked:false, fontFamily:'auto', fontSize:28, fontWeight:'normal', opacity:100, lineMode:'double', currentColor:'#ffebaa', nextColor:'#ffffff', animate:true};
const browser = await chromium.launch({channel:'msedge', headless:true});
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({contentType:'text/html', body:`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/admin/styles.css"><link rel="stylesheet" href="/admin/lyrics-settings.css"><style>html,body{height:auto;overflow:auto}body{padding:16px}</style>${section}<script type="module" src="/admin/lyrics-settings.js"></script>`});
    if (url.pathname === '/admin/api/lyrics/settings') {
      if (route.request().method() === 'POST') Object.assign(settings, route.request().postDataJSON());
      return route.fulfill({json:{code:0,data:{settings,status:'歌词已关闭'}}});
    }
    const name = url.pathname.split('/').at(-1);
    if (['styles.css','lyrics-settings.css','lyrics-settings.js'].includes(name)) return route.fulfill({body:await readFile(new URL(name, base)),contentType:name.endsWith('.css')?'text/css':'text/javascript'});
    return route.abort();
  });
  for (const width of [760, 390]) {
    await page.setViewportSize({width,height:1100}); await page.goto('http://lyrics.test/');
    await page.waitForFunction(() => document.querySelector('#lyricsStatus').textContent === '歌词已关闭');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
    await page.locator('#lyricsSettings').screenshot({path:resolve(output, `lyrics-settings-${width}.png`)});
  }
  await page.locator('#lyricsFontWeight').selectOption('bold');
  await page.locator('#lyricsLineMode').selectOption('single');
  await page.locator('#lyricsPreset').selectOption('ocean');
  await page.waitForFunction(() => document.querySelector('#lyricsPreviewCurrent').style.color === 'rgb(0, 200, 239)');
  assert.equal(await page.locator('#lyricsPreviewNext').isVisible(), false);
  assert.equal(await page.locator('#lyricsPreview').evaluate(e => e.style.fontWeight), '700');
  assert.deepEqual(errors, []);
  console.log('PASS real Edge settings: 760/390 px, no overflow, single line, bold and ocean preview');
} finally { await browser.close(); }
