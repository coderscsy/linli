import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/song-editor.js", import.meta.url), "utf8").catch(() => "");
// DOM/event/media transport boundary only; all editor rendering and commands are real.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.attributes = {}; this.listeners = {}; this.value = ""; this.textContent = ""; this.disabled = false; this.open = false; }
  set innerHTML(_) { throw new Error("editor must not render untrusted HTML"); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; if (name === "src") this.src = ""; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
  removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] ?? []).filter(item => item !== handler); }
  async emit(type, extra = {}) { for (const handler of this.listeners[type] ?? []) await handler({ target: this, preventDefault() {}, stopPropagation() {}, ...extra }); }
  focus() {}
  pause() { this.pauses = (this.pauses ?? 0) + 1; }
  load() { this.loads = (this.loads ?? 0) + 1; }
}
function walk(node) { return [node, ...node.children.flatMap(walk)]; }
const record = { id: "stable/id", name: "<img src=x onerror=alert(1)>", originalName: "Original", customName: "Old", revision: "1",
  variants: [{ key: "DEFAULT0", filename: "<b>part.mp4</b>", url: "/toy/midi/songs/stable%2Fid/video?variant=DEFAULT0", tod: null, view: null }],
  mapping: { TOD12: null, TOD1730: null, TOD20: null }, mappingStatus: "unconfirmed" };
async function fixture({ failSave = false, metadata = record, saveResult = {}, saveGate = null } = {}) {
  const document = new Element("document");
  document.body = new Element("body"); document.head = new Element("head"); document.activeElement = null;
  document.createElement = tag => new Element(tag);
  document.getElementById = id => [...walk(document.body), ...walk(document.head)].find(node => node.id === id);
  const requests = [], saved = [], events = [], saveLifecycle = [], timers = new Map();
  let timerId = 0;
  const window = { document, location: { href: "http://fixture.test/admin/" },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    dispatchEvent(event) { events.push(event); saveLifecycle.push({ type: "event", dialogOpen: walk(document.body).some(node => node.attributes.role === "dialog") }); } };
  const context = vm.createContext({ window, document, URL, AbortController, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, console,
    fetch: async (url, options = {}) => { requests.push({ url, ...options }); if (options.method === "POST" && saveGate) await saveGate; return { ok: !failSave || options.method !== "POST", json: async () => failSave && options.method === "POST"
      ? { code: 409, message: "save rejected" } : { code: 0, data: options.method === "POST" ? { ...metadata, name: "Saved", revision: "2", ...saveResult } : metadata } }; } });
  vm.runInContext(source, context);
  assert.equal(typeof window.OliviaSoulSongEditor?.open, "function", "shared editor API is implemented");
  const handle = window.OliviaSoulSongEditor.open({ baseUrl: "/admin/api", songId: "stable/id", onSaved: data => {
    saved.push(data); saveLifecycle.push({ type: "onSaved", dialogOpen: walk(document.body).some(node => node.attributes.role === "dialog") });
  } });
  await handle.ready;
  const all = () => walk(document.body);
  return { window, document, requests, saved, events, saveLifecycle, timers, handle, all, field: label => all().find(node => node.attributes["aria-label"] === label), button: name => all().find(node => node.tagName === "button" && node.textContent === name) };
}

test("open uses stable ID and text nodes, with no automatic variant binding or preview playback", async () => {
  const f = await fixture();
  assert.equal(f.requests[0].url, "/admin/api/media/songs/stable%2Fid/metadata");
  assert.equal(f.field("显示名称").value, record.name);
  assert.equal(f.field("白天（TOD12）").value, "");
  assert.equal(f.all().filter(node => node.tagName === "details" && node.open).length, 0);
  assert.equal(f.all().filter(node => node.tagName === "video" && node.autoplay).length, 0);
});
test("save sends only changed metadata and publishes the stable ID without replaying", async () => {
  const f = await fixture(); f.field("显示名称").value = "New"; await f.field("显示名称").emit("input");
  await f.button("保存").emit("click");
  assert.deepEqual(JSON.parse(f.requests[1].body), { name: "New" });
  assert.equal(f.saved[0].id, "stable/id");
  assert.equal(f.events[0].detail.id, "stable/id");
  assert.equal(f.document.body.children.length, 0);
});
test("restore and explicit mapping emit null override and exact selected keys", async () => {
  const f = await fixture(); await f.button("恢复正式名称").emit("click");
  f.field("白天（TOD12）").value = "DEFAULT0"; await f.field("白天（TOD12）").emit("change");
  await f.button("保存").emit("click");
  assert.deepEqual(JSON.parse(f.requests[1].body), { name: null, timeOfDayMapping: { TOD12: "DEFAULT0", TOD1730: null, TOD20: null } });
});
test("failed save retains edits and cancel releases previews without another write", async () => {
  const f = await fixture({ failSave: true }); f.field("显示名称").value = "Unsaved"; await f.field("显示名称").emit("input");
  await f.button("保存").emit("click");
  assert.equal(f.all().find(node => node.attributes.role === "alert").textContent, "save rejected");
  const video = f.all().find(node => node.tagName === "video");
  await f.button("取消").emit("click");
  assert.equal(f.requests.length, 2); assert.equal(f.saved.length, 0); assert.equal(video.loads, 1); assert.equal(video.getAttribute("src"), null);
});
test("reconcile mutates matching records by ID only and preserves media/session/progress", async () => {
  const f = await fixture(); const item = { itemId: "playlist-entry", videoUrl: "/toy/midi/songs/stable%2Fid/video", name: "Old", sessionId: "playing", progress: 42 };
  const unrelated = { id: "unrelated", name: "Old" }; const items = [item, unrelated];
  f.window.OliviaSoulSongEditor.applyMetadata(items, { id: "stable/id", name: "New" });
  assert.equal(items[0], item); assert.equal(item.name, "New"); assert.equal(unrelated.name, "Old"); assert.equal(item.sessionId, "playing"); assert.equal(item.progress, 42);
});

