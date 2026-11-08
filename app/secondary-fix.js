'use strict';

// Bring secondary pages in line with the approved layout while retaining the
// real application state, API handlers and existing safeguards.
(() => {
  const byId = id => document.getElementById(id);

  // A subscription link can be a credential. Mask it until deliberately shown.
  const subscriptionUrl = byId('subUrl');
  if (subscriptionUrl) {
    subscriptionUrl.type = 'password';
    subscriptionUrl.inputMode = 'url';
    const wrap = document.createElement('span'); wrap.className = 'secure-url-wrap';
    subscriptionUrl.before(wrap); wrap.append(subscriptionUrl);
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'secure-url-toggle';
    toggle.textContent = '显示'; toggle.setAttribute('aria-label', '显示订阅链接'); toggle.setAttribute('aria-pressed', 'false');
    wrap.append(toggle);
    toggle.addEventListener('click', event => {
      event.preventDefault();
      const reveal = subscriptionUrl.type === 'password'; subscriptionUrl.type = reveal ? 'text' : 'password';
      toggle.textContent = reveal ? '隐藏' : '显示'; toggle.setAttribute('aria-label', reveal ? '隐藏订阅链接' : '显示订阅链接');
      toggle.setAttribute('aria-pressed', String(reveal));
    });
    const formPage = document.querySelector('[data-page="subscriptionForm"]');
    new MutationObserver(() => {
      if (formPage.hidden) { subscriptionUrl.type='password'; toggle.textContent='显示'; toggle.setAttribute('aria-label','显示订阅链接'); toggle.setAttribute('aria-pressed','false'); }
    }).observe(formPage,{attributes:true,attributeFilter:['hidden']});
  }

  // Keep the existing unsaved-draft guard when the user presses Cancel.
  byId('cancelBackups')?.addEventListener('click', event => {
    event.preventDefault(); event.stopImmediatePropagation(); openPage('settings');
  }, true);

  // Move the existing form, not a clone: the original validation and API write
  // listeners continue to be used inside the bottom sheet.
  const portForm=byId('portForm'), portButton=byId('editPort');
  if(portForm && portButton){
    const dialog=document.createElement('dialog'); dialog.className='glass detail-dialog secondary-port-dialog';
    dialog.setAttribute('aria-labelledby','secondaryPortTitle');
    dialog.innerHTML='<div class="secondary-sheet-head"><h2 id="secondaryPortTitle">修改代理端口</h2><button type="button" class="secondary-sheet-close" aria-label="关闭">×</button></div><p class="hint">输入 1 至 65535 的端口号。</p>';
    document.body.append(dialog); dialog.append(portForm);
    let opener=portButton;
    const dismiss=()=>dialog.close();
    portButton.addEventListener('click',event=>{
      event.preventDefault();event.stopImmediatePropagation();opener=portButton;
      byId('portInput').value=ui.core?.port || '';
      set('portError',ui.proxy?.managed&&ui.proxy?.enabled?'请先关闭本软件管理的系统代理，再修改端口。':'');
      portForm.hidden=false;portButton.setAttribute('aria-expanded','true');dialog.showModal();
      byId('portInput').focus({preventScroll:true});
    },true);
    byId('cancelPort').addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();dismiss()},true);
    dialog.querySelector('.secondary-sheet-close').addEventListener('click',dismiss);
    new MutationObserver(()=>{if(portForm.hidden&&dialog.open)dialog.close()}).observe(portForm,{attributes:true,attributeFilter:['hidden']});
    dialog.addEventListener('close',()=>{portForm.hidden=true;portButton.setAttribute('aria-expanded','false');set('portError','');opener?.focus({preventScroll:true})});
  }

  // Preserve all original diagnostic DOM as the source for API updates. The
  // compact screen exposes status for five checks and keeps detail in a sheet.
  const check=document.querySelector('[data-page="check"]');
  const codexAction=check?.querySelector('.codex-check-entry-v2');
  if(check && codexAction){
    const header=check.querySelector('.heading'), run=byId('runCheck');
    const source=document.createElement('div');source.className='check-legacy-source';source.setAttribute('aria-hidden','true');
    for(const child of [...check.children]) if(child!==header&&child!==codexAction) source.append(child);
    const summary=document.createElement('div');summary.className='compact-check-summary';
    summary.innerHTML='<div class="compact-check-copy"><strong id="compactTitle">网络状态待确认</strong><span id="compactDescription">查看网络、端口和内核运行状态</span></div>';
    summary.append(run);
    const heading=document.createElement('div');heading.className='compact-check-heading';heading.innerHTML='<strong>检测项目</strong><span id="compactTime">等待检测</span>';
    const rows=document.createElement('div');rows.className='compact-check-rows';rows.setAttribute('aria-label','检测项目');
    const checks=[['web','网络连接'],['core','代理内核'],['port','代理端口'],['node','当前线路'],['codex','Codex 站点 · 专项修复']];
    for(const [key,label] of checks){
      const row=document.createElement(key==='codex'?'button':'div');row.className='compact-check-row';row.dataset.check=key;
      if(key==='codex'){row.type='button';row.setAttribute('aria-label','查看 Codex 专项修复');row.addEventListener('click',()=>codexAction.click())}
      const name=document.createElement('span');name.textContent=label;const value=document.createElement('span');value.className='compact-check-value';value.textContent='待检测';row.append(name,value);rows.append(row);
    }
    const notice=document.createElement('p');notice.className='compact-check-caveat';notice.textContent='站点响应不代表 Codex 应用内请求一定成功。';
    const actions=document.createElement('div');actions.className='compact-check-actions';
    const details=document.createElement('button');details.type='button';details.className='text-button';details.textContent='查看检测详情';
    const auto=document.createElement('button');auto.type='button';auto.className='text-button';auto.textContent='自动处理设置 ›';auto.addEventListener('click',()=>openPage('settings'));
    actions.append(details,auto);codexAction.hidden=true;
    check.replaceChildren(header,summary,heading,rows,notice,actions,codexAction,source);check.classList.add('compact-check');
    const detailDialog=document.createElement('dialog');detailDialog.className='glass detail-dialog compact-detail-dialog';detailDialog.setAttribute('aria-labelledby','compactDetailTitle');
    detailDialog.innerHTML='<div class="secondary-sheet-head"><h2 id="compactDetailTitle">检测详情</h2><button type="button" class="secondary-sheet-close" aria-label="关闭">×</button></div><div class="compact-detail-body"></div>';
    document.body.append(detailDialog);detailDialog.querySelector('.secondary-sheet-close').addEventListener('click',()=>detailDialog.close());
    details.addEventListener('click',()=>{
      const body=detailDialog.querySelector('.compact-detail-body');body.replaceChildren();
      const para=text=>{const p=document.createElement('p');p.textContent=text;body.append(p)};
      if(ui.runtime?.recoveryWarning)para(ui.runtime.recoveryWarning);
      const failed=byId('resultTitle').textContent==='检测未完成';
      if(failed)para(byId('resultCopy').textContent);
      else if(ui.diagnosis?.detail)para(ui.diagnosis.detail);
      for(const item of failed?[]:ui.diagnosis?.checks||[]){const p=document.createElement('p');const strong=document.createElement('strong');strong.textContent=(item.label||item.name||({core:'代理内核',port:'代理端口',web:'网络连接',codex:'Codex 站点'})[item.id]||item.id)+'：'+(item.value||'未知');p.append(strong);if(item.detail)p.append(document.createTextNode(' · '+item.detail));body.append(p)}
      if(ui.automation?.codexDetail)para(ui.automation.codexDetail);
      if(ui.automation?.message)para(ui.automation.message);
      if(!failed&&Array.isArray(ui.diagnosis?.steps)&&ui.diagnosis.steps.length){const ol=document.createElement('ol');for(const step of ui.diagnosis.steps){const li=document.createElement('li');li.textContent=step;ol.append(li)}body.append(ol)}
      if(!body.children.length)para('尚无检测结果，请先运行检测。');
      for(const id of ['checkSettings','checkLines']){const original=byId(id);if(original&&!original.hidden){const b=document.createElement('button');b.className='secondary';b.type='button';b.textContent=original.textContent;b.addEventListener('click',()=>{detailDialog.close();original.click()});body.append(b)}}
      detailDialog.showModal();
    });
    function updateCheck(){
      if(check.hidden)return;
      const diagnosis=ui.diagnosis, busy=run.disabled, failed=!busy && byId('resultTitle').textContent==='检测未完成';
      byId('compactTitle').textContent=ui.runtime?.recoveryWarning?'运行状态需要确认':busy?'正在检测':failed?'检测未完成':diagnosis?.title||'网络状态待确认';
      byId('compactDescription').textContent=ui.runtime?.recoveryWarning||(failed?byId('resultCopy').textContent:diagnosis?.detail)||'查看网络、端口和内核运行状态';
      const when=diagnosis?.checkedAt?new Date(diagnosis.checkedAt):null;
      byId('compactTime').textContent=busy?'检测中':failed?'未完成':when&&Number.isFinite(when.getTime())?'最近检测 '+when.toLocaleTimeString('zh-CN',{hour12:false}):diagnosis?'检测完成':'等待检测';
      for(const [key] of checks){
        const row=rows.querySelector('[data-check="'+key+'"]'), value=row.querySelector('.compact-check-value');
        const actual=diagnosis?.checks?.find(x=>x.id===key);
        const autoState=key==='node'?ui.automation?.checks?.node:null;
        value.textContent=busy?'检测中':failed?'未知':actual?.value||(key==='node'?(autoState==='ok'?'正常':autoState==='failed'&&ui.automation?.phase!=='confirming'?'异常':'待确认'):'待检测');
        value.dataset.tone=failed?'':actual?.tone||(autoState==='ok'?'ok':autoState==='failed'?'warn':'');
      }
    }
    run.addEventListener('click',()=>queueMicrotask(updateCheck),true);
    window.addEventListener('clash-render',updateCheck);updateCheck();
  }

  // Application connections open as a bottom sheet; details remain interactive
  // and the parent list/search stay in place, using only current API data.
  const connectionList=byId('connectionList');
  if(connectionList){
    const dialog=document.createElement('dialog');dialog.className='glass detail-dialog secondary-connections-dialog';dialog.setAttribute('aria-labelledby','secondaryConnectionsTitle');
    dialog.innerHTML='<div class="secondary-sheet-head"><h2 id="secondaryConnectionsTitle">应用连接</h2><button type="button" class="secondary-sheet-close" aria-label="关闭">×</button></div><p class="hint" id="secondaryConnectionCount"></p><div class="secondary-connection-items"></div>';
    document.body.append(dialog);let opener=null;
    function drawConnections(){
      const items=(ui.connections?.connections||[]).filter(c=>(c.app||'未知应用')===ui.app), root=dialog.querySelector('.secondary-connection-items');root.replaceChildren();
      byId('secondaryConnectionsTitle').textContent=ui.app;byId('secondaryConnectionCount').textContent=items.length+' 条当前连接';
      if(!items.length){const p=document.createElement('p');p.className='hint';p.textContent=ui.connections?'该应用暂无当前连接':'连接数据暂不可用，请稍后重试。';root.append(p);return}
      for(const item of items){const b=document.createElement('button');b.type='button';b.className='secondary-connection-row';const copy=document.createElement('span');copy.className='row-copy';const name=document.createElement('strong');name.textContent=item.address||'未知地址';const route=document.createElement('span');route.className='hint';route.textContent=item.route||'未知路径';copy.append(name,route);const arrow=document.createElement('span');arrow.setAttribute('aria-hidden','true');arrow.textContent='›';b.append(copy,arrow);b.addEventListener('click',()=>{ui.connection=item.id;dialog.close();openPage('connectionDetail')});root.append(b)}
    }
    function openConnections(button){opener=button;drawConnections();dialog.showModal()}
    connectionList.addEventListener('click',event=>{const b=event.target.closest('[data-app]');if(!b)return;event.preventDefault();event.stopImmediatePropagation();ui.app=b.dataset.app;openConnections(b)},true);
    dialog.querySelector('.secondary-sheet-close').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>ui.page==='connections'&&opener?.isConnected&&opener.focus({preventScroll:true}));
    window.addEventListener('clash-render',()=>{if(dialog.open&&ui.page==='connections')drawConnections()});
  }
})();
