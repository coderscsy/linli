import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

const browserTest = process.env.OLIVIA_BROWSER_UI === "1" ? test : test.skip;
const chromium = process.env.OLIVIA_BROWSER_UI === "1" ? createRequire(import.meta.url)("playwright").chromium : null;
const script = await readFile(process.env.OLIVIA_EDITOR_SOURCE || new URL("../public/song-editor.js", import.meta.url), "utf8").catch(() => "");
const adminCss = await readFile(new URL("../public/styles.css", import.meta.url), "utf8").catch(() => "");
const metadata = {
  id: "work/42", name: "<img src=x onerror=alert(1)>", originalName: "Original", customName: "<img src=x onerror=alert(1)>",
  variants: [{ key: "DEFAULT0", filename: "<b>video.mp4</b>", url: "http://fixture.test/video.mp4", tod: null, view: null }],
  mapping: { TOD12: null, TOD1730: null, TOD20: null }, mappingStatus: "unconfirmed", revision: "1",
};
async function fixture(t, { rejectSave = false, record = metadata, viewport = { width: 360, height: 640 }, hostCss = "" } = {}) {
  const tempRoot = process.env.OLIVIA_BROWSER_TEMP_ROOT || tmpdir();
  const launchOptions = {
    executablePath: process.env.OLIVIA_BROWSER_EXECUTABLE_PATH || undefined,
    headless: process.env.OLIVIA_BROWSER_HEADLESS !== "0",
    timeout: 20000,
    env: { ...process.env, TEMP: tempRoot, TMP: tempRoot },
  };
  let context, browser, profile;
  if (process.env.OLIVIA_BROWSER_PERSISTENT === "1") {
    profile = await mkdtemp(join(process.env.OLIVIA_BROWSER_PROFILE_DIR || tempRoot, "olivia-song-editor-"));
    context = await chromium.launchPersistentContext(profile, launchOptions);
  } else {
    browser = await chromium.launch(launchOptions);
    context = await browser.newContext();
  }
  t.after(async () => { await (browser ? browser.close() : context.close()); if (profile) await rm(profile, { recursive: true, force: true }); });
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  const posts = [];
  await page.route("http://fixture.test/**", async route => {
    const request = route.request();
    if (request.url().endsWith("/metadata")) {
      if (request.method() === "POST") posts.push({ url: request.url(), body: request.postDataJSON() });
      return route.fulfill({ status: request.method() === "POST" && rejectSave ? 409 : 200, contentType: "application/json",
        body: JSON.stringify(request.method() === "POST" && rejectSave
          ? { code: 409, message: "save rejected" }
          : { code: 0, data: request.method() === "POST" ? { ...record, name: "Saved", revision: "2" } : record }) });
    }
    return route.fulfill({ contentType: "text/html", body: "<html><body><button id='outside'>outside</button></body></html>" });
  });
  await page.goto("http://fixture.test/");
  if (hostCss) await page.addStyleTag({ content: hostCss });
  await page.addScriptTag({ content: script });
  assert.equal(await page.evaluate(() => typeof window.OliviaSoulSongEditor?.open), "function", "the real shared editor must expose open");
  await page.evaluate(() => { window.saved = []; window.OliviaSoulSongEditor.open({ baseUrl: "/admin/api", songId: "work/42", onSaved: data => window.saved.push(data) }); });
  await page.getByLabel("显示名称", { exact: true }).waitFor();
  return { page, posts };
}