test("blank names remain a validation error and never silently restore the original name", async () => {
  const f = await fixture();
  f.field("显示名称").value = "   "; await f.field("显示名称").emit("input");
  await f.button("保存").emit("click");
  assert.equal(f.requests.length, 1, "only the metadata GET is allowed for an empty name");
  assert.equal(f.saved.length, 0);
  assert.ok(f.all().find(node => node.attributes.role === "alert").textContent);
  assert.equal(f.field("显示名称").value, "   ", "validation must not rewrite input to the original name");
});

test("collapsing all time settings releases hidden previews and lets them reload on reopening", async () => {
  const f = await fixture();
  const [outer, inner] = f.all().filter(node => node.tagName === "details");
  const video = f.all().find(node => node.tagName === "video");
  outer.open = true; await outer.emit("toggle"); inner.open = true; await inner.emit("toggle");
  assert.ok(video.src?.includes("variant=DEFAULT0"));
  outer.open = false; await outer.emit("toggle");
  assert.equal(video.src, "", "a hidden preview must relinquish its media source");
  assert.ok(video.pauses > 0); assert.ok(video.loads > 0); assert.equal(inner.open, false);
  outer.open = true; await outer.emit("toggle"); inner.open = true; await inner.emit("toggle");
  assert.ok(video.src?.includes("variant=DEFAULT0"), "the user can preview the same file again after expanding it");
});

test("opening a preview requests metadata without autoplay", async () => {
  const f = await fixture();
  const [outer, preview] = f.all().filter(node => node.tagName === "details");
  const video = f.all().find(node => node.tagName === "video");
  outer.open = true; await outer.emit("toggle"); preview.open = true; await preview.emit("toggle");
  assert.equal(video.preload, "metadata");
  assert.equal(video.loads, 1);
  assert.equal(video.autoplay, undefined);
});

test("a failed preview tells the operator which clip failed and can retry", async () => {
  const f = await fixture();
  const [outer, preview] = f.all().filter(node => node.tagName === "details");
  const video = f.all().find(node => node.tagName === "video");
  outer.open = true; await outer.emit("toggle"); preview.open = true; await preview.emit("toggle");
  await video.emit("error");
  assert.match(f.all().find(node => node.attributes.role === "alert").textContent, /part\.mp4.*无法预览.*重试/u);
  const retry = f.button("重试预览");
  assert.ok(retry);
  await retry.emit("click");
  assert.equal(video.loads, 2);
  assert.ok(video.src?.includes("variant=DEFAULT0"));
});

test("collapsed or closed previews ignore delayed media errors", async () => {
  const f = await fixture();
  const [outer, preview] = f.all().filter(node => node.tagName === "details");
  const video = f.all().find(node => node.tagName === "video");
  const alert = f.all().find(node => node.attributes.role === "alert");
  outer.open = true; await outer.emit("toggle"); preview.open = true; await preview.emit("toggle");
  await video.emit("error");
  assert.match(alert.textContent, /无法预览/u);
  preview.open = false; await preview.emit("toggle");
  assert.equal(alert.textContent, "");
  preview.open = true; await preview.emit("toggle");
  f.handle.close();
  await video.emit("error");
  assert.equal(alert.textContent, "");
});

