// Presentation-only native game reports. Never alter the local player/session.
export function createNativeLyricsObserver({observe, localActive, now=Date.now}) {
  let latest=null,at=-Infinity,page='',sequence=-1;
  return {
    state:()=>now()-at<3500&&!localActive()?latest:null,
    report(body) {
      if(localActive() || !body || typeof body.pageId!=='string' || body.pageId.length>100
        || !Number.isSafeInteger(body.sequence) || body.sequence<0
        || (page===body.pageId ? body.sequence<=sequence : now()-at<3500)
        || typeof body.songId!=='string' || !body.songId.startsWith('official:') || body.songId.length>200
        || typeof body.sessionId!=='string' || !body.sessionId.startsWith('native:') || body.sessionId.length>200
        || !['playing','paused','stopped'].includes(body.playbackState)
        || !Number.isFinite(body.currentTime) || body.currentTime<0 || body.currentTime>86400
        || !Number.isFinite(body.duration) || body.duration<0 || body.duration>86400) return {ok:false};
      page=body.pageId;sequence=body.sequence;at=now();
      latest={songId:body.songId,sessionId:body.sessionId,name:String(body.name||'').slice(0,300),
        mediaUrl:'',currentTime:body.currentTime,duration:body.duration,
        event:'timeupdate',playbackState:body.playbackState};
      observe(latest,{official:true},true);return {ok:true};
    }
  };
}
