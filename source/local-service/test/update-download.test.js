import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, open, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createUpdateDownloader } from '../update-download.js';

async function until(fn) {
  for (let i = 0; i < 500; i++) { const value = fn(); if (value) return value; await delay(10); }
  throw new Error('Download did not settle');
}
const payload = Buffer.alloc(65536, 42);
async function fixture(t, handler, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'olivia-update-'));
  const requests = [];
  const server = createServer((req, res) => { requests.push(req.headers); handler(req, res, requests.length); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/Setup.exe`;
  const release = { latestTag: 'test.1', asset: { id: 1, name: 'OliviaSoul-Test-Setup.exe', url,
    size: payload.length, digest: `sha256:${createHash('sha256').update(payload).digest('hex')}` } };
  const managers = [];
  let releaseCalls = 0;
  const make = async () => {
    const manager = await createUpdateDownloader({ root, request: fetch,
      fetchRelease: async () => { releaseCalls++; return release; }, ...options });
    managers.push(manager); return manager;
  };
  t.after(async () => { for (const m of managers) await m.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, requests, release, make, releaseCalls: () => releaseCalls };
}
const terminal = m => until(() => !m.status().running && ['failed', 'completed'].includes(m.status().state) && m.status());

test('install preparation rejects obsolete versions and modified packages', async t => {
  let eligible = true;
  const f = await fixture(t, (_req, res) => res.end(payload), { canInstall: () => eligible });
  const m = await f.make(); m.start(); const done = await terminal(m);
  assert.deepEqual(await m.prepareInstall(done.path), { path: done.path });
  eligible = false;
  await assert.rejects(m.prepareInstall(done.path), /版本/);
  eligible = true;
  await writeFile(done.path, Buffer.alloc(payload.length, 43));
  await assert.rejects(m.prepareInstall(done.path), /校验/);
});

test('pause preserves exact bytes and restart stays paused until explicit Range resume', async t => {
  const f = await fixture(t, (req, res) => {
    if (!req.headers.range) { res.writeHead(200, { 'Content-Length': payload.length, ETag: '"pause"' }); res.write(payload.subarray(0, 8192)); }
    else { res.writeHead(206, { 'Content-Range': `bytes 8192-${payload.length-1}/${payload.length}`, ETag: '"pause"' }); res.end(payload.subarray(8192)); }
  });
  const m = await f.make(), first = m.start(); await until(() => m.status().bytes === 8192);
  const pausing = m.pause(first.jobId); assert.equal(m.start().jobId, first.jobId);
  const paused = await pausing;
  assert.equal(paused.state, 'paused'); assert.equal(paused.bytes, 8192); assert.equal(paused.running, false);
  assert.equal(paused.error, null); assert.equal(paused.bytesPerSecond, 0);
  await m.close(); const restarted = await f.make(); assert.equal(restarted.status().state, 'paused');
  assert.equal(restarted.status().bytes, 8192); assert.equal(f.requests.length, 1);
  restarted.start(); const done = await terminal(restarted);
  assert.equal(done.state, 'completed', done.error); assert.deepEqual(await readFile(done.path), payload);
  assert.equal(f.requests[1].range, 'bytes=8192-'); assert.equal(f.requests[1]['if-range'], '"pause"');
  await assert.rejects(restarted.pause(first.jobId), /任务/);
});

test('cancel during pause is serialized and deletes preserved partial files', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': payload.length }); res.write(payload.subarray(0, 4096)); });
  const m = await f.make(), first = m.start(); await until(() => m.status().bytes === 4096);
  const pausing = m.pause(first.jobId), cancelling = m.cancel(first.jobId);
  await pausing; const done = await cancelling;
  assert.equal(done.state, 'cancelled'); assert.equal(done.bytes, 0);
  assert.equal((await readdir(f.root, { recursive: true })).some(p => p.endsWith('.part') || p.endsWith('partial.json')), false);
});

test('pause before first network request stays paused after reopening with zero bytes', async t => {
  const f = await fixture(t, (_req, res) => res.end(payload));
  const m = await f.make(), first = m.start(); const paused = await m.pause(first.jobId);
  assert.equal(paused.state, 'paused'); assert.equal(paused.bytes, 0);
  assert.equal(f.releaseCalls(), 0); await m.close();
  const reopened = await f.make(); assert.equal(reopened.status().state, 'paused');
  assert.equal(reopened.status().bytes, 0);
});

test('startup speed waits for a meaningful sample instead of dividing first chunk by milliseconds', async t => {
  let clock = 0;
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': payload.length }); res.write(payload.subarray(0, 4096)); }, { now: () => clock });
  const m = await f.make(); m.start(); await until(() => m.status().bytes === 4096);
  assert.equal(m.status().bytesPerSecond, 0); assert.equal(m.status().remainingSeconds, null);
  clock = 1000; assert.equal(m.status().bytesPerSecond, 4096);
  clock = 6000; assert.equal(m.status().bytesPerSecond, 0);
});

test('cancelling a cached-package recheck never deletes a previously completed installer', async t => {
  const f = await fixture(t, (_req, res) => res.end(payload));
  const m = await f.make(); m.start(); const completed = await terminal(m);
  const started = m.start(); await Promise.resolve(); await Promise.resolve();
  await m.cancel(started.jobId);
  assert.deepEqual(await readFile(completed.path), payload);
});

test('explicit cancellation deletes current partial and resume metadata, then retries from zero', async t => {
  const f = await fixture(t, (_req, res, n) => {
    res.writeHead(200, { 'Content-Length': payload.length });
    if (n === 1) res.write(payload.subarray(0, 4096)); else res.end(payload);
  });
  const unrelated = join(f.root, 'keep.exe'); await writeFile(unrelated, 'unrelated installer');
  const m = await f.make(); const first = m.start(); await until(() => m.status().bytes === 4096);
  const cancelled = await m.cancel(first.jobId);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.running, false);
  assert.equal(cancelled.bytes, 0); assert.equal(cancelled.path, undefined);
  const files = await readdir(f.root, { recursive: true });
  assert.equal(files.some(p => p.endsWith('.part') || p.endsWith('partial.json')), false);
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated installer');
  const restarted = await f.make(); assert.equal(restarted.status().bytes, 0); assert.equal(restarted.status().error, null);
  m.start(); assert.equal((await terminal(m)).state, 'completed'); assert.equal(f.requests[1].range, undefined);
  await assert.rejects(m.cancel(first.jobId), /任务/);
  assert.deepEqual(await readFile(m.status().path), payload);
});

test('cancel during release lookup blocks new starts until cleanup and never downloads', async t => {
  const f = await fixture(t, (_req, res) => res.end(payload), { fetchRelease: signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const m = await f.make(), first = m.start(); await delay(0);
  const stopping = m.cancel(first.jobId); assert.equal(m.start().jobId, first.jobId);
  assert.equal((await stopping).state, 'cancelled'); assert.equal(f.requests.length, 0);
});

test('single task reports partial progress; restart resumes the same verified bytes', async t => {
  const f = await fixture(t, (req, res) => {
    const offset = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
    if (!offset) { res.writeHead(200, { 'Content-Length': payload.length, ETag: '"one"' }); res.write(payload.subarray(0, 8192)); }
    else { res.writeHead(206, { 'Content-Range': `bytes ${offset}-${payload.length-1}/${payload.length}`, ETag: '"one"' }); res.end(payload.subarray(offset)); }
  });
  let m = await f.make();
  assert.equal(f.releaseCalls(), 0);
  const first = m.start(); assert.equal(m.start().jobId, first.jobId);
  await until(() => m.status().bytes === 8192);
  assert.ok(m.status().percent > 0 && m.status().percent < 100);
  assert.ok(m.status().bytesPerSecond >= 0);
  assert.equal(f.releaseCalls(), 1);
  await m.close();
  m = await f.make(); assert.equal(m.status().bytes, 8192);
  m.start(); const done = await terminal(m);
  assert.equal(done.state, 'completed', done.error);
  assert.deepEqual(await readFile(done.path), payload);
  assert.equal(f.requests[1].range, 'bytes=8192-');
  assert.equal(f.requests[1]['if-range'], '"one"');
});

for (const mode of ['ignore', 'wrong-range', 'changed-asset', 'changed-etag']) {
  test(`resume handles ${mode} without joining unrelated bytes`, async t => {
    const f = await fixture(t, (req, res, n) => {
      if (n === 1) { res.writeHead(200, { 'Content-Length': payload.length, ETag: '"one"' }); res.write(payload.subarray(0, 4096)); return; }
      if (mode === 'ignore' || mode === 'changed-asset') { res.writeHead(200); res.end(payload); return; }
      const start = mode === 'wrong-range' ? 0 : 4096;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${payload.length-1}/${payload.length}`, ETag: mode === 'changed-etag' ? '"two"' : '"one"' });
      res.end(payload.subarray(start));
    }, { idleTimeoutMs: 100 });
    const m = await f.make(); m.start(); assert.equal((await terminal(m)).state, 'failed');
    if (mode === 'changed-asset') f.release.asset.id = 2;
    m.start(); const done = await terminal(m);
    if (mode === 'wrong-range' || mode === 'changed-etag') { assert.equal(done.state, 'failed'); assert.equal(done.path, undefined); }
    else { assert.equal(done.state, 'completed', done.error); assert.deepEqual(await readFile(done.path), payload); }
    if (mode === 'changed-asset') assert.equal(f.requests[1].range, undefined);
  });
}