test("duplicate video filenames remain distinguishable by stable variant key in previews and selectors", async () => {
  const f = await fixture({ metadata: { ...record, variants: [
    { key: "DEFAULT0", filename: "video.mp4", url: "/first.mp4" },
    { key: "ALT1", filename: "video.mp4", url: "/second.mp4" },
  ] } });
  const summaries = f.all().filter(node => node.tagName === "summary").map(node => node.textContent);
  assert.ok(summaries.includes("video.mp4 · DEFAULT0")); assert.ok(summaries.includes("video.mp4 · ALT1"));
  const options = f.field("白天（TOD12）").children;
  assert.equal(options[1].textContent, "video.mp4 · DEFAULT0"); assert.equal(options[1].value, "DEFAULT0");
  assert.equal(options[2].textContent, "video.mp4 · ALT1"); assert.equal(options[2].value, "ALT1");
  assert.equal(f.field("白天（TOD12）").value, "");
});

test("title length validation counts Unicode code points and rejects more than 200 without saving", async () => {
  const long = await fixture(); long.field("显示名称").value = "🎵".repeat(201); await long.field("显示名称").emit("input");
  await long.button("保存").emit("click");
  assert.equal(long.requests.length, 1); assert.ok(long.all().find(node => node.attributes.role === "alert").textContent);
  long.handle.close();
  const valid = await fixture(); valid.field("显示名称").value = "🎵".repeat(200); await valid.field("显示名称").emit("input");
  await valid.button("保存").emit("click");
  assert.equal([...JSON.parse(valid.requests[1].body).name].length, 200);
});

test("permanent save is explicit and never sends media paths or inferred time slots", async () => {
  const f = await fixture();
  f.field("显示名称").value = "Correct song"; await f.field("显示名称").emit("input");
  assert.ok(f.button("永久保存曲名"), "permanent correction has a distinct action");
  await f.button("永久保存曲名").emit("click");
  assert.deepEqual(JSON.parse(f.requests[1].body), { permanentName: "Correct song" });
  assert.equal(f.document.body.children.length, 0);
});

test("restore uses corrected canonical title instead of a wrong imported title", async () => {
  const f = await fixture({ metadata: { ...record, correctedName: "Correct song" } });
  await f.button("恢复正式名称").emit("click");
  assert.equal(f.field("显示名称").value, "Correct song");
  await f.button("保存").emit("click");
  assert.deepEqual(JSON.parse(f.requests[1].body), { name: null });
});

test("failed correction projection keeps editor open, reports saved DB value and allows retry", async () => {
  const f = await fixture({ saveResult: { name: "Correct song", correctedName: "Correct song", nameSync: { state: "failed", error: "correction file unavailable" } } });
  f.field("显示名称").value = "Correct song"; await f.field("显示名称").emit("input");
  await f.button("永久保存曲名").emit("click");
  assert.equal(f.document.body.children.length, 1);
  assert.equal(f.saved[0].correctedName, "Correct song", "labels reflect the already-saved DB value without playback commands");
  const alert = f.all().find(node => node.attributes.role === "alert").textContent;
  assert.match(alert, /名称已保存，仍有同步项目未完成/);
  assert.match(alert, /correction file unavailable/);
  assert.doesNotMatch(alert, /但纠正记录尚未同步/);
  assert.equal(f.field("显示名称").value, "Correct song");
  assert.equal(f.button("永久保存曲名").disabled, false);
  await f.button("永久保存曲名").emit("click");
  assert.equal(f.requests.length, 3);
  assert.deepEqual(JSON.parse(f.requests[2].body), { permanentName: "Correct song" });
});

test("pending permanent save publishes the persisted title then closes with a nonblocking status and no polling", async () => {
  const f = await fixture({ saveResult: { name: "Correct song", correctedName: "Correct song", nameSync: { state: "pending", error: null } } });
  const video = f.all().find(node => node.tagName === "video");
  f.field("显示名称").value = "Correct song";
  f.field("白天（TOD12）").value = "DEFAULT0"; await f.field("白天（TOD12）").emit("change");
  await f.button("永久保存曲名").emit("click");
  await nextTurn();
  assert.deepEqual(f.saveLifecycle, [{ type: "onSaved", dialogOpen: true }, { type: "event", dialogOpen: true }]);
  assert.equal(f.saved[0].correctedName, "Correct song");
  assert.equal(f.events[0].type, "oliviasoul-song-metadata");
  assert.equal(f.all().some(node => node.attributes.role === "dialog"), false);
  const notice = f.all().find(node => node.attributes.role === "status");
  assert.ok(notice, "persisted pending saves leave a status announcement after closing");
  assert.match(notice.textContent, /曲名已永久保存.*旧版视频匹配信息正在后台补全/);
  assert.equal(f.all().some(node => node.attributes.role === "alert"), false);
  assert.equal(f.requests.length, 2, "background enrichment is server-owned, not UI polling");
  assert.deepEqual(JSON.parse(f.requests[1].body), { permanentName: "Correct song", timeOfDayMapping: { TOD12: "DEFAULT0", TOD1730: null, TOD20: null } });
  assert.equal(video.autoplay, undefined);
  assert.equal(video.src, "");
  assert.equal(f.timers.size, 1);
  const [{ callback, delay }] = f.timers.values();
  assert.ok(delay > 0 && delay <= 10000, "the saved notice expires shortly without blocking interaction");
  callback();
  assert.equal(f.document.body.children.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.requests.length, 2);
});

