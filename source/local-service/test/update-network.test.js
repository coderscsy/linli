import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createUpdateFetch, selectSystemProxy } from '../update-network.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t) {
  const seen = [], via = [], sockets = new Set();
  const target = createServer((req, res) => {
    seen.push({ path: req.url, range: req.headers.range });
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/file' }); res.end(); }
    else if (req.url === '/stall') { res.writeHead(200); res.write('start'); }
    else { res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': 'application/octet-stream', ...(req.headers.range ? { 'Content-Range': 'bytes 2-5/6' } : {}) }); res.end(req.headers.range ? 'cdef' : 'abcdef'); }
  });
  const targetUrl = await listen(target);
  const proxy = createServer((req, res) => {
    via.push(req.url);
    const url = new URL(req.url);
    const outgoing = httpRequest(url, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    }); outgoing.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(outgoing);
  });
  proxy.on('connect', (req, socket, head) => {
    via.push(req.url); const [host, port] = req.url.split(':');
    const upstream = connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream); sockets.add(socket);
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { for (const socket of sockets) socket.destroy(); target.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([target, proxy].map(server => new Promise(resolve => server.close(resolve)))); });
  return { targetUrl, proxyUrl, seen, via };
}

test('system proxy formats select explicit HTTPS endpoint and fail closed for unsupported settings', () => {
  assert.equal(selectSystemProxy({ enabled: false }, 'https://github.com'), null);
  assert.equal(selectSystemProxy({ enabled: true, server: 'localhost:8123' }, 'https://github.com'), 'http://localhost:8123/');
  assert.equal(selectSystemProxy({ enabled: true, server: 'http=localhost:8123;https=localhost:8124' }, 'https://github.com'), 'http://localhost:8124/');
  assert.throws(() => selectSystemProxy({ enabled: true, server: 'socks=localhost:8123' }, 'https://github.com'), /代理/);
  assert.throws(() => selectSystemProxy({ enabled: false, pac: 'https://example.test/proxy.pac' }, 'https://github.com'), /PAC/);
  assert.throws(() => selectSystemProxy({ enabled: true, server: 'bad host/name' }, 'https://github.com'), /代理/);
});

test('only update requests use the proxy; redirect and Range remain correct', async t => {
  const f = await fixture(t); let directCalls = 0;
  const update = createUpdateFetch({ readProxySettings: async () => ({ enabled: true, server: f.proxyUrl }),
    directFetch: async () => { directCalls++; throw new Error('unexpected direct request'); } });
  const response = await update(f.targetUrl + '/redirect', { headers: { Range: 'bytes=2-' } });
  assert.equal(response.status, 206); assert.equal(await response.text(), 'cdef');
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/6');
  assert.equal(f.via.length, 2); assert.equal(directCalls, 0);
  assert.deepEqual(f.seen.map(item => item.range), ['bytes=2-', 'bytes=2-']);
  const normal = await fetch(f.targetUrl + '/file'); assert.equal(await normal.text(), 'abcdef');
  assert.equal(f.via.length, 2, 'ordinary model/media fetch must not inherit the update proxy');
});

test('proxy disabled next request returns to existing direct transport', async t => {
  const f = await fixture(t); let enabled = true, reads = 0;
  const update = createUpdateFetch({ readProxySettings: async () => { reads++; return { enabled, server: f.proxyUrl }; } });
  assert.equal(await (await update(f.targetUrl + '/file')).text(), 'abcdef');
  enabled = false; assert.equal(await (await update(f.targetUrl + '/file')).text(), 'abcdef');
  assert.equal(f.via.length, 1); assert.equal(reads, 2);
});

test('unavailable enabled proxy never falls back to direct', async t => {
  const f = await fixture(t); let direct = 0;
  const stopped = createServer(); const unused = await listen(stopped); await new Promise(resolve => stopped.close(resolve));
  const update = createUpdateFetch({ readProxySettings: async () => ({ enabled: true, server: unused }),
    directFetch: async () => { direct++; return new Response('unsafe fallback'); } });
  await assert.rejects(update(f.targetUrl + '/file', { signal: AbortSignal.timeout(2000) }), /代理/);
  assert.equal(direct, 0); assert.equal(f.seen.length, 0);
});

test('cancelling a proxied streaming response closes its request', async t => {
  const f = await fixture(t);
  const update = createUpdateFetch({ readProxySettings: async () => ({ enabled: true, server: f.proxyUrl }) });
  const controller = new AbortController();
  const response = await update(f.targetUrl + '/stall', { signal: controller.signal });
  const body = response.text(); await delay(10); controller.abort();
  await assert.rejects(body);
});
