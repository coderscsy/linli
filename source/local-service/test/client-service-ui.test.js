import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createUpdateDownloadUI } from "../public/update-download-ui.js";
import { createTabNotices } from "../public/tab-notices.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const mounted = { clientSelected: true, clientFound: true, clientExe: "fixture.exe", mounted: true,
  feappMounted: true, webplayerFound: true, webplayerMounted: true, port: 28111, servicePort: 28111 };
const stopped = { ...mounted, mounted: false, feappMounted: false, webplayerMounted: false };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(bridge = {}) {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, { hidden: true, disabled: false, value: "28111", textContent: "", className: "", dataset: {},
        handlers: new Map(), style: {}, focus() {}, setAttribute() {},
        classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
          toggle: (value, force) => force ? classes.add(value) : classes.delete(value) },
        addEventListener(type, handler) { this.handlers.set(type, handler); },
      });
    }
    return nodes.get(selector);
  };
  const timers = new Map();
  let now = 0, nextTimer = 0;
  const context = vm.createContext({
    window: { addEventListener() {}, oliviaDesktop: {
      getSettings: async () => ({ autoStart: false, port: 28111 }),
      getClientStatus: async () => mounted,
      mountClient: async () => mounted, restoreClient: async () => stopped, ...bridge,
    } },
    document: { querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    console, URL, AbortController, createUpdateDownloadUI, createTabNotices,
    fetch: () => { throw new Error("No real HTTP requests in client UI tests"); },
    requestAnimationFrame: callback => callback(),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval() {}, clearInterval() {},
  });
  // Run the actual module and registered handlers; only omit unrelated page startup requests.
  const bootstrap = app.lastIndexOf("Promise.all([refresh(), loadDesktopSettings()])");
  assert.ok(bootstrap > 0, "fixture must isolate admin startup from real services");
  vm.runInContext(app.slice(0, bootstrap).replace(/^import .*\r?\n/gmu, ""), context);
  context.initialStatus = mounted;
  vm.runInContext("renderClientMountStatus(initialStatus)", context);
  const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
  return {
    node, context, flush,
    click: selector => node(selector).handlers.get("click")({ target: node(selector) }),
    render(status) { context.testStatus = status; vm.runInContext("renderClientMountStatus(testStatus)", context); },
    refresh: () => vm.runInContext("loadDesktopSettings()", context),
    async advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await flush();
    },
  };
}

async function confirmRestore(f) {
  const completion = f.click("#restoreClient");
  await f.flush();
  if (!f.node("#noticeLayer").hidden) f.click("#noticeConfirm");
  await f.flush();
  return { completion };
}

test("restore rejection replaces running text, clears the spinner and preserves only a concise safe error", async () => {
  const f = fixture({ restoreClient: async () => { throw new Error("未找到原版备份 token=TEST_SECRET\nprivate diagnostic details"); } });
  const { completion } = await confirmRestore(f);
  await completion;
  const result = f.node("#serviceMountResult");
  assert.match(result.textContent, /停用失败.*未找到原版备份/u);
  assert.doesNotMatch(result.textContent, /正在|TEST_SECRET|private diagnostic/u);
  assert.equal(result.classList.contains("loadingShine"), false);
  assert.equal(f.node("#mountService").disabled, false);
  assert.equal(f.node("#restoreClient").disabled, false);
});

test("enable rejection has its own visible terminal error and never leaves the enable spinner", async () => {
  const f = fixture({ mountClient: async () => { throw new Error("客户端文件被占用"); } });
  await f.click("#mountService");
  assert.match(f.node("#serviceMountResult").textContent, /启用失败.*客户端文件被占用/u);
  assert.equal(f.node("#serviceMountResult").classList.contains("loadingShine"), false);
  assert.equal(f.node("#mountService").disabled, false);
});

test("restore reports stopped only when both verified clients are unmounted", async () => {
  const f = fixture({ getClientStatus: async () => stopped });
  const { completion } = await confirmRestore(f);
  await completion;
  assert.equal(f.node("#serviceMountResult").textContent, "服务已停用");
  assert.equal(f.node("#serviceMountStatus").textContent, "服务未挂载");
  assert.equal(f.node("#serviceMountResult").classList.contains("loadingShine"), false);
  assert.equal(f.node("#mountService").disabled, false);
});