browserTest("dark compact layout keeps the actions visible with long content and save errors", async t => {
  const long = "原始视频文件名-".repeat(42) + ".mp4";
  const hostCss = `${adminCss}\n:root{--tp-surface-1:#232529;--tp-surface-2:#121214;--tp-grey-4:#51545c;--tp-grey-0:#17181c;--tp-primary-2:#d8cfc4;--tp-text-title:#f1eee9}header{height:76px;margin-bottom:20px}`;
  const record = { ...metadata, originalName: long, variants: Array.from({ length: 8 }, (_, index) => ({ key: `DEFAULT${index}`, filename: `${long}-${index}`, url: "http://fixture.test/video.mp4" })) };
  const { page } = await fixture(t, { rejectSave: true, record, viewport: { width: 410, height: 310 }, hostCss });
  await page.getByLabel("显示名称", { exact: true }).fill("Unsaved");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "save rejected" }).waitFor();
  await page.getByText("视频预览与时段", { exact: true }).click();
  const viewports = [{ width: 820, height: 620 }, { width: 1024, height: 768 }, { width: 683, height: 512 }, { width: 512, height: 384 }, { width: 547, height: 413 }, { width: 410, height: 310 }];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
    const dialog = document.querySelector(".ose-dialog");
    const content = document.querySelector(".ose-dialog__content");
    const actions = document.querySelector(".ose-actions");
    const input = document.querySelector("input");
    const dialogBox = dialog.getBoundingClientRect(), actionBox = actions.getBoundingClientRect(), inputBox = input.getBoundingClientRect();
    const footerTop = actionBox.top;
    content.scrollTop = 50;
    return { dialogClass: dialog.className, contentClass: content?.className || "", dialogBox, actionBox, inputBox,
      contentScrollHeight: content.scrollHeight, contentClientHeight: content.clientHeight, contentScrollTop: content.scrollTop,
      dialogScrollTop: dialog.scrollTop, footerTop, footerTopAfter: actions.getBoundingClientRect().top,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      background: getComputedStyle(dialog).backgroundColor, actionsVisible: actionBox.bottom <= innerHeight && actionBox.top >= 0 };
    });
    assert.match(layout.dialogClass, /ose-dialog/);
    assert.match(layout.contentClass, /ose-dialog__content/, "only the inner editor content may scroll");
    assert.ok(layout.contentScrollHeight > layout.contentClientHeight, `${viewport.width}x${viewport.height} has overflowing inner content`);
    assert.ok(layout.contentScrollTop > 0, `${viewport.width}x${viewport.height} scrolls the inner content`);
    assert.equal(layout.dialogScrollTop, 0, "the dialog shell itself does not scroll");
    assert.equal(layout.footerTopAfter, layout.footerTop, "inner scrolling does not move the action footer");
    assert.equal(layout.horizontalOverflow, false, `${viewport.width}x${viewport.height} has no horizontal overflow`);
    assert.equal(layout.actionsVisible, true, `${viewport.width}x${viewport.height} keeps actions visible`);
    assert.ok(layout.inputBox.right <= layout.dialogBox.right + 1 && layout.inputBox.left >= layout.dialogBox.left - 1);
    assert.equal(layout.background, "rgb(35, 37, 41)");
  }
  const screenshots = process.env.OLIVIA_BROWSER_SCREENSHOT_DIR;
  if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, "song-editor-dark-error-410x310.png"), fullPage: true }); }
});

browserTest("editor uses stable ID, treats names as text and keeps previews collapsed inside the viewport", async t => {
  const { page } = await fixture(t);
  assert.equal(await page.getByLabel("显示名称", { exact: true }).inputValue(), metadata.name);
  assert.equal(await page.locator("[role=dialog] img").count(), 0);
  assert.equal(await page.locator("[role=dialog] details[open]").count(), 0);
  assert.equal(await page.locator("video[autoplay]").count(), 0);
  await page.getByText("显示名称", { exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "ose-display-name", "the display-name label focuses its detached input");
  const box = await page.getByRole("dialog").boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 360 && box.y + box.height <= 640);
  const screenshots = process.env.OLIVIA_BROWSER_SCREENSHOT_DIR;
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.setViewportSize({ width: 820, height: 620 });
    await page.screenshot({ path: join(screenshots, "song-editor-dark-collapsed-820x620.png"), fullPage: true });
  }
  await page.getByText("视频预览与时段", { exact: true }).click();
  assert.equal(await page.getByLabel("白天（TOD12）").inputValue(), "", "DEFAULT indices must not silently bind time slots");
});

browserTest("representative collapsed editor captures the approved game-host dark compact appearance", async t => {
  const record = { ...metadata, name: "月光小夜曲", originalName: "月光小夜曲.mp4", customName: "月光小夜曲" };
  const { page } = await fixture(t, { record, viewport: { width: 820, height: 620 }, hostCss: `html,body{margin:0;background:#17181c;color:#f1eee9;user-select:none}button,input{font:inherit}:root{--tp-surface-1:#232529;--tp-surface-2:#121214;--tp-grey-4:#51545c;--tp-grey-0:#17181c;--tp-primary-2:#d8cfc4;--tp-text-title:#f1eee9}` });
  assert.equal(await page.locator("details[open]").count(), 0);
  const screenshots = process.env.OLIVIA_BROWSER_SCREENSHOT_DIR;
  if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, "song-editor-dark-representative-collapsed-820x620.png"), fullPage: true }); }
});

