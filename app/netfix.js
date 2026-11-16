'use strict';

/* Rendering only. Diagnosis, decisions, plans and transactions belong to the service. */
(() => {
  const app = document.querySelector('.app'), main = app?.querySelector('main'), nav = document.querySelector('.tabs');
  if (!app || !main || !nav) return;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = name => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  const button = (label, action, cls = 'secondary', disabled = false) => '<button type="button" class="' + cls + '" data-nf-action="' + action + '"' + (disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
  const shell = document.createElement('section');
  shell.className = 'doctor-shell netfix-shell';
  shell.hidden = true;
  shell.innerHTML = '<div class="app-body" tabindex="-1"></div><footer class="action-area"></footer>';
  main.after(shell);
  const body = shell.querySelector('.app-body'), footer = shell.querySelector('.action-area');
  const dialog = document.createElement('dialog');
  dialog.id = 'nf-sheet'; dialog.className = 'glass detail-dialog';
  dialog.setAttribute('aria-labelledby', 'nf-sheet-title'); dialog.setAttribute('aria-describedby', 'nf-sheet-sub');
  document.body.append(dialog);
  const live = document.createElement('p');
  live.className = 'sr-only'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  document.body.append(live);
  let snapshot = null, visible = false, pending = false, polling = false, cancelPending = false;
  let epoch = 0, knownRevision = -1, lastRead = 0, details = false, auditOpen = false, selectedBackup = '';
  let modal = '', plan = null, restoreFocus = null, restoreFocusKey = '', serviceError = '', submitting = false;
  const busy = () => Boolean(snapshot?.busy);
  const blocked = () => pending || busy();
  const allowed = action => !serviceError && Array.isArray(snapshot?.allowedActions) && snapshot.allowedActions.includes(action);
  const entries = value => Array.isArray(value) ? value : [];
  const announce = value => { live.textContent = value; };
  function accept(next) {
    if (!next || typeof next !== 'object') throw new Error('诊断服务没有返回可用结果，请重新诊断。');
    const revision = Number(next.revision);
    if (Number.isFinite(revision) && revision < knownRevision) return false;
    if (Number.isFinite(revision)) knownRevision = revision;
    snapshot = next; serviceError = '';
    const backups = entries(next.backups).filter(item => item.restorable === true);
    if (!backups.some(item => item.name === selectedBackup)) selectedBackup = backups[0]?.name || '';
    window.dispatchEvent(new CustomEvent('netfix-state-change', {detail:{busy:busy(), stage:next.stage, verdict:next.verdict}}));
    if (visible) render();
    if (modal === 'execution') renderExecution();
    return true;
  }
  async function refresh() {
    if (polling || pending) return;
    polling = true;
    const mine = epoch;
    try {
      const next = await api('netfix');
      if (mine !== epoch || pending) return;
      lastRead = Date.now(); accept(next);
    } catch (error) {
      if (mine === epoch && visible) { serviceError = error.message || '诊断服务暂不可用，请重新诊断。'; render(); announce(serviceError); }
    } finally { polling = false; }
  }
  async function request(action, payload = {}) {
    if (pending) return null;
    pending = true; epoch++;
    const mine = epoch;
    if (visible) render();
    try {
      const next = await api('netfix/' + action, payload);
      if (mine !== epoch) return null;
      accept(next); return next;
    } catch (error) {
      if (mine === epoch) { serviceError = error.message || '本次操作未完成，请重新检查。'; announce(serviceError); notify(serviceError); }
      return null;
    } finally {
      if (mine === epoch) { pending = false; if (visible) render(); if (modal === 'execution') renderExecution(); }
    }
  }
  function setNavigation() {
    nav.hidden = false;
    nav.querySelectorAll('[data-open]').forEach(item => { if (item.dataset.open === 'settings') item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
  }
  function header() {
    return '<header class="page-header"><button type="button" class="icon-button" data-nf-action="overview" aria-label="返回综合检查">' + icon('back') + '</button><div><h1 tabindex="-1">Codex 网络修复工具箱</h1><p>诊断只读取证据不做修改</p></div></header>';
  }
  function rowsMarkup() {
    const rows = entries(snapshot?.rows);
    return '<div class="nf-panel nf-result-list" data-sc-surface="card" aria-label="A B C 三类诊断">' + (rows.length ? rows.map(row => '<div class="result-row"><span class="result-mark ' + (row.level === 'ok' ? 'ok' : 'warn') + '">' + icon(row.level === 'ok' ? 'check' : 'alert') + '</span><span class="row-copy"><span class="row-title">' + esc(row.tag) + '</span><span class="row-detail">' + esc(row.value ?? row.val) + (row.note ? '<br>' + esc(row.note) : '') + '</span></span><span class="row-state">' + (row.level === 'ok' ? '正常' : row.level === 'error' ? '异常' : '注意') + '</span></div>').join('') : '<p class="nf-caption">尚未取得诊断证据。</p>') + '</div>';
  }
  function detailsMarkup() {
    return '<details class="nf-panel nf-fold" data-sc-surface="card" id="nf-details"' + (details ? ' open' : '') + '><summary data-nf-action="details"><span>诊断详情<small>证据 · 链路探测（默认折叠）</small></span>' + icon('chevron') + '</summary><dl class="nf-evidence">' + entries(snapshot?.evidence).map(item => '<div><dt>' + esc(item.label) + '</dt><dd>' + esc(item.value) + (item.note ? '<p class="nf-caption">' + esc(item.note) + '</p>' : '') + '</dd></div>').join('') + '</dl><p class="nf-caption">B 成功率只计算当前链路的样本；候选与直连仅作对照，不计入。</p><div class="nf-table-wrap"><table class="nf-table"><caption class="sr-only">本轮链路探测结果</caption><thead><tr><th scope="col">目标</th><th scope="col">通道</th><th scope="col">结果</th><th scope="col">耗时</th></tr></thead><tbody>' + entries(snapshot?.probes).map(probe => '<tr data-nf-probe-kind="' + esc(probe.kind) + '"><td>' + esc(probe.target) + '</td><td>' + esc(probe.channel) + '</td><td>' + esc(probe.result) + '</td><td>' + esc(probe.ms == null ? '—' : probe.ms + ' ms') + '</td></tr>').join('') + '</tbody></table></div><p class="nf-caption">L1：配置与端口证据。L2：HTTP 链路探测。HTTP 响应不等于 Codex 模型请求完成；当前窗口和原任务未验证。</p></details>';
  }
  function backupMarkup() {
    const backups = entries(snapshot?.backups), locked = snapshot?.env?.locked === true;
    const canRestore = !blocked() && allowed('restore') && Boolean(selectedBackup);
    return '<section class="nf-panel" data-sc-surface="card" aria-label="备份与防复发"><div class="nf-group-row"><label for="nf-backup-select">备份</label><select id="nf-backup-select"' + (blocked() || !allowed('restore') ? ' disabled' : '') + '>' + (backups.length ? backups.map(item => '<option value="' + esc(item.name) + '"' + (item.name === selectedBackup ? ' selected' : '') + (item.restorable === true ? '' : ' disabled') + '>' + esc([item.at, item.port, item.name].filter(x => x != null).join(' · ') + (item.restorable === true ? '' : ' · 仅历史证据')) + '</option>').join('') : '<option value="">（暂无）</option>') + '</select>' + button('恢复', 'restore', 'secondary', !canRestore) + '</div><div class="nf-group-row"><span class="nf-group-label">防复发</span>' + button(locked ? '解除只读锁' : '锁定 .env 只读', 'lock', 'secondary', blocked() || !allowed(locked ? 'unlock' : 'lock')) + '<span class="nf-lock-state">' + (snapshot?.env?.locked == null ? '待确认' : locked ? '已锁定' : '未锁定') + '</span></div><p class="nf-caption">C 类禁自动修复 · provider 禁改 · 未备份文件禁覆盖</p></section>';
  }
  function render() {
    if (!visible) return;
    const scroll = body.scrollTop, focused = document.activeElement;
    const focusAction = shell.contains(focused) ? focused.dataset?.nfAction : null;
    const verdict = snapshot?.verdict, progress = entries(snapshot?.progress);
    const diagnosing = busy() && snapshot?.stage === 'diagnosing';
    const title = diagnosing ? progress.find(step => step.status === 'running')?.name || '正在收集诊断证据…' : verdict?.title || (pending ? '正在读取本轮诊断状态…' : '点「重新诊断」检查 Codex 网络状态');
    body.innerHTML = header() + (serviceError ? '<section class="nf-panel" data-sc-surface="card" role="alert"><p>' + esc(serviceError) + '</p></section>' : '') + '<p class="nf-scope-note">' + icon('info') + '<span>本机诊断 · 配置与链路分开验证</span></p><section class="nf-panel nf-verdict" data-sc-surface="card" aria-labelledby="nf-verdict-title"><div class="nf-tag" data-level="' + esc(verdict?.level || 'neutral') + '">' + icon(verdict?.level === 'ok' ? 'check' : verdict?.level === 'error' || verdict?.level === 'warn' ? 'alert' : 'scan') + '<span>' + esc(verdict?.tag || '就绪') + '</span></div><h2 id="nf-verdict-title">' + esc(title) + '</h2><p>' + esc(verdict?.detail || '诊断只读取证据不做修改。根因判定顺序：A 链路配置 → C 身份配额排除 → B 传输量化。') + '</p>' + (busy() && progress.length ? '<ol class="nf-diagnostic-steps">' + progress.map(step => '<li' + (step.status === 'running' ? ' aria-current="step"' : '') + '>' + icon(step.status === 'done' ? 'check' : step.status === 'running' ? 'scan' : 'clock') + esc(step.name) + '</li>').join('') + '</ol>' : '') + '</section>' + rowsMarkup() + detailsMarkup() + backupMarkup() + '<details class="nf-panel nf-fold" data-sc-surface="card" id="nf-audit"' + (auditOpen ? ' open' : '') + '><summary><span>操作记录<small>本轮变更与审计留痕</small></span>' + icon('chevron') + '</summary><ul class="nf-audit">' + entries(snapshot?.audit).map(item => '<li><time>' + esc(item.at) + '</time>' + esc(item.action) + ' → ' + esc(item.result) + '</li>').join('') + '</ul></details>';
    const mode = verdict?.fixMode || 'none';
    const enabled = mode === 'copy-report' ? Boolean(snapshot?.report) : mode === 'advice' ? Boolean(verdict?.advice) : mode === 'lock-only' ? allowed('lock') : mode === 'fix-port' ? allowed('fix-port') : false;
    footer.innerHTML = button(verdict?.fixLabel || '一键修复', 'main', 'primary', blocked() || !enabled) + '<div class="nf-action-pair">' + button(busy() ? '停止本轮处理' : '重新诊断', busy() ? 'stop' : 'diagnose', 'text-button', pending && !busy()) + (mode === 'copy-report' ? '' : button('复制报告', 'copy', 'text-button', blocked() || !snapshot?.report)) + '</div><p class="nf-foot-note">A 链路配置 → C 身份配额排除 → B 传输量化</p>';
    body.querySelector('#nf-details').addEventListener('toggle', event => { details = event.target.open; });
    body.querySelector('#nf-audit').addEventListener('toggle', event => { auditOpen = event.target.open; });
    body.querySelector('#nf-backup-select').addEventListener('change', event => { selectedBackup = event.target.value; render(); });
    body.scrollTop = scroll;
    shell.setAttribute('aria-busy', String(blocked()));
    if (focusAction && !dialog.open) shell.querySelector('[data-nf-action="' + focusAction + '"]')?.focus({preventScroll:true});
    setNavigation();
  }
  function showDialog(title, sub, content, actions) {
    const wasOpen = dialog.open, scroll = dialog.querySelector('.nf-sheet-scroll')?.scrollTop || 0;
    const focusAction = dialog.contains(document.activeElement) ? document.activeElement.dataset?.nfAction : null;
    if (!wasOpen) { restoreFocus = document.activeElement; restoreFocusKey = restoreFocus?.dataset?.nfAction || restoreFocusKey; }
    dialog.innerHTML = '<div class="nf-sheet-scroll"><div class="nf-sheet-head"><div><h2 id="nf-sheet-title">' + esc(title) + '</h2><p id="nf-sheet-sub" class="nf-caption">' + esc(sub) + '</p></div>' + (modal === 'execution' && blocked() ? '' : '<button type="button" class="dialog-close" data-nf-action="cancel-dialog" aria-label="关闭">' + icon('close') + '</button>') + '</div>' + content + '</div><div class="nf-sheet-actions">' + actions + '</div>';
    const source = shell.querySelector('.action-area .primary');
    if (source) {
      const original = getComputedStyle(source);
      dialog.querySelectorAll('.primary').forEach(item => ['borderRadius','fontSize','fontWeight','lineHeight','minHeight','padding','color','backgroundColor','boxShadow','border'].forEach(property => { item.style[property] = original[property]; }));
    }
    if (!wasOpen) dialog.showModal();
    dialog.querySelector('.nf-sheet-scroll').scrollTop = scroll;
    const focus = focusAction ? dialog.querySelector('[data-nf-action="' + focusAction + '"]:not(:disabled)') : null;
    if (focus) focus.focus({preventScroll:true});
    else if (!dialog.contains(document.activeElement)) dialog.querySelector('button:not(:disabled),textarea')?.focus({preventScroll:true});
  }
  function closeDialog(force = false) {
    if (!force && modal === 'execution' && blocked()) return;
    dialog.close(); modal = ''; plan = null;
    if (visible) {
      const target = restoreFocusKey ? shell.querySelector('[data-nf-action="' + restoreFocusKey + '"]:not(:disabled)') : null;
      if (target) target.focus({preventScroll:true});
      else if (restoreFocus?.isConnected && restoreFocus !== document.body) restoreFocus.focus({preventScroll:true});
      else shell.querySelector('[data-nf-action="main"]:not(:disabled),[data-nf-action="diagnose"]')?.focus({preventScroll:true});
    }
  }
  async function preview(action) {
    if (blocked() || !allowed(action)) return;
    restoreFocusKey = document.activeElement?.dataset?.nfAction || (action === 'fix-port' ? 'main' : action === 'restore' ? 'restore' : 'lock');
    pending = true; epoch++; const mine = epoch; render();
    try {
      const result = await api('netfix/preview', {action, ...(action === 'restore' ? {backupName:selectedBackup} : {})});
      if (mine !== epoch) return;
      if (!result?.token || entries(result.rows).length !== 6) throw new Error('修复方案不完整，请重新诊断后再试。');
      plan = result; modal = 'confirm';
      showDialog(result.title, result.sub, '<dl class="nf-disclosure">' + result.rows.map(item => '<div class="nf-disclosure-row"><dt>' + esc(Array.isArray(item) ? item[0] : item.label) + '</dt><dd>' + esc(Array.isArray(item) ? item[1] : item.value) + '</dd></div>').join('') + '</dl>', button(result.confirmLabel || '确认执行修复', 'confirm', 'primary') + button('取消', 'cancel-dialog', 'text-button'));
    } catch (error) { if (mine === epoch) { serviceError = error.message; notify(error.message); announce(error.message); } }
    finally { if (mine === epoch) { pending = false; render(); } }
  }
  function renderExecution() {
    if (!visible || modal !== 'execution') return;
    const working = blocked() || submitting;
    const title = working ? cancelPending ? '正在安全停止…' : submitting ? '正在提交本次确认…' : '正在执行修复' : serviceError ? '本次操作未确认完成' : snapshot?.stage === 'rollback_conflict' ? '恢复未完成' : snapshot?.stage === 'rolled_back' ? '链路验证失败，已回滚' : snapshot?.stage === 'cancelled' ? '本轮已停止' : '执行完成';
    const steps = submitting ? [] : entries(snapshot?.progress);
    showDialog(title, working ? '正在写入的单步会先完成，再处理停止与恢复。' : snapshot?.verdict?.detail || '请查看本轮实际处理结果。', '<ol class="nf-exec-steps">' + steps.map((step, index) => '<li data-nf-step="' + index + '" data-status="' + esc(step.status) + '">' + icon(step.status === 'done' ? 'check' : step.status === 'failed' || step.status === 'warn' ? 'alert' : step.status === 'running' ? 'scan' : 'clock') + '<div><strong>' + esc(step.name) + '</strong><small>' + esc(step.detail || ({pending:'等待执行',running:'处理中…',done:'已完成',failed:'未通过',warn:'仍需确认'})[step.status] || '') + '</small></div></li>').join('') + '</ol>' + (serviceError ? '<p class="nf-caption" role="alert">' + esc(serviceError) + '</p>' : '') + '<p class="nf-caption">当前窗口和原任务尚未验证。此处不宣称已恢复。</p>', working ? button(cancelPending ? '正在完成恢复…' : '停止本轮处理', 'stop', 'text-button', cancelPending) : button('关闭', 'close-result', 'primary'));
  }
  async function apply() {
    if (blocked() || modal !== 'confirm' || !plan?.token) return;
    const token = plan.token;
    plan = null; modal = 'execution'; submitting = true;
    renderExecution();
    await request('apply', {token, confirmed:true});
    submitting = false; renderExecution();
  }
  async function cancel() {
    if (cancelPending || (!busy() && !pending && !submitting)) return;
    cancelPending = true; epoch++;
    const mine = epoch;
    if (modal === 'execution' && visible) renderExecution();
    try { const result = await api('netfix/cancel', {}); if (mine === epoch) accept(result); }
    catch (error) { if (mine === epoch) { serviceError = error.message; notify(error.message); announce(error.message); } }
    finally { if (mine === epoch) { cancelPending = false; pending = false; submitting = false; render(); if (modal === 'execution') renderExecution(); } }
  }
  function advice() {
    const item = snapshot?.verdict?.advice;
    if (!item || typeof item !== 'object') return;
    modal = 'advice';
    showDialog(item.title, item.sub, '<ol class="nf-evidence">' + entries(item.steps).map(step => '<li><p>' + esc(step) + '</p></li>').join('') + '</ol>', button('知道了', 'cancel-dialog', 'primary'));
  }
  async function copyReport() {
    const report = snapshot?.report;
    if (!report || blocked()) return;
    try { if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(report); notify('诊断报告已复制（不含 token 明文）。'); }
    catch { modal = 'report'; showDialog('复制诊断报告', '浏览器未开放剪贴板权限，可选中报告后复制。', '<label class="nf-caption" for="nf-report-text">诊断报告</label><textarea class="nf-report" id="nf-report-text" readonly>' + esc(report) + '</textarea>', button('选中报告', 'select-report', 'primary') + button('关闭', 'cancel-dialog', 'text-button')); }
  }
  async function open() {
    window.connectionDoctor?.hide?.();
    visible = true; main.hidden = true; shell.hidden = false; setNavigation(); render();
    body.scrollTop = 0; shell.querySelector('h1')?.focus({preventScroll:true});
    if (pending) return;
    await refresh();
    if (visible && !busy() && !pending) await request('diagnose', {});
  }
  function close() {
    visible = false; shell.hidden = true;
    if (dialog.open) closeDialog(true);
  }
  async function handle(action) {
    if (action === 'details') return;
    if (action === 'overview') { close(); window.connectionDoctor?.open('start'); return; }
    if (action === 'cancel-dialog' || action === 'close-result') { closeDialog(); return; }
    if (action === 'select-report') { const target = dialog.querySelector('textarea'); target?.focus(); target?.select(); return; }
    if (action === 'stop') { await cancel(); return; }
    if (action === 'confirm') { await apply(); return; }
    if (blocked()) return;
    if (action === 'diagnose') { await request('diagnose', {}); return; }
    if (action === 'copy') { await copyReport(); return; }
    if (action === 'restore') { await preview('restore'); return; }
    if (action === 'lock') { await preview(snapshot?.env?.locked ? 'unlock' : 'lock'); return; }
    if (action === 'main') {
      const mode = snapshot?.verdict?.fixMode;
      if (mode === 'fix-port') await preview('fix-port');
      else if (mode === 'lock-only') await preview('lock');
      else if (mode === 'advice') advice();
      else if (mode === 'copy-report') await copyReport();
    }
  }
  function click(event) {
    const target = event.target.closest('[data-nf-action]');
    if (!target) return;
    if (target.dataset.nfAction !== 'details') event.preventDefault();
    void handle(target.dataset.nfAction);
  }
  shell.addEventListener('click', click); dialog.addEventListener('click', click);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (modal === 'execution' && blocked()) void cancel(); else closeDialog(); });
  dialog.addEventListener('click', event => { if (event.target !== dialog || blocked()) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled),textarea,select,input,a[href]')].filter(item => item.getClientRects().length);
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  });
  const previousOpen = openPage;
  openPage = function(name, ...args) { close(); return previousOpen(name, ...args); };
  window.netfixRepair = {
    open, close, refresh,
    getState: () => snapshot ? {...JSON.parse(JSON.stringify(snapshot)), ui:{visible,pending:pending || cancelPending,modal,details,error:serviceError}} : {ui:{visible,pending,modal,details,error:serviceError}}
  };
  window.addEventListener('clash-render', () => { if (visible) setNavigation(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && (visible || busy())) void refresh(); });
  setInterval(() => {
    const expires = plan ? typeof plan.expiresAt === 'number' ? plan.expiresAt : Date.parse(plan.expiresAt) : NaN;
    if (plan && Number.isFinite(expires) && Date.now() >= expires) { plan = null; modal = 'expired'; showDialog('修复方案已过期', '请重新诊断，核对当前配置后再生成方案。', '', button('关闭', 'cancel-dialog', 'primary')); }
    if ((visible || busy()) && Date.now() - lastRead > 700) void refresh();
  }, 700);
})();
