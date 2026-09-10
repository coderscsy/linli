// Runs inside the existing WebPlayer component; no extra player or timer.
function OliviaSoulSwapPlayback(url, options, onReady) {
  window.__OliviaSoulMediaSwap?.cancel();
  const old = i.value, next = v.value;
  if (!old || !next || old === next || !url) { if(onReady)onReady(false); return; }
  ie(); O(); ++G;
  if (u !== null) { clearTimeout(u); u = null; }
  old.style.transition = ''; old.style.opacity = '1'; old.style.filter = '';
  next.style.transition = ''; next.style.opacity = '0'; next.style.filter = '';
  const offset = Math.max(0, Number(options?.offset) || 0);
  let finished = false, metadata = false, positioned = false, starting = false, frame = null, target = offset;
  const handlers = [];
  const transaction = {url, offset, cancel: () => finish(false)};
  window.__OliviaSoulMediaSwap = transaction;
  const timer = setTimeout(() => finish(false), 8000);
  function finish(commit) {
    if (finished) return; finished = true;
    if(commit&&options?.isCurrent&&!options.isCurrent())commit=false;
    clearTimeout(timer);
    for (const [name, fn] of handlers) next.removeEventListener(name, fn);
    if (frame !== null && next.cancelVideoFrameCallback) next.cancelVideoFrameCallback(frame);
    if (window.__OliviaSoulMediaSwap !== transaction) return;
    window.__OliviaSoulMediaSwap = null;
    if (!commit) { next.pause(); next.removeAttribute('src'); next.load(); if(onReady)onReady(false); return; }
    r.value = 1 - r.value;
    next.style.opacity = '1'; old.style.opacity = '0';
    next.muted = typeof options?.mute === 'boolean' ? options.mute : h.muted;
    old.pause(); old.removeAttribute('src'); old.load();
    if (Number.isFinite(next.duration)) a.value = next.duration;
    if (onReady) onReady(true);
  }
  function listen(name, fn) { handlers.push([name, fn]); next.addEventListener(name, fn); }
  function ready() {
    if (finished || !metadata || !positioned || next.readyState < 2 || next.seeking || starting) return;
    starting = true;
    // Decode silently, then expose the first frame; keep the old frame meanwhile.
    if (next.requestVideoFrameCallback) frame = next.requestVideoFrameCallback(() => finish(true));
    Promise.resolve(next.play()).then(() => {
      if (!next.requestVideoFrameCallback && !finished) finish(true);
    }).catch(() => finish(false));
  }
  listen('loadedmetadata', () => {
    metadata = true;
    target = Math.min(offset, Number.isFinite(next.duration) ? Math.max(0, next.duration - 0.01) : offset);
    positioned = Math.abs(next.currentTime - target) < 0.02;
    if (!positioned) next.currentTime = target;
    ready();
  });
  listen('seeked', () => { positioned = Math.abs(next.currentTime - target) < 0.25; ready(); });
  listen('loadeddata', ready); listen('canplay', ready); listen('error', () => finish(false));
  R(next); A(next, options); next.muted = true; next.src = url; next.load();
}

// Commands are delivered by the existing player poll/SSE notification. Only one
// snapshot and one result are retained; original game stop/next clears them.
async function OliviaSoulNativeLyricsCommand(command) {
  if(!command||Date.now()>command.expiresAt)return;
  let result=window.__OliviaSoulNativeResult;
  if(result?.id!==command.id){
    result={id:command.id,ok:false,currentTime:0,duration:0};
    try {
      if(window.__OliviaSoulActiveSessionId)throw new Error('Local playback owns player');
      if(command.action==='pause'){
        const player=i.value,url=String(player?.currentSrc||player?.src||'');
        if(!url||url.toLowerCase().includes('/assets/wallpaper_presence/')||window.__OliviaSoulMediaSwap)throw new Error('No confirmed performance');
        player.pause();
        const saved={url,offset:player.currentTime,duration:player.duration,songId:command.songId,sessionId:command.sessionId};
        window.__OliviaSoulNativePaused=saved;
        window.__OliviaSoulRestoreDefaultPlayback();
        result={id:command.id,ok:true,currentTime:saved.offset,duration:saved.duration};
      } else if(command.action==='resume') {
        const saved=window.__OliviaSoulNativePaused;
        if(!saved||saved.sessionId!==command.sessionId||saved.songId!==command.songId)throw new Error('Native session changed');
        await new Promise((resolve,reject)=>OliviaSoulSwapPlayback(saved.url,{offset:saved.offset,loop:false,isCurrent:()=>window.__OliviaSoulNativePaused===saved&&!window.__OliviaSoulActiveSessionId},ok=>{
          if(!ok)return reject(new Error('Resume failed'));
          if(window.__OliviaSoulNativePaused!==saved)return reject(new Error('Native session changed'));
          window.__OliviaSoulNativePaused=null;resolve();
        }));
        result={id:command.id,ok:true,currentTime:i.value.currentTime,duration:i.value.duration};
      }
    }catch{}
    window.__OliviaSoulNativeResult=result;
  }
  await fetch('__OLIVIA_NATIVE_RESULT_URL__',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result),signal:AbortSignal.timeout(2000)}).catch(()=>{});
}

function OliviaSoulSuspendLocalPlayback() {
  if (window.__OliviaSoulSuspendedPlayback) return;
  const player = i.value;
  if (!player || !window.__OliviaSoulActiveSessionId) return;
  player.pause();
  const loading = window.__OliviaSoulMediaSwap;
  window.__OliviaSoulSuspendedPlayback = {
    url: loading?.url.includes('/toy/midi/songs/') ? loading.url : String(player.currentSrc || player.src || ''),
    offset: loading?.url.includes('/toy/midi/songs/') ? loading.offset : Number(player.currentTime) || 0,
    duration: Number.isFinite(player.duration) ? player.duration : 0,
    songId: window.__OliviaSoulActiveSongId,
    sessionId: window.__OliviaSoulActiveSessionId
  };
  window.__OliviaSoulRestoreDefaultPlayback();
}

function OliviaSoulResumeLocalPlayback(command) {
  const saved = window.__OliviaSoulSuspendedPlayback;
  if (!saved) { ce(); return; }
  if (saved.sessionId !== command.sessionId || saved.songId !== command.songId
      || saved.sessionId !== window.__OliviaSoulActiveSessionId
      || saved.songId !== window.__OliviaSoulActiveSongId) return;
  window.__OliviaSoulSuspendedPlayback = null;
  pe({cmd:'play',url:saved.url,offset:saved.offset,songId:saved.songId,sessionId:saved.sessionId,
      __oliviaRevision:window.__OliviaSoulActivePlayerRevision});
}

function OliviaSoulReportPausedPlayback() {
  const saved = window.__OliviaSoulSuspendedPlayback;
  if (!saved || saved.sessionId !== window.__OliviaSoulActiveSessionId
      || saved.songId !== window.__OliviaSoulActiveSongId) return;
  return window.__OliviaSoulPlayerPost({commandRevision:window.__OliviaSoulActivePlayerRevision,
    sessionId:saved.sessionId,songId:saved.songId,mediaUrl:saved.url,
    event:'timeupdate',paused:true,currentTime:saved.offset,duration:saved.duration});
}