test('idle timeout preserves bytes but regular data keeps a longer download alive', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': payload.length }); let offset = 0;
    const timer = setInterval(() => { res.write(payload.subarray(offset, offset += 4096));
      if (offset >= payload.length) { clearInterval(timer); res.end(); } }, 30);
    res.on('close', () => clearInterval(timer));
  }, { idleTimeoutMs: 200 });
  const m = await f.make(); m.start(); assert.equal((await terminal(m)).state, 'completed');
});

test('bad checksum never exposes an installer and next retry starts clean', async t => {
  const f = await fixture(t, (_req, res, n) => res.end(n === 1 ? Buffer.alloc(payload.length, 1) : payload));
  const m = await f.make(); m.start(); const bad = await terminal(m);
  assert.equal(bad.state, 'failed'); assert.match(bad.error, /SHA-256/); assert.equal(bad.path, undefined);
  m.start(); const good = await terminal(m); assert.equal(good.state, 'completed');
  assert.equal(f.requests[1].range, undefined);
  const restarted = await f.make(); assert.equal(restarted.status().bytes, payload.length);
  assert.equal(restarted.status().path, undefined, 'restart requires fresh verification before exposing installer');
  restarted.start(); assert.equal((await terminal(restarted)).state, 'completed');
  assert.equal(f.requests.length, 2, 'verified cached package does not download again');
});

