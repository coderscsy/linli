const enabled = document.querySelector('#lyricsEnabled');
if (enabled) {
  const locked = document.querySelector('#lyricsLocked'), size = document.querySelector('#lyricsFontSize');
  const status = document.querySelector('#lyricsStatus');
  const lifecycle = new AbortController();
  const appearance = { orientation: '#lyricsOrientation', fontFamily: '#lyricsFontFamily', fontWeight: '#lyricsFontWeight', opacity: '#lyricsOpacity', lineMode: '#lyricsLineMode', currentColor: '#lyricsCurrentColor', nextColor: '#lyricsNextColor', animate: '#lyricsAnimate' };
  const fields = Object.fromEntries(Object.entries(appearance).map(([key, selector]) => [key, document.querySelector(selector)]));
  const preview = document.querySelector('#lyricsPreview'), current = document.querySelector('#lyricsPreviewCurrent'), next = document.querySelector('#lyricsPreviewNext');
  const presets = {gold:['#ffebaa','#ffffff'], ocean:['#00c8ef','#b2eaf5'], mint:['#80efbd','#e0f5eb'], white:['#ffffff','#bdbdc4']};
  const preset = document.querySelector('#lyricsPreset');
  const autoFontLabel = '默认（优先林离回信字体）';
  let fontInfo = null;
  const selectedFont = () => !fields.fontFamily?.value || fields.fontFamily.value === autoFontLabel ? 'auto' : fields.fontFamily.value;
  function setFont(value) {
    const field = fields.fontFamily;
    if (!field) return;
    value = !value || value === autoFontLabel ? 'auto' : value;
    // Preserve a saved choice even when settings arrive before the font list.
    if (field.options && !Array.from(field.options).some(option => option.value === value)) {
      const option = document.createElement('option'); option.value = value; option.textContent = value;
      field.appendChild(option);
    }
    field.value = value;
  }
  function updatePreview() {
    if (!preview || !current || !next) return;
    const font = selectedFont();
    const resolved = fontInfo ? (fontInfo.fonts.includes(font) ? font : fontInfo.defaultFont) : null;
    const fontStatus = document.querySelector('#lyricsResolvedFont');
    if (fontStatus) fontStatus.textContent = resolved ? `当前使用：${resolved}${font !== 'auto' && resolved !== font ? '（所选字体未安装，已回退）' : ''}` : '请在 OliviaSoul 桌面管理窗口中读取系统字体';
    preview.style.fontFamily = font === 'auto' ? 'SentyTEA, "新蒂下午茶体", "汉仪新蒂下午茶体", "Hanyi Senty Tea", KaiTi, "楷体", "Microsoft YaHei UI", sans-serif' : `${JSON.stringify(font)}, KaiTi, "Microsoft YaHei UI", sans-serif`;
    if (resolved) preview.style.fontFamily = `${JSON.stringify(resolved)}, sans-serif`;
    preview.style.fontWeight = fields.fontWeight?.value === 'bold' ? '700' : '400';
    const opacity = Math.max(20, Math.min(100, Number(fields.opacity?.value) || 100));
    preview.style.opacity = String(opacity / 100);
    const readout = document.querySelector('#lyricsOpacityValue'); if (readout) readout.textContent = `${opacity}%`;
    const fontSize = Math.max(16, Math.min(64, Number(size.value) || 28));
    current.style.fontSize = `${fontSize}px`; next.style.fontSize = `${Math.max(14, fontSize - 5)}px`;
    current.style.color = fields.currentColor?.value || '#ffebaa'; next.style.color = fields.nextColor?.value || '#ffffff';
    next.hidden = fields.lineMode?.value === 'single';
    const vertical = fields.orientation?.value === 'vertical';
    preview.style.display = vertical ? 'flex' : 'block';
    preview.style.flexDirection = 'column'; preview.style.alignItems = 'center'; preview.style.gap = '24px';
    for (const line of [current, next]) { line.style.writingMode = vertical ? 'vertical-lr' : 'horizontal-tb'; line.style.maxHeight = vertical ? '280px' : 'none'; }
    preview.style.margin = '0 auto';
    if (preset) preset.value = Object.keys(presets).find(key => presets[key][0] === fields.currentColor?.value && presets[key][1] === fields.nextColor?.value) || 'custom';
  }
  let pending = 0, chain = Promise.resolve(), revision = 0, reading = false;
  function render(data) {
    if (!data?.settings || pending || lifecycle.signal.aborted) return;
    enabled.checked = data.settings.enabled; locked.checked = data.settings.locked;
    size.value = data.settings.fontSize; status.textContent = data.status || '';
    for (const [key, field] of Object.entries(fields)) if (field && data.settings[key] !== undefined) {
      if (key === 'animate') field.checked = data.settings[key]; else if (key === 'fontFamily') setFont(data.settings[key]); else field.value = data.settings[key];
    }
    updatePreview();
  }
  async function request(patch) {
    if (lifecycle.signal.aborted) throw new Error('界面已关闭');
    const controller = new AbortController();
    const abort = () => controller.abort(); lifecycle.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 5000);
    try {
      const response = await fetch('/admin/api/lyrics/settings', { signal: controller.signal, cache: 'no-store',
        ...(patch ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) } : {}) });
      const result = await response.json();
      if (!response.ok || result.code !== 0) throw new Error(result.message || '歌词设置保存失败');
      return result.data;
    } finally { clearTimeout(timer); lifecycle.signal.removeEventListener('abort', abort); }
  }
  function save(patch) {
    revision++;
    pending++;
    chain = chain.catch(() => {}).then(() => request(patch)).then(data => {
      pending--; if (!pending) render(data);
    }, failure => { pending--; if (!lifecycle.signal.aborted) status.textContent = failure.message || '歌词服务不可用'; });
  }
  enabled.addEventListener('change', () => save({ enabled: enabled.checked }));
  locked.addEventListener('change', () => save({ locked: locked.checked }));
  size.addEventListener('change', () => save({ fontSize: Number(size.value) }));
  size.addEventListener('input', updatePreview);
  for (const [key, field] of Object.entries(fields)) {
    field?.addEventListener('input', updatePreview);
    field?.addEventListener('change', () => { updatePreview(); save({ [key]: key === 'animate' ? field.checked : key === 'opacity' ? Number(field.value) : key === 'fontFamily' ? selectedFont() : field.value }); });
  }
  preset?.addEventListener('change', () => {
    const colors = presets[preset.value]; if (!colors) return;
    fields.currentColor.value = colors[0]; fields.nextColor.value = colors[1]; updatePreview();
    save({currentColor:colors[0], nextColor:colors[1]});
  });
  document.querySelector('#lyricsReset')?.addEventListener('click', () => save({resetAppearance:true}));
  window.oliviaDesktop?.getLyricsFontInfo?.().then(info => {
    if (lifecycle.signal.aborted || !Array.isArray(info?.fonts) || typeof info.defaultFont !== 'string') return;
    const selected = selectedFont();
    fontInfo = info;
    const list = fields.fontFamily; if (!list) return;
    const options = ['auto', ...new Set(info.fonts.filter(font => typeof font === 'string' && font && font !== 'auto'))].map(font => {
      const option = document.createElement('option'); option.value = font; option.textContent = font === 'auto' ? autoFontLabel : font; return option;
    });
    list.replaceChildren(...options); setFont(selected); updatePreview();
  }).catch(() => { const hint = document.querySelector('#lyricsResolvedFont'); if (hint && !lifecycle.signal.aborted) hint.textContent = '系统字体读取失败，请重新打开管理窗口'; });
  const message = event => {
    if (event.data?.type === 'lyrics-settings') { revision++; render(event.data.data); }
    if (event.data?.type === 'lyrics-open-settings' && !lifecycle.signal.aborted) {
      document.querySelector('.sideTab[data-tab="lyrics"]')?.click();
      document.querySelector('#lyricsSettings')?.scrollIntoView({block:'start'});
    }
  };
  window.chrome?.webview?.addEventListener('message', message);
  const refresh = () => {
    if (pending || reading || lifecycle.signal.aborted) return;
    const expected = revision; reading = true;
    request().then(data => { if (expected === revision) render(data); })
      .catch(() => { if (expected === revision && !lifecycle.signal.aborted) status.textContent = '歌词服务暂时不可用'; })
      .finally(() => { reading = false; });
  };
  window.addEventListener('focus', refresh);
  window.addEventListener('pagehide', () => { lifecycle.abort(); window.removeEventListener('focus', refresh); window.chrome?.webview?.removeEventListener('message', message); }, { once: true });
  refresh();
}
