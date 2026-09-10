(() => {
  if (window.__oliviaLyricsButton) return;
  window.__oliviaLyricsButton = true;
  const base = new URL(document.currentScript.src).origin;
  let enabled = false, known = false, busy = false, stopped = false, timer, request;
  const button = document.createElement('button');
  button.textContent = '词'; button.type = 'button';
  button.style.cssText = 'border:0;background:transparent;border-radius:6px;padding:4px 8px;font:600 18px system-ui;cursor:pointer;margin-left:8px';
  function render() {
    button.disabled = busy || !known;
    button.style.color = enabled ? '#ffebaa' : '#a5a5a8';
    button.setAttribute('aria-pressed', String(enabled));
    button.title = known ? (enabled ? '关闭歌词' : '启用歌词') : '歌词服务暂不可用';
  }
  async function sync(value) {
    if (busy || stopped) return;
    busy = true; render(); request = new AbortController();
    const timeout = setTimeout(() => request?.abort(), 3000);
    try {
      const response = await fetch(base + '/toy/lyrics/settings', { cache: 'no-store', signal: request.signal,
        ...(typeof value === 'boolean' ? { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({enabled:value}) } : {}) });
      const result = await response.json();
      if (!response.ok || result.code !== 0) throw new Error('lyrics unavailable');
      if (!stopped) { enabled = result.data.settings.enabled === true; known = true; }
    } catch { if (!stopped) known = false; }
    finally { clearTimeout(timeout); request = null; busy = false; if (!stopped) render(); }
  }
  button.addEventListener('click', () => { if (known) void sync(!enabled); });
  const completed = new Map(); let controlRequest, controlQueued = false, commandEvents;
  async function playback() {
    if (typeof window.OliviaSoulLyricsPlayback !== 'function') return;
    if (stopped) return;
    if (controlRequest) { controlQueued = true; return; }
    const abort = new AbortController(), timeout = setTimeout(()=>abort.abort(),15000);
    controlRequest = abort;
    try {
      const native = window.OliviaSoulNativeLyricsState?.();
      if (known && enabled && native) await fetch(base+'/toy/lyrics/native-state', {
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(native),signal:abort.signal
      });
      const result = await (await fetch(base+'/toy/lyrics/playback',{cache:'no-store',signal:abort.signal})).json();
      const command = result.data?.command;
      if (!command || stopped) return;
      let ok = completed.get(command.id);
      if (ok === undefined) {
        ok = false;
        const official = command.songId.startsWith('official:') ? window.OliviaSoulNativeLyricsState?.() : null;
        if (official && ['playing','paused'].includes(official.playbackState) && Date.now() < command.expiresAt && command.songId === official.songId && command.sessionId === official.sessionId) {
          try { await window.OliviaSoulOfficialLyricsControl(command.action,abort.signal);
            const updated=window.OliviaSoulNativeLyricsState?.();
            if(updated)await fetch(base+'/toy/lyrics/native-state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(updated),signal:abort.signal});
            ok = true; } catch {}
        } else if (!official && Date.now() < command.expiresAt && command.songId === String(window.__OliviaSoulSongId || '') && command.sessionId === window.__OliviaSoulSessionId) {
          try { await window.OliviaSoulLyricsPlayback(command.action, abort.signal); ok = true; } catch {}
        }
        completed.set(command.id,ok); if(completed.size>32) completed.delete(completed.keys().next().value);
      }
      await fetch(base+'/toy/lyrics/playback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:command.id,ok}),signal:abort.signal});
    } catch {} finally {
      clearTimeout(timeout); if(controlRequest===abort) controlRequest=null;
      if(controlQueued&&!stopped){controlQueued=false;queueMicrotask(playback);}
    }
  }
  async function tick() {
    if (stopped) return;
    const controls = document.querySelector('.lite-playback-control .flex.gap-2.items-center');
    if (controls && button.parentNode !== controls) controls.appendChild(button);
    if (controls) { await playback(); if(!document.hidden) await sync(); }
    if (!stopped) timer = setTimeout(tick, 2000);
  }
  if (typeof EventSource === 'function') {
    commandEvents = new EventSource(base+'/toy/command-events?channel=lyrics');
    commandEvents.onmessage = () => { void playback(); };
    const refreshLibrary = () => {
      if (!stopped) window.dispatchEvent(new CustomEvent('oliviasoul-library-changed'));
    };
    commandEvents.addEventListener('open', refreshLibrary);
    commandEvents.addEventListener('library-changed', refreshLibrary);
    commandEvents.addEventListener('library-removed',event=>{
      try {
        const data=JSON.parse(event.data);
        if(!stopped&&Array.isArray(data.ids)&&data.ids.length<=1000&&data.ids.every(id=>typeof id==='string'))
          window.dispatchEvent(new CustomEvent('oliviasoul-songs-removed',{detail:{ids:data.ids,counts:data.counts}}));
      } catch {}
    });
  }
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); request?.abort(); controlRequest?.abort(); commandEvents?.close(); button.remove(); }, {once:true});
  render(); void tick();
})();
