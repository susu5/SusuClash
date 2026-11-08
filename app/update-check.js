'use strict';

// Application update checks are separate from subscription updates.
(() => {
  const page = document.querySelector('[data-page="settings"]');
  const theme = page?.querySelector('.settings-theme-entry');
  const stack = theme?.closest('.stack');
  if (!stack) return;

  const entry = document.createElement('button');
  entry.type = 'button';
  entry.className = 'settings-update-entry';
  entry.setAttribute('aria-haspopup', 'dialog');
  entry.innerHTML = '<span class="row-copy"><span class="row-label">检查更新</span><span class="hint">查看 SusuClash 的新版本</span></span><span class="settings-update-version"></span><span class="settings-update-arrow" aria-hidden="true">›</span>';
  stack.append(entry);

  const autoRow = document.createElement('div');
  autoRow.className = 'settings-update-auto';
  autoRow.innerHTML = '<span class="row-copy"><span class="row-label" id="autoUpdateLabel">每天自动检查更新</span><span class="hint">每 24 小时检查一次，不会自动安装</span></span><button type="button" class="switch" role="switch" aria-labelledby="autoUpdateLabel" aria-checked="false" disabled><span class="track"></span></button>';
  entry.before(autoRow);
  const autoSwitch = autoRow.querySelector('button');
  const entryHint = entry.querySelector('.hint');
  const nav = document.querySelector('.tabs [data-open="settings"]');
  const badge = document.createElement('span');
  badge.className = 'settings-update-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.hidden = true;
  nav?.append(badge);

  const banner = document.createElement('div');
  banner.className = 'update-notice';
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.innerHTML = '<button type="button" class="update-notice-open"><span class="update-notice-dot" aria-hidden="true"></span><span class="update-notice-text"></span><span aria-hidden="true">›</span></button><button type="button" class="update-notice-close" aria-label="关闭更新提醒">×</button>';
  document.body.append(banner);

  const dialog = document.createElement('dialog');
  dialog.className = 'glass detail-dialog app-update-dialog';
  dialog.setAttribute('aria-labelledby', 'appUpdateTitle');
  dialog.innerHTML = '<div class="app-update-head"><h2 id="appUpdateTitle">检查更新</h2><button type="button" class="dialog-close" aria-label="关闭">×</button></div><div class="app-update-result" role="status" aria-live="polite"><span class="app-update-indicator" aria-hidden="true"></span><div><strong class="app-update-title">准备检查</strong><p class="app-update-description">查看 SusuClash 的最新发布版本</p></div></div><dl class="app-update-versions"><div><dt>当前版本</dt><dd class="app-update-current">—</dd></div><div><dt>最新版本</dt><dd class="app-update-latest">—</dd></div></dl><p class="app-update-last"></p><p class="app-update-note">仅检查版本，不会自动下载或安装。</p><div class="app-update-actions"><button type="button" class="secondary app-update-retry" hidden>重新检查</button><a class="secondary app-update-link" href="https://github.com/susu5/SusuClash/releases" target="_blank" rel="noopener noreferrer" hidden>查看发布页（浏览器）</a></div>';
  document.body.append(dialog);
  const title = dialog.querySelector('.app-update-title');
  const description = dialog.querySelector('.app-update-description');
  const current = dialog.querySelector('.app-update-current');
  const latest = dialog.querySelector('.app-update-latest');
  const note = dialog.querySelector('.app-update-note');
  const last = dialog.querySelector('.app-update-last');
  const retry = dialog.querySelector('.app-update-retry');
  const link = dialog.querySelector('.app-update-link');
  const version = entry.querySelector('.settings-update-version');
  const fallbackUrl = 'https://github.com/susu5/SusuClash/releases';
  let pending = false;
  let settings = null, settingsPending = false, refreshPending = false, refreshQueued = false, queuedAnnounce = false, epoch = 0, lastPoll = 0;
  let announcedVersion = '', bannerTimer = null;
  function hideBanner() { banner.hidden = true; clearTimeout(bannerTimer); bannerTimer = null; }

  function safeVersion(value) {
    return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) && value.length <= 80 ? value : '—';
  }
  function safeReleaseUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/susu5\/SusuClash\/releases\/tag\/[A-Za-z0-9._-]+$/.test(url.pathname)) return url.href;
    } catch { /* Use only the fixed official releases list as a fallback. */ }
    return fallbackUrl;
  }
  function showVersion() {
    version.textContent = safeVersion(ui.runtime?.appVersion);
    if (version.textContent === '—') version.textContent = '';
  }
  window.addEventListener('clash-render', showVersion);
  showVersion();

  const errors = {
    invalid_release: ['无法识别发布版本', '发布信息格式不受支持，请稍后重试。'],
    network_error: ['无法连接更新服务', '请检查网络连接后重试。'],
    timeout: ['检查超时', '更新服务响应较慢，请稍后重试。'],
    service_error: ['更新服务暂不可用', '请稍后重试。'],
    rate_limited: ['检查次数过多', 'GitHub 暂时限制了检查请求，请稍后重试。']
  };

  function formatTime(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) : '';
  }
  function stateLabel(result) {
    return ({available:'有新版本',up_to_date:'已是最新',unreleased:'暂无正式发布',invalid_release:'发布信息无法识别',network_error:'上次检查失败',timeout:'上次检查超时',service_error:'更新服务不可用',rate_limited:'请求受到限制'})[result?.status] || '尚未检查';
  }
  function renderSettings(data, announce = true) {
    if (!data || typeof data.enabled !== 'boolean') return;
    settings = data;
    autoSwitch.setAttribute('aria-checked', String(data.enabled));
    autoSwitch.disabled = settingsPending;
    autoRow.querySelector('.hint').textContent = data.enabled ? '每 24 小时检查一次，不会自动安装' : '已关闭，可随时手动检查';
    const when = formatTime(data.lastCheckedAt), result = data.lastResult;
    entryHint.textContent = data.checking ? '正在检查更新…' : when ? '上次检查 ' + when + ' · ' + stateLabel(result) : '尚未检查';
    last.textContent = when ? '上次检查：' + when : '尚无检查记录';
    const latestVersion = safeVersion(result?.latestVersion);
    const available = !data.checking && result?.status === 'available' && latestVersion !== '—';
    badge.hidden = !available;
    if (nav) nav.setAttribute('aria-label', available ? '设置，有新版本可用' : '设置');
    if (!available || !data.enabled) hideBanner();
    if (available && data.enabled && announce && latestVersion !== announcedVersion) {
      announcedVersion = latestVersion;
      banner.querySelector('.update-notice-text').textContent = '发现新版本 ' + latestVersion + ' · 查看';
      banner.hidden = dialog.open;
      if (!banner.hidden) { clearTimeout(bannerTimer); bannerTimer = setTimeout(hideBanner, 8000); }
    }
  }
  async function refreshSettings(announce = true) {
    if (refreshPending || settingsPending) { refreshQueued = true; queuedAnnounce ||= announce; return; }
    refreshPending = true;
    lastPoll = Date.now();
    const requestEpoch = epoch;
    try {
      const value = await api('update-settings');
      if (typeof value?.enabled !== 'boolean') throw new Error('invalid response');
      if (requestEpoch === epoch && !settingsPending) renderSettings(value, announce);
    } catch {
      if (!settings) { autoSwitch.disabled = true; autoRow.querySelector('.hint').textContent = '更新设置暂不可用，稍后重试'; }
    } finally {
      refreshPending = false;
      if (refreshQueued && !settingsPending) {
        const announceQueued = queuedAnnounce;
        refreshQueued = false; queuedAnnounce = false;
        void refreshSettings(announceQueued);
      }
    }
  }
  autoSwitch.addEventListener('click', async () => {
    if (!settings || settingsPending) return;
    settingsPending = true;
    epoch++;
    autoSwitch.disabled = true;
    try {
      const result = await api('update-settings', {enabled:!settings.enabled});
      if (typeof result?.enabled !== 'boolean') throw new Error('invalid response');
      renderSettings(result, false);
    } catch { notify('更新设置保存失败，请重试'); }
    finally {
      settingsPending = false; autoSwitch.disabled = !settings;
      if (refreshQueued && !refreshPending) {
        const announceQueued = queuedAnnounce;
        refreshQueued = false; queuedAnnounce = false;
        void refreshSettings(announceQueued);
      }
    }
  });
  banner.querySelector('.update-notice-close').addEventListener('click', hideBanner);
  banner.querySelector('.update-notice-open').addEventListener('click', () => {
    hideBanner();
    dialog.showModal();
    if (settings?.lastResult?.status === 'available') showResult(settings.lastResult);
    else void check();
  });
  window.addEventListener('clash-render', () => { if (!document.hidden && Date.now() - lastPoll >= 15000) void refreshSettings(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshSettings(); });
  const pollTimer = setInterval(() => { if (!document.hidden) void refreshSettings(); }, 30000);
  window.addEventListener('pagehide', () => clearInterval(pollTimer), {once:true});
  void refreshSettings();

  function showResult(result) {
    const state = result?.status;
    note.textContent = '仅检查版本，不会自动下载或安装。';
    current.textContent = safeVersion(result?.currentVersion || ui.runtime?.appVersion);
    latest.textContent = safeVersion(result?.latestVersion);
    retry.hidden = true;
    link.hidden = true;
    if (state === 'available' && latest.textContent !== '—') {
      dialog.dataset.state = 'available';
      title.textContent = '发现新版本';
      description.textContent = 'SusuClash ' + latest.textContent + ' 已发布。';
      note.textContent = '将在浏览器打开发布页，请在那里确认安装包；不会自动下载或安装。';
      link.textContent = '查看发布页（浏览器）';
      link.href = safeReleaseUrl(result.releaseUrl);
      link.hidden = false;
      return;
    }
    if (state === 'up_to_date' && latest.textContent !== '—') {
      dialog.dataset.state = 'success';
      title.textContent = '已是最新版本';
      description.textContent = '当前没有发现更新。';
      return;
    }
    if (state === 'unreleased') {
      dialog.dataset.state = 'empty';
      title.textContent = '尚未发布版本';
      description.textContent = 'GitHub 暂无正式发布版本，请稍后再检查。';
      return;
    }
    const [heading, copy] = errors[state] || errors.service_error;
    dialog.dataset.state = 'error';
    title.textContent = heading;
    description.textContent = copy;
    retry.hidden = false;
  }

  async function check() {
    if (pending) return;
    pending = true;
    dialog.dataset.state = 'loading';
    title.textContent = '正在检查更新';
    description.textContent = '正在获取 GitHub 发布信息…';
    current.textContent = safeVersion(ui.runtime?.appVersion);
    latest.textContent = '—';
    note.textContent = '仅检查版本，不会自动下载或安装。';
    retry.hidden = true;
    link.hidden = true;
    try {
      const result = await api('update-check');
      showResult(result);
    } catch {
      dialog.dataset.state = 'error';
      title.textContent = '检查失败';
      description.textContent = '无法完成检查，请稍后重试。';
      retry.hidden = false;
    } finally { pending = false; epoch++; void refreshSettings(false); }
  }

  entry.addEventListener('click', () => { hideBanner(); dialog.showModal(); void check(); });
  retry.addEventListener('click', () => { void check(); });
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
})();