test('invalid digest and unsafe release path fail before writing installer bytes', async t => {
  const f = await fixture(t, (_req, res) => res.end(payload));
  f.release.latestTag = '../outside';
  const m = await f.make(); m.start(); assert.equal((await terminal(m)).state, 'failed');
  assert.equal(f.requests.length, 0);
  f.release.latestTag = 'test.2'; f.release.asset.digest = '';
  m.start(); assert.equal((await terminal(m)).state, 'failed'); assert.equal(f.requests.length, 0);
  assert.equal((await readdir(f.root)).some(name => name.endsWith('.exe')), false);
});

test('displayed speed falls to zero during a stalled connection before timeout', async t => {
  let clock = 0;
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Length': payload.length }); res.write(payload.subarray(0, 4096)); }, { now: () => clock });
  const m = await f.make(); m.start(); await until(() => m.status().bytes === 4096);
  clock = 1000; assert.ok(m.status().bytesPerSecond > 0);
  clock = 7000; assert.equal(m.status().bytesPerSecond, 0);
  assert.equal(m.status().remainingSeconds, null);
});

test('retry atomically replaces metadata without truncating the previous descriptor', async t => {
  const f = await fixture(t, (_req, res, n) => { res.writeHead(200, { 'Content-Length': payload.length, ETag: n === 1 ? '"one"' : '"two"' }); res.write(payload.subarray(0, 4096)); });
  let m = await f.make(); m.start(); await until(() => m.status().state === 'downloading' && m.status().bytes === 4096); await m.close();
  const metadata = (await readdir(f.root, { recursive: true })).find(path => path.endsWith('partial.json'));
  const original = await open(join(f.root, metadata), 'r'); t.after(() => original.close());
  m = await f.make(); m.start(); await until(() => m.status().state === 'failed' || (m.status().state === 'downloading' && m.status().bytes === 4096));
  assert.equal(JSON.parse(await original.readFile('utf8')).etag, '"one"');
  if (m.status().state === 'failed') {
    // Windows may refuse replacement while the descriptor is open. The previous
    // record must remain intact; releasing the reader makes the retry succeed.
    await terminal(m); assert.match(m.status().error, /EPERM|EBUSY|EACCES/);
    assert.equal(JSON.parse(await readFile(join(f.root, metadata), 'utf8')).etag, '"one"');
    await original.close(); m.start();
    await until(() => m.status().state === 'downloading' && m.status().bytes === 4096);
  }
  assert.equal(JSON.parse(await readFile(join(f.root, metadata), 'utf8')).etag, '"two"');
});
