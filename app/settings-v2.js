'use strict';

// Augment the existing settings view without replacing its working controls.
(() => {
  const page = document.querySelector('[data-page="settings"]');
  if (!page) return;
  const get = id => document.getElementById(id);
  const section = (name, tail) => {
    const d = document.createElement('div'); d.className = 'section-label';
    d.append(document.createTextNode(name)); if (tail) d.append(tail); return d;
  };
  const existingHeader = page.querySelector('.heading');
  const warning = get('settingsRuntimeWarning');
  const subscriptionButton = page.querySelector('[data-open="subscriptions"]');
  const automationLabel = get('automationInterval').closest('.section-label');
  const automation = get('autoRepairSwitch').closest('.stack');
  const backupRow = get('backupSummary').closest('.row');
  const switchRow = get('autoSwitch').closest('.row');
  automation.insertBefore(switchRow, backupRow);
  const detailTargets = page.querySelector('.target-details');
  const portRow = get('settingsPort').closest('.row');
  const portForm = get('portForm');
  const tunRow = get('tunSwitch').closest('.row');
  const startupRow = page.querySelector('[data-local-switch="开机启动"]').closest('.row');
  const trayRow = page.querySelector('[data-local-switch="关闭窗口时留在托盘"]').closest('.row');
  const notImplemented = page.querySelector('[data-local-switch="自动更新订阅"]').closest('.row');
  const runtime = page.querySelector('[data-open="runtime"]');
  const logs = page.querySelector('[data-open="logs"]');
  const about = page.querySelector('[data-open="about"]');
  // Reuse the existing button and listener, so the author page stays the same.
  about.className = 'settings-author-entry';
  about.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.3"/><path d="M5.5 19c.4-3.4 2.8-5.2 6.5-5.2s6.1 1.8 6.5 5.2"/></svg><span>关于作者</span><span class="settings-author-arrow" aria-hidden="true">›</span>';
  existingHeader.append(about);

  const card = document.createElement('div'); card.className = 'usage-card-v2';
  card.innerHTML = '<img class="usage-motion-v2" alt="" aria-hidden="true"><div class="usage-body-v2"><div class="usage-head-v2"><div><span class="hint">当前订阅</span><h2 id="usageName">尚未启用订阅</h2></div></div><div class="usage-numbers-v2"><div><span>已用</span><strong id="usageUsed">—</strong></div><div><span>剩余</span><strong id="usageRemaining">—</strong></div></div><div id="usageMeter" class="usage-meter-v2" role="meter" aria-label="订阅流量使用情况" aria-valuemin="0" aria-valuemax="100" hidden><span></span></div><p id="usageHint" class="usage-hint-v2">暂无用量信息</p></div>';
  subscriptionButton.className = 'usage-manage-v2';
  subscriptionButton.textContent = '设置 ›';
  subscriptionButton.setAttribute('aria-label', '打开订阅管理');
  card.querySelector('.usage-head-v2').append(subscriptionButton);

  const network = document.createElement('div'); network.className = 'glass stack'; network.append(tunRow, portRow, portForm);
  const appSettings = document.createElement('div'); appSettings.className = 'glass stack'; appSettings.append(startupRow, trayRow);
  const themeEntry = document.createElement('button'); themeEntry.type = 'button'; themeEntry.className = 'settings-theme-entry';
  themeEntry.innerHTML = '<span class="row-copy"><span class="row-label">主题</span><span class="hint">选择界面与球体风格</span></span><span id="currentThemeName"></span><span aria-hidden="true">›</span>';
  appSettings.append(themeEntry);
  notImplemented.hidden = true;
  // Detailed probe targets belong with runtime information; the main settings
  // screen keeps the concise controls from the approved layout.
  document.querySelector('[data-page="runtime"] .runtime-list')?.after(detailTargets);
  page.replaceChildren(existingHeader, warning, card, automationLabel, automation,
    section('网络'), network, section('应用'), appSettings, section('更多'), runtime, logs, notImplemented);
  page.classList.add('settings-v2');

  const themeNames = {cat:'珍珠猫猫',fish:'薄荷游鱼',whale:'夜航鲸鱼'};
  const dialog = document.createElement('dialog'); dialog.className = 'glass detail-dialog theme-dialog-v2';
  dialog.setAttribute('aria-labelledby','themeTitleV2');
  dialog.innerHTML = '<div class="theme-head-v2"><h2 id="themeTitleV2">选择主题</h2><button type="button" class="theme-close-v2" aria-label="关闭">×</button></div><p>选择一种你喜欢的外观</p><div class="theme-list-v2" role="radiogroup" aria-label="主题"></div><p class="hint">仅改变界面外观，不影响订阅或代理设置。</p>';
  document.body.append(dialog);
  let currentTheme = 'cat';
  try { const saved = localStorage.getItem('clash-theme'); if (themeNames[saved]) currentTheme=saved; } catch {}
  let savedTheme = currentTheme, themeVersion = 0, themeWrites = Promise.resolve();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  function setTheme(theme, persist = true) {
    if (!themeNames[theme]) theme='cat'; currentTheme=theme;
    document.documentElement.dataset.theme=theme;
    get('currentThemeName').textContent=themeNames[theme];
    const image=card.querySelector('.usage-motion-v2');
    const src=theme+(motion.matches?'-poster.png':'-motion.gif');
    if(image.getAttribute('src')!==src) image.setAttribute('src',src);
    window.dispatchEvent(new CustomEvent('clash-theme-change',{detail:{theme}}));
    if (persist) {
      const requested=++themeVersion, chosen=theme;
      themeWrites=themeWrites.catch(()=>{}).then(()=>api('theme',{theme:chosen})).then(result=>{
        if(!themeNames[result?.theme]) throw new Error('主题保存结果无效。');
        savedTheme=result.theme;
        if(requested===themeVersion) try { localStorage.setItem('clash-theme',savedTheme); } catch {}
      }).catch(()=>{
        if(requested===themeVersion){setTheme(savedTheme,false);notify('主题保存失败，请重试');}
      });
    }
  }
  const list=dialog.querySelector('.theme-list-v2');
  function buildThemes() {
    list.replaceChildren(...Object.entries(themeNames).map(([id,name])=>{
      const button=document.createElement('button'); button.type='button'; button.className='theme-option-v2';
      button.setAttribute('role','radio'); button.setAttribute('aria-checked',String(id===currentTheme));
      const img=document.createElement('img'); img.src=id+'-poster.png'; img.alt='';
      const label=document.createElement('span'); label.textContent=name;
      const check=document.createElement('span'); check.textContent=id===currentTheme?'✓':''; check.setAttribute('aria-hidden','true');
      button.append(img,label,check); button.addEventListener('click',()=>{setTheme(id);dialog.close()}); return button;
    }));
  }
  themeEntry.addEventListener('click',()=>{buildThemes();dialog.showModal()});
  dialog.querySelector('.theme-close-v2').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close()});
  motion.addEventListener('change',()=>setTheme(currentTheme,false));
  setTheme(currentTheme,false);
  const initialVersion=themeVersion;
  // Queue writes behind the initial read. A quick selection is displayed at
  // once, but a failed save can still restore the actual stored theme.
  themeWrites=api('theme').then(result=>{
    if(themeNames[result?.theme]) {
      savedTheme=result.theme;
      if(themeVersion===initialVersion) {
        setTheme(savedTheme,false);
        try { localStorage.setItem('clash-theme',savedTheme); } catch {}
      }
    }
  }).catch(()=>{});

  function updateUsage() {
    const profile = currentProfile();
    get('usageName').textContent = profile?.name || '尚未启用订阅';
    const usage=profile?.usage, meter=get('usageMeter'), hint=get('usageHint');
    get('usageUsed').textContent=Number.isSafeInteger(usage?.used)?bytes(usage.used):'—';
    get('usageRemaining').textContent=Number.isSafeInteger(usage?.remaining)?bytes(usage.remaining):'—';
    const measurable=Number.isSafeInteger(usage?.used)&&Number.isSafeInteger(usage?.total)&&usage.total>0;
    meter.hidden=!measurable;
    if(measurable){const percent=Math.min(100,Math.max(0,usage.used/usage.total*100));meter.setAttribute('aria-valuenow',String(Math.round(percent)));meter.setAttribute('aria-valuetext','已用 '+bytes(usage.used)+'，总量 '+bytes(usage.total));meter.firstElementChild.style.width=percent+'%';}
    hint.textContent=profile?.lastError?'上次更新失败，显示上次获取的数据':!profile?'添加并启用订阅后显示':!usage?'订阅未提供用量信息':!measurable?'未提供流量总量':usage.exceeded?'已超过提供的流量总量':'总量 '+bytes(usage.total);
  }
  window.addEventListener('clash-render',updateUsage);
  updateUsage();
})();
