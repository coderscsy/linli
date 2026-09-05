import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const execute = promisify(execFile);

// Read only WinINET's explicit proxy configuration. Never change process-wide agents.
export async function readWindowsProxySettings() {
  if (process.platform !== 'win32') return { enabled: false };
  try {
    const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{enabled=($p.ProxyEnable -eq 1);server=[string]$p.ProxyServer;pac=[string]$p.AutoConfigURL}|ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 5000, maxBuffer: 16384, encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch { throw new Error('无法读取 Windows 系统代理，请检查代理设置后重试'); }
}

export function selectSystemProxy(settings, target) {
  if (!settings?.enabled) {
    if (settings?.pac) throw new Error('更新暂不支持 PAC 自动代理，请在代理软件中启用系统 HTTP 代理');
    return null;
  }
  let server = String(settings.server ?? '').trim();
  if (server.includes('=')) {
    const entries = Object.fromEntries(server.split(';').filter(Boolean).map(part => {
      const i = part.indexOf('='); return [part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()];
    }));
    server = entries[new URL(target).protocol.slice(0, -1)] ?? '';
  }
  try {
    if (!server || /\s/.test(server)) throw new Error();
    const proxy = new URL(server.includes('://') ? server : `http://${server}`);
    if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== '/'
      || proxy.search || proxy.hash || proxy.username || proxy.password) throw new Error();
    return proxy.href;
  } catch { throw new Error('系统代理地址无效或不支持，请启用 HTTP/HTTPS 系统代理后重试'); }
}

function proxyRequest(url, init, proxy, redirects = 0) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major === 22 && minor >= 21 || major === 24 && minor >= 5 || major > 24))
    throw new Error('当前 Node.js 运行时不支持系统代理，请使用 OliviaSoul 随附的新版运行时');
  const transport = url.protocol === 'https:' ? https : http;
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('更新代理不支持此下载协议');
  const agent = new transport.Agent({ keepAlive: false,
    proxyEnv: { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: '' } });
  const headers = new Headers(init.headers);
  headers.set('Accept-Encoding', 'identity');
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method: init.method ?? 'GET', headers: Object.fromEntries(headers), agent, signal: init.signal }, res => {
      res.once('close', () => agent.destroy());
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.destroy();
        try {
          const next = new URL(res.headers.location, url);
          if (redirects >= 5) throw new Error('更新代理重定向次数过多');
          if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('更新代理拒绝不安全的降级跳转');
          if (next.origin !== url.origin) { headers.delete('Authorization'); headers.delete('Cookie'); }
          resolve(proxyRequest(next, { ...init, headers }, proxy, redirects + 1));
        } catch (error) { reject(error); }
        return;
      }
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const noBody = init.method === 'HEAD' || [204, 205, 304].includes(res.statusCode);
      let body = res;
      const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[res.headers['content-encoding']];
      if (!noBody && decoder) {
        body = decoder(); res.on('error', error => body.destroy(error));
        body.once('close', () => res.destroy()); res.pipe(body);
        responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
      }
      try {
        resolve(new Response(noBody ? null : Readable.toWeb(body), { status: res.statusCode, headers: responseHeaders }));
        if (noBody) res.resume();
      } catch (error) { res.destroy(); reject(error); }
    });
    req.once('error', error => { agent.destroy(); reject(init.signal?.aborted ? init.signal.reason
      : new Error(`更新代理连接失败（${error.code || 'NETWORK_ERROR'}），请检查代理软件或节点后重试`)); });
    req.end();
  });
}

export function createUpdateFetch({ readProxySettings = readWindowsProxySettings, directFetch = fetch } = {}) {
  return async (input, init = {}) => {
    init.signal?.throwIfAborted();
    const url = new URL(input);
    const proxy = selectSystemProxy(await readProxySettings(), url);
    init.signal?.throwIfAborted();
    if (!proxy) return directFetch(input, init);
    if (init.body || !['GET', 'HEAD'].includes(init.method ?? 'GET')) throw new Error('更新代理仅允许读取请求');
    return proxyRequest(url, init, proxy);
  };
}
