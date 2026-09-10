export async function lyricsRoute(req, path, lyrics, readJson) {
  if (path === '/toy/lyrics/settings') {
    if (req.method === 'GET') return lyrics.settings();
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!body || typeof body.enabled !== 'boolean' || Object.keys(body).length !== 1) throw Object.assign(new Error('只允许设置歌词开关'), {status:400});
      return lyrics.updateSettings({enabled:body.enabled});
    }
  }
  if (path === '/admin/api/lyrics/settings') {
    if (req.method === 'GET') return lyrics.settings();
    if (req.method === 'POST') return lyrics.updateSettings(await readJson(req));
  }
  const match = /^\/(?:admin\/api|toy)\/media\/songs\/([^/]+)\/lyrics$/u.exec(path);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (req.method === 'GET') return lyrics.info(id);
    if (req.method === 'POST' || req.method === 'DELETE') return lyrics.save(id, await readJson(req), req.method === 'DELETE');
  }
  return null;
}
