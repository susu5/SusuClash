'use strict';

const $ = id => document.getElementById(id);
const pages = [...document.querySelectorAll('[data-page]')];
const tabs = [...document.querySelectorAll('.tabs button')];
const ui = { page: 'home', runtime: null, core: null, groups: [], group: '', groupScope: '', profiles: [], profile: '', proxy: null, autostart: null, tray: null, connections: null, connectionPending: false, connectionFailed: false, app: '', connection: '', diagnosis: null, automation: null, logs: null, logError: '', logFilter: 'all', backupDraft: [], pendingPage: '', formPendingPage: '', formInitial: '', busy: false, filter: 'all', failures: new Set(), sample: null, first: true };
const modeLabels = { rule: '规则模式', global: '全局模式', direct: '直连模式' };

function set(id, value) { $(id).textContent = value ?? '—'; }
function el(tag, cls, content) { const n = document.createElement(tag); if (cls) n.className = cls; if (content != null) n.textContent = content; return n; }
async function api(endpoint, payload) {
  const options = payload === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  const response = await fetch('api/' + endpoint, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败，请重试');
  return data;
}
function notify(message) { const node = $('toast'); node.textContent = message; node.hidden = false; clearTimeout(notify.timer); notify.timer = setTimeout(() => { node.hidden = true; }, 3500); }
function bytes(value) { if (!Number.isFinite(value)) return '—'; if (value < 1024) return Math.round(value) + ' B'; if (value < 1048576) return (value / 1024).toFixed(1) + ' KB'; if (value < 1073741824) return (value / 1048576).toFixed(1) + ' MB'; return (value / 1073741824).toFixed(1) + ' GB'; }
function currentGroup() { return ui.groups.find(g => g.name === ui.group) || ui.groups[0]; }
function currentProfile() { return ui.profiles.find(p => p.active); }
function currentDetail() { return ui.profiles.find(p => p.id === ui.profile); }
function unavailable(button, reason) { button.disabled = true; button.title = reason; button.setAttribute('aria-description', reason); }
function openPage(name, discard = false) {
  if (!discard && ui.page === 'subscriptionForm' && name !== 'subscriptionForm' && JSON.stringify([$('subName').value,$('subUrl').value]) !== ui.formInitial) { ui.formPendingPage=name; $('subDiscardDialog').showModal(); return; }
  if (!discard && ui.page === 'backups' && name !== 'backups' && JSON.stringify(ui.backupDraft) !== JSON.stringify(ui.automation?.backups || [])) { ui.pendingPage=name; $('discardDialog').showModal(); return; }
  if (name === 'backups' && ui.page !== 'backups') { ui.backupDraft=ui.automation?.group===currentGroup()?.name ? [...(ui.automation?.backups || [])] : []; renderBackupEditor(); }
  if (name === 'subscriptionForm' && ui.page !== 'subscriptionForm') ui.formInitial=JSON.stringify([$('subName').value,$('subUrl').value]);
  ui.page = name;
  pages.forEach(p => { p.hidden = p.dataset.page !== name; });
  const active = ['subscriptionForm','subscriptionDetail','subscriptions','localImport','backups','runtime','logs','about'].includes(name) ? 'settings' : ['connectionApp','connectionDetail'].includes(name) ? 'connections' : name === 'check' ? 'home' : name;
  tabs.forEach(t => { if (t.dataset.open === active) t.setAttribute('aria-current','page'); else t.removeAttribute('aria-current'); });
  document.querySelector('.tabs').hidden = name === 'welcome';
  document.querySelector('.app main').scrollTop = 0;
  document.querySelector('[data-page="' + name + '"] [tabindex="-1"]')?.focus({preventScroll:true});
  if (name === 'subscriptions') refreshProfiles();
  if (name === 'lines') refreshGroups();
  if (name === 'connections') refreshConnections();
  if (name === 'logs') refreshLogs();
  if (name === 'check') runCheck();
  render();
}
async function action(label, fn) {
  if (ui.busy) return;
  ui.busy = true; render(); notify(label);
  try { return await fn(); } catch (error) { notify(error.message); throw error; }
  finally { ui.busy = false; render(); }
}
function renderHome() {
  const core = ui.core, runtime = ui.runtime;
  const group = currentGroup();
  const item = group?.members?.find(m => m.name === group.current);
  const issue = Boolean(runtime?.recoveryWarning) || ui.automation?.phase === 'issue' || ui.diagnosis?.tone === 'warn' || runtime?.state === 'error' || runtime?.state === 'missing';
  const processing = ['repairing','switching'].includes(ui.automation?.phase);
  const confirming = ui.automation?.phase === 'confirming';
  document.body.dataset.tone = issue || confirming ? 'problem' : core ? 'normal' : 'off';
  set('heroTitle', issue ? (runtime?.recoveryWarning ? '运行状态需要确认' : runtime?.state === 'missing' ? '未找到代理内核' : runtime?.state === 'error' ? '内核运行异常' : ui.automation?.problem === 'codex' ? 'Codex 连接异常' : '检测发现问题') : processing ? '正在自动处理' : confirming ? '正在确认异常' : core ? '内核运行中' : currentProfile() ? '内核未运行' : '先添加配置');
  set('heroSubLead', core?.mode ? (modeLabels[core.mode] || core.mode) + ' · ' : '');
  set('heroSubDetail', issue ? '点击圆球查看问题' : processing ? '点击圆球查看处理进度' : confirming ? '点击圆球查看检查情况' : core ? (ui.automation?.message || '网络状态待检测') : (runtime?.message || '添加并启用配置'));
  $('statusOrb').disabled = false;
  $('statusOrb').setAttribute('aria-label', '查看问题检测');
  set('port', core?.port ?? '—'); set('settingsPort', core?.port ?? '—'); set('heroLatency', item?.delay > 0 ? item.delay + ' ms' : '—');
  set('download', core?.rate ?? '—'); set('nodeName', group?.current || '尚未选择线路');
  document.querySelectorAll('[data-mode]').forEach(b => { b.disabled = !core || ui.busy; b.setAttribute('aria-pressed', String(core?.mode === b.dataset.mode)); });
  const externalProxy = ui.proxy?.enabled === true && ui.proxy?.managed === false;
  $('proxySwitch').disabled = !ui.proxy || ui.proxy.enabled == null || ui.busy || externalProxy || (!core && !ui.proxy.managed);
  $('proxySwitch').setAttribute('aria-checked', String(ui.proxy?.enabled === true));
  $('proxySwitch').title = ui.proxy?.enabled == null ? '无法读取系统代理状态' : externalProxy ? '当前系统代理由其他程序管理，请先检查现有设置' : !core ? '请先启动内核' : '';
  $('runtimeProxyState').textContent = ui.proxy?.enabled == null ? '未知' : ui.proxy.enabled ? (externalProxy ? '其他程序已开启' : '已开启') : '已关闭';
  const autostart=document.querySelector('[data-local-switch="开机启动"]');
  autostart.disabled=!ui.autostart || ui.autostart.conflict || ui.busy;
  autostart.setAttribute('aria-checked',String(ui.autostart?.enabled===true));
  autostart.closest('.row').querySelector('.hint').textContent=!ui.autostart?'无法读取启动状态':ui.autostart.conflict?'同名启动项已被占用，请检查 Windows 启动设置':ui.autostart.enabled?'登录 Windows 后自动打开':'已关闭';
  const tray=document.querySelector('[data-local-switch="关闭窗口时留在托盘"]');
  tray.disabled=!ui.tray || ui.tray.available!==true || ui.busy;
  tray.setAttribute('aria-checked',String(ui.tray?.available===true && ui.tray?.closeToTray===true));
  tray.closest('.row').querySelector('.hint').textContent=!ui.tray?'无法读取托盘设置':ui.tray.available===false?'托盘不可用，关闭窗口将退出':ui.tray.available!==true?'托盘尚未就绪，关闭窗口将退出':ui.tray.closeToTray?'关闭后继续运行，可从托盘退出':'关闭窗口时退出';
  $('runtimeCoreState').textContent = ({missing:'未找到',stopped:'已停止',starting:'启动中',running:'运行中',error:'异常'})[runtime?.state] || '未知';
  set('aboutAppVersion', runtime?.appVersion || '—');
  set('aboutCoreVersion', runtime?.version || '—');
  for(const id of ['settingsRuntimeWarning','checkRuntimeWarning']){const box=$(id);box.textContent=runtime?.recoveryWarning||'';box.hidden=!runtime?.recoveryWarning;}
  $('runtimeTunState').textContent = '尚未接入';
  $('tunSwitch').setAttribute('aria-checked', String(core?.tun === true));
  $('lineSubscriptionName').textContent = currentProfile()?.name || '尚未启用配置';
  $('update').textContent = currentProfile()?.kind === 'url' ? '更新订阅' : '管理订阅';
  $('subscriptionHint').textContent = currentProfile() ? '当前配置' : '请先添加并启用配置';
  renderAutomation();
  $('restartCore').textContent = runtime?.state === 'running' ? '重启内核' : '启动内核';
  $('restartCore').disabled = !currentProfile() || runtime?.state === 'missing' || runtime?.state === 'starting' || ui.busy;
  $('stopCore').disabled = runtime?.state !== 'running' || ui.busy;
  $('editPort').disabled = !core || ui.busy;
  document.querySelector('.preview-note').textContent = runtime?.message || (runtime?.version ? '内核 ' + runtime.version : '');
}
function renderLines() {
  const group = currentGroup();
  const select = $('strategyGroup');
  const values = ui.groups.map(g => g.name);
  if ([...select.options].map(o=>o.value).join('\0') !== values.join('\0')) select.replaceChildren(...values.map(v=>new Option(v,v)));
  if (group) { ui.group = group.name; select.value = group.name; }
  select.disabled = !group || ui.busy;
  $('ping').disabled = !group?.members?.length || ui.busy || !ui.core;
  const query = $('lineSearch').value.trim().toLowerCase();
  let members = [...(group?.members || [])].filter(m => m.name.toLowerCase().includes(query)).filter(m => ui.filter === 'backup' ? (ui.automation?.group === group.name && (ui.automation?.backups || []).includes(m.name)) : ui.filter === 'normal' ? m.delay > 0 : ui.filter === 'abnormal' ? ui.failures.has(group.name + '\0' + m.name) : true);
  const order = $('lineSort').value;
  members.sort((a,b) => (a.delay > 0 ? 0 : 1) - (b.delay > 0 ? 0 : 1) || (order === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : order === 'high' ? (b.delay || 0) - (a.delay || 0) : (a.delay || 0) - (b.delay || 0)));
  const nodes = members.map(m => {
    const button = el('button','node'); button.type = 'button'; button.dataset.member = m.name; button.disabled = !ui.core || ui.busy; button.setAttribute('aria-pressed', String(m.name === group.current));
    const code = el('span','node-code', m.name.slice(0,2).toUpperCase());
    const copy = el('span','row-copy row-label',m.name); const meta = el('span','line-meta', m.name === group.current ? '当前' : ''); copy.append(meta);
    const status = m.delay > 0 ? m.delay + ' ms' : ui.failures.has(group.name + '\0' + m.name) ? '测试失败' : '未测';
    button.append(code,copy,el('span','latency',status)); return button;
  });
  $('nodes').replaceChildren(...(nodes.length ? nodes : [el('p','line-empty', !group ? '当前配置没有可手动选择的策略组。' : ui.filter === 'backup' ? '备用节点功能尚未接入。' : '没有符合条件的线路。')]));
}
function renderProfiles() {
  set('subscriptionCount', ui.profiles.length + ' 个');
  const items = ui.profiles.map(p => { const b = el('button','sub-list-item'); b.type='button'; b.dataset.profile = p.id; const c=el('span','row-copy'); c.append(el('span','row-label',p.name),el('span','hint',p.lastError?(p.active?'更新失败 · 沿用当前配置':'更新失败'):p.active?'当前配置':p.loaded?'已加载':'未加载')); b.append(c,el('span','chevron','›')); return b; });
  $('subscriptionList').replaceChildren(...(items.length ? items : [el('p','sub-empty','还没有配置，点击右上角新建。')]));
}
function renderProfileDetail() {
  const p = currentDetail(); if (!p) return;
  set('subDetailName',p.name); set('subDetailState',p.active?'当前配置':p.loaded?'已加载':'未加载');
  set('subDetailExplanation',p.lastError ? '上次更新失败：' + p.lastError : p.lastSuccess ? '最近成功更新：' + new Date(p.lastSuccess).toLocaleString() : '');
  $('selectSubscription').disabled = p.active || !p.loaded || ui.busy;
  $('selectSubscription').textContent = p.active?'当前配置':'设为当前';
  $('updateSubscription').hidden = p.kind !== 'url';
  $('editSubscription').hidden = p.kind !== 'url';
  $('deleteSubscription').disabled = p.active || ui.busy;
  $('deleteSubscription').title = p.active ? '请先切换到其他配置' : '';
}
function renderAutomation() {
  const a=ui.automation, group=currentGroup();
  const enabled=Boolean(a && group && currentProfile() && ui.core && a.group===group.name && a.scope===currentProfile().id);
  const backups = a?.group === group?.name && Array.isArray(a?.backups) ? a.backups : [];
  const eligible=backups.some(name=>name!==group?.current && group?.members?.some(m=>m.name===name));
  $('autoRepairSwitch').disabled = !enabled || ui.busy;
  $('autoRepairSwitch').setAttribute('aria-checked',String(a?.autoRepair===true));
  $('autoRepairSwitch').closest('.row').querySelector('.hint').textContent=enabled?'目前仅支持尝试恢复内核':'等待内核和策略组';
  // An enabled control can guide the user to pick backups instead of silently
  // disabling a setting they cannot discover how to enable.
  $('autoSwitch').disabled = !enabled || ui.busy;
  $('autoSwitch').setAttribute('aria-checked',String(a?.autoSwitch===true));
  $('autoSwitchHint').textContent = !enabled ? '等待内核和策略组' : !eligible ? (a?.autoSwitch?'当前策略组没有其他可用备用节点，切换暂停':'先选择不同于当前线路的备用节点') : a?.autoSwitch?'确认节点故障后按顺序尝试':'开启后确认节点故障再切换';
  $('backupSummary').textContent = !enabled?'等待内核和策略组': backups.length?'已选 '+backups.length+' 个 · 按顺序尝试':'尚未设置';
  const preview=$('backupPreview');preview.hidden=!backups.length;preview.replaceChildren(...backups.map((name,i)=>{const row=el('li');row.append(el('span','order-badge',i+1),el('span','',name+(name===group?.current?' · 当前线路，切换时跳过':!group?.members?.some(m=>m.name===name)?' · 已失效':'')));return row;}));
  const button=document.querySelector('[data-page="settings"] [data-open="backups"]');button.disabled=!enabled||ui.busy;
  document.querySelector('[data-filter="backup"]').disabled=!enabled;
  $('automationInterval').textContent=a?'每 5 秒检查一次':'检测服务不可用';
  set('automationStatus',a?.message || '自动检查状态暂不可用');
  const targets = Array.isArray(a?.targets) && a.targets.length ? a.targets.join('；') : '暂不可用';
  set('settingsTargets', targets); set('checkTargets', targets);
  const codexTarget = typeof a?.codexTarget === 'string' && a.codexTarget ? a.codexTarget : '暂不可用';
  set('settingsCodexTarget',codexTarget); set('checkCodexTarget',codexTarget);
  const when=a?.lastChecked ? new Date(a.lastChecked) : null; set('autoCheckedTime',when && Number.isFinite(when.getTime())?'最近检查：'+when.toLocaleString('zh-CN',{hour12:false}):'最近检查：暂无');
  const checks=[['core','代理内核'],['port','代理端口'],['network','本机网络'],['node','当前线路'],['codex','Codex 连接']];
  $('autoChecks').replaceChildren(...checks.map(([key,label])=>{const row=el('div','row');const state=a?.checks?.[key];const result=el('span','result',state==='ok'?'正常':state==='failed'?(a?.phase==='confirming'?'待确认':'异常'):'未知');result.dataset.tone=state==='ok'?'ok':state==='failed'?'warn':'';const copy=el('span','row-copy');copy.append(el('span','row-label',label));if(key==='codex'){const checked=a?.codexCheckedAt?new Date(a.codexCheckedAt):null;const detail=[a?.codexDetail,checked && Number.isFinite(checked.getTime())?'最近检查：'+checked.toLocaleString('zh-CN',{hour12:false}):'最近检查：暂无'].filter(Boolean).join(' · ');copy.append(el('span','hint',detail));}row.append(copy,result);return row;}));
}
function renderBackupEditor(focusName) {
  const group=currentGroup();set('backupGroupLabel',group?'策略组 · '+group.name:'暂无策略组');
  set('draftCount','已选 '+ui.backupDraft.length+' 个'+(JSON.stringify(ui.backupDraft)!==JSON.stringify(ui.automation?.backups||[])?' · 未保存':''));
  const list=$('backupList');list.replaceChildren();
  if(!ui.backupDraft.length) list.append(el('p','empty-state','还没有备用节点，从下方添加。'));
  ui.backupDraft.forEach((name,i)=>{const row=el('div','backup-row');row.dataset.name=name;const copy=el('span','row-copy');copy.append(el('span','row-label',name));if(name===group?.current)copy.append(el('span','hint','当前线路，切换时跳过'));else if(!group?.members?.some(m=>m.name===name))copy.append(el('span','hint','已失效，切换时跳过'));const actions=el('div','order-actions');const remove=el('button');remove.type='button';remove.dataset.remove=name;remove.setAttribute('aria-label','移除 '+name);remove.innerHTML='<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';const handle=el('button','drag-handle');handle.type='button';handle.dataset.name=name;handle.setAttribute('aria-label','排序 '+name+'，按住拖动或使用上下方向键');handle.innerHTML='<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M8 7h8M8 12h8M8 17h8"/></svg>';actions.append(remove,handle);row.append(el('span','order-badge',i+1),copy,actions);list.append(row);});
  const available=(group?.members||[]).map(member=>{const b=el('button','available-node');b.type='button';b.dataset.add=member.name;b.disabled=member.name===group.current||ui.backupDraft.includes(member.name);b.append(el('span','row-copy row-label',member.name),el('span','add-label',member.name===group.current?'当前线路':ui.backupDraft.includes(member.name)?'已添加':'添加'));return b;});
  $('availableNodes').replaceChildren(...(available.length?available:[el('p','empty-state','暂无可选线路。')]));
  if(focusName) [...list.querySelectorAll('.drag-handle')].find(b=>b.dataset.name===focusName)?.focus({preventScroll:true});
}
function connectionMessage() {
  if (ui.connectionPending && !ui.connectionFailed) return el('p','connection-empty','正在读取连接…');
  const block=el('div','connection-error');
  block.append(el('p','',ui.core ? '连接数据暂不可用，请重试或检查内核状态。' : '内核尚未就绪，请先启用配置并启动内核。'));
  const retry=el('button','text-button','重新读取'); retry.type='button'; retry.dataset.retryConnections='true';
  block.append(retry); return block;
}
function renderConnections() {
  const items = ui.connections?.connections;
  if (!Array.isArray(items)) { set('connectionCount',ui.connectionPending && !ui.connectionFailed?'读取中':'暂不可用'); $('connectionList').replaceChildren(connectionMessage()); return; }
  set('connectionCount',items.length+' 条当前连接');
  const query = $('connectionSearch').value.trim().toLowerCase();
  const matches = items.filter(i => ((i.app || '未知应用') + ' ' + (i.address || '')).toLowerCase().includes(query));
  const apps = [...new Set(matches.map(i => i.app || '未知应用'))];
  const emptyMessage = items.length ? '没有找到匹配的连接'
    : ui.proxy?.enabled === true && ui.proxy?.managed === false ? '暂无当前连接。系统代理由其他程序管理，流量可能未经过本软件。'
    : ui.proxy?.enabled === false && ui.core?.tun === false ? '暂无当前连接。系统代理和 TUN 均未开启，流量可能未经过本软件。'
    : '暂无当前连接';
  $('connectionList').replaceChildren(...(apps.length ? apps.map(name => { const count=items.filter(i=>(i.app||'未知应用')===name).length; const b=el('button','connection-item'); b.type='button'; b.dataset.app=name; const c=el('span','row-copy'); c.append(el('span','row-label',name),el('span','connection-domain',count+' 条当前连接')); b.append(c,el('span','chevron','›')); return b; }) : [el('p','connection-empty',emptyMessage)]));
}
function renderConnectionApp() {
  if (!ui.connections || !Array.isArray(ui.connections.connections)) {
    set('connectionAppTitle',ui.app); set('connectionAppCount','连接数据暂不可用');
    $('connectionAppList').replaceChildren(connectionMessage()); return;
  }
  const items = (ui.connections?.connections || []).filter(i=>(i.app||'未知应用')===ui.app);
  set('connectionAppTitle',ui.app); set('connectionAppCount',items.length+' 条当前连接');
  $('connectionAppList').replaceChildren(...(items.length?items.map(i=>{ const b=el('button','connection-item'); b.type='button'; b.dataset.id=i.id; const c=el('span','row-copy'); c.append(el('span','row-label',i.address||'未知地址'),el('span','connection-domain',i.route||'未知路径')); b.append(c,el('span','chevron','›')); return b; }):[el('p','connection-empty','该应用暂无当前连接')]));
}
function renderConnectionDetail() {
  if (!ui.connections || !Array.isArray(ui.connections.connections)) {
    $('detailUnavailable').hidden=false; $('disconnectOne').disabled=true;
    set('detailConnectionState','未知'); set('detailRoute','—'); set('detailDuration','—'); set('detailTraffic','—'); return;
  }
  const i=ui.connections?.connections?.find(x=>x.id===ui.connection); if (!i) { openPage('connectionApp'); return; }
  $('detailUnavailable').hidden=true; $('disconnectOne').disabled=false; set('detailConnectionState','连接中');
  set('detailAddress',i.address||'未知地址'); set('detailApp',i.app||'未知应用'); set('detailRoute',i.route||'未知');
  const seconds = i.startedAt ? Math.max(0,Math.floor((Date.now()-Date.parse(i.startedAt))/1000)) : NaN;
  set('detailDuration',Number.isFinite(seconds)?Math.floor(seconds/60)+' 分 '+seconds%60+' 秒':'未知'); set('detailTraffic',bytes(i.upload)+' / '+bytes(i.download));
}
function cleanLogText(value) {
  return String(value || '').replace(/https?:\/\/[^\s"'<>]+/gi,'[链接已隐藏]').replace(/\b(token|password|passwd|authorization|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'$1=[已隐藏]').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[地址已隐藏]').replace(/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]{1,39}\b/gi,'[地址已隐藏]');
}
function renderLogs() {
  const container=$('runtimeLogList');
  if(ui.logs===null){container.replaceChildren(el('p','empty-state',ui.logError||'正在读取日志…'));return;}
  const now=Date.now(), period=$('logPeriod').value, startOfDay=new Date();startOfDay.setHours(0,0,0,0);
  const cutoff=period==='hour'?now-3600000:period==='today'?startOfDay.getTime():period==='week'?now-7*86400000:null;
  const filtered=ui.logs.filter(item=>{const when=Date.parse(item.time);const level=String(item.level||'info').toLowerCase();return (!cutoff || Number.isFinite(when)&&when>=cutoff) && (ui.logFilter==='all'||['error','warn','warning','fatal'].includes(level));});
  const rows=filtered.map(item=>{const row=el('div','log-item');const date=new Date(item.time);const label=Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'时间未知';const level=String(item.level||'info').toLowerCase();row.append(el('time','',label+' · '+(['error','fatal'].includes(level)?'错误':['warn','warning'].includes(level)?'警告':'信息')),el('p','',cleanLogText(item.message)));return row;});
  container.replaceChildren(...(rows.length?rows:[el('p','empty-state',ui.logs.length?'当前筛选条件下没有日志':'暂无运行日志')]));
}
function render() { renderHome(); if(ui.page==='lines')renderLines(); if(ui.page==='subscriptions')renderProfiles(); if(ui.page==='subscriptionDetail')renderProfileDetail(); if(ui.page==='connections')renderConnections(); if(ui.page==='connectionApp')renderConnectionApp(); if(ui.page==='connectionDetail')renderConnectionDetail(); if(ui.page==='logs')renderLogs(); window.dispatchEvent(new Event('clash-render')); }
async function refreshProfiles() { try { const r=await api('profiles'); ui.profiles=r.profiles || []; render(); } catch(e) { notify(e.message); } }
async function refreshGroups() { try { const r=await api('groups'); ui.groups=r.groups || []; const scope=currentProfile()?.id || ''; const preferred=ui.groupScope!==scope && ui.automation?.scope===scope ? ui.automation.group : ui.group; ui.group=ui.groups.some(g=>g.name===preferred)?preferred:(ui.groups[0]?.name||''); if(ui.groups.length)ui.groupScope=scope; render(); } catch { ui.groups=[]; render(); } }
let connectionRequestId = 0;
async function refreshConnections() {
  const requestId = ++connectionRequestId;
  if (!ui.connections) { ui.connectionPending=true; ui.connectionFailed=false; render(); }
  try {
    const result=await api('connections');
    if (!Array.isArray(result?.connections)) throw new Error('invalid connection data');
    if (requestId !== connectionRequestId) return;
    ui.connections=result; ui.connectionFailed=false;
  } catch {
    if (requestId !== connectionRequestId) return;
    ui.connections=null; ui.connectionFailed=true;
  } finally {
    if (requestId === connectionRequestId) { ui.connectionPending=false; render(); }
  }
}
async function refreshLogs() { $('refreshLogs').disabled=true; try { const result=await api('logs'); if(!Array.isArray(result.entries))throw new Error('日志数据格式无效');ui.logs=result.entries;ui.logError=''; } catch(e) { ui.logs=null;ui.logError=cleanLogText(e.message || '无法读取日志'); } finally { $('refreshLogs').disabled=false;renderLogs(); } }
async function refresh() {
  try { ui.runtime=await api('runtime'); } catch { ui.runtime={state:'error',message:'本地服务不可用'}; }
  try { const next=await api('state'); const previous=ui.sample; if(previous && next.connections?.downloaded>=previous.connections?.downloaded) { const dt=(next.sampledAt-previous.sampledAt)/1000; next.rate=dt>0?bytes((next.connections.downloaded-previous.connections.downloaded)/dt)+'/s':'—'; } ui.sample=next.mode ? next : null; ui.core=next.mode ? next : null; }
  catch { ui.core=null; ui.sample=null; }
  try { ui.proxy=await api('system-proxy'); } catch { ui.proxy=null; }
  try { const value=await api('autostart'); ui.autostart=typeof value.enabled==='boolean' && typeof value.conflict==='boolean' ? value : null; } catch { ui.autostart=null; }
  try { const value=await api('tray'); ui.tray=typeof value.closeToTray==='boolean' ? value : null; } catch { ui.tray=null; }
  try { ui.automation=await api('automation'); } catch { ui.automation=null; }
  if(ui.core && (ui.page==='home'||ui.page==='lines'||ui.groupScope!==(currentProfile()?.id||''))) await refreshGroups();
  try { const g=currentGroup(); if(ui.automation && g && currentProfile() && (ui.automation.group!==g.name || ui.automation.scope!==currentProfile().id)) ui.automation=await api('automation',{group:g.name}); if(ui.automation?.phase==='recovered')ui.diagnosis=null; } catch { ui.automation=null; }
  if(['connections','connectionApp','connectionDetail'].includes(ui.page)) await refreshConnections();
  render();
}
async function runCheck() {
  $('runCheck').disabled=true; $('runCheck').textContent='检测中…';
  try { const d=await api('diagnose',{}); ui.diagnosis=d; $('notice').hidden=false; $('notice').dataset.tone=d.tone||''; set('resultTitle',d.title); set('resultCopy',d.detail); $('repairSteps').replaceChildren(...(d.steps||[]).map(x=>el('li','',x))); const names={core:'代理内核',port:'代理端口',web:'网络连接',codex:'Codex 连接'}; const root=document.querySelector('.results'); root.replaceChildren(...(d.checks||[]).map(x=>{const row=el('li','row'); const copy=el('span','row-copy row-label',x.label||x.name||names[x.id]||x.id); if(x.detail)copy.append(el('span','hint',x.detail)); const val=el('span','result',x.value); val.dataset.tone=x.tone||''; row.append(copy,val); return row;})); }
  catch(e) { $('notice').hidden=false; set('resultTitle','检测未完成'); set('resultCopy',e.message); }
  finally { $('runCheck').disabled=false; $('runCheck').textContent='重新检测'; render(); }
}

document.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>openPage(b.dataset.open)));
$('welcomeAdd').addEventListener('click',()=>{ui.profile='';$('subName').value='';$('subUrl').value='';set('subFormError','');openPage('subscriptionForm');});
$('welcomeDemo').addEventListener('click',()=>openPage('home'));
$('update').addEventListener('click',()=>{if(ui.busy)return;const p=currentProfile();if(!p||p.kind!=='url'){openPage('subscriptions');return}const d=$('updateDialog'),text=$('updateDialogStatus'),close=$('closeUpdateDialog');text.textContent='正在获取订阅配置与线路信息…';close.disabled=true;close.textContent='更新中…';d.showModal();action('正在更新订阅…',async()=>{await api('profiles/update',{id:p.id});await refreshProfiles();await refresh();text.textContent='订阅更新完成。配置或线路如有变化，请检查当前连接。';}).catch(()=>{text.textContent='更新失败，当前配置保持原状，请稍后重试。'}).finally(()=>{close.disabled=false;close.textContent='完成'});});$('closeUpdateDialog').addEventListener('click',()=>$('updateDialog').close());
$('newSubscription').addEventListener('click',()=>{ ui.profile=''; $('subName').value=''; $('subUrl').value=''; set('subFormError',''); $('subFormTitle').textContent='新建订阅'; $('subUrl').placeholder='https://…'; openPage('subscriptionForm'); });
$('cancelSubscriptionForm').addEventListener('click',()=>openPage(ui.profile?'subscriptionDetail':'subscriptions'));
$('subscriptionForm').addEventListener('submit',async event=>{
  event.preventDefault(); const name=$('subName').value.trim(), url=$('subUrl').value.trim();
  if(!name || (!ui.profile && !url)) { set('subFormError','请填写名称和订阅链接'); return; }
  $('saveSubscription').disabled=true; set('subFormError','正在加载并验证…');
  try { await api(ui.profile?'profiles/edit':'profiles/url',ui.profile?{id:ui.profile,name,url}:{name,url}); $('subUrl').value=''; set('subFormError',''); await refreshProfiles(); openPage('subscriptions',true); notify('配置已保存'); }
  catch(e) { set('subFormError',e.message); } finally { $('saveSubscription').disabled=false; }
});
$('subscriptionList').addEventListener('click',e=>{const b=e.target.closest('[data-profile]'); if(!b)return; ui.profile=b.dataset.profile; openPage('subscriptionDetail');});
$('editSubscription').addEventListener('click',()=>{const p=currentDetail(); if(!p)return; $('subName').value=p.name; $('subUrl').value=''; set('subFormError',''); $('subFormTitle').textContent='编辑订阅'; $('subUrl').placeholder='留空则保留原链接'; openPage('subscriptionForm');});
$('selectSubscription').addEventListener('click',()=>action('正在启用配置…',async()=>{await api('profiles/activate',{id:ui.profile}); ui.diagnosis=null; await refreshProfiles(); await refresh(); await refreshGroups(); notify('配置已启用');}).catch(()=>{}));
$('updateSubscription').addEventListener('click',()=>action('正在更新订阅…',async()=>{await api('profiles/update',{id:ui.profile}); await refreshProfiles(); await refresh(); notify('订阅已更新');}).catch(async()=>{await refreshProfiles();}));
$('deleteSubscription').addEventListener('click',()=>{ const p=currentDetail(); if(!p || p.active)return; set('subDeleteCopy','确认删除该配置？此操作不可撤销。'); $('subDeleteDialog').showModal(); });
$('subKeep').addEventListener('click',()=>$('subDeleteDialog').close());
$('subDeleteConfirm').addEventListener('click',()=>{ $('subDeleteDialog').close(); action('正在删除…',async()=>{await api('profiles/delete',{id:ui.profile}); await refreshProfiles(); openPage('subscriptions'); notify('配置已删除');}).catch(()=>{}); });
$('selectLocalFile').addEventListener('click',()=>$('configFile').click());
$('configFile').addEventListener('change',async event=>{const file=event.target.files?.[0]; event.target.value=''; if(!file)return; if(file.size>5*1024*1024){notify('文件不能超过 5 MiB');return;} try {const content=await file.text(); await action('正在导入配置…',async()=>{await api('profiles/local',{name:file.name.replace(/\.(ya?ml)$/i,''),content}); await refreshProfiles(); openPage('subscriptions'); notify('配置已导入，请选择启用');});} catch {} });
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>action('正在切换模式…',async()=>{await api('mode',{mode:b.dataset.mode}); ui.diagnosis=null; await refresh(); notify('模式已切换');}).catch(()=>{})));
$('proxySwitch').addEventListener('click',()=>{if(ui.proxy?.enabled==null)return; action('正在更新系统代理…',async()=>{ui.proxy=await api('system-proxy',{enabled:!ui.proxy.enabled}); render(); notify('系统代理已更新');}).catch(()=>{});});
document.querySelector('[data-local-switch="开机启动"]').addEventListener('click',()=>{if(!ui.autostart||ui.autostart.conflict)return;action('正在更新开机启动…',async()=>{ui.autostart=await api('autostart',{enabled:!ui.autostart.enabled});notify('开机启动已更新');}).catch(()=>{});});
document.querySelector('[data-local-switch="关闭窗口时留在托盘"]').addEventListener('click',()=>{if(!ui.tray || ui.tray.available!==true)return;action('正在更新托盘设置…',async()=>{const desired=!ui.tray.closeToTray;const result=await api('tray',{closeToTray:desired});if(typeof result.closeToTray!=='boolean' || result.closeToTray!==desired || result.available!==true){ui.tray=null;throw new Error('无法确认托盘设置，请刷新后重试');}ui.tray=result;notify('托盘设置已更新');}).catch(()=>{});});
$('strategyGroup').addEventListener('change',e=>{const previous=ui.group;ui.group=e.target.value;ui.diagnosis=null;renderLines();if(ui.automation)action('正在切换策略组…',async()=>{ui.automation=await api('automation',{group:ui.group});render();}).catch(()=>{ui.group=previous;renderLines();});});
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{ui.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));renderLines();}));
$('lineSort').addEventListener('change',renderLines);
$('nodes').addEventListener('click',e=>{const b=e.target.closest('[data-member]'),g=currentGroup();if(!b||!g||b.dataset.member===g.current)return;action('正在切换线路…',async()=>{await api('select',{group:g.name,member:b.dataset.member});ui.diagnosis=null;await refreshGroups();notify('线路已切换');}).catch(()=>{});});
$('ping').addEventListener('click',()=>{const g=currentGroup();if(!g)return;action('正在测速…',async()=>{const queue=[...g.members]; let done=0; async function worker(){for(;;){const m=queue.shift();if(!m)return;try{const r=await api('delay',{group:g.name,member:m.name});m.delay=r.delay;ui.failures.delete(g.name+'\0'+m.name);}catch{m.delay=null;ui.failures.add(g.name+'\0'+m.name);}set('lineStatus','测速 '+(++done)+' / '+g.members.length);renderLines();}} await Promise.all(Array.from({length:Math.min(4,queue.length)},worker));notify('测速完成');}).catch(()=>{});});
$('statusOrb').addEventListener('click',()=>window.connectionDoctor?.open()); $('runCheck').addEventListener('click',runCheck);
$('connectionSearch').addEventListener('input',renderConnections);
$('connectionList').addEventListener('click',e=>{if(e.target.closest('[data-retry-connections]')){void refreshConnections();return;}const b=e.target.closest('[data-app]');if(b){ui.app=b.dataset.app;openPage('connectionApp');}});
$('connectionAppList').addEventListener('click',e=>{if(e.target.closest('[data-retry-connections]'))void refreshConnections();});
$('connectionAppList').addEventListener('click',e=>{const b=e.target.closest('[data-id]');if(b){ui.connection=b.dataset.id;openPage('connectionDetail');}});
$('disconnectOne').addEventListener('click',()=>$('connectionDialog').showModal()); $('cancelDisconnect').addEventListener('click',()=>$('connectionDialog').close());
$('confirmDisconnect').addEventListener('click',()=>{ $('connectionDialog').close(); action('正在断开…',async()=>{await api('disconnect',{id:ui.connection});await refreshConnections();openPage('connectionApp');notify('连接已断开');}).catch(()=>{}); });
$('restartCore').addEventListener('click',()=>action('正在启动内核…',async()=>{if(ui.runtime?.state==='running')await api('core-stop',{});await api('core-start',{});await refresh();notify('内核已启动');}).catch(()=>{}));
$('stopCore').addEventListener('click',()=>$('stopCoreDialog').showModal());
$('cancelStopCore').addEventListener('click',()=>$('stopCoreDialog').close());
$('confirmStopCore').addEventListener('click',()=>{$('stopCoreDialog').close();action('正在停止内核…',async()=>{await api('core-stop',{});await refresh();notify('内核已停止');}).catch(()=>{});});
$('editPort').addEventListener('click',()=>{$('portInput').value=ui.core?.port || '';set('portError',ui.proxy?.managed && ui.proxy?.enabled ? '请先关闭本软件管理的系统代理，再修改端口。' : '');$('portForm').hidden=false;$('editPort').setAttribute('aria-expanded','true');$('portInput').focus();});
$('cancelPort').addEventListener('click',()=>{$('portForm').hidden=true;$('editPort').setAttribute('aria-expanded','false');set('portError','');$('editPort').focus();});
$('portForm').addEventListener('submit',async event=>{
  event.preventDefault();const input=$('portInput'),port=Number(input.value);
  if(!input.value || !Number.isInteger(port) || port<1 || port>65535){set('portError','请输入 1 到 65535 之间的整数。');input.setAttribute('aria-invalid','true');input.focus();return;}
  if(!ui.proxy){set('portError','无法确认系统代理状态，请稍后重试。');return;}
  if(ui.proxy.managed && ui.proxy.enabled){set('portError','请先关闭本软件管理的系统代理，再修改端口。');return;}
  input.removeAttribute('aria-invalid');const oldPort=ui.core?.port;
  try{await action('正在修改端口…',async()=>{const result=await api('port',{port});await refresh();if(result.port!==port || ui.core?.port!==port)throw new Error('内核未确认新端口，请检查实际运行状态。');ui.diagnosis=null;$('portForm').hidden=true;$('editPort').setAttribute('aria-expanded','false');set('portError','');notify('端口已修改');});}
  catch(error){set('portError',error.message + (oldPort?'；此前端口为 '+oldPort+'。':''));await refresh();}
});
$('refreshLogs').addEventListener('click',refreshLogs);
$('logPeriod').addEventListener('change',renderLogs);
document.querySelectorAll('[data-log-filter]').forEach(b=>b.addEventListener('click',()=>{ui.logFilter=b.dataset.logFilter;document.querySelectorAll('[data-log-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));renderLogs();}));

for(const [id,field] of [['autoRepairSwitch','autoRepair'],['autoSwitch','autoSwitch']]) $(id).addEventListener('click',()=>{
  const group=currentGroup();if(!group || !ui.automation)return;
  if(field==='autoSwitch' && !ui.automation.autoSwitch) {
    const eligible=(ui.automation.backups || []).some(name=>name!==group.current && group.members?.some(m=>m.name===name));
    if(!eligible){openPage('backups');notify('请先选择至少一个可用的备用节点');return;}
  }
  action('正在保存设置…',async()=>{ui.automation=await api('automation',{group:group.name,[field]:!ui.automation[field]});notify('设置已保存');}).catch(()=>{});
});
$('availableNodes').addEventListener('click',event=>{const b=event.target.closest('[data-add]');if(!b||b.disabled)return;ui.backupDraft.push(b.dataset.add);renderBackupEditor(b.dataset.add);});
$('backupList').addEventListener('click',event=>{const b=event.target.closest('[data-remove]');if(!b)return;ui.backupDraft=ui.backupDraft.filter(x=>x!==b.dataset.remove);renderBackupEditor();});
let dragBackup=null;
$('backupList').addEventListener('pointerdown',event=>{const handle=event.target.closest('.drag-handle');if(!handle||event.button!==0)return;event.preventDefault();dragBackup={handle,row:handle.closest('.backup-row'),name:handle.dataset.name,id:event.pointerId};handle.setPointerCapture(event.pointerId);dragBackup.row.classList.add('dragging');});
$('backupList').addEventListener('pointermove',event=>{if(!dragBackup||event.pointerId!==dragBackup.id)return;const list=$('backupList');const others=[...list.querySelectorAll('.backup-row')].filter(row=>row!==dragBackup.row);const before=others.find(row=>event.clientY<row.getBoundingClientRect().top+row.offsetHeight/2);list.insertBefore(dragBackup.row,before||null);[...list.querySelectorAll('.backup-row')].forEach((row,i)=>row.querySelector('.order-badge').textContent=i+1);});
function finishDrag(event,cancel){if(!dragBackup||event.pointerId!==dragBackup.id)return;const name=dragBackup.name;if(!cancel)ui.backupDraft=[...$('backupList').querySelectorAll('.backup-row')].map(row=>row.dataset.name);dragBackup=null;renderBackupEditor(name);}
$('backupList').addEventListener('pointerup',e=>finishDrag(e,false));$('backupList').addEventListener('pointercancel',e=>finishDrag(e,true));
$('backupList').addEventListener('keydown',event=>{const handle=event.target.closest('.drag-handle');if(!handle||!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const name=handle.dataset.name,i=ui.backupDraft.indexOf(name),j=i+(event.key==='ArrowUp'?-1:1);if(j<0||j>=ui.backupDraft.length)return;[ui.backupDraft[i],ui.backupDraft[j]]=[ui.backupDraft[j],ui.backupDraft[i]];renderBackupEditor(name);set('announcement',name+'已调整为第 '+(j+1)+' 顺位');});
$('saveBackups').addEventListener('click',()=>{const group=currentGroup();if(!group)return;action('正在保存备用节点…',async()=>{ui.automation=await api('automation',{group:group.name,backups:ui.backupDraft});openPage('settings',true);notify('备用节点已保存');}).catch(()=>{});});
$('cancelBackups').addEventListener('click',()=>openPage('settings',true));
$('keepEditing').addEventListener('click',()=>{$('discardDialog').close();ui.pendingPage='';});
$('discardChanges').addEventListener('click',()=>{const next=ui.pendingPage;ui.pendingPage='';$('discardDialog').close();if(next)openPage(next,true);});
$('subKeepEditing').addEventListener('click',()=>{$('subDiscardDialog').close();ui.formPendingPage='';});
$('subDiscard').addEventListener('click',()=>{const next=ui.formPendingPage;ui.formPendingPage='';$('subDiscardDialog').close();$('subUrl').value='';if(next)openPage(next,true);});

// 尚未实现的设置不能显示成可操作的开关。
unavailable($('tunSwitch'),'TUN 控制尚未接入'); $('tunSwitch').closest('.row').querySelector('.hint').textContent='TUN 控制尚未接入';
document.querySelectorAll('[data-local-switch]:not([data-local-switch="开机启动"]):not([data-local-switch="关闭窗口时留在托盘"])').forEach(b=>{unavailable(b,'此功能尚未接入');b.closest('.row').querySelector('.hint').textContent='尚未接入';b.setAttribute('aria-checked','false');});
unavailable($('checkAppUpdate'),'更新功能尚未接入');
document.querySelectorAll('[data-page="about"] .contact-copy').forEach(button=>button.addEventListener('click',async()=>{
  const value=button.dataset.copy, feedback=document.querySelector('.author-feedback');
  let copied=false;
  try { if(navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); copied=true; } } catch { /* Fallback is useful in constrained WebView hosts. */ }
  if(!copied){const area=document.createElement('textarea');area.value=value;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();try{copied=document.execCommand('copy')}catch{}area.remove()}
  feedback.textContent=copied?'已复制':'复制失败，请手动选择文字复制';
}));
$('editSubscription').hidden=true;

(async()=>{ await refreshProfiles(); await refresh(); openPage(ui.profiles.length?'home':'welcome'); })();
setInterval(()=>{if(!document.hidden && !ui.busy)refresh();},5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden && !ui.busy)refresh();});
