// One source is served by admin and embedded in the game archive by the patcher.
(function (global) {
  "use strict";
  const document = global.document;
  const slots = [["TOD12", "白天（TOD12）", "06:00–16:00"], ["TOD1730", "傍晚（TOD1730）", "16:00–20:00"], ["TOD20", "夜晚（TOD20）", "20:00–06:00"]];
  const pendingNameSyncMessage = "曲名已永久保存，旧版视频匹配信息正在后台补全";
  let active = null, toast = null, toastTimer = null;
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }
  function stableId(item) {
    if (!item) return "";
    const match = String(item.videoUrl || item.mediaUrl || "").match(/\/toy\/midi\/songs\/([^/?#]+)/);
    if (match) { try { return decodeURIComponent(match[1]); } catch { return ""; } }
    return String(item.songId || item.id || item.itemId || "");
  }
  function applyMetadata(items, metadata) {
    if (!metadata || !metadata.id || typeof metadata.name !== "string") return;
    for (const item of items || []) {
      if (!item || stableId(item) !== String(metadata.id)) continue;
      // Display fields only: never change media URLs, IDs, name keys or playback.
      item.name = metadata.name;
      if ("originalName" in metadata) item.originalName = metadata.originalName;
      if ("customName" in metadata) item.customName = metadata.customName;
      if ("correctedName" in metadata) item.correctedName = metadata.correctedName;
    }
  }
  function clearToast() {
    if (toastTimer !== null) global.clearTimeout(toastTimer);
    toastTimer = null; toast?.remove(); toast = null;
  }
  function showToast(message) {
    clearToast();
    const notice = node("p", message, "ose-toast");
    notice.setAttribute("role", "status");
    document.body.append(notice); toast = notice;
    toastTimer = global.setTimeout(() => { if (toast === notice) clearToast(); }, 6000);
  }
  function installStyles() {
    if (document.getElementById("olivia-song-editor-style")) return;
    const style = node("style"); style.id = "olivia-song-editor-style";
    style.textContent = `
      .ose-overlay { position:fixed; inset:0; z-index:2147483000; display:grid; place-items:center; padding:16px; background:#000b; box-sizing:border-box; }
      .ose-dialog { width:min(800px,100%); min-width:0; max-height:calc(100dvh - 32px); display:flex; flex-direction:column; overflow:hidden; box-sizing:border-box; background:var(--tp-surface-1,#232529); color:var(--tp-text-title,#f1eee9); border:1px solid var(--tp-grey-4,#51545c); border-radius:16px; box-shadow:0 20px 70px #0008; color-scheme:dark; font:400 14px/1.5 system-ui,"Microsoft YaHei","PingFang SC",sans-serif; overflow-wrap:anywhere; user-select:text; text-align:left; }
      .ose-dialog * { box-sizing:border-box; min-width:0; font-family:inherit; }
      .ose-dialog__content { min-height:0; overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; scrollbar-width:thin; scrollbar-color:#51545c #232529; padding:20px 22px 12px; }
      .ose-dialog__content::-webkit-scrollbar { width:10px; height:10px; }
      .ose-dialog__content::-webkit-scrollbar-thumb { border:2px solid var(--tp-surface-1,#232529); border-radius:8px; background:#51545c; }
      .ose-dialog h2 { margin:0; font:650 20px/1.25 system-ui,"Microsoft YaHei","PingFang SC",sans-serif; color:var(--tp-text-title,#f1eee9); }
      .ose-dialog .ose-status { margin:6px 0 0; font-size:13px; font-weight:400; line-height:1.5; color:var(--tp-text-secondary,#b8b4ae); word-break:break-word; }
      .ose-dialog label { display:block; margin:0; color:var(--tp-text-body,#dedad3); font-size:14px; line-height:1.5; font-weight:600; }
      .ose-name-row { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:18px; }
      .ose-restore { flex:0 0 auto; }
      .ose-name-input { margin-top:8px; }
      .ose-dialog input,.ose-dialog select { width:100%; min-width:0; padding:10px; border:1px solid var(--tp-grey-4,#51545c); border-radius:8px; background:var(--tp-surface-2,#121214); color:var(--tp-text-title,#f1eee9); font:inherit; }
      .ose-dialog button { width:auto; min-height:40px; flex-shrink:0; padding:8px 13px; border:1px solid var(--tp-grey-4,#51545c); border-radius:8px; background:var(--tp-surface-2,#121214); color:var(--tp-text-body,#dedad3); font:inherit; white-space:nowrap; cursor:pointer; }
      .ose-dialog button:disabled { opacity:.5; cursor:wait; }
      .ose-dialog button[data-primary] { background:var(--tp-primary-2,#d8cfc4); color:var(--tp-grey-0,#17181c); border-color:var(--tp-primary-2,#d8cfc4); }
      .ose-dialog summary { padding:10px 0; color:var(--tp-text-title,#f1eee9); font-size:14px; font-weight:600; line-height:1.5; cursor:pointer; }
      .ose-time-settings { margin-top:18px; border-top:1px solid var(--tp-grey-4,#51545c); }
      .ose-dialog details details { margin-top:8px; border-top:1px solid var(--tp-grey-4,#51545c); }
      .ose-dialog video { display:block; width:100%; height:auto; aspect-ratio:16/9; object-fit:contain; margin:8px 0; background:#111; }
      .ose-actions { display:flex; flex:0 0 auto; flex-wrap:wrap; justify-content:flex-end; gap:8px; padding:12px 22px 20px; border-top:1px solid var(--tp-grey-4,#51545c); background:var(--tp-surface-1,#232529); }
      .ose-permanent { margin-right:auto; }
      .ose-error { margin:12px 0 0; color:var(--tp-el-color-danger,#f08c8c)!important; word-break:break-word; }
      .ose-error:empty { display:none; }
      .ose-dialog .ose-sync-status { margin:12px 0 0; color:var(--tp-text-secondary,#b8b4ae); font-size:13px; line-height:1.5; }
      .ose-sync-status:empty { display:none; }
      .ose-toast { position:fixed; left:50%; bottom:20px; transform:translateX(-50%); z-index:2147483001; width:max-content; max-width:calc(100vw - 32px); margin:0; padding:12px 16px; box-sizing:border-box; border:1px solid var(--tp-grey-4,#51545c); border-radius:10px; background:var(--tp-surface-1,#232529); color:var(--tp-text-body,#dedad3); box-shadow:0 8px 24px #0006; font:400 13px/1.5 system-ui,"Microsoft YaHei","PingFang SC",sans-serif; text-align:left; overflow-wrap:anywhere; pointer-events:none; }
      .ose-dialog .ose-help,.ose-dialog .ose-preview-status { margin:8px 0; color:var(--tp-text-secondary,#b8b4ae); font-size:12px; line-height:1.5; font-weight:400; }
      .ose-preview-status:empty { display:none; }
      .ose-dialog :focus-visible { outline:2px solid var(--tp-primary-2,#d8cfc4); outline-offset:2px; }
      @media(max-width:420px) { .ose-overlay { padding:8px; } .ose-dialog { max-height:calc(100dvh - 16px); } .ose-dialog__content { padding:16px 16px 10px; } .ose-actions { padding:10px 16px 16px; } .ose-name-row { align-items:flex-start; flex-wrap:wrap; gap:8px; } }
    `;
    document.head.append(style);
  }
  function open({ baseUrl, songId, onSaved } = {}) {
    if (active) { active.focus(); return active; }
    if (!songId || typeof baseUrl !== "string") throw new Error("缺少作品 ID 或服务地址");
    clearToast();
    installStyles();
    const endpoint = `${baseUrl.replace(/\/$/, "")}/media/songs/${encodeURIComponent(String(songId))}/metadata`;
    const previousFocus = document.activeElement, controller = new AbortController();
    const overlay = node("div", null, "ose-overlay"), dialog = node("div", null, "ose-dialog");
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-label", "编辑作品");
    const content = node("div", null, "ose-dialog__content"), heading = node("h2", "编辑作品"), status = node("p", "正在读取作品……", "ose-status"), error = node("p", "", "ose-error");
    error.setAttribute("role", "alert");
    const syncStatus = node("p", "", "ose-sync-status"); syncStatus.setAttribute("role", "status");
    const actions = node("div", null, "ose-actions"), cancel = node("button", "取消"), save = node("button", "保存"), permanent = node("button", "永久保存曲名", "ose-permanent");
    save.setAttribute("data-primary", ""); save.disabled = true; permanent.disabled = true;
    permanent.title = "纠正正式曲名；保留导入名称记录，不改文件名和视频路径";
    actions.append(permanent, cancel, save); content.append(heading, status, error); dialog.append(content, actions); overlay.append(dialog); document.body.append(overlay);
    const videos = [], selects = new Map(), editingControls = [];
    let closed = false, saving = false, metadata = null, input = null, restoring = false, mappingDirty = false;
    function release(video) { video.pause(); video.removeAttribute("src"); video.load(); }
    function close() {
      if (closed || saving) return;
      closed = true; controller.abort(); videos.forEach(release); overlay.remove();
      document.removeEventListener("keydown", keydown); active = null; previousFocus?.focus?.();
    }
    function keydown(event) {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const fields = [...dialog.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled),summary")];
        const first = fields[0], last = fields.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener("keydown", keydown);
    cancel.addEventListener("click", close);
    async function request(options = {}) {
      const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal, ...options });
      const result = await response.json();
      if (!response.ok || Number(result?.code) !== 0) throw new Error(result?.message || "无法保存作品");
      if (String(result.data?.id) !== String(songId)) throw new Error("作品已经切换，请重新打开编辑器");
      return result.data;
    }
    function showNameSync(data) {
      syncStatus.textContent = data.nameSync?.state === "pending" ? pendingNameSyncMessage : "";
      if (data.nameSync?.state === "failed") error.textContent = `名称已保存，仍有同步项目未完成：${data.nameSync.error || "请重试"}。请点击“永久保存曲名”重试同步。`;
    }
    async function saveChanges(permanentCorrection = false) {
      if (!metadata || saving || closed) return;
      const body = {}, name = input.value.trim();
      if ((permanentCorrection || !restoring) && (!name || [...name].length > 200 || /[\u0000-\u001f\u007f]/.test(name))) {
        error.textContent = "名称须为 1–200 个字符，不能包含控制字符。";
        input.focus(); return;
      }
      if (permanentCorrection) body.permanentName = name;
      else if (restoring) body.name = null;
      else if (name !== metadata.name) body.name = name;
      if (mappingDirty) body.timeOfDayMapping = Object.fromEntries(slots.map(([slot]) => [slot, selects.get(slot).value || null]));
      if (!Object.keys(body).length) { close(); return; }
      const submitButton = permanentCorrection ? permanent : save, submitLabel = submitButton.textContent;
      saving = true; save.disabled = true; cancel.disabled = true; permanent.disabled = true; error.textContent = ""; syncStatus.textContent = "";
      submitButton.textContent = "正在保存…";
      editingControls.forEach(control => { control.disabled = true; });
      try {
        const updated = await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (closed) return;
        try { onSaved?.(updated); } catch (callbackError) { console.error(callbackError); }
        global.dispatchEvent(new CustomEvent("oliviasoul-song-metadata", { detail: updated }));
        metadata = updated;
        if (updated.nameSync?.state === "failed") {
          showNameSync(updated);
          return;
        }
        saving = false; close();
        if (updated.nameSync?.state === "pending") showToast(pendingNameSyncMessage);
      } catch (failure) { if (!closed) error.textContent = failure.message; }
      finally { saving = false; submitButton.textContent = submitLabel; save.disabled = false; cancel.disabled = false; permanent.disabled = false; editingControls.forEach(control => { control.disabled = false; }); }
    }
    save.addEventListener("click", () => saveChanges(false));
    permanent.addEventListener("click", () => saveChanges(true));
    const handle = { close, focus: () => (input || cancel).focus(), ready: null }; active = handle;
    handle.ready = request().then(data => {
      if (closed) return;
      metadata = data; status.textContent = `导入名称：${data.originalName || data.name}`;
      const form = node("div"), nameRow = node("div", null, "ose-name-row"), label = node("label", "显示名称");
      input = node("input"); input.type = "text"; input.value = data.name;
      input.className = "ose-name-input"; input.id = "ose-display-name"; label.setAttribute("for", input.id); input.setAttribute("aria-label", "显示名称"); input.addEventListener("input", () => { restoring = false; });
      const restore = node("button", "恢复正式名称", "ose-restore"); restore.addEventListener("click", () => { restoring = true; input.value = metadata.correctedName || metadata.originalName || metadata.name; });
      editingControls.push(input, restore);
      nameRow.append(label, restore);
      const details = node("details", null, "ose-time-settings"), summary = node("summary", "视频预览与时段");
      details.append(summary, node("p", data.mappingStatus === "unconfirmed" ? "尚未确认时段。请先预览，再选择白天、傍晚、夜晚；文件序号不会自动决定时段。" : "时段选择仅影响下次播放，不会切换当前演奏。", "ose-help"));
      const variants = Array.isArray(data.variants) ? data.variants : [];
      const previews = [];
      details.addEventListener("toggle", () => {
        if (details.open) return;
        for (const { preview, video, clearError } of previews) { preview.open = false; clearError(); release(video); }
      });
      for (const variant of variants) {
        const preview = node("details"), title = node("summary", `${variant.filename || "视频"} · ${variant.key}`), video = node("video");
        const retry = node("button", "重试预览"), progress = node("p", "", "ose-preview-status");
        progress.setAttribute("role", "status");
        let previewError = "";
        video.controls = true; video.preload = "metadata"; videos.push(video);
        retry.type = "button"; retry.hidden = true;
        function isActivePreview() { return !closed && preview.open && !!video.src; }
        function clearError() {
          if (error.textContent === previewError) error.textContent = "";
          previewError = ""; retry.hidden = true; progress.textContent = "";
        }
        function showError() {
          if (!isActivePreview()) return;
          previewError = `视频片段“${variant.filename || "视频"} · ${variant.key}”无法预览，请重试。`;
          error.textContent = previewError; retry.hidden = false; progress.textContent = "";
        }
        function loadPreview() {
          if (closed || !preview.open) return;
          try {
            const url = new URL(variant.url, new URL(baseUrl, global.location.href));
            if (!["http:", "https:"].includes(url.protocol)) throw new Error("视频地址无效");
            clearError(); progress.textContent = "正在加载片段……"; video.src = url.href; video.load();
          } catch (failure) { previewError = failure.message; error.textContent = previewError; retry.hidden = false; }
        }
        video.addEventListener("loadedmetadata", () => { if (isActivePreview()) clearError(); });
        video.addEventListener("error", showError);
        retry.addEventListener("click", loadPreview);
        previews.push({ preview, video, clearError });
        preview.append(title, progress, video, retry);
        preview.addEventListener("toggle", () => {
          if (!preview.open) { clearError(); release(video); return; }
          loadPreview();
        });
        details.append(preview);
      }
      for (const [slot, caption, hours] of slots) {
        const slotLabel = node("label", `${caption} · ${hours}`), select = node("select"); select.setAttribute("aria-label", caption);
        const empty = node("option", "未确认 / 不指定"); empty.value = ""; select.append(empty);
        for (const variant of variants) { const option = node("option", `${variant.filename || "视频"} · ${variant.key}`); option.value = variant.key; select.append(option); }
        select.value = data.mapping?.[slot] || ""; selects.set(slot, select);
        editingControls.push(select);
        select.addEventListener("change", () => { mappingDirty = true; }); slotLabel.append(select); details.append(slotLabel);
      }
      form.append(nameRow, input, node("p", "保存：修改显示名称。永久保存曲名：纠正正式名称，重新导入后仍保留；不改视频文件和时段绑定。", "ose-help"), syncStatus, details); error.remove(); content.append(form, error);
      showNameSync(data);
      save.disabled = false; permanent.disabled = false; input.focus();
    }).catch(failure => { if (!closed) { status.textContent = "读取失败"; error.textContent = failure.message; } });
    return handle;
  }
  global.OliviaSoulSongEditor = { open, stableId, applyMetadata };
})(window);
