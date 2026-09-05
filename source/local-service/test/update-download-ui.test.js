import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createUpdateDownloadUI } from '../public/update-download-ui.js';

function fixture(options = {}) {
  const elements = Object.fromEntries(['progress', 'message', 'details', 'button', 'cancel', 'pause'].map(k => [k,
    { textContent: '', hidden: true, disabled: false, value: 0, removeAttribute(name) { delete this[name]; } }]));
  let status = { state: 'idle', bytes: 0 }, reads = 0, starts = 0, prompts = 0, installs = 0;
  const ui = createUpdateDownloadUI({ elements, intervalMs: 10, api: async (url, init) => {
    if (init?.method === 'POST') { starts++; return status; }
    reads++; return status;
  }, confirmInstall: async () => { prompts++; return true; }, install: async () => { installs++; }, ...options });
  ui.setRelease?.({ latestTag: 'test.1', updateAvailable: true });
  return { ui, elements, set: value => { status = value; }, counts: () => ({ reads, starts, prompts, installs }) };
}

test('installed newer version hides old resume progress and cannot prompt or install cached releases', async t => {
  const f = fixture(); t.after(() => f.ui.setVisible(false));
  f.ui.setRelease({ currentTag: '2008.2.7-linli.4', latestTag: '2008.2.7-linli.3', updateAvailable: false });
  for (const state of ['idle', 'paused', 'completed']) {
    f.set({ state, jobId: 'old', tag: '2008.2.7-linli.3', bytes: 100, totalBytes: 100, percent: 100, path: '/old.exe' });
    f.ui.setVisible(true); await f.ui.refresh(); await f.ui.start();
    assert.equal(f.elements.button.hidden, true); assert.equal(f.elements.progress.hidden, true);
  }
  assert.deepEqual({ starts: f.counts().starts, prompts: f.counts().prompts, installs: f.counts().installs }, { starts: 0, prompts: 0, installs: 0 });
});

test('new release check dismisses cancelled message across subsequent status polls', async t => {
  const f = fixture(); t.after(() => f.ui.setVisible(false));
  f.set({ state: 'cancelled', jobId: 'cancelled', bytes: 0 });
  f.ui.setVisible(true); await f.ui.refresh();
  f.ui.setRelease({ currentTag: 'test.1', latestTag: 'test.2', updateAvailable: true });
  await f.ui.refresh(); await f.ui.refresh();
  assert.equal(f.elements.message.textContent, '');
});

test('changing release eligibility while install confirmation is open prevents installation', async t => {
  let confirm;
  const f = fixture({ confirmInstall: () => new Promise(resolve => { confirm = resolve; }) });
  t.after(() => f.ui.setVisible(false));
  f.set({ state: 'completed', jobId: 'one', tag: 'test.1', path: '/cached.exe' });
  f.ui.setVisible(true); const pending = f.ui.refresh();
  while (!confirm) await delay(1);
  f.ui.setRelease({ currentTag: 'test.1', latestTag: 'test.1', updateAvailable: false });
  confirm(true); await pending;
  assert.equal(f.counts().installs, 0);
});

test('renders real progress, speed and retry state without hiding errors', async t => {
  const f = fixture(); t.after(() => f.ui.setVisible(false));
  f.set({ state: 'downloading', running: true, jobId: 'one', bytes: 5242880, totalBytes: 10485760,
    percent: 50, bytesPerSecond: 1048576, remainingSeconds: 5 });
  f.ui.setVisible(true); await f.ui.refresh();
  assert.equal(f.elements.progress.value, 50); assert.equal(f.elements.button.disabled, true);
  assert.match(f.elements.details.textContent, /5\.0.*10\.0.*1\.0.*5/);
  f.set({ state: 'failed', bytes: 5242880, totalBytes: 10485760, percent: 50, error: '网络中断' });
  await f.ui.refresh(); assert.match(f.elements.message.textContent, /网络中断/);
  assert.equal(f.elements.button.disabled, false); assert.match(f.elements.button.textContent, /重试/);
});

test('installation prompt uses specific Chinese actions; deferring never launches installer', async t => {
  let prompt;
  const f = fixture({ confirmInstall: async (message, options) => { prompt = { message, options }; return false; } });
  t.after(() => f.ui.setVisible(false));
  f.set({ state: 'completed', tag: 'test.1', jobId: 'ready', path: '/verified.exe', bytes: 10, totalBytes: 10 });
  f.ui.setVisible(true); await f.ui.refresh();
  assert.equal(prompt.options?.title, '更新已准备就绪');
  assert.equal(prompt.options.confirmText, '立即安装'); assert.equal(prompt.options.cancelText, '稍后安装');
  assert.match(prompt.message, /退出游戏/); assert.match(prompt.message, /校验/);
  assert.equal(f.counts().installs, 0);
});

test('failed installer launch presents Chinese guidance and preserves original error as details', async t => {
  let shown;
  const f = fixture({ install: async () => { throw new Error('EACCES: access denied'); },
    showInstallError: async options => { shown = options; } });
  t.after(() => f.ui.setVisible(false));
  f.set({ state: 'completed', tag: 'test.1', jobId: 'failed-launch', path: '/verified.exe' });
  f.ui.setVisible(true); await f.ui.refresh();
  assert.equal(shown?.title, '无法启动安装程序'); assert.match(shown.message, /权限|安全软件/);
  assert.equal(shown.details, 'EACCES: access denied'); assert.equal(shown.confirmText, '知道了');
  assert.doesNotMatch(f.elements.message.textContent, /EACCES/);
  await f.ui.refresh(); assert.match(f.elements.button.textContent, /校验/);
  await f.ui.start(); assert.equal(f.counts().starts, 1, 'failed launch must allow package revalidation/redownload');
});

