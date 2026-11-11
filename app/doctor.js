'use strict';
(() => {
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=n=>`<svg class="icon" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const names={network:'本机网络',core:'代理内核',port:'本机端口',system:'系统代理',config:'订阅与配置',routing:'模式与选路',line:'线路与目标连通',dns:'DNS 与证书'};
  const labels={passed:'通过',probe_passed:'测试通过',app_verified:'应用已验证',awaiting_activation:'待生效确认',verified:'用户已确认',failed:'待处理',needs_action:'待处理',needs_user:'待操作',unknown:'待确认',stale:'需复查',pending:'未检查',cancelled:'已停止',unsupported:'暂不支持',waiting_user:'需要登录',waiting_service:'服务待恢复',rollback_conflict:'恢复未完成'};
  let data={base:null,codex:null,task:null,history:[]},screen='start',client='desktop',symptom='send',pathMode='system',viewScope='proxy',visible=false,pending=false,details=false,polling=false,revision=0;
  const main=document.querySelector('.app main'),nav=document.querySelector('.tabs');
  const shell=document.createElement('section');shell.className='doctor-shell';shell.hidden=true;
  shell.innerHTML='<div class="app-body" tabindex="-1"></div><footer class="action-area"></footer>';
  main.after(shell);const body=shell.firstElementChild,actions=shell.lastElementChild;
  const live=document.createElement('p');live.className='sr-only';live.setAttribute('role','status');live.setAttribute('aria-live','polite');live.setAttribute('aria-atomic','true');shell.after(live);
  function announce(message){live.textContent=message;}
  const active=()=>['checking','repairing'].includes(data.task?.phase);
  const row=(name,status='pending',detail='')=>`<div class="result-row"><span class="result-mark ${status==='passed'||status==='probe_passed'||status==='verified'?'ok':['failed','needs_action'].includes(status)?'warn':'pending'}">${icon(status==='passed'||status==='probe_passed'||status==='verified'?'check':['failed','needs_action'].includes(status)?'alert':'clock')}</span><span class="row-copy"><span class="row-title">${esc(name)}</span>${detail?`<span class="row-detail">${esc(detail)}</span>`:''}</span><span class="row-state">${esc(labels[status]||'待确认')}</span></div>`;
  const list=checks=>'<div class="result-list">'+checks.map(c=>row(c.name||c.id,c.status,c.detail)).join('')+'</div>';
  const baseRows=(detail=false)=>'<div class="result-list check-compact">'+Object.entries(names).map(([id,name])=>{const c=data.base?.checks.find(x=>x.id===id);return row(name,c?.status,detail?c?.detail:'');}).join('')+'</div>';
  const button=(name,action,cls='primary',disabled=false)=>`<button type="button" class="${cls}" data-doctor="${action}" ${disabled?'disabled':''}>${esc(name)}</button>`;
  const header=(title,sub='代理综合检查')=>`<header class="page-header"><button class="icon-button" type="button" data-doctor="back" aria-label="返回上一步">${icon('back')}</button><div><h1 tabindex="-1">${esc(title)}</h1><p>${esc(sub)}</p></div></header>`;
  const notice=(text,kind='')=>`<div class="notice ${kind}">${icon(kind==='warn'?'alert':'info')}<p>${esc(text)}</p></div>`;
  const intro=(title,copy)=>`<div class="intro"><h2>${esc(title)}</h2><p>${esc(copy)}</p></div>`;
  const outcome=(title,copy,ok=false)=>`<div class="outcome-symbol ${ok?'ok':''}">${icon(ok?'check':'info')}</div><h2 class="outcome-title">${esc(title)}</h2><p class="outcome-copy">${esc(copy)}</p>`;
  const flow=step=>`<div class="flow" aria-label="当前阶段：${['检查','验证','修复','复查'][step]}">${['检查','验证','修复','复查'].map((label,i)=>`<div class="flow-step ${i<step?'done':i===step?'active':''}"><span class="flow-point">${i<step?icon('check'):i+1}</span><span>${label}</span></div>`).join('')}</div>`;
  const codexEntry=()=>`<button type="button" class="special-entry" data-doctor="codex"><span class="result-mark">${icon('scan')}</span><span class="row-copy"><span class="row-title">Codex 连接修复</span><span class="row-detail">自动排查消息发不出、断流和反复重连</span></span><span class="special-state">${esc(labels[data.codex?.status]||'未检测')}${icon('chevron')}</span></button>`;
  const autoFlow=stage=>{const step=({checking:0,repairing:1,verifying:2})[stage]??2;return '<div class="flow repair-flow" aria-label="当前阶段：'+['定位问题','自动处理','验证结果'][step]+'">'+['定位问题','自动处理','验证结果'].map((label,i)=>`<div class="flow-step ${i<step?'done':i===step?'active':''}"><span class="flow-point">${i<step?icon('check'):i+1}</span><span>${label}</span></div>`).join('')+'</div>';};
  const repairScope=()=>'<p class="small-note">点击后将自动尝试可恢复的连接设置或已允许的备用线路，最多发送 5 条简短测试消息，可能消耗额度。主动处理最长 3 分钟；无效改动会尝试恢复。</p>';
  function autoResult(c){
    const a=c.autoRepair,stale=c.status==='stale';
    const title=stale?'连接条件已变化，请重新检查':({app_verified:'当前 Codex 已通过验证',awaiting_activation:'测试通过，当前窗口尚未确认',probe_passed:a.changed===false?'本轮未复现连接问题':'独立请求测试通过',needs_action:'本轮仍未恢复连接',cancelled:'本轮已停止',rollback_conflict:'恢复改动尚未完成',unsupported:'当前入口暂不能自动处理',waiting_user:'需要完成账户操作',waiting_service:'服务暂时无法完成请求'})[a.stage]||'尚不能确认恢复';
    const copy=stale?'下面是上次处理记录，不能代表当前连接状态。':a.stage==='awaiting_activation'?'两个新的测试连接已顺利回复。当前打开的 Codex 还没验证，暂不能确认已经恢复。':a.detail;
    let html=header('Codex 处理结果','本轮处理与验证')+outcome(title,copy,a.stage==='app_verified'&&!stale);
    if(a.stage==='awaiting_activation'&&!stale)html+=notice('连接设置已保存。当前版本还不能安全重开正在使用的 Codex，已保留你的窗口和任务。');
    if(a.actions?.length)html+='<h2 class="section-title">本轮做了什么</h2>'+list(a.actions.map(x=>({name:x.title,status:x.status==='passed'?'passed':x.status==='failed'?'failed':'unknown'})));
    const verification=({none:'尚未完成真实请求验证',route_ok:'代理连接可用，消息回复尚未验证',probe_passed:'独立测试收到完整回复，当前窗口和原聊天尚未验证',app_verified:'当前应用入口已完成真实请求验证；原任务结果单独记录'})[a.verification]||'尚未确认';
    html+='<details class="fold"><summary>查看验证范围与检测依据</summary><p>'+esc(verification)+'</p><p>诊断请求尝试：'+esc(a.requests||0)+' / '+esc(a.requestLimit||5)+'</p>'+list(c.checks||[])+(c.checkedAt?'<p class="small-note">本轮记录：'+esc(new Date(c.checkedAt).toLocaleString('zh-CN',{hour12:false}))+'</p>':'')+'</details>';
    html+=button('更改使用方式或问题类型','codex-options','text-button');
    const retry=['needs_action','cancelled','waiting_user','waiting_service'].includes(a.stage)||stale;
    if(retry)html+=repairScope();
    return {html,footer:retry?button('重新自动检查并修复','auto-start')+button('返回综合检查','overview','text-button'):button('返回首页','home')+button('只重新检查，不修改','start-codex','text-button')};
  }
  function render() {
    if(!visible){renderHomeStatus();return;}
    const focused=shell.contains(document.activeElement)?document.activeElement:null;
    const focusKey=focused?.id?'#'+CSS.escape(focused.id):focused?.dataset.doctor?'[data-doctor="'+CSS.escape(focused.dataset.doctor)+'"]':focused?.dataset.preview?'[data-preview="'+CSS.escape(focused.dataset.preview)+'"]':focused?.dataset.symptom?'[data-symptom="'+CSS.escape(focused.dataset.symptom)+'"]':null;
    const consent=screen==='plan'&&document.getElementById('doctorConsent')?.checked;
    let html='',footer='';
    body.classList.toggle('is-overview',screen==='start');
    if(screen==='start'){
      html=header('代理综合检查','网络、配置、线路与应用')+'<p class="overview-lead">检查代理基础状态，按需要进入应用专项。</p><div class="scope-heading"><h2>代理基础检查</h2><span class="row-state">'+esc(labels[data.base?.status]||'未检查')+'</span></div>'+baseRows()+'<h2 class="section-title">应用专项</h2>'+codexEntry()+'<details class="fold"><summary>检查范围与判断方式</summary><p>按当前运行方式判断系统代理；关闭不一定代表异常。应用专项结果单独验证，不替代基础检查结论。</p><label class="field-label" for="doctorPathMode">本次代理接管方式</label><select class="app-select" id="doctorPathMode"><option value="system">系统代理</option><option value="fixed">应用固定代理</option><option value="direct">明确使用直连</option></select></details>';
      footer=active()?button('查看当前任务进度','progress'):data.base&&data.base.status!=='stale'?button('查看基础检查结果','base-result'):button('开始代理基础检查','start-base')+'<p class="action-hint">先检查，不修改设置；Codex 专项可按需进入</p>';
    }else if(screen==='codex'){
      const supported=['desktop','cli'].includes(client)&&symptom!=='tool'&&pathMode==='system';
      html=header('修复 Codex 连接','从查找原因到验证回复')+autoFlow('checking')+'<label class="field-label" for="doctorClient">正在使用的 Codex</label><select class="app-select" id="doctorClient" '+(active()?'disabled':'')+'>'+Object.entries({desktop:'Codex 桌面客户端',cli:'Codex CLI（命令行）',ide:'Codex IDE 扩展（编辑器内）',wsl:'WSL 内的 Codex',remote:'远端环境'}).map(([v,t])=>`<option value="${v}" ${client===v?'selected':''}>${t}</option>`).join('')+'</select><div class="context-row"><span>检测环境</span><span>'+(['remote','wsl'].includes(client)?'需要目标环境适配':'Windows 本机')+'</span></div><p class="field-label">遇到的情况</p><div class="symptoms">'+[['send','消息发不出去'],['stream','回复中途断开'],['reconnect','反复重连后才回复'],['tool','只有工具失败']].map(([v,t])=>`<button type="button" class="symptom" data-symptom="${v}" aria-pressed="${symptom===v}">${t}</button>`).join('')+'</div>'+notice(supported?'先找出连接问题，再尝试安全修复，最后用新的测试连接确认回复是否完整。':'这个使用方式目前仅支持检查，自动修复尚未覆盖。')+(supported?repairScope():'')+'<details class="fold"><summary>会修改什么？</summary><p>仅处理能够核对归属、能够备份和恢复的连接设置。不会替你重发原任务。无法安全重开 Codex 时会保留明确结果，不强制结束任务。</p><p>运行记录在本机检查，页面不展示聊天内容或密钥。本人登录、额度和服务故障会单独说明。</p></details>';
      footer=active()?button('查看当前任务进度','progress'):supported?button('自动检查并修复','auto-start')+button('只检查，不修改','start-codex','text-button'):button('开始 Codex 专项检测','start-codex');
    }else if(screen==='progress'){
      const scope=data.task?.scope==='proxy',a=data.codex?.autoRepair;
      html=header(a?'正在处理 Codex 连接':data.task?.phase==='repairing'?'正在执行修复':scope?'正在检查整个代理':'正在检查 Codex 连接',scope?'代理基础检查':a?'自动检查与修复':'Codex 专项检测')+(a?autoFlow(a.stage):flow(data.task?.phase==='repairing'?2:0))+intro(data.task?.step||'正在读取本地状态',a?'请稍候，处理结果会自动显示。':'已通过的结果会保留；无法确认的项目不会当作成功。')+'<div class="progress-lines" aria-label="检查进行中"><span></span><span></span><span></span><span></span></div>'+(a?(a.actions?.length?list(a.actions.map(x=>({name:x.title,status:x.status==='passed'?'passed':'unknown'}))):notice('正在核对当前配置和最近的连接记录。')):scope?baseRows():notice('等待检测完成；网页响应与模型请求完成分别记录。'));
      footer=a?button('停止本轮处理','cancel','text-button')+'<p class="action-hint">停止后会先完成必要的恢复，再显示结果。</p>':data.task?.phase==='repairing'?'<p class="action-hint">当前变更正在完成，请等待复查。</p>':button('停止本次检查','cancel','text-button');
    }else if(screen==='base-result'){
      html=header('代理基础检查结果')+outcome(data.base?.status==='passed'?'本次代理基础检查通过':'代理仍有项目需要确认',data.base?.reason||'保留已通过项，继续处理未通过或无法确认的部分。',data.base?.status==='passed')+baseRows(details)+'<button class="section-link" type="button" data-doctor="details"><span>'+ (details?'收起检查依据':'查看各项检查依据')+'</span>'+icon('chevron')+'</button>';
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
    }else if(screen==='codex-result'&&data.codex?.autoRepair){
      ({html,footer}=autoResult(data.codex));
    }else if(screen==='codex-result'){
      const c=data.codex,stale=c?.status==='stale',verified=!stale&&c?.sessionConfirmed,pass=c?.status==='probe_passed',recentIssue=c?.recent?.status==='needs_action';
      const checked=c?.checkedAt?new Date(c.checkedAt):null;
      const repeated=Boolean(c?.recent?.counts?.timeout||c?.recent?.counts?.reconnect),connectFailed=Boolean(c?.recent?.counts?.connection);
      const recentTitle=repeated?'检测到最近有超时或重连':connectFailed?'检测到最近有连接失败':'检测到最近有连接异常';
      const recentDetail=repeated?'即使最终收到了回复，超时或重连也属于连接异常。可以继续自动检查并修复。':connectFailed?'运行记录中有连接未能建立。可以继续自动检查并修复。':'运行记录中发现异常，具体原因还需确认。可以继续自动检查并修复。';
      html=header('Codex 专项结果','每轮检测单独记录')+outcome(stale?'上次结果已过期，请重新检测':verified?'本次原任务已由你确认恢复':recentIssue?recentTitle:c?.status==='needs_action'?'发现连接问题，需要继续处理':pass?'Codex 测试请求已成功':'尚不能确认 Codex 连接正常',stale?'连接设置已经变化，下方保留的是上次记录。':verified?'你已在出问题的聊天里完成验证。':recentIssue?recentDetail:pass?'命令行的短消息测试成功，请再回出问题的聊天验证。':'网页能打开不代表消息能顺利回复，还需要验证真实请求。',verified||pass);
      if(checked&&Number.isFinite(checked.getTime()))html+='<p class="small-note">本轮检测完成：'+esc(checked.toLocaleString('zh-CN',{hour12:false}))+'</p>';
      if(recentIssue&&!verified)html+=notice(c.recent.detail,'warn');
      html+='<details class="fold"><summary>查看本轮检测依据</summary>'+list(c?.checks||[])+(c?.recent?.lastErrorAt?'<p class="small-note">最近错误：'+esc(new Date(c.recent.lastErrorAt).toLocaleString('zh-CN',{hour12:false}))+'</p>':'')+'</details>';
      if(c?.client==='cli'&&c?.symptom!=='tool'&&!pass&&!stale)html+=button('试发一条命令行测试消息','request-plan','secondary');
      html+=button('更改使用方式或问题类型','codex-options','text-button');
      const supported=['desktop','cli'].includes(c?.client)&&c?.symptom!=='tool'&&pathMode==='system';
      if(supported&&!verified)html+=repairScope();
      footer=verified?button('完成，返回首页','home')+button('重新检测 Codex','start-codex','text-button'):(supported?button('自动检查并修复','auto-start'):'')+button('重新检测 Codex','start-codex','text-button');
    }else if(screen==='plan'){
      html=header('确认本次修复')+flow(2)+intro(({ 'system-proxy':'启用系统代理','core-restart':'重启本软件代理内核','port-migrate':'迁移本机代理入口','codex-port':'更新固定代理端口','candidates':'验证候选线路后再切换','client-restart':'正常重开 SusuClash'})[data.plan?.kind]||'处理已确认的问题','只执行下面列出的操作；完成后重新检查连接。')+'<ol class="plan-list"><li><span class="plan-index">1</span><div><strong>核对原状态与归属</strong><p>原配置和代理归属用于核对与恢复。</p></div></li><li><span class="plan-index">2</span><div><strong>执行本次确认的方案</strong><p>'+esc(data.plan?.detail)+'</p></div></li><li><span class="plan-index">3</span><div><strong>重新检查，确认实际结果</strong></div></li></ol>'+notice('如设置或归属发生变化，方案失效，需重新检查。正在写入的单步操作会先完成，再显示复查结果。','warn')+'<label class="consent"><input type="checkbox" id="doctorConsent"><span>'+(data.plan?.kind==='codex-port'?'我已确认当前客户端使用这个配置文件，并会保存内容后正常重开':'我已了解本次变更和可能的短暂中断')+'</span></label>';
      footer=button('确认并修复','apply','primary',true)+button('返回检查结果','result','text-button');
    }else if(screen==='handoff'){
      html=header('独立恢复进程已接手','SusuClash 客户端恢复')+outcome('正在正常重开 SusuClash','进度已保留。原进程退出后，恢复助手才会打开新客户端，并重新检查代理基础连接。')+notice('如果没有正常重开，请从托盘正常退出后再打开，或使用安装目录中的“恢复SusuClash.cmd”。','neutral');
      footer='<p class="action-hint">等待客户端正常退出，不会强制结束其他程序。</p>';
    }else if(screen==='request-plan'){
      html=header('验证独立 CLI 请求','Codex 专项检测')+intro('先确认测试范围','启动一次短暂的 CLI 测试，接收固定短回复和完成事件。')+notice('使用现有登录与默认 OpenAI 模型，可能消耗额度。此测试使用本次受控代理入口，不加载用户自定义配置；桌面、IDE、自定义服务和持续长回复需分别确认。')+'<p class="small-note">测试不需要工具，出现工具事件即停止；只读沙箱；90 秒内未完整完成则保留待确认。你也可以直接回原会话验证。</p>';
      footer=button('发送一次测试请求','request')+button('返回专项结果','codex-result','text-button');
    }else if(screen==='history'){
      html=header('最近的连接检查')+intro('每一步都能回看','只记录本次处理对象、结果与验证范围。')+(data.history.length?list(data.history.map(h=>({name:(h.scope==='proxy'?'代理基础检查':'Codex 专项')+' · '+new Date(h.at).toLocaleString(),status:h.status,detail:h.checks.map(c=>c.name+'：'+(labels[c.status]||'待确认')).join('；')}))):notice('尚未运行检查，可以从首页大圆球开始。','neutral'));
      footer=button('返回综合检查','overview')+button('导出诊断记录','export','text-button');
    }else if(screen==='help'&&viewScope==='codex'){
      html=header('Codex 连接处理说明')+intro('先让软件完成检查与修复','自动流程会查找原因、尝试可恢复的变更，再用新的连接验证回复。')+notice('需要本人登录、额度不足或服务异常时，会停止无效尝试并说明原因。测试通过与当前聊天恢复分别记录。')+repairScope();
      footer=button('返回检查结果','result');
    }else if(screen==='help'){
      const steps=viewScope==='codex'&&data.codex?.nextSteps?.length?data.codex.nextSteps:[{title:'先确认电脑可以上网',detail:'用浏览器打开一个平时常用的网站。酒店或校园网络可能要先登录认证。'},{title:'重新检查代理',detail:'回到综合检查，点击“开始代理基础检查”，按结果处理。'}];
      html=header('还有问题时怎么做','按顺序操作')+'<ol class="manual-list">'+steps.map(s=>'<li><strong>'+esc(s.title)+'</strong><p>'+esc(s.detail)+'</p></li>').join('')+'<li><strong>记下报错后再继续排查</strong><p>如果多条线路都会超时，保存 Codex 显示的错误和发生时间。登录失效就重新登录；额度用完就按提示等待。原因不明确时不要反复改配置。</p></li></ol>'+notice('“request timed out”是请求超时，“正在重新连接”是连接中断后的重试。最终有回复，也需要观察是否还反复重连。','neutral');
      footer=button('返回检查结果','result');
    }
    if(data.task?.error&&['base-result','codex-result'].includes(screen))html=notice(data.task.error,'warn')+html;
    body.innerHTML=html;actions.innerHTML=footer;const pathSelect=body.querySelector('#doctorPathMode');if(pathSelect){pathSelect.value=pathMode;pathSelect.disabled=active();}
    if(consent&&screen==='plan'){body.querySelector('#doctorConsent').checked=true;actions.querySelector('[data-doctor="apply"]').disabled=false;}
    if(focusKey)shell.querySelector(focusKey)?.focus({preventScroll:true});
    shell.setAttribute('aria-busy',String(pending));renderHomeStatus();
  }
  function repairEntry(kind,title,copy){return `<button class="section-link" type="button" data-preview="${kind}"><span class="row-copy"><span class="row-title">${esc(title)}</span><span class="row-detail">${esc(copy)}</span></span>${icon('chevron')}</button>`;}
  function show(view){if(['codex','codex-result','request-plan'].includes(view))viewScope='codex';if(view==='base-result')viewScope='proxy';if(view==='progress')viewScope=data.task?.scope||viewScope;visible=true;screen=view;main.hidden=true;shell.hidden=false;nav.hidden=false;render();body.scrollTop=0;body.querySelector('h1')?.focus({preventScroll:true});}
  function hide(){visible=false;shell.hidden=true;main.hidden=false;}
  function result(){return viewScope==='codex'?'codex-result':'base-result';}
  async function sync(){if(polling||pending)return;polling=true;const mine=revision;try{const next=await api('doctor');if(mine!==revision||pending)return;const changed=JSON.stringify(next)!==JSON.stringify(data);data=next;if(visible&&screen==='progress'&&!active()){show(data.task?.handoffReady?'handoff':result());announce(data.task?.error||body.querySelector('h1')?.textContent||'检查已结束');}else if(changed)render();}catch(e){if(visible){notify('诊断服务暂不可用，请稍后重试；未确认恢复。');announce('诊断服务暂不可用，请稍后重试；未确认恢复。');}}finally{polling=false;}}
  async function call(endpoint,payload={}){if(pending)return;pending=true;revision++;try{data=await api('doctor/'+endpoint,payload);return true;}catch(e){notify(e.message);announce(e.message);return false;}finally{pending=false;}}
  async function handle(action){
    if(action==='overview')return show('start');
    if(action==='codex'){if(data.codex){client=data.codex.client;symptom=data.codex.symptom;return show('codex-result');}return show('codex');}
    if(action==='codex-options')return show('codex');
    if(action==='back')return screen==='start'?(hide(),openPage('home')):show('start');
    if(action==='home')return hide(),openPage('home');
    if(['codex','history','progress','base-result','codex-result','request-plan','help'].includes(action))return show(action);
    if(action==='details'){details=!details;return render();}
    if(action==='result')return show(result());
    if(action==='lines'||action==='profiles'){hide();return openPage(action==='profiles'?'subscriptions':'lines');}
    if(action==='auto-start'){
      if(pending)return;if(active())return show('progress');
      const previous=data;viewScope='codex';
      data={...data,task:{scope:'codex',phase:'repairing',step:'正在发起新一轮自动检查'},codex:{client,symptom,autoRepair:{stage:'checking',actions:[]}}};show('progress');announce('自动检查与修复已开始');
      if(await call('auto-start',{client,symptom,pathMode,consent:true}))show(active()?'progress':'codex-result');else{data=previous;show('codex');}
    }
    if(action==='start-base'||action==='start-codex'){
      if(pending)return;if(active())return show('progress');
      const scope=action==='start-base'?'proxy':'codex',previous=data;viewScope=scope;
      data={...data,task:{scope,phase:'checking',step:'正在发起新一轮检测，重新读取当前状态'},[scope==='proxy'?'base':'codex']:null};show('progress');announce('新一轮检测已开始');
      if(await call('start',{scope,client,symptom,pathMode}))show(active()?'progress':result());else{data=previous;show(scope==='codex'?'codex':'start');}
    }
    if(action==='cancel'){const auto=Boolean(data.codex?.autoRepair);if(await call('cancel'))show(auto?(active()?'progress':'codex-result'):'start');}
    if(action==='apply'){const planId=data.plan?.id;show('progress');if(await call('apply',{id:planId,confirmed:true})){viewScope=data.task?.scope||viewScope;if(data.task?.error)notify(data.task.error);if(visible&&screen==='progress')show(data.task?.handoffReady?'handoff':result());announce(data.task?.error||body.querySelector('h1')?.textContent||'本次操作已结束');}else if(visible&&screen==='progress')show(result());}
    if(action==='request'){if(await call('request'))show('progress');}
    if(action==='confirm'){if(await call('confirm'))show('codex-result');}
    if(action==='next-help')return show('help');
    if(action==='export'){const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),history:data.history},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='SusuClash-连接检查.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }
  shell.addEventListener('click',async e=>{const p=e.target.closest('[data-preview]');if(p){if(await call('preview',{kind:p.dataset.preview}))show('plan');return;}const b=e.target.closest('[data-doctor]');if(b)await handle(b.dataset.doctor);const s=e.target.closest('[data-symptom]');if(s&&!active()){symptom=s.dataset.symptom;render();}});
  shell.addEventListener('change',e=>{if(e.target.id==='doctorClient'){client=e.target.value;render();}if(e.target.id==='doctorPathMode')pathMode=e.target.value;if(e.target.id==='doctorConsent')actions.querySelector('[data-doctor="apply"]').disabled=!e.target.checked;});
  const settings=document.querySelector('[data-page="settings"]');const entry=document.createElement('button');entry.type='button';entry.className='sub-entry';entry.innerHTML='<span class="row-icon">'+icon('scan')+'</span><span class="row-copy"><span class="row-label">代理综合检查</span><span class="hint">代理基础状态与 Codex 专项</span></span><span class="chevron">›</span>';entry.addEventListener('click',()=>{void sync();show('start');});settings.querySelector('[data-open="runtime"]').before(entry);
  const oldOpen=openPage;
  openPage=function(name,...rest){if(name==='check'){void sync();show('start');return;}hide();return oldOpen(name,...rest);};
  window.connectionDoctor={open:view=>{void sync();show(view||(active()?'progress':'start'));}};
  function renderHomeStatus(){
    const orb=$('statusOrb');if(!orb)return;
    const node=$('nodeName');if(node)node.title=node.textContent;
    const checking=active(),stale=data.base?.status==='stale'||data.codex?.status==='stale';
    const text=checking?(data.task.scope==='proxy'?'代理基础检查进行中':'Codex 专项检测进行中'):stale?'连接设置已变化，请重新检查':data.base?.status==='passed'?'本次代理基础检查通过':data.base?'代理仍有项目需要确认':data.codex?.sessionConfirmed?'原任务已确认，代理基础未检查':data.codex?.status==='probe_passed'?'Codex 请求通过，代理基础未检查':'代理基础状态尚未检查';
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
  window.addEventListener('clash-render',renderHomeStatus);window.addEventListener('online',()=>{void api('doctor/invalidate',{}).then(x=>{data=x;render();});});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void sync();});
  // A suspended computer invalidates earlier observations. Never reuse an old
  // green result after sleep simply because no setting button was touched.
  let lastTick=Date.now();setInterval(()=>{const now=Date.now();if(now-lastTick>20000)void api('doctor/invalidate',{}).then(x=>{data=x;render();}).catch(()=>{});lastTick=now;if(active()||visible)void sync();},1200);
  void sync();
})();
