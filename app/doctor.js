'use strict';
(() => {
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=n=>'<svg class="icon" aria-hidden="true"><use href="#i-'+n+'"/></svg>';
  const names={network:'本机网络',core:'代理内核',port:'本机端口',system:'系统代理',config:'订阅与配置',routing:'模式与选路',line:'线路与目标连通',dns:'DNS 与证书'};
  const labels={passed:'通过',probe_passed:'测试通过',app_verified:'应用已验证',awaiting_activation:'待生效确认',verified:'用户已确认',failed:'待处理',needs_action:'待处理',needs_user:'待操作',unknown:'待确认',stale:'需复查',pending:'未检查',cancelled:'已停止',unsupported:'暂不支持',waiting_user:'需要登录',waiting_service:'服务待恢复',rollback_conflict:'恢复未完成'};
  let data={base:null,task:null,history:[]},screen='start',pathMode='system',visible=false,pending=false,details=false,polling=false,revision=0;
  const main=document.querySelector('.app main'),nav=document.querySelector('.tabs');
  const shell=document.createElement('section');shell.className='doctor-shell';shell.hidden=true;
  shell.innerHTML='<div class="app-body" tabindex="-1"></div><footer class="action-area"></footer>';
  main.after(shell);const body=shell.firstElementChild,actions=shell.lastElementChild;
  const live=document.createElement('p');live.className='sr-only';live.setAttribute('role','status');live.setAttribute('aria-live','polite');live.setAttribute('aria-atomic','true');shell.after(live);
  function announce(message){live.textContent=message;}
  const active=()=>data.task?.scope==='proxy'&&['checking','repairing'].includes(data.task?.phase);
  const row=(name,status='pending',detail='')=>'<div class="result-row"><span class="result-mark '+(['passed','probe_passed','verified'].includes(status)?'ok':['failed','needs_action'].includes(status)?'warn':'pending')+'">'+icon(['passed','probe_passed','verified'].includes(status)?'check':['failed','needs_action'].includes(status)?'alert':'clock')+'</span><span class="row-copy"><span class="row-title">'+esc(name)+'</span>'+(detail?'<span class="row-detail">'+esc(detail)+'</span>':'')+'</span><span class="row-state">'+esc(labels[status]||'待确认')+'</span></div>';
  const list=checks=>'<div class="result-list">'+checks.map(c=>row(c.name||c.id,c.status,c.detail)).join('')+'</div>';
  const baseRows=(detail=false)=>'<div class="result-list check-compact">'+Object.entries(names).map(([id,name])=>{const c=data.base?.checks.find(x=>x.id===id);return row(name,c?.status,detail?c?.detail:'');}).join('')+'</div>';
  const button=(name,action,cls='primary',disabled=false)=>'<button type="button" class="'+cls+'" data-doctor="'+action+'" '+(disabled?'disabled':'')+'>'+esc(name)+'</button>';
  const header=(title,sub='代理综合检查')=>'<header class="page-header"><button class="icon-button" type="button" data-doctor="back" aria-label="返回上一步">'+icon('back')+'</button><div><h1 tabindex="-1">'+esc(title)+'</h1><p>'+esc(sub)+'</p></div></header>';
  const notice=(text,kind='')=>'<div class="notice '+kind+'">'+icon(kind==='warn'?'alert':'info')+'<p>'+esc(text)+'</p></div>';
  const intro=(title,copy)=>'<div class="intro"><h2>'+esc(title)+'</h2><p>'+esc(copy)+'</p></div>';
  const outcome=(title,copy,ok=false)=>'<div class="outcome-symbol '+(ok?'ok':'')+'">'+icon(ok?'check':'info')+'</div><h2 class="outcome-title">'+esc(title)+'</h2><p class="outcome-copy">'+esc(copy)+'</p>';
  const flow=step=>'<div class="flow" aria-label="当前阶段：'+['检查','验证','修复','复查'][step]+'">'+['检查','验证','修复','复查'].map((label,i)=>'<div class="flow-step '+(i<step?'done':i===step?'active':'')+'"><span class="flow-point">'+(i<step?icon('check'):i+1)+'</span><span>'+label+'</span></div>').join('')+'</div>';
  const codexEntry=()=>{const next=window.netfixRepair?.getState();return '<button type="button" class="special-entry" data-doctor="codex"><span class="result-mark">'+icon('scan')+'</span><span class="row-copy"><span class="row-title">Codex 网络修复工具箱</span><span class="row-detail">A 链路配置 · B 传输 · C 身份配额</span></span><span class="special-state">'+(next?.busy?'进行中':next?.checkedAt?'已诊断':'未诊断')+icon('chevron')+'</span></button>';};
  function render(){
    if(!visible){renderHomeStatus();return;}
    const focused=shell.contains(document.activeElement)?document.activeElement:null;
    const focusKey=focused?.id?'#'+CSS.escape(focused.id):focused?.dataset.doctor?'[data-doctor="'+CSS.escape(focused.dataset.doctor)+'"]':focused?.dataset.preview?'[data-preview="'+CSS.escape(focused.dataset.preview)+'"]':null;
    const consent=screen==='plan'&&document.getElementById('doctorConsent')?.checked;
    let html='',footer='';body.classList.toggle('is-overview',screen==='start');
    if(screen==='start'){
      html=header('代理综合检查','网络、配置、线路与应用')+'<p class="overview-lead">检查代理基础状态，按需要进入应用专项。</p><div class="scope-heading"><h2>代理基础检查</h2><span class="row-state">'+esc(labels[data.base?.status]||'未检查')+'</span></div>'+baseRows()+'<h2 class="section-title">应用专项</h2>'+codexEntry()+'<details class="fold"><summary>检查范围与判断方式</summary><p>按当前运行方式判断系统代理；关闭不一定代表异常。应用专项结果单独验证，不替代基础检查结论。</p><label class="field-label" for="doctorPathMode">本次代理接管方式</label><select class="app-select" id="doctorPathMode"><option value="system">系统代理</option><option value="fixed">应用固定代理</option><option value="direct">明确使用直连</option></select></details>';
      footer=active()?button('查看当前任务进度','progress'):data.base&&data.base.status!=='stale'?button('查看基础检查结果','base-result'):button('开始代理基础检查','start-base')+'<p class="action-hint">先检查，不修改设置；Codex 专项可按需进入</p>';
    }else if(screen==='progress'){
      html=header(data.task?.phase==='repairing'?'正在执行修复':'正在检查整个代理','代理基础检查')+flow(data.task?.phase==='repairing'?2:0)+intro(data.task?.step||'正在读取本地状态','已通过的结果会保留；无法确认的项目不会当作成功。')+'<div class="progress-lines" aria-label="检查进行中"><span></span><span></span><span></span><span></span></div>'+baseRows();
      footer=data.task?.phase==='repairing'?'<p class="action-hint">当前变更正在完成，请等待复查。</p>':button('停止本次检查','cancel','text-button');
    }else if(screen==='base-result'){
      html=header('代理基础检查结果')+outcome(data.base?.status==='passed'?'本次代理基础检查通过':'代理仍有项目需要确认',data.base?.reason||'保留已通过项，继续处理未通过或无法确认的部分。',data.base?.status==='passed')+baseRows(details)+'<button class="section-link" type="button" data-doctor="details"><span>'+(details?'收起检查依据':'查看各项检查依据')+'</span>'+icon('chevron')+'</button>';
      const checks=data.base?.checks||[],need=id=>checks.find(c=>c.id===id)?.status!=='passed';
      if(need('network'))html+=notice('外部目标无响应不一定是电脑断网。先检查 Wi-Fi、网线、酒店或校园网络认证，再复查。','neutral');
      if(need('core'))html+=repairEntry('core-restart','恢复或重启代理内核','只停止和启动本软件的受控内核');
      if(need('port'))html+=repairEntry('port-migrate','检查入口迁移方案','保留占用程序，协调受控端口与系统代理');
      if(need('system'))html+=repairEntry('system-proxy','查看系统代理启用方案','仅在你需要系统代理接管时启用');
      if(need('config'))html+=button('前往订阅管理','profiles','secondary');
      if(need('routing'))html+=button('核对模式与线路','lines','secondary');
      if(need('line'))html+=repairEntry('candidates','测试允许的候选线路','最多 3 条，验证后再切换；没有改善就恢复原选择');
      if(need('dns'))html+=notice('请核对 Windows 日期、时区、证书链与网络拦截。不关闭证书验证，也不全局重置网络。','neutral');
      html+='<h2 class="section-title">应用专项结果</h2>'+codexEntry()+'<p class="small-note">基础检查通过不代表所有应用都已恢复，也不替代 Codex 的实际请求验证。</p>';
      footer=button('返回综合检查','overview')+button('重新检查代理基础','start-base','text-button');
    }else if(screen==='plan'){
      html=header('确认本次修复')+flow(2)+intro(({'system-proxy':'启用系统代理','core-restart':'重启本软件代理内核','port-migrate':'迁移本机代理入口','candidates':'验证候选线路后再切换','client-restart':'正常重开 SusuClash'})[data.plan?.kind]||'处理已确认的问题','只执行下面列出的操作；完成后重新检查连接。')+'<ol class="plan-list"><li><span class="plan-index">1</span><div><strong>核对原状态与归属</strong><p>原配置和代理归属用于核对与恢复。</p></div></li><li><span class="plan-index">2</span><div><strong>执行本次确认的方案</strong><p>'+esc(data.plan?.detail)+'</p></div></li><li><span class="plan-index">3</span><div><strong>重新检查，确认实际结果</strong></div></li></ol>'+notice('如设置或归属发生变化，方案失效，需重新检查。正在写入的单步操作会先完成，再显示复查结果。','warn')+'<label class="consent"><input type="checkbox" id="doctorConsent"><span>我已了解本次变更和可能的短暂中断</span></label>';
      footer=button('确认并修复','apply','primary',true)+button('返回检查结果','result','text-button');
    }else if(screen==='handoff'){
      html=header('独立恢复进程已接手','SusuClash 客户端恢复')+outcome('正在正常重开 SusuClash','进度已保留。原进程退出后，恢复助手才会打开新客户端，并重新检查代理基础连接。')+notice('如果没有正常重开，请从托盘正常退出后再打开，或使用安装目录中的“恢复SusuClash.cmd”。','neutral');footer='<p class="action-hint">等待客户端正常退出，不会强制结束其他程序。</p>';
    }else if(screen==='history'){
      html=header('最近的连接检查')+intro('每一步都能回看','只记录本次处理对象、结果与验证范围。')+(data.history.length?list(data.history.map(h=>({name:(h.scope==='proxy'?'代理基础检查':'Codex 专项')+' · '+new Date(h.at).toLocaleString(),status:h.status,detail:h.checks.map(c=>c.name+'：'+(labels[c.status]||'待确认')).join('；')}))):notice('尚未运行检查，可以从首页大圆球开始。','neutral'));footer=button('返回综合检查','overview')+button('导出诊断记录','export','text-button');
    }else if(screen==='help'){
      html=header('还有问题时怎么做','按顺序操作')+'<ol class="manual-list"><li><strong>先确认电脑可以上网</strong><p>用浏览器打开一个平时常用的网站。酒店或校园网络可能要先登录认证。</p></li><li><strong>重新检查代理</strong><p>回到综合检查，点击“开始代理基础检查”，按结果处理。</p></li><li><strong>记下报错后再继续排查</strong><p>登录失效就重新登录；额度用完就按提示等待。原因不明确时不要反复改配置。</p></li></ol>';footer=button('返回检查结果','result');
    }
    if(data.task?.error&&screen==='base-result')html=notice(data.task.error,'warn')+html;
    body.innerHTML=html;actions.innerHTML=footer;const select=body.querySelector('#doctorPathMode');if(select){select.value=pathMode;select.disabled=active();}
    if(consent&&screen==='plan'){body.querySelector('#doctorConsent').checked=true;actions.querySelector('[data-doctor="apply"]').disabled=false;}
    if(focusKey)shell.querySelector(focusKey)?.focus({preventScroll:true});shell.setAttribute('aria-busy',String(pending));renderHomeStatus();
  }
  function repairEntry(kind,title,copy){return '<button class="section-link" type="button" data-preview="'+kind+'"><span class="row-copy"><span class="row-title">'+esc(title)+'</span><span class="row-detail">'+esc(copy)+'</span></span>'+icon('chevron')+'</button>';}
  function show(view){if(['codex','codex-result','request-plan'].includes(view)){hide();void window.netfixRepair?.open();return;}window.netfixRepair?.close();visible=true;screen=['start','progress','base-result','plan','handoff','history','help'].includes(view)?view:'start';main.hidden=true;shell.hidden=false;nav.hidden=false;render();body.scrollTop=0;body.querySelector('h1')?.focus({preventScroll:true});}
  function hide(){visible=false;shell.hidden=true;main.hidden=false;}
  async function sync(){if(polling||pending)return;polling=true;const mine=revision;try{const next=await api('doctor');if(mine!==revision||pending)return;const changed=JSON.stringify(next)!==JSON.stringify(data);data=next;if(visible&&screen==='progress'&&!active()){show(data.task?.handoffReady?'handoff':'base-result');announce(data.task?.error||body.querySelector('h1')?.textContent||'检查已结束');}else if(changed)render();}catch{if(visible){notify('诊断服务暂不可用，请稍后重试；未确认恢复。');announce('诊断服务暂不可用，请稍后重试；未确认恢复。');}}finally{polling=false;}}
  async function call(endpoint,payload={}){if(pending)return;pending=true;revision++;try{data=await api('doctor/'+endpoint,payload);return true;}catch(error){notify(error.message);announce(error.message);return false;}finally{pending=false;}}
  async function handle(action){
    if(action==='codex'){hide();await window.netfixRepair?.open();return;}
    if(action==='overview')return show('start');
    if(action==='back')return screen==='start'?(hide(),openPage('home')):show('start');
    if(action==='home')return hide(),openPage('home');
    if(['history','progress','base-result','help'].includes(action))return show(action);
    if(action==='details'){details=!details;return render();}
    if(action==='result')return show('base-result');
    if(action==='lines'||action==='profiles'){hide();return openPage(action==='profiles'?'subscriptions':'lines');}
    if(action==='start-base'){if(pending)return;if(active())return show('progress');const previous=data;data={...data,task:{scope:'proxy',phase:'checking',step:'正在发起新一轮检测，重新读取当前状态'},base:null};show('progress');announce('新一轮检测已开始');if(await call('start',{scope:'proxy',pathMode}))show(active()?'progress':'base-result');else{data=previous;show('start');}}
    if(action==='cancel'&&active()){if(await call('cancel'))show(active()?'progress':'start');}
    if(action==='apply'){const id=data.plan?.id;show('progress');if(await call('apply',{id,confirmed:true})){if(data.task?.error)notify(data.task.error);if(visible&&screen==='progress')show(data.task?.handoffReady?'handoff':'base-result');}else if(visible)show('base-result');}
    if(action==='export'){const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),history:data.history},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='SusuClash-连接检查.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }
  shell.addEventListener('click',async event=>{const preview=event.target.closest('[data-preview]');if(preview){if(['system-proxy','core-restart','port-migrate','candidates','client-restart'].includes(preview.dataset.preview)&&await call('preview',{kind:preview.dataset.preview}))show('plan');return;}const target=event.target.closest('[data-doctor]');if(target)await handle(target.dataset.doctor);});
  shell.addEventListener('change',event=>{if(event.target.id==='doctorPathMode')pathMode=event.target.value;if(event.target.id==='doctorConsent')actions.querySelector('[data-doctor="apply"]').disabled=!event.target.checked;});
  const settings=document.querySelector('[data-page="settings"]'),entry=document.createElement('button');entry.type='button';entry.className='sub-entry';entry.innerHTML='<span class="row-icon">'+icon('scan')+'</span><span class="row-copy"><span class="row-label">代理综合检查</span><span class="hint">代理基础状态与 Codex 专项</span></span><span class="chevron">›</span>';entry.addEventListener('click',()=>{void sync();show('start');});settings.querySelector('[data-open="runtime"]').before(entry);
  const oldOpen=openPage;openPage=function(name,...rest){if(name==='check'){void sync();show('start');return;}hide();return oldOpen(name,...rest);};
  window.connectionDoctor={open:view=>{if(['codex','codex-result','request-plan'].includes(view)||(!view&&window.netfixRepair?.getState()?.busy)){hide();void window.netfixRepair?.open();return;}void sync();show(view||(active()?'progress':'start'));},hide};
  function renderHomeStatus(){
    const orb=$('statusOrb');if(!orb)return;const node=$('nodeName');if(node)node.title=node.textContent;
    const netfix=window.netfixRepair?.getState(),checking=active()||netfix?.busy,stale=data.base?.status==='stale'||netfix?.stage==='stale';
    const text=checking?(active()?'代理基础检查进行中':'Codex 专项检测进行中'):stale?'连接设置已变化，请重新检查':data.base?.status==='passed'?'本次代理基础检查通过':data.base?'代理仍有项目需要确认':'代理基础状态尚未检查';
    const status=$('doctorHomeStatus'),hint=$('doctorHomeHint');if(status)status.textContent=text;if(hint)hint.textContent=checking?'点击查看检查进度':'点击圆球检查代理状态';
    orb.setAttribute('aria-label',checking?'查看当前检查进度':'打开代理综合检查');if($('doctorProxyReadout'))$('doctorProxyReadout').textContent=ui.proxy?.enabled===true?'已开启':ui.proxy?.enabled===false?'未开启':'待确认';
    if($('doctorHomeMode'))$('doctorHomeMode').textContent=ui.core?.mode?(modeLabels[ui.core.mode]||'模式待确认'):'模式待确认';
  }
  // Preserve the existing API-bound controls and image nodes while applying the
  // approved home composition. No duplicate repair card or Codex-only orb.
  const home=document.querySelector('[data-page="home"]'),hero=home.querySelector('.hero'),orb=$('statusOrb');
  home.classList.add('doctor-home');
  const oldStats=hero.querySelector('.stats');
  const stats=document.createElement('dl');stats.className='home-stats';stats.innerHTML='<div><dt>代理端口</dt></div><div><dt>线路延迟</dt></div><div><dt>系统代理</dt><dd id="doctorProxyReadout">待确认</dd></div>';
  for(const [i,id] of ['port','heroLatency'].entries()){const dd=$(id);stats.children[i].append(dd);}
  const metadata=document.createElement('div');metadata.className='doctor-legacy-state';metadata.append($('heroTitle'),$('heroSubDetail').closest('.hero-sub'),oldStats);
  const node=$('nodeName');node.className='home-node';
  const mode=document.createElement('p');mode.className='home-sub';mode.id='doctorHomeMode';
  const status=document.createElement('p');status.className='home-connection-state';status.id='doctorHomeStatus';status.setAttribute('role','status');
  const hint=document.createElement('p');hint.className='home-orb-hint';hint.id='doctorHomeHint';orb.setAttribute('aria-describedby','doctorHomeStatus doctorHomeHint');
  const controls=hero.querySelector('.player-controls');hero.replaceChildren(orb,node,mode,status,hint,stats,controls,metadata);
  controls.querySelector('.player-circle').innerHTML=icon('settings');controls.querySelector('.player-action:last-child .player-circle').innerHTML=icon('route');
  nav.querySelector('[data-open=lines] .icon').innerHTML='<use href="#i-route"/>';nav.querySelector('[data-open=settings] .icon').innerHTML='<use href="#i-settings"/>';
  const history=document.createElement('button');history.className='section-link';history.type='button';history.innerHTML='<span>最近的连接检查</span>'+icon('chevron');history.addEventListener('click',()=>{void sync();show('history');});hero.append(history);
  window.addEventListener('clash-render',renderHomeStatus);window.addEventListener('netfix-state-change',()=>{if(visible&&screen==='start')render();else renderHomeStatus();});window.addEventListener('online',()=>{void api('doctor/invalidate',{}).then(x=>{data=x;render();});});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void sync();});
  // A suspended computer invalidates earlier observations. Never reuse an old
  // green result after sleep simply because no setting button was touched.
  let lastTick=Date.now();setInterval(()=>{const now=Date.now();if(now-lastTick>20000)void api('doctor/invalidate',{}).then(x=>{data=x;render();}).catch(()=>{});lastTick=now;if(active()||visible)void sync();},1200);
  void sync();
})();