test("reopening clears the previous pending notice and its timer without removing a newer save notice", async () => {
  const f = await fixture({ saveResult: { nameSync: { state: "pending", error: null } } });
  await f.button("永久保存曲名").emit("click");
  assert.equal(f.timers.size, 1);
  const staleCallback = [...f.timers.values()][0].callback;
  const reopened = f.window.OliviaSoulSongEditor.open({ baseUrl: "/admin/api", songId: "stable/id" });
  assert.equal(f.timers.size, 0);
  assert.equal(f.all().some(node => node.className === "ose-toast"), false);
  await reopened.ready;
  await f.button("永久保存曲名").emit("click");
  const currentNotice = f.all().find(node => node.attributes.role === "status");
  assert.ok(currentNotice);
  staleCallback();
  assert.equal(f.all().find(node => node.attributes.role === "status"), currentNotice);
  assert.equal(f.timers.size, 1);
});

test("opening pending metadata explains background work as information without an error or automatic retry", async () => {
  const f = await fixture({ metadata: { ...record, correctedName: "Correct song", nameSync: { state: "pending", error: null } } });
  const information = f.all().find(node => node.attributes.role === "status" && node.textContent);
  assert.ok(information, "pending metadata must explain which work remains");
  assert.match(information.textContent, /曲名已永久保存.*旧版视频匹配信息正在后台补全/);
  assert.equal(f.all().find(node => node.attributes.role === "alert").textContent, "");
  assert.equal(f.requests.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.button("永久保存曲名").disabled, false);
});

test("opening a failed partial sync retains the saved name and describes retry without implying JSON was never saved", async () => {
  const f = await fixture({ metadata: { ...record, name: "Correct song", correctedName: "Correct song", nameSync: { state: "failed", error: "legacy identity unavailable <b>retry</b>" } } });
  const alert = f.all().find(node => node.attributes.role === "alert").textContent;
  assert.match(alert, /名称已保存，仍有同步项目未完成/);
  assert.match(alert, /legacy identity unavailable <b>retry<\/b>/);
  assert.match(alert, /永久保存曲名.*重试/);
  assert.doesNotMatch(alert, /纠正记录尚未同步/);
  assert.equal(f.field("显示名称").value, "Correct song");
  await f.button("永久保存曲名").emit("click");
  assert.deepEqual(JSON.parse(f.requests[1].body), { permanentName: "Correct song" });
});

test("an in-flight permanent save shows busy state, prevents duplicate writes and restores retry controls on failure", async () => {
  let completeSave;
  const saveGate = new Promise(resolve => { completeSave = resolve; });
  const f = await fixture({ saveGate, saveResult: { nameSync: { state: "failed", error: "legacy identity unavailable" } } });
  const permanent = f.button("永久保存曲名");
  const saving = permanent.emit("click");
  assert.match(permanent.textContent, /正在保存/);
  assert.equal(permanent.disabled, true);
  assert.equal(f.field("显示名称").disabled, true);
  await permanent.emit("click");
  f.handle.close();
  assert.equal(f.requests.length, 2);
  assert.ok(f.all().some(node => node.attributes.role === "dialog"));
  completeSave(); await saving;
  assert.equal(f.button("永久保存曲名"), permanent);
  assert.equal(permanent.disabled, false);
  assert.equal(f.field("显示名称").disabled, false);
});

test("preview loading status is visible until metadata arrives and is cleared on collapse", async () => {
  const f = await fixture();
  const [outer, preview] = f.all().filter(node => node.tagName === "details");
  const video = f.all().find(node => node.tagName === "video");
  outer.open = true; await outer.emit("toggle"); preview.open = true; await preview.emit("toggle");
  const progress = f.all().find(node => node.className === "ose-preview-status");
  assert.ok(progress); assert.match(progress.textContent, /正在加载/);
  await video.emit("loadedmetadata"); assert.equal(progress.textContent, "");
  preview.open = false; await preview.emit("toggle"); assert.equal(progress.textContent, "");
});
