import { createUpdateDownloadUI } from './update-download-ui.js';
import { createTabNotices } from './tab-notices.js';
const $ = selector => document.querySelector(selector);
let noticeStorage;
try { noticeStorage = window.localStorage; } catch { /* Storage may be disabled. */ }
const tabNotices = createTabNotices({ storage: noticeStorage, render(tab, notice) {
  const button = $(`.sideTab[data-tab="${tab}"]`);
  if (!button) return;
  if (notice.kind) button.dataset.noticeKind = notice.kind;
  else delete button.dataset.noticeKind;
  const label = button.textContent.trim();
  button.title = notice.messages.join('；');
  button.setAttribute?.('aria-label', notice.kind ? `${label}：${button.title}` : label);
} });
let previewId = null;
let aiExchanges = [];
let aiImportMetadata = null;
let memoryExchanges = [];
let memoryLoaded = false;
let showMemorySummaries = false;
let noticeResolver = null;
let transcriptionSelection = null;
let transcriptionJobId = null;
let remoteMemoryJobId = null;
let modelConfiguration = null;
let modelRuntimeSnapshot = null;
let modelRuntimeTimer = null;
let modelRuntimeRequest = 0;
let midiLibraryPreviewId = null;
let midiStatusSnapshot = null;
let updateInformation = null;
const updateDownloadUI = createUpdateDownloadUI({ api,
  elements: { button: $('#downloadUpdate'), cancel: $('#cancelUpdateDownload'), pause: $('#pauseUpdateDownload'), progress: $('#updateDownloadProgress'),
    message: $('#updateTransferResult'), details: $('#updateDownloadDetails') },
  confirmInstall: (message, options) => openNotice({ ...options, message }),
  showInstallError: options => openNotice(options),
  install: window.oliviaDesktop?.installUpdate ? path => window.oliviaDesktop.installUpdate(path) : null,
});
let storageMigrationPreview = null;
let storageMigrationPreviewJobId = null;
let storageMigrationPollTimer = null;
let clientMountSnapshot = null;
let clientMountAction = null;
let clientMountGeneration = 0;
let clientMountStatusRequest = 0;
const safely = handler => async event => {
  try {
    await handler(event);
  } catch (error) {
    showError(error);
  }
};

async function runModelOperation({ buttonSelector, resultSelector, pendingText, successText, failureText, operation }) {
  const button = $(buttonSelector);
  const resultTarget = $(resultSelector);
  button.disabled = true;
  resultTarget.textContent = pendingText;
  try {
    const result = await operation();
    resultTarget.textContent = typeof successText === "function" ? successText(result) : successText;
    return result;
  } catch (error) {
    resultTarget.textContent = `${failureText}：${String(error?.message ?? error ?? "未知错误")}`;
    throw error;
  } finally {
    button.disabled = false;
  }
}

function closeNotice(result) {
  const resolver = noticeResolver;
  noticeResolver = null;
  $("#noticeLayer").hidden = true;
  if (resolver) resolver(result);
}

function openNotice({ title = "提示", message, confirmText = "确定", cancelText = "", details = "" }) {
  if (noticeResolver) closeNotice(false);
  $("#noticeTitle").textContent = title;
  $("#noticeMessage").textContent = message;
  $("#noticeDetails").hidden = !details;
  $("#noticeDetails").open = false;
  $("#noticeErrorText").textContent = details;
  $("#noticeConfirm").textContent = confirmText;
  $("#noticeCancel").textContent = cancelText;
  $("#noticeCancel").hidden = !cancelText;
  $("#noticeLayer").hidden = false;
  requestAnimationFrame(() => $("#noticeConfirm").focus());
  return new Promise(resolvePromise => noticeResolver = resolvePromise);
}

function confirmNotice(message) {
  return openNotice({ title: "请确认", message, confirmText: "确认", cancelText: "取消" });
}

async function api(path, options) {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const envelope = await response.json();
  if (envelope.code !== 0) throw new Error(envelope.message);
  return envelope.data;
}

function renderTaskProgress(prefix, job) {
  const tab = prefix === 'transcription' ? 'transcription' : 'memory';
  const failed = job.state === 'failed';
  const completed = job.state === 'done' && (prefix !== 'remoteMemory' || job.imported === true);
  tabNotices.set(tab, prefix, failed || completed ? {
    kind: failed ? 'fault' : 'info', id: String(job.id ?? (prefix === 'transcription' ? transcriptionJobId : remoteMemoryJobId) ?? job.message),
    message: failed ? '任务失败，请查看详情并重试' : '任务已完成，请查看结果',
  } : null);
  const progress = $(`#${prefix}Progress`);
  progress.dataset.state = job.state;
  progress.querySelector(".taskProgressTrack span").style.width = `${Math.max(0, Math.min(100, job.percent))}%`;
  $(`#${prefix}Stage`).textContent = job.message;
  $(`#${prefix}Percent`).textContent = `${job.percent}%`;
  if (job.modelState === undefined) return;
  const modelProgress = $(`#${prefix}ModelProgress`);
  modelProgress.hidden = job.modelState === "idle";
  modelProgress.dataset.state = job.modelState;
  modelProgress.querySelector(".taskProgressTrack span").style.width = `${job.modelPercent}%`;
  $(`#${prefix}ModelStage`).textContent = job.modelMessage;
  $(`#${prefix}ModelPercent`).textContent = `${job.modelPercent}%`;
}

async function pollTranscription() {
  if (!transcriptionJobId) return;
  const job = await api(`/admin/api/transcription/${encodeURIComponent(transcriptionJobId)}`);
  renderTaskProgress("transcription", job);
  if (job.state === "running") {
    setTimeout(() => pollTranscription().catch(showError), 650);
    return;
  }
  $("#startTranscription").disabled = !transcriptionSelection;
  $("#cancelTranscription").disabled = true;
  if (job.state !== "done") return;
  $("#rawTranscript").value = job.rawText;
  $("#organizedTranscript").value = job.organizedText;
}

async function pollRemoteMemory() {
  if (!remoteMemoryJobId) return;
  const job = await api(`/admin/api/remote-memory/${encodeURIComponent(remoteMemoryJobId)}`);
  renderTaskProgress("remoteMemory", job);
  if (job.state === "running") {
    setTimeout(() => pollRemoteMemory().catch(showError), 650);
    return;
  }
  $("#startRemoteMemory").disabled = false;
  $("#cancelRemoteMemory").disabled = true;
  if (job.state === "cancelled") {
    remoteMemoryJobId = null;
    return;
  }
  if (job.state !== "done") {
    const reason = job.error || job.message || "未知错误";
    renderTaskProgress("remoteMemory", { ...job, message: `导入失败：${reason}` });
    remoteMemoryJobId = null;
    await openNotice({ title: "一键导入失败", message: reason });
    return;
  }
  renderTaskProgress("remoteMemory", { state: "running", percent: 100, message: "正在导入本地记忆" });
  let result;
  try {
    result = await api(`/admin/api/remote-memory/${encodeURIComponent(remoteMemoryJobId)}/import`, {
      method: "POST",
      body: "{}",
    });
  } catch (error) {
    renderTaskProgress("remoteMemory", { ...job, state: "failed", message: `导入失败：${error.message}` });
    remoteMemoryJobId = null;
    await openNotice({ title: "一键导入失败", message: error.message });
    return;
  }
  memoryLoaded = false;
  const completedJobId = remoteMemoryJobId;
  remoteMemoryJobId = null;
  renderMemoryStatus(result);
  renderTaskProgress("remoteMemory", {
    id: completedJobId,
    imported: true,
    state: "done",
    percent: 100,
    message: `已导入 ${result.total} 封`,
  });
}

function renderStatus(status) {
  $("#statusCards").innerHTML = `
    <article>
      <span>本地服务</span>
      <strong>${status.ready ? "已就绪" : "未就绪"}</strong>
    </article>`;
}

function renderIdentity(identity) {
  $("#offlineUid").value = identity.uid;
  $("#offlineNickname").value = identity.nickname;
  $(".avatar").textContent = Array.from(identity.nickname)[0];
}

