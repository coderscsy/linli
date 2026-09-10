import {randomUUID} from 'node:crypto';
export function createNativeLyricsControl({getState,notify}) {
  let pending=null;
  const failure=message=>Object.assign(new Error(message),{status:409});
  function finish(error,result){if(!pending)return;const p=pending;pending=null;clearTimeout(p.timer);error?p.reject(failure(error)):p.resolve(result);}
  return {
    request(body){
      const s=getState();
      if(!s||s.songId!==body.songId||s.sessionId!==body.sessionId||!['playing','paused'].includes(s.playbackState))throw failure('官方曲目已经切换');
      if(!['pause','resume'].includes(body.action)||pending)throw failure('播放操作处理中或无效');
      return new Promise((resolve,reject)=>{
        pending={resolve,reject,command:{id:randomUUID(),action:body.action,songId:body.songId,sessionId:body.sessionId,expiresAt:Date.now()+9000},timer:setTimeout(()=>finish('官方播放器响应超时'),9000)};
        notify();
      });
    },
    poll(){return pending?.command||null;},
    ack(body){
      if(!pending||body.id!==pending.command.id)return {ok:false};
      if(body.ok!==true||!Number.isFinite(body.currentTime)||body.currentTime<0||!Number.isFinite(body.duration)||body.duration<=0)finish('官方播放器未能完成操作');
      else finish(null,{currentTime:body.currentTime,duration:body.duration});
      return {ok:true};
    },
    close(){finish('本地服务已关闭');}
  };
}
