const active = state => ['connecting', 'downloading', 'verifying', 'cancelling', 'pausing'].includes(state.state) || state.running;
const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
const time = seconds => seconds == null ? '计算中' : seconds >= 3600 ? `${Math.ceil(seconds / 60)} 分钟`
  : seconds >= 60 ? `${Math.ceil(seconds / 60)} 分钟` : `${Math.ceil(seconds)} 秒`;

export function createUpdateDownloadUI({ api, elements, confirmInstall, showInstallError, install, intervalMs = 1000 }) {
  let visible = false, timer, polling = null, starting = null, snapshot = null, installing = false;
  let generation = 0, selectedTag = null, cancelling = null, pausing = null;
  let releaseInfo = null, checkedSinceAction = true;
  const eligible = () => releaseInfo?.updateAvailable === true;
  const outdated = s => selectedTag && s.tag && s.tag !== selectedTag;
  const prompted = new Set();
  const installFailures = new Map();
  function render(s) {
    snapshot = s;
    elements.message.textContent = '';
    const busy = active(s);
    elements.button.disabled = Boolean(busy || cancelling || pausing);
    if (elements.pause) {
      elements.pause.hidden = !['connecting', 'downloading', 'pausing'].includes(s.state);
      elements.pause.disabled = Boolean(cancelling || pausing || s.state === 'pausing');
      elements.pause.textContent = pausing || s.state === 'pausing' ? '正在暂停……' : '暂停下载';
    }
    if (elements.cancel) {
      elements.cancel.hidden = !(busy || s.state === 'paused' || s.bytes > 0 && s.state !== 'completed');
      elements.cancel.disabled = Boolean(cancelling || pausing || s.state === 'cancelling' || s.state === 'pausing');
      elements.cancel.textContent = cancelling || s.state === 'cancelling' ? '正在取消……' : '取消下载';
    }
    if (s.state !== 'idle' || s.bytes > 0) elements.button.hidden = false;
    elements.button.textContent = s.state === 'paused' ? '继续下载' : s.state === 'failed' ? '重试下载' : s.state === 'completed' ? '安装更新'
      : s.bytes > 0 && !busy ? '继续下载 / 校验' : '下载并安装更新';
    if (!busy && outdated(s)) elements.button.textContent = '下载新版本';
    elements.progress.hidden = !(s.totalBytes > 0);
    elements.progress.value = Math.max(0, Math.min(100, Number(s.percent) || 0));
    elements.details.hidden = !(s.totalBytes > 0);
    elements.details.textContent = `${(Number(s.percent) || 0).toFixed(1)}% · ${size(s.bytes || 0)} / ${size(s.totalBytes || 0)}`
      + (s.state === 'downloading' ? ` · ${s.bytesPerSecond > 0 ? `${size(s.bytesPerSecond)}/s` : '速度计算中'} · 剩余约 ${time(s.remainingSeconds)}` : '');
    const messages = {
      connecting: '正在连接下载源，检查可续传进度……',
      pausing: '正在暂停下载并保存进度……',
      paused: '已暂停，下载进度已保留；点击继续下载可断点续传',
      cancelling: '正在停止下载并删除本次下载文件……',
      cancelled: '已取消下载，已删除本次下载文件',
      downloading: '正在下载；网络中断后可重试续传', verifying: '下载完成，正在校验完整安装包……',
      completed: `校验通过：${s.path ?? ''}`, failed: `${s.error || '下载中断'}${s.bytes > 0 ? '（已保留下载进度）' : ''}`,
    };
    if (messages[s.state]) elements.message.textContent = messages[s.state];
    else if (s.bytes > 0) elements.message.textContent = '发现上次下载进度，可以继续下载或校验';
    if (!busy && outdated(s)) elements.message.textContent = `上次任务为 ${s.tag}；可下载新版本 ${selectedTag}`;
    if (s.state === 'completed' && !outdated(s) && installFailures.has(s.jobId)) {
      elements.button.textContent = '重新校验安装包';
      elements.message.textContent = installFailures.get(s.jobId);
    }
    if (checkedSinceAction && s.state === 'cancelled') elements.message.textContent = '';
    if (!eligible()) {
      elements.button.hidden = true;
      elements.button.disabled = true;
      elements.progress.hidden = true;
      elements.details.hidden = true;
      if (elements.pause) elements.pause.hidden = true;
      if (s.bytes > 0 && !busy) {
        elements.message.textContent = releaseInfo ? '旧下载任务已忽略，不会续传或安装。' : '等待检查更新，暂不恢复旧下载任务。';
        if (elements.cancel) {
          elements.cancel.hidden = s.state === 'completed';
          elements.cancel.textContent = '清除旧任务';
        }
      }
    } else elements.button.hidden = false;
  }
  async function offerInstall(s, manual = false) {
    if (!eligible() || cancelling || pausing || !visible || !install || !s.path || s.state !== 'completed' || outdated(s) || (!selectedTag && !manual)
      || installing || installFailures.has(s.jobId) || (!manual && prompted.has(s.jobId))) return;
    prompted.add(s.jobId); installing = true;
    try {
      if (await confirmInstall('安装包已下载并通过完整性校验。请先退出游戏。\n点击“立即安装”后，将启动安装程序并退出 OliviaSoul。\n升级前建议备份 UserData，并沿用原安装目录。', {
        title: '更新已准备就绪', confirmText: '立即安装', cancelText: '稍后安装',
      })
        && eligible() && !cancelling && !pausing && visible && !outdated(s) && snapshot?.jobId === s.jobId && snapshot?.state === 'completed') await install(s.path);
    } catch (e) {
      installFailures.set(s.jobId, '无法启动安装程序，请检查文件权限或安全软件提示，然后重新校验安装包');
      if (snapshot?.jobId === s.jobId) render(snapshot);
      if (showInstallError) await showInstallError({ title: '无法启动安装程序',
        message: '请检查文件权限或安全软件提示。处理后点击“重新校验安装包”；校验通过后可再次安装，文件丢失时会重新下载。',
        details: String(e.message || e), confirmText: '知道了',
      });
    }
    finally { installing = false; }
  }
  function schedule() { clearTimeout(timer); if (visible) timer = setTimeout(() => refresh(), intervalMs); }
  function refresh() {
    if (polling) return polling;
    const requestedGeneration = generation;
    polling = (async () => {
      try {
        const s = await api('/admin/api/update/download/status', { signal: AbortSignal.timeout(10_000) });
        if (!cancelling && !pausing && visible && requestedGeneration === generation) { render(s); await offerInstall(s); }
      } catch (e) { if (visible && requestedGeneration === generation) elements.message.textContent = `读取下载进度失败：${e.message}；稍后自动重试`; }
      finally { polling = null; schedule(); }
    })();
    return polling;
  }
  return {
    refresh,
    setRelease(release) { releaseInfo = release; selectedTag = release.latestTag; checkedSinceAction = true; render(snapshot ?? { state: 'idle', bytes: 0 }); },
    setVisible(value) { visible = value; generation++; clearTimeout(timer); if (visible) void refresh(); },
    start() {
      if (!eligible()) return Promise.resolve();
      checkedSinceAction = false;
      if (pausing) return pausing;
      if (cancelling) return cancelling;
      if (starting) return starting;
      if (snapshot?.state === 'completed' && !outdated(snapshot) && !installFailures.has(snapshot.jobId)) return offerInstall(snapshot, true);
      if (snapshot && active(snapshot)) return Promise.resolve();
      elements.button.disabled = true;
      generation++;
      starting = (async () => {
        try { render(await api('/admin/api/update/download', { method: 'POST', body: '{}' })); }
        finally { starting = null; elements.button.disabled = Boolean(snapshot && active(snapshot)); schedule(); }
      })();
      return starting;
    },
    pause() {
      checkedSinceAction = false;
      if (cancelling) return cancelling;
      if (pausing) return pausing;
      generation++;
      elements.button.disabled = true;
      if (elements.pause) { elements.pause.disabled = true; elements.pause.textContent = '正在暂停……'; }
      if (elements.cancel) elements.cancel.disabled = true;
      pausing = (async () => {
        try {
          if (starting) await starting;
          render(await api('/admin/api/update/download/pause', {
            method: 'POST', body: JSON.stringify({ jobId: snapshot?.jobId ?? null }),
          }));
        } catch (error) { elements.message.textContent = `暂停下载失败：${error.message}`; }
        finally {
          pausing = null;
          elements.button.disabled = Boolean(snapshot && active(snapshot));
          if (elements.pause) elements.pause.disabled = false;
          if (elements.cancel) elements.cancel.disabled = false;
          schedule();
        }
      })();
      return pausing;
    },
    cancel() {
      checkedSinceAction = false;
      if (pausing) return pausing;
      if (cancelling) return cancelling;
      generation++;
      elements.button.disabled = true;
      if (elements.cancel) { elements.cancel.disabled = true; elements.cancel.textContent = '正在取消……'; }
      cancelling = (async () => {
        try {
          if (starting) await starting;
          const result = await api('/admin/api/update/download/cancel', {
            method: 'POST', body: JSON.stringify({ jobId: snapshot?.jobId ?? null }),
          });
          render(result);
        } catch (error) { elements.message.textContent = `取消下载失败：${error.message}`; }
        finally {
          cancelling = null;
          elements.button.disabled = Boolean(snapshot && active(snapshot));
          if (elements.cancel) elements.cancel.disabled = false;
          schedule();
        }
      })();
      return cancelling;
    },
  };
}