function renderMemoryStatus(status) {
  tabNotices.set('memory', 'health', ['failed', 'paused', 'pending'].includes(status.state)
    ? { kind: 'fault', id: status.state, message: status.state === 'failed' ? '记忆整理失败，请重试' : '记忆整理有待处理内容' } : null);
  const progress = $("#memoryProgress");
  const previousState = progress.dataset.state;
  if (status.state === 'idle' && previousState === 'running')
    tabNotices.set('memory', 'finished', { kind: 'info', id: String(Date.now()), message: '记忆整理已完成' });
  progress.dataset.state = status.state;
  progress.className = `memoryProgress ${status.state}`;
  progress.style.display = "grid";
  const labels = {
    idle: "记忆整理完成",
    pending: "等待整理 · 点击继续",
    paused: "整理暂停 · 点击继续",
    running: status.progressStage === "bulk"
      ? "正在整理旧信合集"
      : status.progressTotal
        ? `逐封摘要 ${status.progressCurrent}/${status.progressTotal}`
        : "记忆整理中",
    failed: "记忆整理失败 · 点击重试",
  };
  const label = $(".memoryProgressLabel");
  label.textContent = labels[status.state] ?? "记忆状态未知";
  label.classList.toggle("loadingShine", status.state === "running");
  if (status.state === "running") label.dataset.shine = label.textContent;
  else delete label.dataset.shine;
  const percent = status.state === "idle"
    ? 100
    : Math.max(0, Math.min(100, Number(status.progressPercent) || 0));
  progress.querySelector(".memoryProgressTrack span").style.width = `${percent}%`;
  progress.title = status.state === "failed" ? status.error ?? "记忆整理失败" : "";
  if (status.state === "idle" && previousState && previousState !== "idle" && memoryLoaded)
    loadMemory().catch(showError);
}

function updateClientMountButtons() {
  const busy = clientMountAction !== null;
  $("#mountService").disabled = busy || !clientMountSnapshot?.clientSelected;
  $("#restoreClient").disabled = busy || !clientMountSnapshot?.clientSelected;
  $("#selectClient").disabled = busy;
}

function renderClientMountStatus(status) {
  // A status snapshot is not proof that an unresolved desktop write has stopped.
  if (clientMountAction) { updateClientMountButtons(); return; }
  clientMountSnapshot = status;
  tabNotices.set('desktop', 'health', status.clientSelected && (status.updateAvailable || (!status.mounted && (status.feappMounted || status.webplayerMounted)) || (status.mounted && status.port !== status.servicePort))
    ? { kind: 'fault', id: 'client', message: status.updateAvailable ? '客户端补丁待更新' : '客户端挂载或端口状态异常' } : null);
  tabNotices.set('desktop', 'query', null);
  const badge = $("#serviceMountStatus");
  const partiallyMounted = !status.mounted && (status.feappMounted === true || status.webplayerMounted === true);
  $("#clientExe").value = status.clientExe ?? "";
  badge.className = `mountStatus ${status.mounted || partiallyMounted ? "mounted" : "unmounted"}`;
  badge.textContent = status.updateAvailable ? "客户端补丁待更新" : partiallyMounted ? "服务部分挂载" : status.mounted ? "服务已挂载" : "服务未挂载";
  if (!status.clientSelected) {
    $("#serviceMountDetail").textContent = "请先选择游戏 exe";
  } else if (status.updateAvailable) {
    $("#serviceMountDetail").textContent = `界面补丁 FE ${status.feappRevision ?? status.revision ?? "未确认"}，播放器 WP ${status.webplayerRevision ?? "未确认"}；请更新客户端补丁后再启动游戏`;
  } else if (partiallyMounted) {
    $("#serviceMountDetail").textContent = `客户端状态不一致：FE ${status.feappMounted ? "已挂载" : "未挂载"}，WP ${status.webplayerMounted ? "已挂载" : "未挂载"}`;
  } else if (status.mounted) {
    const synchronized = status.port === status.servicePort;
    $("#serviceMountDetail").textContent = synchronized
      ? ""
      : `客户端端口 ${status.port}，本机服务端口 ${status.servicePort}`;
  } else {
    $("#serviceMountDetail").textContent = `客户端使用原服务，本机服务端口 ${status.servicePort}`;
  }
  $("#mountService").hidden = status.mounted && !status.updateAvailable;
  $("#mountService").textContent = status.updateAvailable ? "更新客户端补丁" : "启用本地服务";
  $("#restoreClient").hidden = !status.mounted && !partiallyMounted;
  updateClientMountButtons();
}

function clientMountErrorMessage(error) {
  return String(error?.message ?? error ?? "未知错误").split(/[\r\n]/u)[0]
    .replace(/Bearer\s+\S+/giu, "Bearer [已隐藏]")
    .replace(/((?:api[_ -]?key|token|password|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1[已隐藏]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[已隐藏]@")
    .replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 240) || "未知错误";
}

async function refreshClientMountStatus({ preserveResult = false } = {}) {
  if (!window.oliviaDesktop || clientMountAction) return null;
  const generation = clientMountGeneration;
  const request = ++clientMountStatusRequest;
  let timer;
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(() => window.oliviaDesktop.getClientStatus())
        .then(status => ({ status }), error => ({ error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), 35_000); }),
    ]);
    if (generation !== clientMountGeneration || request !== clientMountStatusRequest || clientMountAction) return null;
    if (outcome.status) { renderClientMountStatus(outcome.status); return outcome.status; }
    tabNotices.set('desktop', 'query', { kind: 'fault', id: 'query', message: '客户端状态检查失败，请查看详情' });
    if (!preserveResult) $("#serviceMountResult").textContent = outcome.timedOut
      ? "状态查询超时，当前客户端状态尚未确认。"
      : `状态查询失败：${clientMountErrorMessage(outcome.error)}`;
    return null;
  } finally { clearTimeout(timer); }
}

function finishClientMountAction(action, status, error) {
  if (clientMountAction !== action) return;
  clientMountAction = null;
  clientMountGeneration++;
  stopLoading("#serviceMountResult");
  const label = action.kind === "enable" ? "启用" : "停用";
  if (error) {
    $("#serviceMountResult").textContent = `${label}失败：${clientMountErrorMessage(error)}`;
    updateClientMountButtons();
    void refreshClientMountStatus({ preserveResult: true });
    return;
  }
  if (status) renderClientMountStatus(status);
  else updateClientMountButtons();
  const expectedMounted = action.kind === "enable";
  const verified = status?.clientSelected === true && status.clientFound === true && status.webplayerFound === true
    && status.feappMounted === expectedMounted && status.webplayerMounted === expectedMounted
    && (!expectedMounted || (status.mounted === true && !status.updateAvailable));
  $("#serviceMountResult").textContent = verified ? `服务已${label}`
    : `${label}未完成：客户端状态未确认或仍有部分挂载，请检查 FE/WP 状态后重试。`;
}

async function runClientMountAction(kind) {
  if (clientMountAction) return;
  const action = { kind };
  clientMountAction = action;
  clientMountGeneration++;
  updateClientMountButtons();
  if (kind === "disable") {
    try {
      if (!await confirmNotice("确认停用客户端本机信件服务？本机后台仍会继续运行。")) {
        clientMountAction = null;
        clientMountGeneration++;
        updateClientMountButtons();
        return;
      }
    } catch (error) { finishClientMountAction(action, null, error); return; }
  }
  startLoading("#serviceMountResult", kind === "enable" ? "正在检查备份并启用客户端……" : "正在检查备份并恢复客户端……");
  const port = $("#servicePort").value;
  let timer;
  const completion = Promise.resolve().then(() => kind === "enable"
    ? window.oliviaDesktop.mountClient(port) : window.oliviaDesktop.restoreClient())
    .then(status => finishClientMountAction(action, status, null), error => finishClientMountAction(action, null, error))
    .finally(() => clearTimeout(timer));
  await Promise.race([
    completion,
    new Promise(resolve => { timer = setTimeout(() => {
      if (clientMountAction === action) {
        stopLoading("#serviceMountResult");
        $("#serviceMountResult").textContent = `${kind === "enable" ? "启用" : "停用"}等待超时，操作结果尚未确认；请勿重复点击，等待原操作返回。`;
        // Do not release the lock: a UI timeout does not cancel the desktop write.
        updateClientMountButtons();
      }
      resolve();
    }, 120_000); }),
  ]);
}

