'use strict';

// A user-initiated check of the application's own GitHub releases.
// Subscription updates use a separate flow and are not affected.
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

  const dialog = document.createElement('dialog');
  dialog.className = 'glass detail-dialog app-update-dialog';
  dialog.setAttribute('aria-labelledby', 'appUpdateTitle');
  dialog.innerHTML = '<div class="app-update-head"><h2 id="appUpdateTitle">检查更新</h2><button type="button" class="dialog-close" aria-label="关闭">×</button></div><div class="app-update-result" role="status" aria-live="polite"><span class="app-update-indicator" aria-hidden="true"></span><div><strong class="app-update-title">准备检查</strong><p class="app-update-description">查看 SusuClash 的最新发布版本</p></div></div><dl class="app-update-versions"><div><dt>当前版本</dt><dd class="app-update-current">—</dd></div><div><dt>最新版本</dt><dd class="app-update-latest">—</dd></div></dl><p class="app-update-note">仅检查版本，不会自动下载或安装。</p><div class="app-update-actions"><button type="button" class="secondary app-update-retry" hidden>重新检查</button><a class="secondary app-update-link" href="https://github.com/susu5/SusuClash/releases" target="_blank" rel="noopener noreferrer" hidden>查看发布页（浏览器）</a></div>';
  document.body.append(dialog);
  const title = dialog.querySelector('.app-update-title');
  const description = dialog.querySelector('.app-update-description');
  const current = dialog.querySelector('.app-update-current');
  const latest = dialog.querySelector('.app-update-latest');
  const note = dialog.querySelector('.app-update-note');
  const retry = dialog.querySelector('.app-update-retry');
  const link = dialog.querySelector('.app-update-link');
  const version = entry.querySelector('.settings-update-version');
  const fallbackUrl = 'https://github.com/susu5/SusuClash/releases';
  let pending = false;

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
      const state = result?.status;
      current.textContent = safeVersion(result?.currentVersion || ui.runtime?.appVersion);
      latest.textContent = safeVersion(result?.latestVersion);
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
    } catch {
      dialog.dataset.state = 'error';
      title.textContent = '检查失败';
      description.textContent = '无法完成检查，请稍后重试。';
      retry.hidden = false;
    } finally { pending = false; }
  }

  entry.addEventListener('click', () => { dialog.showModal(); void check(); });
  retry.addEventListener('click', () => { void check(); });
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
})();