test("partial or unverified client status cannot be reported as fully stopped", async () => {
  for (const status of [
    { ...stopped, feappMounted: true },
    { ...stopped, webplayerMounted: true },
    { ...stopped, feappMounted: undefined },
    { ...stopped, clientFound: false },
  ]) {
    const f = fixture({ restoreClient: async () => status, getClientStatus: async () => status });
    const { completion } = await confirmRestore(f);
    await completion;
    assert.doesNotMatch(f.node("#serviceMountResult").textContent, /服务已停用/u);
    assert.match(f.node("#serviceMountResult").textContent, /未完成|未确认/u);
    assert.equal(f.node("#serviceMountResult").classList.contains("loadingShine"), false);
    if (status.feappMounted === true || status.webplayerMounted === true)
      assert.equal(f.node("#restoreClient").hidden, false, "partial mount must retain its restore action");
  }
});

test("a pending write suppresses duplicate and conflicting clicks even if status is rendered", async () => {
  const write = deferred();
  let restores = 0, mounts = 0;
  const f = fixture({ restoreClient: () => { restores++; return write.promise; }, mountClient: async () => { mounts++; return mounted; } });
  const { completion } = await confirmRestore(f);
  f.render(mounted);
  assert.equal(f.node("#mountService").disabled, true);
  assert.equal(f.node("#restoreClient").disabled, true);
  assert.equal(f.node("#selectClient").disabled, true);
  await confirmRestore(f);
  f.click("#mountService");
  await f.flush();
  assert.equal(restores, 1);
  assert.equal(mounts, 0);
  write.resolve(stopped);
  await completion;
});

test("the 120-second timeout stops waiting but protects an unknown write until its original promise settles", async () => {
  const write = deferred();
  let restores = 0, mounts = 0, finished = false;
  const f = fixture({ restoreClient: () => { restores++; return write.promise; }, mountClient: async () => { mounts++; return mounted; } });
  const { completion } = await confirmRestore(f);
  completion.then(() => { finished = true; });
  await f.advance(119_999);
  assert.equal(finished, false);
  assert.equal(f.node("#serviceMountResult").classList.contains("loadingShine"), true);
  await f.advance(1);
  assert.equal(finished, true, "desktop wait must return at the 120-second boundary");
  assert.match(f.node("#serviceMountResult").textContent, /超时.*结果.*未.*确认/u);
  assert.match(f.node("#serviceMountResult").textContent, /请勿重复/u);
  assert.doesNotMatch(f.node("#serviceMountResult").textContent, /正在|已停用|已取消/u);
  assert.equal(f.node("#serviceMountResult").classList.contains("loadingShine"), false);
  f.render(mounted);
  assert.equal(f.node("#mountService").disabled, true);
  assert.equal(f.node("#restoreClient").disabled, true);
  await confirmRestore(f);
  await f.click("#mountService");
  assert.equal(restores, 1);
  assert.equal(mounts, 0);
  write.reject(new Error("原操作已明确失败"));
  await f.flush();
  assert.match(f.node("#serviceMountResult").textContent, /停用失败.*原操作已明确失败/u);
  assert.equal(f.node("#mountService").disabled, false);
  assert.equal(f.node("#restoreClient").disabled, false);
});

test("a late original success reconciles a timed-out action without replaying the write", async () => {
  const write = deferred();
  const f = fixture({ restoreClient: () => write.promise, getClientStatus: async () => stopped });
  await confirmRestore(f);
  await f.advance(120_000);
  assert.match(f.node("#serviceMountResult").textContent, /超时/u);
  write.resolve(stopped);
  await f.flush();
  assert.equal(f.node("#serviceMountResult").textContent, "服务已停用");
  assert.equal(f.node("#mountService").disabled, false);
});

test("a status request made before restore cannot overwrite the completed operation when it arrives late", async () => {
  const oldStatus = deferred();
  const f = fixture({ getClientStatus: () => oldStatus.promise });
  const refresh = f.refresh();
  await f.flush();
  const { completion } = await confirmRestore(f);
  await completion;
  oldStatus.resolve(mounted);
  await refresh;
  await f.flush();
  assert.equal(f.node("#serviceMountStatus").textContent, "服务未挂载");
  assert.equal(f.node("#serviceMountResult").textContent, "服务已停用");
});