function resetSecretInput(inputSelector, buttonSelector) {
  $(inputSelector).type = "password";
  $(buttonSelector).classList.remove("isVisible");
  $(buttonSelector).title = "显示 API Key";
  $(buttonSelector).setAttribute("aria-label", "显示 API Key");
}

function renderDeepSeek(profile) {
  $("#apiKey").value = profile.apiKey ?? "";
  $("#apiKey").placeholder = "填写远程接口 API Key";
  resetSecretInput("#apiKey", "#toggleApiKey");
  const custom = profile.model !== "deepseek-v4-pro" || profile.baseUrl !== "https://api.deepseek.com";
  $("#customModel").checked = custom;
  replaceModelOptions("#modelName", [profile.model], profile.model);
  $("#modelBaseUrl").value = profile.baseUrl;
  $("#customFields").hidden = !custom;
}

function renderLocalModel(profile) {
  $("#localApiKey").value = profile.apiKey ?? "";
  resetSecretInput("#localApiKey", "#toggleLocalApiKey");
  replaceModelOptions("#localModelName", [profile.model], profile.model);
  $("#localModelBaseUrl").value = profile.baseUrl;
  $("#localAuthMode").value = profile.authMode;
  $("#localApiKeyField").hidden = profile.authMode !== "bearer";
}

function showModelProfile(provider) {
  document.querySelectorAll("[data-model-profile]").forEach(panel => {
    panel.hidden = panel.dataset.modelProfile !== provider;
  });
  const active = modelConfiguration?.activeProvider;
  $("#activateModelProvider").disabled = provider === active;
  $("#activateModelProvider").textContent = provider === active ? "当前已启用" : "检测并设为当前模型";
}

function renderModelConfig(config, preserveSelection = false) {
  modelConfiguration = config;
  const selected = preserveSelection ? $("#modelProvider").value : config.activeProvider;
  const activeProfile = config.profiles[config.activeProvider];
  const active = $("#activeModelProvider");
  active.dataset.baseText = `当前：${providerLabel(config.activeProvider)} · ${activeProfile.model}`;
  active.textContent = active.dataset.baseText;
  active.title = active.textContent;
  $("#modelProvider").value = selected;
  renderDeepSeek(config.profiles.deepseek);
  renderLocalModel(config.profiles.local);
  showModelProfile(selected);
  if (modelRuntimeSnapshot?.provider === config.activeProvider && modelRuntimeSnapshot.model === activeProfile.model)
    renderModelRuntime(modelRuntimeSnapshot);
}

function toggleSecret(inputSelector, button) {
  const input = $(inputSelector);
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  button.classList.toggle("isVisible", !visible);
  button.title = visible ? "显示 API Key" : "隐藏 API Key";
  button.setAttribute("aria-label", button.title);
}

function deepSeekProfileFromForm() {
  const custom = $("#customModel").checked;
  return {
    provider: "deepseek",
    apiKey: $("#apiKey").value,
    authMode: "bearer",
    model: custom ? $("#modelName").value : "deepseek-v4-pro",
    baseUrl: custom ? $("#modelBaseUrl").value : "https://api.deepseek.com",
  };
}

function localProfileFromForm() {
  return {
    provider: "local",
    apiKey: $("#localApiKey").value,
    authMode: $("#localAuthMode").value,
    model: $("#localModelName").value,
    baseUrl: $("#localModelBaseUrl").value,
  };
}

function renderModelRuntime(status) {
  if (!status?.state) return;
  // A background check is not itself an error; retain a known fault until resolved.
  if (status.state !== 'checking') tabNotices.set('ai', 'health', ['unconfigured', 'unavailable', 'unknown', 'unchecked'].includes(status.state)
    ? { kind: 'fault', id: status.state, message: status.state === 'unavailable' ? '模型连接失败，请检查服务或配置' : '模型配置或连接状态需要确认' } : null);
  else if (status.lastCheck?.state === 'unavailable') tabNotices.set('ai', 'health', {
    kind: 'fault', id: 'unavailable', message: '上次模型检测失败，正在后台复查',
  });
  modelRuntimeSnapshot = status;
  modelRuntimeRequest++;
  clearTimeout(modelRuntimeTimer);
  const labels = { unconfigured: "未配置", unchecked: "配置已保存，待检测", unknown: "状态暂未确认", checking: "后台检测中", available: "可用", unavailable: "不可用" };
  const active = $("#activeModelProvider");
  if (active) {
    const baseText = active.dataset.baseText ?? active.textContent;
    active.dataset.baseText = baseText;
    const historical = status.state === "checking" && status.lastCheck
      ? `上次检测${status.lastCheck.state === "available" ? "可用" : "不可用"} · ` : "";
    active.textContent = `${baseText} · ${historical}${labels[status.state] ?? status.state}`;
    active.title = active.textContent + (status.lastCheck?.checkedAt
      ? `（上次检测：${new Date(status.lastCheck.checkedAt).toLocaleString()}）` : "");
  }
  if (status.state === "checking") modelRuntimeTimer = setTimeout(refreshModelRuntime, 1000);
}

async function refreshModelRuntime() {
  const request = ++modelRuntimeRequest;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const status = await api("/admin/api/model/status", { signal: controller.signal });
    if (request === modelRuntimeRequest) renderModelRuntime(status);
  } catch {
    if (request === modelRuntimeRequest) renderModelRuntime({ ...modelRuntimeSnapshot, state: "unknown" });
  } finally { clearTimeout(timer); }
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function renderStorageStatus(status) {
  const labels = {
    ready: "可用",
    scanning: "正在扫描",
    migrating: "正在迁移",
    insufficient_space: "空间不足",
    unavailable: "路径不可用，继续保留最后有效路径",
    partial: "部分作品路径不可用",
    failed: "处理失败",
  };
  $("#storageState").textContent = labels[status.state] ?? status.state;
  $("#storageConfiguredPath").textContent = status.configuredPath || "尚未读取";
  $("#storageConfiguredPath").title = status.configuredPath || "";
  $("#storageActivePath").textContent = status.activePath || "暂无有效路径";
  $("#storageActivePath").title = status.activePath || "";
  const roots = Array.isArray(status.referencedRoots) ? status.referencedRoots : [];
  const referenced = roots.length
    ? roots.map(root => `${root.path}（${root.works} 个作品，${root.files} 个视频文件${Number.isInteger(root.missing) ? `，${root.missing} 个缺失` : ""}）`).join("\n")
    : "当前数据库没有外部作品引用";
  $("#storageReferencedRoots").textContent = referenced;
  $("#storageReferencedRoots").title = referenced;
  const summaryParts = [
    `${Number(status.workCount ?? 0)} 个作品`,
    `${Number(status.referencedFileCount ?? 0)} 个视频文件`,
    `${Number(status.referencedRootCount ?? roots.length)} 个来源目录`,
  ];
  if (Number.isInteger(status.missingFileCount)) summaryParts.push(`${status.missingFileCount} 个缺失`);
  $("#storageReferenceSummary").textContent = summaryParts.join(" · ");
  $("#storageManagedPath").textContent = status.managedPath || "尚未取得游戏保存路径";
  $("#storageManagedPath").title = status.managedPath || "";
  if (!storageMigrationPreview) $("#storageSpace").textContent = "尚未预览；不会自动迁移";
  $("#storageError").textContent = status.error || "";
}

function stopStorageMigrationPolling() {
  if (storageMigrationPollTimer) clearTimeout(storageMigrationPollTimer);
  storageMigrationPollTimer = null;
}