test('pause keeps progress visible and Continue resumes without stale polling reactivating download', async t => {
  let reads = 0, oldPoll, starts = 0;
  const f = fixture({ api: async (url, init) => {
    if (url.endsWith('/pause')) { assert.deepEqual(JSON.parse(init.body), { jobId: 'one' });
      return { state: 'paused', jobId: 'one', bytes: 100, totalBytes: 1000, percent: 10 }; }
    if (init?.method === 'POST') { starts++; return { state: 'connecting', jobId: 'two', running: true, bytes: 100, totalBytes: 1000, percent: 10 }; }
    if (++reads > 1) return new Promise(resolve => { oldPoll = resolve; });
    return { state: 'downloading', jobId: 'one', running: true, bytes: 100, totalBytes: 1000, percent: 10 };
  } });
  t.after(() => f.ui.setVisible(false)); f.ui.setVisible(true); await f.ui.refresh();
  assert.equal(f.elements.pause.hidden, false);
  const pending = f.ui.refresh(); await f.ui.pause();
  oldPoll({ state: 'downloading', jobId: 'one', running: true, bytes: 150, totalBytes: 1000, percent: 15 }); await pending;
  assert.equal(f.elements.progress.value, 10); assert.equal(f.elements.progress.hidden, false);
  assert.equal(f.elements.pause.hidden, true); assert.equal(f.elements.cancel.hidden, false);
  assert.match(f.elements.button.textContent, /继续下载/); assert.equal(f.elements.button.disabled, false);
  assert.match(f.elements.message.textContent, /暂停.*保留/);
  await f.ui.start(); assert.equal(starts, 1); assert.equal(f.elements.button.disabled, true);
});

test('cancel clears progress and ignores stale completion without prompting installation', async t => {
  let oldPoll, cancelCalls = 0;
  const f = fixture({ api: async (url, init) => {
    if (url.endsWith('/cancel')) { cancelCalls++; assert.deepEqual(JSON.parse(init.body), { jobId: 'one' });
      return { state: 'cancelled', bytes: 0, totalBytes: 0, running: false }; }
    if (oldPoll) return new Promise(resolve => { oldPoll.resolve = resolve; });
    return { state: 'downloading', running: true, jobId: 'one', bytes: 100, totalBytes: 1000 };
  } });
  t.after(() => f.ui.setVisible(false)); f.ui.setVisible(true); await f.ui.refresh();
  assert.equal(f.elements.cancel.hidden, false);
  oldPoll = {}; const poll = f.ui.refresh(); await f.ui.cancel();
  oldPoll.resolve({ state: 'completed', jobId: 'one', tag: 'test.1', path: '/stale.exe' }); await poll;
  assert.equal(cancelCalls, 1); assert.equal(f.elements.progress.hidden, true);
  assert.equal(f.elements.cancel.hidden, true); assert.equal(f.elements.button.disabled, false);
  assert.match(f.elements.message.textContent, /取消.*删除/); assert.equal(f.counts().installs, 0);
});

test('hidden page stops polling; returning recovers task and confirms installation once', async t => {
  const f = fixture(); t.after(() => f.ui.setVisible(false));
  f.set({ state: 'completed', tag: 'test.1', jobId: 'one', bytes: 10, totalBytes: 10, percent: 100, path: '/verified.exe' });
  f.ui.setVisible(true); await f.ui.refresh(); await delay(25);
  assert.equal(f.counts().prompts, 1); assert.equal(f.counts().installs, 1);
  f.ui.setVisible(false); await delay(15); const count = f.counts().reads;
  await delay(30); assert.equal(f.counts().reads, count);
  f.ui.setVisible(true); await f.ui.refresh(); assert.equal(f.counts().prompts, 1);
});

test('concurrent clicks start only one request and stale hidden responses cannot install', async t => {
  let resolveRequest, calls = 0;
  const f = fixture({ api: () => { calls++; return new Promise(resolve => { resolveRequest = resolve; }); } });
  t.after(() => f.ui.setVisible(false));
  const first = f.ui.start(); const second = f.ui.start();
  assert.equal(calls, 1);
  resolveRequest({ state: 'connecting', running: true }); await Promise.all([first, second]);
  assert.equal(f.elements.button.disabled, true);
  f.ui.setVisible(true); const refresh = f.ui.refresh();
  f.ui.setVisible(false);
  resolveRequest({ state: 'completed', jobId: 'stale', path: '/verified.exe', percent: 100 });
  await refresh; assert.equal(f.counts().installs, 0);
});

test('old status response cannot clear a newly started download', async t => {
  let oldResponse;
  const f = fixture({ api: async (_url, init) => init?.method === 'POST'
    ? { state: 'connecting', running: true, jobId: 'new' }
    : new Promise(resolve => { oldResponse = resolve; }) });
  t.after(() => f.ui.setVisible(false));
  f.ui.setVisible(true); const oldPoll = f.ui.refresh();
  await f.ui.start(); oldResponse({ state: 'idle', bytes: 0 }); await oldPoll;
  assert.equal(f.elements.button.disabled, true, 'stale idle must not overwrite running task');
});

test('checking a newer release offers the new download rather than installing an old cached package', async t => {
  const f = fixture(); t.after(() => f.ui.setVisible(false));
  f.set({ state: 'completed', tag: 'test.1', jobId: 'old', bytes: 10, totalBytes: 10, percent: 100, path: '/old.exe' });
  f.ui.setVisible(true);
  await f.ui.refresh();
  f.ui.setRelease({ latestTag: 'test.2', updateAvailable: true });
  await f.ui.refresh(); await f.ui.start();
  assert.equal(f.counts().starts, 1, 'new release must take download path');
  assert.equal(f.counts().installs, 1, 'must not reinstall old package after selecting new release');
});
