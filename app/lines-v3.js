/* Lines page presentation. The original controls remain the source of truth. */
(() => {
  const page = document.querySelector('[data-page="lines"]');
  const select = document.getElementById('strategyGroup');
  const nodes = document.getElementById('nodes');
  const status = document.getElementById('lineStatus');
  const filters = page?.querySelector('.line-filters');
  const sort = page?.querySelector('.line-sort');
  const testToolbar = document.getElementById('ping')?.closest('.line-toolbar');
  if (!page || !select || !nodes || !status || !filters || !sort || !testToolbar) return;

  const controls = document.createElement('div');
  controls.className = 'line-controls-v3';
  testToolbar.before(controls);
  controls.append(testToolbar, filters, sort);

  const groupButton = document.createElement('button');
  groupButton.type = 'button';
  groupButton.className = 'line-group-button';
  groupButton.setAttribute('aria-haspopup', 'dialog');
  groupButton.innerHTML = '<span class="line-group-value"></span><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>';
  select.hidden = true;
  select.after(groupButton);

  const dialog = document.createElement('dialog');
  dialog.className = 'glass detail-dialog line-group-dialog';
  dialog.setAttribute('aria-labelledby', 'lineGroupDialogTitle');
  dialog.innerHTML = '<div class="line-sheet-handle" aria-hidden="true"></div><div class="line-sheet-head"><div><h2 id="lineGroupDialogTitle">选择策略组</h2><p>选择要查看和切换线路的策略组</p></div><button type="button" class="line-sheet-close" aria-label="关闭"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div><div class="line-group-list"></div>';
  document.body.append(dialog);
  const groupList = dialog.querySelector('.line-group-list');
  dialog.querySelector('.line-sheet-close').addEventListener('click', () => dialog.close());

  function updateGroupButton() {
    groupButton.disabled = select.disabled;
    groupButton.querySelector('.line-group-value').textContent = select.value || '暂无策略组';
    groupButton.setAttribute('aria-label', '策略组：' + (select.value || '暂无策略组') + '，点击选择');
  }
  groupButton.addEventListener('click', () => {
    groupList.replaceChildren();
    for (const option of select.options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'line-group-option';
      item.setAttribute('aria-pressed', String(option.value === select.value));
      const label = document.createElement('span');
      label.textContent = option.textContent;
      item.append(label);
      if (option.value === select.value) {
        const check = document.createElement('span');
        check.className = 'line-group-current';
        check.textContent = '当前';
        item.append(check);
      }
      item.addEventListener('click', () => {
        if (select.value !== option.value) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          updateGroupButton();
        }
        dialog.close();
      });
      groupList.append(item);
    }
    dialog.showModal();
  });

  function decorateNodes() {
    const group = currentGroup();
    const profile = currentProfile();
    updateGroupButton();
    const backups = ui.automation && group && profile && ui.automation.group === group.name && ui.automation.scope === profile.id ? ui.automation.backups || [] : [];
    for (const button of nodes.querySelectorAll('button.node')) {
      const member = group?.members?.find(item => item.name === button.dataset.member);
      if (!member) continue;
      const failed = ui.failures.has(group.name + '\0' + member.name);
      const state = member.delay > 0 ? 'normal' : failed ? 'failed' : 'unknown';
      const dot = document.createElement('span');
      dot.className = 'line-node-dot';
      dot.dataset.state = state;
      dot.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      copy.className = 'line-node-copy';
      const headline = document.createElement('span');
      headline.className = 'line-node-headline';
      const name = document.createElement('span');
      name.className = 'line-node-name';
      name.textContent = member.name;
      headline.append(name);
      for (const [enabled, label, kind] of [[member.name === group.current, '当前', 'current'], [backups.includes(member.name), '备用', 'backup']]) {
        if (!enabled) continue;
        const badge = document.createElement('span');
        badge.className = 'line-node-badge';
        badge.dataset.kind = kind;
        badge.textContent = label;
        headline.append(badge);
      }
      const detail = document.createElement('span');
      detail.className = 'line-node-detail';
      detail.textContent = state === 'normal' ? '已测速' : state === 'failed' ? '测试失败' : '尚未测速';
      copy.append(headline, detail);
      const delay = document.createElement('span');
      delay.className = 'line-node-latency';
      delay.dataset.state = state;
      delay.textContent = state === 'normal' ? member.delay + ' ms' : state === 'failed' ? '不可用' : '—';
      button.replaceChildren(dot, copy, delay);
    }
    const empty = nodes.querySelector('.line-empty');
    if (empty && ui.filter === 'backup' && group) empty.textContent = '尚未设置备用节点，或没有符合条件的线路。';
  }
  new MutationObserver(decorateNodes).observe(nodes, { childList: true });

  // Keep only timestamps observed from completed, real tests in this session.
  const testTimes = new Map();
  let activeTestKey = '';
  let running = false;
  const key = () => (currentProfile()?.id || '') + '\0' + (currentGroup()?.name || '');
  document.getElementById('ping').addEventListener('click', () => {
    if (!ui.busy && currentGroup()?.members?.length) { activeTestKey = key(); running = true; }
  }, { capture: true });
  const formatTime = value => '最近测速 ' + value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const updateStatus = () => {
    if (running) return;
    const last = testTimes.get(key());
    const text = last ? formatTime(last) : '暂无测速时间';
    if (status.textContent !== text) status.textContent = text;
  };
  new MutationObserver(() => {
    const match = status.textContent.match(/^测速\s+(\d+)\s*\/\s*(\d+)$/);
    if (!match) return;
    if (+match[2] > 0 && +match[1] === +match[2]) {
      testTimes.set(activeTestKey || key(), new Date());
      running = false;
      updateStatus();
    }
  }).observe(status, { childList: true, characterData: true, subtree: true });
  window.addEventListener('clash-render', () => {
    if (running && !ui.busy) running = false;
    updateGroupButton(); updateStatus();
  });
  updateGroupButton();
  decorateNodes();
  updateStatus();
})();