function renderStorageMigrationJob(job) {
  const progress = $("#storageMigrationProgress");
  const running = job.state === "scanning";
  progress.hidden = false;
  progress.dataset.state = job.state === "ready" ? "done" : job.state;
  const total = Math.max(0, Number(job.totalFiles ?? 0));
  const processed = Math.max(0, Number(job.processedFiles ?? 0));
  const percent = total > 0 ? Math.min(100, Math.round(processed / total * 100)) : 0;
  progress.querySelector(".taskProgressTrack span").style.width = `${percent}%`;
  $("#storageMigrationPercent").textContent = `${percent}%`;
  $("#storageMigrationStage").textContent = running
    ? total > 0 ? `正在扫描 ${processed}/${total} 个视频文件` : "正在收集视频文件"
    : job.state === "ready" ? `预览完成，共 ${job.files} 个视频文件`
      : job.state === "cancelled" ? "预览已取消"
        : job.state === "failed" ? "预览失败" : "等待开始预览";
  $("#previewStorageMigration").disabled = running;
  $("#cancelStorageMigrationPreview").hidden = !running;
  $("#confirmStorageMigration").disabled = job.state !== "ready" || !job.sufficient || job.files === 0;
}

async function pollStorageMigrationPreview() {
  stopStorageMigrationPolling();
  const jobId = storageMigrationPreviewJobId;
  if (!jobId) return;
  const job = await api(`/admin/api/storage/migration/preview/${encodeURIComponent(jobId)}`);
  if (jobId !== storageMigrationPreviewJobId) return;
  renderStorageMigrationJob(job);
  if (job.state === "scanning") {
    storageMigrationPollTimer = setTimeout(() => pollStorageMigrationPreview().catch(showError), 1_000);
    return;
  }
  storageMigrationPreviewJobId = null;
  if (job.state === "ready") {
    storageMigrationPreview = job;
    $("#storageSpace").textContent = job.sufficient
      ? `${job.files} 个视频，需要 ${formatBytes(job.totalBytes)}，可用 ${formatBytes(job.freeBytes)}`
      : `${job.files} 个视频，空间不足 ${formatBytes(job.shortfallBytes)}`;
    $("#storageError").textContent = "预览不会复制文件；确认后才开始迁移";
  } else {
    storageMigrationPreview = null;
    $("#storageError").textContent = job.error || (job.state === "cancelled" ? "已取消迁移预览" : "迁移预览失败");
  }
}

function replaceModelOptions(targetSelector, models, preferred = "") {
  const target = $(targetSelector);
  const values = [...new Set(models.map(value => String(value).trim()).filter(Boolean))];
  target.replaceChildren();
  if (!values.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "尚未查询到模型";
    option.disabled = true;
    option.selected = true;
    target.append(option);
    return;
  }
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.title = value;
    target.append(option);
  }
  target.value = values.includes(preferred) ? preferred : values[0];
}

