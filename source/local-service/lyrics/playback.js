import { randomUUID } from 'node:crypto';

// A bounded, expiring command handoff to the game's existing playlist controller.
export function createLyricsPlayback({getState, now = Date.now, notify = () => {}}) {
  let heartbeat = -Infinity, pending = null, closed = false;
  const failure = message => Object.assign(new Error(message), {status:409});
  function matches(request) {
    const state = getState();
    return request.songId && request.songId === state.songId && request.sessionId === state.sessionId
      && ['playing','paused'].includes(state.playbackState);
  }
  function finish(error) {
    if (!pending) return;
    const old = pending; pending = null; clearTimeout(old.timer);
    error ? old.reject(failure(error)) : old.resolve({ok:true});
  }
  return {
    request(request) {
      if (closed || now()-heartbeat > 5000) throw failure('游戏控制未连接，请更新客户端补丁并打开游戏');
      if (!['previous','pause','resume','next'].includes(request.action)) throw failure('播放操作无效');
      if (!matches(request)) throw failure('播放会话已经切换');
      if (pending) throw failure('播放操作处理中，请稍候');
      return new Promise((resolve,reject)=>{
        const timeout=request.songId.startsWith('official:')?12000:5000;
        const command = {id:randomUUID(), action:request.action, songId:request.songId, sessionId:request.sessionId, expiresAt:now()+timeout};
        pending={command,resolve,reject,timer:setTimeout(()=>finish('游戏控制超时，请重试'),timeout)};
        notify();
      });
    },
    poll() {
      heartbeat=now();
      if(pending && !matches(pending.command)) finish('播放会话已经切换');
      if(pending && now() >= pending.command.expiresAt) finish('游戏控制超时，请重试');
      return {command:pending?.command || null};
    },
    ack(body) { if(pending?.command.id===body.id) finish(body.ok === true ? null : '游戏播放操作失败，请检查客户端补丁'); return {ok:true}; },
    close() {closed=true;finish('播放服务已关闭');}
  };
}