test("an old failure refresh cannot overwrite a newer successful enable", async () => {
  const oldStatus = deferred();
  const f = fixture({ getClientStatus: () => oldStatus.promise, restoreClient: async () => { throw new Error("restore failed"); } });
  const { completion } = await confirmRestore(f);
  await completion;
  await f.click("#mountService");
  oldStatus.resolve(stopped);
  await f.flush();
  assert.equal(f.node("#serviceMountStatus").textContent, "服务已挂载");
  assert.match(f.node("#serviceMountResult").textContent, /服务已启用/u);
});

test("a status-only refresh allows a backend retry then ignores a later stale response", async () => {
  const oldStatus = deferred();
  const f = fixture({ getClientStatus: () => oldStatus.promise });
  let finished = false;
  const refresh = f.refresh().then(() => { finished = true; });
  await f.flush();
  await f.advance(34_999);
  assert.equal(finished, false);
  await f.advance(1);
  assert.equal(finished, true);
  assert.match(f.node("#serviceMountResult").textContent, /状态.*超时/u);
  oldStatus.resolve(stopped);
  await refresh;
  await f.flush();
  assert.equal(f.node("#serviceMountStatus").textContent, "服务已挂载");
});

test("legacy managed archives display upgrade versions rather than contradictory partial state", () => {
  const f = fixture();
  f.render({ ...mounted, mounted: false, updateAvailable: true, revision: "v31", feappRevision: "v31", webplayerRevision: "v13" });
  assert.match(f.node("#serviceMountDetail").textContent, /v31.*v13.*更新/u);
  assert.doesNotMatch(f.node("#serviceMountDetail").textContent, /状态不一致/u);
  assert.match(f.node("#serviceMountStatus").textContent, /待更新/u);
  assert.equal(f.node("#mountService").hidden, false);
});

test("enable cannot claim success when old managed patches remain", async () => {
  const old = { ...mounted, mounted: false, updateAvailable: true };
  const f = fixture({ mountClient: async () => old });
  await f.click("#mountService");
  assert.match(f.node("#serviceMountResult").textContent, /未完成/u);
});

test("model checking shows historical availability and refreshes to terminal state without probing", async () => {
  const f = fixture();
  const calls = [];
  f.context.statusApi = async path => {
    calls.push(path);
    return { provider: "local", model: "test-model", state: "available", error: null };
  };
  vm.runInContext('api = statusApi; renderModelRuntime({ provider: "local", model: "test-model", state: "checking", lastCheck: { state: "available", checkedAt: 1000 } })', f.context);
  assert.match(f.node("#activeModelProvider").textContent, /上次检测可用.*后台/u);
  await f.advance(1500);
  assert.match(f.node("#activeModelProvider").textContent, /· 可用$/u);
  await f.advance(10000);
  assert.deepEqual(calls, ["/admin/api/model/status"]);
});

test("late model poll cannot replace a newly verified configuration", async () => {
  const f = fixture();
  const pending = deferred();
  let reads = 0;
  f.context.statusApi = () => { reads++; return pending.promise; };
  vm.runInContext('api = statusApi; renderModelRuntime({ state: "checking" })', f.context);
  await f.advance(1500);
  assert.equal(reads, 1);
  vm.runInContext('renderModelRuntime({ state: "available" })', f.context);
  pending.resolve({ state: "unavailable" });
  await f.flush();
  assert.match(f.node("#activeModelProvider").textContent, /· 可用$/u);
});

test("model fault dot survives viewing and checking, then clears on recovery", () => {
  const f = fixture();
  const button = f.node('.sideTab[data-tab="ai"]');
  vm.runInContext('renderModelRuntime({ state: "checking" })', f.context);
  assert.equal(button.dataset.noticeKind, undefined);
  vm.runInContext('renderModelRuntime({ state: "unavailable" }); tabNotices.visit("ai")', f.context);
  assert.equal(button.dataset.noticeKind, 'fault');
  assert.match(button.title, /模型连接失败/u);
  vm.runInContext('renderModelRuntime({ state: "checking" })', f.context);
  assert.equal(button.dataset.noticeKind, 'fault');
  vm.runInContext('renderModelRuntime({ state: "available" })', f.context);
  assert.equal(button.dataset.noticeKind, undefined);
});