async function queryModels(provider) {
  const profile = provider === "local" ? localProfileFromForm() : deepSeekProfileFromForm();
  const target = provider === "local" ? "#localModelName" : "#modelName";
  const resultSelector = provider === "local" ? "#localModelResult" : "#deepSeekResult";
  const buttonSelector = provider === "local" ? "#queryLocalModels" : "#queryRemoteModels";
  return runModelOperation({
    buttonSelector,
    resultSelector,
    pendingText: "正在查询模型列表……",
    successText: result => `已查询到 ${result.models.length} 个模型；请选择后保存并测试`,
    failureText: "查询失败",
    operation: async () => {
      const result = await api("/admin/api/model/models", {
        method: "POST",
        body: JSON.stringify(profile),
      });
      if (provider === "deepseek" && !$("#customModel").checked) {
        $("#customModel").checked = true;
        $("#customFields").hidden = false;
      }
      replaceModelOptions(target, result.models, profile.model);
      return result;
    },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function resetImportPreview() {
  previewId = null;
  aiExchanges = [];
  aiImportMetadata = null;
  $("#confirmImport").disabled = true;
  $("#importResult").textContent = "内容已修改，请重新识别";
}

function formatImportPreview(result) {
  const findings = result.findings.length ? `\n\n校验结果：\n${result.findings.join("\n")}` : "";
  const exchanges = result.exchanges.map((exchange, index) =>
    `往来 ${String(index + 1).padStart(2, "0")} · ${exchange.date || "日期未注明"} ${exchange.time || "12:00"}\n\n来信：\n${exchange.incoming}\n\n林离回信：\n${exchange.reply}`)
    .join("\n\n━━━━━━━━━━━━━━━━━━━━\n\n");
  return `共 ${result.exchangeCount} 组往来${findings}\n\n${exchanges}`;
}

async function previewAiExchanges() {
  const result = await api("/admin/api/memory/import/preview", {
    method: "POST",
    body: JSON.stringify({ exchanges: aiExchanges }),
  });
  previewId = result.blocked ? null : "ready";
  $("#confirmImport").disabled = !previewId;
  $("#importResult").textContent = formatImportPreview(result);
  return result;
}

function startLoading(selector, text) {
  const element = $(selector);
  element.textContent = text;
  element.dataset.shine = text;
  element.classList.add("loadingShine");
}

function stopLoading(selector) {
  const element = $(selector);
  element.classList.remove("loadingShine");
  delete element.dataset.shine;
}

function localToday() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function renderMemoryList() {
  $("#memoryList").innerHTML = memoryExchanges.length ? memoryExchanges.map((exchange, index) => {
    const summary = showMemorySummaries && exchange.summary ? `
      <div class="letterSummary">
        <span>逐封摘要 · ${escapeHtml(exchange.contentMd5.slice(0, 8))}</span>
        <p>${escapeHtml(exchange.summary)}</p>
      </div>` : "";
    const videoStatus = exchange.replyVideoUrl
      ? `<a href="${escapeHtml(exchange.replyVideoUrl)}" target="_blank" rel="noreferrer">已上传 MP4</a>`
      : `<span>${exchange.letterId ? "未上传" : "请先确认保存这封信"}</span>`;
    const videoAction = exchange.replyVideoUrl
      ? `<button class="secondary compact danger" type="button" data-action="remove-video">移除视频</button>`
      : `<label class="fileButton">
          加入视频
          <input type="file" data-action="video-file" accept=".mp4,video/mp4" ${exchange.letterId ? "" : "disabled"}>
        </label>`;
    return `<article class="exchangeCard" data-index="${index}">
      <div class="exchangeHead">
        <div class="exchangeTitleActions">
          <strong>往来 ${String(memoryExchanges.length - index).padStart(2, "0")}</strong>
          <div class="exchangeActions">
          <button class="secondary compact" type="button" data-action="insert-above">上方插入</button>
          <button class="secondary compact" type="button" data-action="up" ${index === 0 ? "disabled" : ""} title="上移">↑</button>
          <button class="secondary compact" type="button" data-action="down" ${index === memoryExchanges.length - 1 ? "disabled" : ""} title="下移">↓</button>
          <button class="secondary compact danger" type="button" data-action="remove">删除</button>
          </div>
        </div>
        <div class="exchangeDateTime">
          <input type="date" data-field="date" value="${escapeHtml(exchange.date)}" aria-label="往来日期">
          <input type="time" data-field="time" value="${escapeHtml(exchange.time || "12:00")}" aria-label="往来时间">
        </div>
      </div>
      <div class="exchangeBody">
        <div class="exchangeField">
          <label>来信</label>
          <textarea data-field="incoming">${escapeHtml(exchange.incoming)}</textarea>
        </div>
        <div class="exchangeField">
          <label>林离回信</label>
          <textarea data-field="reply">${escapeHtml(exchange.reply)}</textarea>
        </div>
      </div>
      <div class="videoAttachment">
        <div>
          <strong>视频回信</strong>
          ${videoStatus}
        </div>
        <div class="videoActions">
          ${videoAction}
        </div>
      </div>
      ${summary}
      <div class="cardConfirm">
        <button type="button" data-action="save" ${exchange.dirty ? "" : "hidden"}>确认修改</button>
      </div>
    </article>`;
  }).join("") : `<p class="empty">还没有信件记忆。</p>`;
}

async function loadMemory() {
  const result = await api("/admin/api/memory");
  memoryExchanges = result.exchanges.map(exchange => ({ ...exchange, dirty: false }));
  memoryLoaded = true;
  renderMemoryList();
}

async function saveMemory() {
  for (const exchange of memoryExchanges)
    if (!exchange.time) exchange.time = "12:00";
  const result = await api("/admin/api/memory", {
    method: "POST",
    body: JSON.stringify({ exchanges: memoryExchanges }),
  });
  memoryExchanges.forEach(exchange => exchange.dirty = false);
  renderMemoryList();
  renderMemoryStatus(result);
  $("#memoryResult").textContent = memoryExchanges.length ? "已保存，等待整理" : "";
}

function providerLabel(provider) {
  return provider === "local" ? "本地兼容 API" : "远程兼容 API";
}

function openMidiSongEditor(songId) {
  return window.OliviaSoulSongEditor.open({ baseUrl: "/admin/api", songId, onSaved(metadata) {
    if (!midiStatusSnapshot) return;
    window.OliviaSoulSongEditor.applyMetadata(midiStatusSnapshot.songs, metadata);
    renderMidiStatus(midiStatusSnapshot);
  } });
}

function renderMidiStatus(data) {
  midiStatusSnapshot = data;
  const dataRoot = data.dataRoot
    ? `${data.library?.mode === "reference" ? "当前引用目录" : "当前保存目录"}：${data.dataRoot}`
    : "尚未取得官方作品目录";
  $("#midiDataRoot").textContent = dataRoot;
  $("#midiDataRoot").title = dataRoot;
  const query = $("#midiSongSearch").value.trim().normalize("NFKC").toLocaleLowerCase();
  const list = $("#midiSongList");
  const rows = new Map([...list.querySelectorAll("[data-song-id]")].map(row => [row.dataset.songId, row]));
  const ids = new Set();
  list.querySelector(".empty")?.remove();
  for (const song of data.songs) {
    const id = String(song.id); ids.add(id);
    let row = rows.get(id);
    if (!row) {
      row = document.createElement("article"); row.className = "performanceItem"; row.dataset.songId = id;
      const title = document.createElement("strong"), info = document.createElement("span"), edit = document.createElement("button");
      edit.type = "button"; edit.className = "secondary compact songEditButton"; edit.textContent = "名称 / 时段";
      edit.addEventListener("click", event => { event.stopPropagation(); openMidiSongEditor(id); });
      row.append(title, info, edit); list.append(row);
    }
    row.querySelector("strong").textContent = song.name;
    row.querySelector("span").textContent = `完整视频导入${song.durationUs ? ` · ${Math.round(song.durationUs / 1_000_000)} 秒` : ""}`;
    row.hidden = Boolean(query && !String(song.name).normalize("NFKC").toLocaleLowerCase().includes(query));
  }
  for (const [id, row] of rows) if (!ids.has(id)) row.remove();
  if (!data.songs.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "还没有本地曲目。"; list.append(empty); }
}

async function refreshMidiStatus() {
  renderMidiStatus(await api("/admin/api/midi"));
}

function renderMidiLibraryPreview(preview) {
  $("#midiLibraryPreview").classList.remove("empty");
  $("#midiLibraryPreview").innerHTML = preview.entries.length
    ? preview.entries.map(entry => `
      <article>
        <strong>${escapeHtml(entry.name)}</strong>
        <span>${entry.hasVideo ? `视频 ${entry.variantCount} 个版本` : "缺少官方生成的视频（跳过）"}</span>
      </article>`).join("")
    : '<p class="empty">没有找到可导入的 MIDI 或 MP4。</p>';
}

async function refresh() {
  const [status, identity, modelConfig, memoryStatus, storageStatus] = await Promise.all([
    api("/admin/api/status"),
    api("/admin/api/identity"),
    api("/admin/api/model"),
    api("/admin/api/memory/status"),
    api("/admin/api/storage"),
    refreshModelRuntime(),
  ]);
  renderStatus(status);
  renderIdentity(identity);
  renderModelConfig(modelConfig);
  renderMemoryStatus(memoryStatus);
  renderStorageStatus(storageStatus);
  if (window.oliviaDesktop) await refreshClientMountStatus();
}

async function refreshStatus() {
  const [status, memoryStatus, storageStatus] = await Promise.all([
    api("/admin/api/status"),
    api("/admin/api/memory/status"),
    api("/admin/api/storage"),
  ]);
  renderStatus(status);
  renderMemoryStatus(memoryStatus);
  renderStorageStatus(storageStatus);
  if (!document.querySelector('[data-page="performances"]').hidden) await refreshMidiStatus();
}

async function loadDesktopSettings() {
  if (!window.oliviaDesktop) return;
  $("#desktopSettings").hidden = false;
  $("#serviceMountSettings").hidden = false;
  const [settings] = await Promise.all([
    window.oliviaDesktop.getSettings(),
    refreshClientMountStatus(),
  ]);
  $("#autoStart").checked = settings.autoStart;
  $("#servicePort").value = settings.port;
}

function renderUpdateInformation(data) {
  tabNotices.set('update', 'release', data.updateAvailable
    ? { kind: 'info', id: String(data.latestTag), message: `有新版本 ${data.latestTag}` } : null);
  tabNotices.set('update', 'check', null);
  updateInformation = data;
  $("#updateVersion").textContent = `当前 ${data.currentTag} · GitHub 最新 ${data.latestTag}`;
  $("#downloadUpdate").hidden = !data.updateAvailable;
  $("#updateResult").textContent = data.updateAvailable ? "发现新版本，可以下载"
    : data.currentTag !== data.latestTag ? "当前版本高于 GitHub 公开版，无需更新" : "当前已经是最新版本";
  updateDownloadUI.setRelease(data);
}

async function loadUpdate() {
  startLoading("#updateResult", "正在查询 GitHub Release……");
  try {
    renderUpdateInformation(await api("/admin/api/update"));
  } catch (error) {
    tabNotices.set('update', 'check', { kind: 'fault', id: 'check', message: '更新检查失败，可进入页面重试' });
    throw error;
  } finally {
    stopLoading("#updateResult");
    await updateDownloadUI.refresh();
  }
}

function renderDebug(data) {
  $("#debugDelay").value = data.delaySeconds;
  $("#debugDelayLabel").textContent = `回信最小延迟（${data.delaySeconds}秒）`;
  $("#debugDailyLetterLimit").value = data.dailyLetterLimit;
  $("#debugQuotaStatus").textContent = `今天还可发送 ${Number(data.remainingToday) || 0} 封（上限 ${data.dailyLetterLimit}）`;
  const show = $("#showSummaries").checked;
  $("#debugSummaries").hidden = !show;
  if (!show) return;
  $("#bulkSummarySection").hidden = !data.bulkSummary;
  $("#bulkSummary").textContent = data.bulkSummary;
}

async function loadDebug() {
  renderDebug(await api("/admin/api/debug"));
}

$("#noticeConfirm").addEventListener("click", () => closeNotice(true));
$("#noticeCancel").addEventListener("click", () => closeNotice(false));
$("#noticeClose").addEventListener("click", () => closeNotice(false));
document.addEventListener("keydown", event => {
  const target = event.target;
  const editable = target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target.isContentEditable;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !editable) {
    event.preventDefault();
    return;
  }
  if ($("#noticeLayer").hidden) return;
  if (event.key === "Escape") closeNotice(false);
  if (event.key === "Enter") closeNotice(true);
});
document.querySelectorAll(".sideTab").forEach(button => {
  button.addEventListener("click", safely(async () => {
    tabNotices.visit(button.dataset.tab);
    document.querySelectorAll(".sideTab").forEach(tab => tab.classList.toggle("active", tab === button));
    document.querySelectorAll(".tabPage").forEach(page => page.hidden = page.dataset.page !== button.dataset.tab);
    const content = document.querySelector(".content");
    if (content) content.scrollTop = 0;
    updateDownloadUI.setVisible(button.dataset.tab === "update");
    if (button.dataset.tab === "memory" && !memoryLoaded) await loadMemory();
    if (button.dataset.tab === "performances") await refreshMidiStatus();
    if (button.dataset.tab === "update" && !updateInformation) await loadUpdate();
    if (button.dataset.tab === "debug") await loadDebug();
  }));
});
document.querySelectorAll(".memoryTab").forEach(button => {
  button.addEventListener("click", safely(async () => {
    document.querySelectorAll(".memoryTab").forEach(tab => tab.classList.toggle("active", tab === button));
    document.querySelectorAll(".memoryView").forEach(view => view.hidden = view.dataset.memoryView !== button.dataset.memoryTab);
    if (button.dataset.memoryTab === "manage" && !memoryLoaded) await loadMemory();
  }));
});
$("#selectTranscriptionMedia").addEventListener("click", safely(async () => {
  if (!window.oliviaDesktop?.selectMediaFile) {
    $("#transcriptionMediaFile").click();
    return;
  }
  const selected = await window.oliviaDesktop.selectMediaFile();
  if (selected.cancelled) return;
  transcriptionSelection = { path: selected.path, name: selected.name };
  $("#transcriptionFileName").textContent = selected.name;
  $("#startTranscription").disabled = false;
}));
$("#selectMidiLibrary").addEventListener("click", safely(async () => {
  if (!window.oliviaDesktop?.selectLibraryFolder) {
    $("#midiLibraryRoot").focus();
    return;
  }
  const selected = await window.oliviaDesktop.selectLibraryFolder($("#midiLibraryRoot").value.trim());
  if (!selected.cancelled) $("#midiLibraryRoot").value = selected.path;
}));
$("#openMidiLibraryFolder").addEventListener("click", safely(async () => {
  const path = $("#midiLibraryRoot").value.trim();
  if (!path) throw new Error("请先选择曲库文件夹");
  if (!window.oliviaDesktop?.openDirectory) throw new Error("当前运行方式不支持打开目录");
  const result = await window.oliviaDesktop.openDirectory(path);
  if (result?.error) throw new Error(result.error);
}));
$("#previewMidiLibrary").addEventListener("click", safely(async () => {
  const root = $("#midiLibraryRoot").value.trim();
  if (!root) throw new Error("请先选择曲库文件夹");
  $("#previewMidiLibrary").disabled = true;
  startLoading("#midiLibraryResult", "正在扫描曲库……");
  try {
    const preview = await api("/admin/api/midi-library/preview", {
      method: "POST",
      body: JSON.stringify({ root }),
    });
    midiLibraryPreviewId = preview.previewId;
    renderMidiLibraryPreview(preview);
    $("#confirmMidiLibrary").disabled = preview.total === 0;
    $("#midiLibraryResult").textContent = `找到 ${preview.total} 首曲目`;
  } finally {
    $("#previewMidiLibrary").disabled = false;
    stopLoading("#midiLibraryResult");
  }
}));
$("#confirmMidiLibrary").addEventListener("click", safely(async () => {
  if (!midiLibraryPreviewId) throw new Error("请先扫描曲库");
  $("#confirmMidiLibrary").disabled = true;
  startLoading("#midiLibraryResult", "正在导入曲库……");
  try {
    const result = await api("/admin/api/midi-library/confirm", {
      method: "POST",
      body: JSON.stringify({ previewId: midiLibraryPreviewId }),
    });
    midiLibraryPreviewId = null;
    $("#midiLibraryResult").textContent = `导入 ${result.imported} 首，跳过重复 ${result.skipped} 首`;
    await refreshMidiStatus();
  } finally {
    stopLoading("#midiLibraryResult");
  }
}));
$("#refreshMidiStatus").addEventListener("click", safely(refreshMidiStatus));
$("#refreshStorage").addEventListener("click", safely(async () => {
  storageMigrationPreview = null;
  $("#confirmStorageMigration").disabled = true;
  renderStorageStatus(await api("/admin/api/storage/refresh", { method: "POST", body: "{}" }));
}));
$("#previewStorageMigration").addEventListener("click", safely(async () => {
  storageMigrationPreview = null;
  $("#confirmStorageMigration").disabled = true;
  $("#storageError").textContent = "正在只读扫描，不会复制文件";
  const started = await api("/admin/api/storage/migration/preview", { method: "POST", body: "{}" });
  storageMigrationPreviewJobId = started.jobId;
  renderStorageMigrationJob(started);
  pollStorageMigrationPreview().catch(showError);
}));
$("#cancelStorageMigrationPreview").addEventListener("click", safely(async () => {
  if (!storageMigrationPreviewJobId) return;
  const jobId = storageMigrationPreviewJobId;
  const cancelled = await api(
    `/admin/api/storage/migration/preview/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST", body: "{}" },
  );
  if (jobId !== storageMigrationPreviewJobId) return;
  stopStorageMigrationPolling();
  storageMigrationPreviewJobId = null;
  storageMigrationPreview = null;
  renderStorageMigrationJob(cancelled);
  $("#storageError").textContent = "已取消迁移预览；没有复制或修改任何文件";
}));
$("#confirmStorageMigration").addEventListener("click", safely(async () => {
  if (!storageMigrationPreview) throw new Error("请先预览迁移内容");
  const accepted = await confirmNotice(
    `确认复制 ${storageMigrationPreview.files} 个视频到统一目录？来源文件会继续保留，迁移完成前数据库不会切换。`,
  );
  if (!accepted) return;
  $("#confirmStorageMigration").disabled = true;
  startLoading("#storageError", "正在复制并校验视频……");
  try {
    const result = await api("/admin/api/storage/migration/confirm", {
      method: "POST",
      body: JSON.stringify({ token: storageMigrationPreview.token, confirmed: true }),
    });
    storageMigrationPreview = null;
    $("#storageSpace").textContent = `已迁移 ${result.migrated} 首，跳过 ${result.skipped} 个已有文件`;
    renderStorageStatus(await api("/admin/api/storage"));
  } finally {
    stopLoading("#storageError");
  }
}));
$("#midiSongSearch").addEventListener("input", () => {
  if (midiStatusSnapshot) renderMidiStatus(midiStatusSnapshot);
});
function isEditableTextTarget(target) {
  return target instanceof Element && Boolean(target.closest("input, textarea, [contenteditable='true'], [contenteditable='plaintext-only']"));
}

document.addEventListener("contextmenu", event => {
  if (!isEditableTextTarget(event.target)) event.preventDefault();
});
window.addEventListener("beforeunload", stopStorageMigrationPolling);
$("#transcriptionMediaFile").addEventListener("change", event => {
  const file = event.target.files[0];
  if (!file) return;
  transcriptionSelection = { file, name: file.name };
  $("#transcriptionFileName").textContent = file.name;
  $("#startTranscription").disabled = false;
});
$("#startTranscription").addEventListener("click", safely(async () => {
  if (!transcriptionSelection) throw new Error("请先选择视频或音频");
  $("#startTranscription").disabled = true;
  $("#selectTranscriptionMedia").disabled = true;
  $("#cancelTranscription").disabled = false;
  $("#rawTranscript").value = "";
  $("#organizedTranscript").value = "";
  renderTaskProgress("transcription", {
    state: "running",
    percent: 0,
    message: "正在创建转写任务",
    modelState: "idle",
    modelPercent: 0,
    modelMessage: "",
  });
  try {
    const job = transcriptionSelection.file
      ? await api(`/admin/api/transcription/upload?name=${encodeURIComponent(transcriptionSelection.name)}`, {
        method: "POST",
        headers: { "Content-Type": transcriptionSelection.file.type || "application/octet-stream" },
        body: transcriptionSelection.file,
      })
      : await api("/admin/api/transcription", {
        method: "POST",
        body: JSON.stringify({ path: transcriptionSelection.path }),
      });
    transcriptionJobId = job.id;
    renderTaskProgress("transcription", job);
    pollTranscription().catch(showError);
  } finally {
    $("#selectTranscriptionMedia").disabled = false;
    if (!transcriptionJobId) {
      $("#startTranscription").disabled = false;
      $("#cancelTranscription").disabled = true;
    }
  }
}));
$("#cancelTranscription").addEventListener("click", safely(async () => {
  if (!transcriptionJobId) return;
  renderTaskProgress("transcription", await api(
    `/admin/api/transcription/${encodeURIComponent(transcriptionJobId)}/cancel`,
    { method: "POST", body: "{}" },
  ));
}));
$("#startRemoteMemory")?.addEventListener("click", safely(async () => {
  if (!await confirmNotice("远端记忆会覆盖当前记忆。是否继续？")) return;
  $("#startRemoteMemory").disabled = true;
  $("#cancelRemoteMemory").disabled = false;
  renderTaskProgress("remoteMemory", {
    state: "running",
    percent: 0,
    message: "正在读取远端记忆",
    modelState: "idle",
    modelPercent: 0,
    modelMessage: "",
  });
  try {
    const job = await api("/admin/api/remote-memory", { method: "POST", body: "{}" });
    remoteMemoryJobId = job.id;
    renderTaskProgress("remoteMemory", job);
    pollRemoteMemory().catch(showError);
  } finally {
    if (!remoteMemoryJobId) {
      $("#startRemoteMemory").disabled = false;
      $("#cancelRemoteMemory").disabled = true;
    }
  }
}));
$("#cancelRemoteMemory")?.addEventListener("click", safely(async () => {
  if (!remoteMemoryJobId) return;
  renderTaskProgress("remoteMemory", await api(
    `/admin/api/remote-memory/${encodeURIComponent(remoteMemoryJobId)}/cancel`,
    { method: "POST", body: "{}" },
  ));
}));
$("#memoryProgress").addEventListener("click", safely(async () => {
  if (!["pending", "paused", "failed"].includes($("#memoryProgress").dataset.state)) return;
  renderMemoryStatus({ state: "running", error: null });
  renderMemoryStatus(await api("/admin/api/memory/refresh", { method: "POST", body: "{}" }));
}));
$("#toggleApiKey").addEventListener("click", event => {
  toggleSecret("#apiKey", event.currentTarget);
});
$("#toggleLocalApiKey").addEventListener("click", event => {
  toggleSecret("#localApiKey", event.currentTarget);
});
$("#modelProvider").addEventListener("change", event => showModelProfile(event.target.value));
$("#resetModelConfig").addEventListener("click", safely(async event => {
  const button = event.currentTarget;
  if (!await confirmNotice("确认清除当前保存的模型、接口与 API Key？信件、数据库、曲库和媒体不会被删除。")) return;
  button.disabled = true;
  $("#resetModelResult").textContent = "正在清除……";
  try {
    renderModelConfig(await api("/admin/api/models/reset", { method: "POST", body: "{}" }));
    await refreshModelRuntime();
    $("#resetModelResult").textContent = "模型配置已清除";
  } finally {
    button.disabled = false;
  }
}));
$("#localAuthMode").addEventListener("change", event => {
  $("#localApiKeyField").hidden = event.target.value !== "bearer";
});
$("#customModel").addEventListener("change", event => {
  $("#customFields").hidden = !event.target.checked;
});
$("#autoStart").addEventListener("change", safely(async event => {
  const requested = event.target.checked;
  try {
    event.target.checked = (await window.oliviaDesktop.setAutoStart(requested)).autoStart;
  } catch (error) {
    event.target.checked = !requested;
    throw error;
  }
}));
$("#checkUpdate").addEventListener("click", safely(async () => {
  await loadUpdate();
}));
$("#downloadUpdate").addEventListener("click", safely(async () => {
  await updateDownloadUI.start();
}));
$("#cancelUpdateDownload").addEventListener("click", safely(async () => {
  await updateDownloadUI.cancel();
}));
$("#pauseUpdateDownload").addEventListener("click", safely(async () => {
  await updateDownloadUI.pause();
}));
$("#showSummaries").addEventListener("change", safely(async event => {
  showMemorySummaries = event.target.checked;
  if (showMemorySummaries) await Promise.all([loadDebug(), loadMemory()]);
  else $("#debugSummaries").hidden = true;
  renderMemoryList();
}));
$("#debugDelay").addEventListener("change", safely(async () => {
  const result = await api("/admin/api/debug/delay", {
    method: "POST",
    body: JSON.stringify({ seconds: Number($("#debugDelay").value) }),
  });
  $("#debugDelay").value = result.delaySeconds;
  $("#debugDelayLabel").textContent = `回信最小延迟（${result.delaySeconds}秒）`;
  $("#debugDelayResult").textContent = "";
}));
$("#defaultDebugDelay").addEventListener("click", safely(async () => {
  const result = await api("/admin/api/debug/delay/default", { method: "POST", body: "{}" });
  $("#debugDelay").value = result.delaySeconds;
  $("#debugDelayLabel").textContent = `回信最小延迟（${result.delaySeconds}秒）`;
  $("#debugDelayResult").textContent = "已恢复默认";
}));
$("#resetTodayQuota").addEventListener("click", safely(async () => {
  if (!await confirmNotice("确认重置今天的信件次数？")) return;
  const result = await api("/admin/api/debug/quota/reset", { method: "POST", body: "{}" });
  renderDebug({ ...(await api("/admin/api/debug")), ...result });
  $("#debugQuotaResult").textContent = "今日计数已重置";
}));
$("#saveDailyLetterLimit").addEventListener("click", safely(async () => {
  const result = await api("/admin/api/debug/quota/limit", {
    method: "POST",
    body: JSON.stringify({ limit: Number($("#debugDailyLetterLimit").value) }),
  });
  renderDebug({ ...(await api("/admin/api/debug")), ...result });
  $("#debugQuotaResult").textContent = result.dailyLetterLimit === 0 ? "已设为当天不能写信" : "上限已保存";
}));
$("#selectClient").addEventListener("click", safely(async () => {
  if (clientMountAction) return;
  const generation = clientMountGeneration;
  const status = await window.oliviaDesktop.selectClient();
  if (clientMountAction || generation !== clientMountGeneration) return;
  clientMountGeneration++;
  renderClientMountStatus(status);
  if (status.selectionChanged) $("#serviceMountResult").textContent = "已选择客户端";
}));
$("#mountService").addEventListener("click", safely(() => runClientMountAction("enable")));
$("#restoreClient").addEventListener("click", safely(() => runClientMountAction("disable")));
const saveIdentity = safely(async () => {
  const identity = await api("/admin/api/identity", {
    method: "POST",
    body: JSON.stringify({
      uid: $("#offlineUid").value,
      nickname: $("#offlineNickname").value,
    }),
  });
  renderIdentity(identity);
  $("#identityResult").textContent = "已自动保存";
});
$("#offlineUid").addEventListener("change", saveIdentity);
$("#offlineNickname").addEventListener("change", saveIdentity);
$("#queryRemoteModels").addEventListener("click", safely(() => queryModels("deepseek")));
$("#testDeepSeek").addEventListener("click", safely(() => runModelOperation({
  buttonSelector: "#testDeepSeek",
  resultSelector: "#deepSeekResult",
  pendingText: "正在测试……",
  successText: "连接成功，配置已保存",
  failureText: "测试失败",
  operation: async () => {
    const result = await api("/admin/api/model/test-save", {
      method: "POST",
      body: JSON.stringify(deepSeekProfileFromForm()),
    });
    renderModelConfig(result.config, true);
    await refreshModelRuntime();
    return result;
  },
})));
$("#queryLocalModels").addEventListener("click", safely(() => queryModels("local")));
$("#testLocalModel").addEventListener("click", safely(() => runModelOperation({
  buttonSelector: "#testLocalModel",
  resultSelector: "#localModelResult",
  pendingText: "正在测试……",
  successText: "连接成功，配置已保存",
  failureText: "测试失败",
  operation: async () => {
    const result = await api("/admin/api/model/test-save", {
      method: "POST",
      body: JSON.stringify(localProfileFromForm()),
    });
    renderModelConfig(result.config, true);
    await refreshModelRuntime();
    return result;
  },
})));
$("#detectActiveModel").addEventListener("click", safely(async () => {
  const button = $("#detectActiveModel");
  if (button.disabled) return;
  button.disabled = true;
  try {
    await api("/admin/api/model/detect", { method: "POST", body: "{}" });
  } finally {
    await refreshModelRuntime();
    button.disabled = false;
  }
}));
$("#activateModelProvider").addEventListener("click", safely(() => {
  const provider = $("#modelProvider").value;
  return runModelOperation({
    buttonSelector: "#activateModelProvider",
    resultSelector: provider === "local" ? "#localModelResult" : "#deepSeekResult",
    pendingText: "正在检测已保存的模型……",
    successText: "检测成功，已设为当前模型",
    failureText: "启用失败",
    operation: async () => {
      const result = await api("/admin/api/model/activate", {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      renderModelConfig(result, true);
      await refreshModelRuntime();
      return result;
    },
  });
}));
$("#importContent").addEventListener("input", resetImportPreview);
$("#aiImport").addEventListener("click", safely(async () => {
  $("#aiImport").disabled = true;
  $("#confirmImport").disabled = true;
  previewId = null;
  aiExchanges = [];
  aiImportMetadata = null;
  let recognized = false;
  startLoading("#aiImportResult", "正在识别信件……");
  try {
    const result = await api("/admin/api/import/ai", {
      method: "POST",
      body: JSON.stringify({ content: $("#importContent").value }),
    });
    aiExchanges = result.exchanges;
    aiImportMetadata = {
      person: result.person,
      source: result.source,
      order: result.order,
      oldMemory: result.oldMemory,
    };
    recognized = true;
    startLoading("#aiImportResult", `已识别 ${aiExchanges.length} 组，正在校验……`);
    const preview = await previewAiExchanges();
    $("#aiImportResult").textContent = preview.blocked
      ? "识别结果未通过校验"
      : `AI 识别完成，已列出 ${aiExchanges.length} 组往来`;
  } catch (error) {
    $("#confirmImport").disabled = true;
    $("#importResult").textContent = error.message;
    $("#aiImportResult").textContent = recognized ? "识别结果格式不合法" : "识别失败";
    throw error;
  } finally {
    $("#aiImport").disabled = false;
    stopLoading("#aiImportResult");
  }
}));
$("#confirmImport").addEventListener("click", safely(async () => {
  if (!previewId) throw new Error("请先完成 AI 识别");
  $("#aiImport").disabled = true;
  $("#confirmImport").disabled = true;
  startLoading("#aiImportResult", "正在导入并整理记忆……");
  try {
    const result = await api("/admin/api/memory/import", {
      method: "POST",
      body: JSON.stringify({ ...aiImportMetadata, exchanges: aiExchanges }),
    });
    previewId = null;
    aiExchanges = [];
    aiImportMetadata = null;
    $("#importContent").value = "";
    $("#importResult").textContent = `导入完成：记忆新增 ${result.imported}，信箱新增 ${result.mailboxImported}，跳过 ${result.skipped}`;
    $("#aiImportResult").textContent = result.state === "running" ? "导入完成，记忆正在整理" : "导入完成";
    renderMemoryStatus(result);
    memoryLoaded = false;
    document.querySelector('[data-memory-tab="manage"]').click();
  } finally {
    $("#aiImport").disabled = false;
    $("#confirmImport").disabled = !previewId;
    stopLoading("#aiImportResult");
  }
}));
$("#selectSoul").addEventListener("click", () => $("#soulFile").click());
$("#soulFile").addEventListener("change", safely(async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".soul")) {
    event.target.value = "";
    throw new Error("请选择 .soul 文件");
  }
  const firstConfirmed = await openNotice({
    title: ".soul 导入",
    message: "将覆盖当前全部记忆",
    confirmText: "继续",
    cancelText: "取消",
  });
  if (!firstConfirmed) {
    event.target.value = "";
    return;
  }
  const secondConfirmed = await openNotice({
    title: "再次确认",
    message: ".soul导入是覆盖式的！确保您已没有要保留的记忆！",
    confirmText: "确认覆盖",
    cancelText: "取消",
  });
  if (!secondConfirmed) {
    event.target.value = "";
    return;
  }
  $("#selectSoul").disabled = true;
  startLoading("#soulImportResult", "正在覆盖导入 .soul 信件与视频……");
  try {
    const result = await api("/admin/api/memory/import/soul", {
      method: "POST",
      headers: { "Content-Type": "application/x-olivia-soul" },
      body: file,
    });
    $("#soulImportResult").textContent = result.state === "running"
      ? `已覆盖 ${result.total} 组记忆和 ${result.videosImported} 个视频，正在整理`
      : `已覆盖 ${result.total} 组记忆和 ${result.videosImported} 个视频`;
    renderMemoryStatus(result);
    memoryLoaded = false;
    document.querySelector('[data-memory-tab="manage"]').click();
  } finally {
    event.target.value = "";
    $("#selectSoul").disabled = false;
    stopLoading("#soulImportResult");
  }
}));
$("#exportMemory").addEventListener("click", safely(async () => {
  if (!window.oliviaDesktop?.exportSoul) {
    $("#memoryResult").textContent = "请在桌面版中导出 .soul";
    return;
  }
  try {
    const result = await window.oliviaDesktop.exportSoul();
    $("#memoryResult").textContent = result.cancelled ? "已取消导出" : `已导出到 ${result.path}`;
  } catch (error) {
    if (error.message.includes("暂无记忆")) {
      $("#memoryResult").textContent = "无记忆可导出";
      return;
    }
    throw error;
  }
}));
$("#newMemoryExchange").addEventListener("click", () => {
  memoryExchanges.unshift({
    date: localToday(),
    time: "12:00",
    incoming: "",
    reply: "",
    replyLabel: "回信",
    dirty: true,
  });
  renderMemoryList();
  $("#memoryList .exchangeCard:first-child textarea").focus();
});
$("#memoryList").addEventListener("input", event => {
  const field = event.target.dataset.field;
  if (!field) return;
  const index = Number(event.target.closest(".exchangeCard").dataset.index);
  memoryExchanges[index][field] = event.target.value;
  memoryExchanges[index].dirty = true;
  memoryExchanges[index].summary = "";
  memoryExchanges[index].contentMd5 = "";
  event.target.closest(".exchangeCard").querySelector('[data-action="save"]').hidden = false;
});
$("#memoryList").addEventListener("change", safely(async event => {
  if (event.target.dataset.action !== "video-file") return;
  const file = event.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".mp4")) throw new Error("请选择 MP4 视频");
  if (file.size > 512 * 1024 * 1024) throw new Error("视频不能超过 512 MB");
  const index = Number(event.target.closest(".exchangeCard").dataset.index);
  const exchange = memoryExchanges[index];
  const result = await api(`/admin/api/letters/${encodeURIComponent(exchange.letterId)}/video`, {
    method: "POST",
    headers: { "Content-Type": "video/mp4" },
    body: file,
  });
  exchange.replyVideoUrl = result.replyVideoUrl;
  renderMemoryList();
  $("#memoryResult").textContent = "视频已上传";
}));
$("#memoryList").addEventListener("click", safely(async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const index = Number(button.closest(".exchangeCard").dataset.index);
  if (button.dataset.action === "save") return saveMemory();
  if (button.dataset.action === "insert-above") {
    memoryExchanges.splice(index, 0, {
      date: localToday(),
      time: "12:00",
      incoming: "",
      reply: "",
      replyLabel: "回信",
      dirty: true,
    });
    renderMemoryList();
    document.querySelector(`.exchangeCard[data-index="${index}"] textarea`).focus();
    return;
  }
  if (button.dataset.action === "remove") {
    if (!await confirmNotice("确认删除这组往来？")) return;
    memoryExchanges.splice(index, 1);
    return saveMemory();
  }
  if (button.dataset.action === "remove-video") {
    if (!await confirmNotice("确认移除这封信的视频？")) return;
    await api(`/admin/api/letters/${encodeURIComponent(memoryExchanges[index].letterId)}/video`, { method: "DELETE" });
    memoryExchanges[index].replyVideoUrl = null;
    renderMemoryList();
    $("#memoryResult").textContent = "视频已移除";
    return;
  }
  if (button.dataset.action === "up" && index > 0)
    [memoryExchanges[index - 1], memoryExchanges[index]] = [memoryExchanges[index], memoryExchanges[index - 1]];
  if (button.dataset.action === "down" && index < memoryExchanges.length - 1)
    [memoryExchanges[index + 1], memoryExchanges[index]] = [memoryExchanges[index], memoryExchanges[index + 1]];
  await saveMemory();
}));

function showError(error) {
  void openNotice({ title: "操作失败", message: error.message });
}

Promise.all([refresh(), loadDesktopSettings()]).catch(showError);
// One quiet release check per page load; never downloads or installs automatically.
void loadUpdate().catch(() => {});
setInterval(() => refreshStatus().catch(console.error), 5000);
