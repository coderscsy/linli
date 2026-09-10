// Runs inside the existing game playlist store; no player or timer is created.
const OliviaSoulNativePage = crypto.randomUUID();
let OliviaSoulNativeSequence = 0, OliviaSoulNativeKey = '', OliviaSoulNativeSession = '';
let OliviaSoulNativePaused = null;
window.OliviaSoulNativeLyricsState = () => {
  if (window.__OliviaSoulSongId) return null;
  const item = te.value;
  const key = String(item?.id || 'unknown');
  const identity = key + ':' + String(window.__OliviaSoulNativePlayEpoch || 0);
  if (identity !== OliviaSoulNativeKey) {
    OliviaSoulNativePaused = null;
    OliviaSoulNativeKey = identity;
    OliviaSoulNativeSession = 'native:' + crypto.randomUUID();
  }
  const playing = !!item && m.value && Date.now() - Number(window.__OliviaSoulNativeProgressAt || 0) < 3500;
  if (!item) OliviaSoulNativePaused = null;
  const paused = OliviaSoulNativePaused?.sessionId === OliviaSoulNativeSession;
  return {pageId:OliviaSoulNativePage,sequence:++OliviaSoulNativeSequence,
    songId:'official:' + key,sessionId:OliviaSoulNativeSession,name:String(item?.name || ''),
    currentTime:paused?OliviaSoulNativePaused.currentTime:Math.max(0,Number(d.value)||0),duration:paused?OliviaSoulNativePaused.duration:Math.max(0,Number(item?.duration)||0),playbackState:paused?'paused':playing?'playing':'stopped'};
};
window.OliviaSoulOfficialLyricsControl = async (action,signal) => {
  if (window.__OliviaSoulSongId) throw new Error('playback changed');
  if (action === 'previous') return S();
  if (action === 'next') return U();
  if (action === 'pause' || action === 'resume') {
    const before=window.OliviaSoulNativeLyricsState();
    const response=await fetch('__OLIVIA_NATIVE_CONTROL_URL__',{method:'POST',headers:{'Content-Type':'application/json'},signal,
      body:JSON.stringify({action,songId:before.songId,sessionId:before.sessionId})});
    const result=await response.json();if(!response.ok||result.code!==0)throw new Error(result.message||'Official control failed');
    const current=window.OliviaSoulNativeLyricsState();
    if(!current||current.sessionId!==before.sessionId)throw new Error('playback changed');
    OliviaSoulNativePaused=action==='pause'?{sessionId:before.sessionId,...result.data}:null;
    d.value=result.data.currentTime;m.value=action==='resume';window.__OliviaSoulNativeProgressAt=Date.now();return;
  }
  throw new Error('unsupported playback action');
};