browserTest("save submits only edited fields to the stable work ID and reports saved metadata", async t => {
  const { page, posts } = await fixture(t);
  await page.getByLabel("显示名称", { exact: true }).fill("New title");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.deepEqual(posts, [{ url: "http://fixture.test/admin/api/media/songs/work%2F42/metadata", body: { name: "New title" } }]);
  assert.equal(await page.evaluate(() => window.saved[0].id), "work/42");
});

browserTest("restore original and confirmed slot changes use null override and selected variant keys", async t => {
  const { page, posts } = await fixture(t);
  await page.getByRole("button", { name: "恢复正式名称" }).click();
  await page.getByText("视频预览与时段", { exact: true }).click();
  await page.getByLabel("白天（TOD12）").selectOption("DEFAULT0");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.deepEqual(posts[0].body, { name: null, timeOfDayMapping: { TOD12: "DEFAULT0", TOD1730: null, TOD20: null } });
});

browserTest("save errors retain the editor and Cancel never submits changes", async t => {
  const { page, posts } = await fixture(t, { rejectSave: true });
  await page.getByLabel("显示名称", { exact: true }).fill("Unsaved");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "save rejected" }).waitFor();
  assert.equal(await page.getByLabel("显示名称", { exact: true }).inputValue(), "Unsaved");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(posts.length, 1);
  assert.equal(await page.evaluate(() => window.saved.length), 0);
});

browserTest("closing releases preview resources without autoplay", async t => {
  const { page, posts } = await fixture(t);
  await page.getByText("视频预览与时段", { exact: true }).click();
  await page.locator("summary").filter({ hasText: `${metadata.variants[0].filename} · DEFAULT0` }).click();
  assert.equal(await page.locator("video[controls]").count(), 1);
  await page.evaluate(() => { window.preview = document.querySelector("video"); window.released = 0; window.preview.load = () => window.released++; });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => ({ src: window.preview.getAttribute("src"), released: window.released })), { src: null, released: 1 });
  assert.equal(posts.length, 0);
});

browserTest("title reconciliation mutates only matching stable IDs without changing playback fields or list identity", async t => {
  const { page } = await fixture(t);
  const result = await page.evaluate(() => {
    const current = { id: "work/42", name: "old", videoUrl: "/toy/midi/songs/work%2F42/video", currentTime: 33, sessionId: "playing" };
    const unrelated = { id: "other", name: "old" };
    const list = [current, unrelated];
    window.OliviaSoulSongEditor.applyMetadata(list, { id: "work/42", name: "New" });
    return { same: list[0] === current, current, unrelated };
  });
  assert.equal(result.same, true);
  assert.equal(result.current.name, "New");
  assert.equal(result.current.currentTime, 33);
  assert.equal(result.current.sessionId, "playing");
  assert.equal(result.current.videoUrl, "/toy/midi/songs/work%2F42/video");
  assert.equal(result.unrelated.name, "old");
});

browserTest("admin and game hosts render identical editor typography and preview geometry", async t => {
  const hostileGameCss = ':root{--tp-font-family:UnavailableCustomFont}*{font-weight:400}body{font-family:serif;font-size:22px}h2{font:32px serif}label{font:24px serif}summary{font-family:serif}button,input,select{line-height:2;font-family:serif}';
  const samples = [];
  for (const hostCss of [adminCss, hostileGameCss]) {
    const { page } = await fixture(t, { hostCss, viewport: { width: 1024, height: 768 } });
    await page.getByText("视频预览与时段", { exact: true }).click();
    await page.locator('.ose-time-settings details summary').first().click();
    samples.push(await page.evaluate(() => {
      const typography = ['.ose-dialog','h2','.ose-name-row label','input','summary','.ose-actions button'].map(selector => {
        const element = document.querySelector('.ose-dialog').querySelector(selector) || document.querySelector(selector);
        const css = getComputedStyle(element);
        return [css.fontFamily, css.fontSize, css.fontWeight, css.lineHeight];
      });
      const video = document.querySelector('video').getBoundingClientRect();
      const controls = [...document.querySelectorAll('.ose-actions button,.ose-name-row button,.ose-name-input')].map(element => element.getBoundingClientRect().height);
      return { typography, controls, width: video.width, height: video.height };
    }));
    await page.getByRole('button', { name: '取消', exact: true }).click();
  }
  assert.deepEqual(samples[0], samples[1]);
  assert.ok(Math.abs(samples[0].width / samples[0].height - 16 / 9) < 0.03);
});
