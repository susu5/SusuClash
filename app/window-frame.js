'use strict';
(() => {
  const bridge = window.chrome?.webview;
  if (!bridge || typeof bridge.postMessage !== 'function') return;
  document.documentElement.classList.add('native-desktop');
  const bar = document.createElement('header');
  bar.className = 'desktop-titlebar';
  bar.innerHTML = '<div class="desktop-brand"><img src="icon.svg" alt=""><span>SusuClash</span></div><div class="desktop-controls" aria-label="窗口控制"><button type="button" data-window="minimize" aria-label="最小化" title="最小化"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 9h10"/></svg></button><button type="button" data-window="maximize" aria-label="最大化" title="最大化"><svg class="desktop-max-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx=".6"/></svg><svg class="desktop-restore-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3h8v8M3 5h8v8H3z"/></svg></button><button type="button" data-window="close" class="desktop-close" aria-label="关闭" title="关闭"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>';
  document.body.insertBefore(bar, document.querySelector('.app'));
  const send = message => bridge.postMessage(message);
  bar.querySelectorAll('[data-window]').forEach(button => button.addEventListener('click', () => send('window:' + button.dataset.window)));
  let dragStart = null;
  bar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    dragStart = {x:event.clientX, y:event.clientY, id:event.pointerId};
    send('window:drag');
  });
  bar.addEventListener('pointermove', event => {
    if (!dragStart || event.pointerId !== dragStart.id || event.buttons !== 1) return;
    if (Math.hypot(event.clientX-dragStart.x, event.clientY-dragStart.y) > 6) {
      dragStart = null;
      send('window:restore-drag');
    }
  });
  for (const type of ['pointerup','pointercancel']) bar.addEventListener(type, () => { dragStart=null; });
  bridge.addEventListener('message', event => {
    if (event.data !== 'window:state:normal' && event.data !== 'window:state:maximized') return;
    const maximized = event.data === 'window:state:maximized';
    document.documentElement.classList.toggle('native-maximized', maximized);
    const button = bar.querySelector('[data-window="maximize"]');
    button.setAttribute('aria-label', maximized ? '还原' : '最大化');
    button.title = maximized ? '还原' : '最大化';
  });
  const syncTheme = () => {
    const theme = document.documentElement.dataset.theme;
    if (['cat', 'fish', 'whale'].includes(theme)) send('theme:' + theme);
  };
  window.addEventListener('clash-theme-change', syncTheme);
  syncTheme();
})();
