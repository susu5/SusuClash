/* In-memory data for the isolated visual preview. Never imports real adapters. */
const APP_VERSION=require('../package.json').version;
const names={network:'本机网络',core:'代理内核',port:'本机端口',system:'系统代理',config:'订阅与配置',routing:'模式与选路',line:'线路与目标连通',dns:'DNS 与证书'};
function createFixture(theme='cat',scenario='normal'){
  const now=Date.now(),group='日常代理';
  const members=[{name:'香港 02 · 低延迟',delay:38},{name:'日本 01 · 稳定线路',delay:82},{name:'新加坡 03 · 日常备用',delay:106},{name:'美国 02 · 备用',delay:168},{name:'德国 01 · 待测线路',delay:null}];
  if(scenario==='long')members[0].name='香港 02 · 面向长时间任务与高清视频的日常线路（长名称布局预览）';
  const profiles=scenario==='empty'?[]:[{id:'daily',name:'日常订阅',kind:'url',active:true,loaded:true,url:'https://preview.example/subscription.yaml',lastSuccess:new Date(now-3600000).toISOString(),usage:{used:28*1024**3,remaining:72*1024**3,total:100*1024**3}},{id:'backup',name:'旅行备用',kind:'url',active:false,loaded:true,url:'https://preview.example/backup.yaml',lastSuccess:new Date(now-7200000).toISOString()},{id:'local',name:'本地配置',kind:'local',active:false,loaded:true}];
  const state={theme,scenario,profiles,runtime:{state:scenario==='empty'?'stopped':'running',version:'Mihomo v1.19.33',appVersion:APP_VERSION,message:''},core:{mode:'rule',port:7890,tun:false,connections:{downloaded:1200000},sampledAt:now},proxy:{enabled:false,managed:true,externalChanged:false},autostart:{enabled:false,conflict:false},tray:{available:true,closeToTray:true},groups:[{name:group,current:members[0].name,members},{name:'流媒体',current:'日本 01 · 稳定线路',members:members.slice(1,4)}],automation:{scope:'daily',group,backups:[members[1].name,members[2].name],autoRepair:false,autoSwitch:false,phase:'healthy',message:'自动处理已就绪',targets:['https://example.test/connectivity'],codexTarget:'https://chatgpt.example.test',checks:{core:'ok',port:'ok',network:'ok',node:'ok',codex:'unknown'},lastChecked:now,codexDetail:'预览数据，未发起真实检测'},connections:scenario==='empty'?[]:[{id:'conn-1',app:'浏览器',address:'example.test:443',route:members[0].name,startedAt:new Date(now-64000).toISOString(),upload:182000,download:1560000},{id:'conn-2',app:'浏览器',address:'assets.example.test:443',route:'DIRECT',startedAt:new Date(now-30000).toISOString(),upload:14200,download:728000},{id:'conn-3',app:'Codex',address:'api.example.test:443',route:members[0].name,startedAt:new Date(now-120000).toISOString(),upload:92000,download:320000}],logs:[{time:new Date(now-120000).toISOString(),level:'info',message:'配置已启用：日常订阅'},{time:new Date(now-64000).toISOString(),level:'info',message:'内核已启动，代理入口就绪'},{time:new Date(now-40000).toISOString(),level:'warn',message:'一条线路尚未测速，保留待确认状态'}],doctor:{base:null,codex:null,task:null,plan:null,history:[]},readyAt:0,nextResult:null,sequence:0,updateEnabled:true};
  const clone=x=>JSON.parse(JSON.stringify(x));
  function baseResult(){const running=state.runtime.state==='running',active=state.profiles.some(p=>p.active&&p.loaded),selected=state.groups[0]?.members.find(m=>m.name===state.groups[0].current);const statuses={core:running?'passed':'failed',port:running?'passed':'failed',config:active?'passed':'needs_user',routing:running&&active?'passed':'unknown',line:running&&selected?.delay>0?'passed':'unknown',system:state.proxy.enabled||['fixed','direct'].includes(state.doctor.task?.pathMode)?'passed':'needs_action'};const checks=Object.entries(names).map(([id,name])=>({id,name,status:statuses[id]||'passed',detail:id==='system'&&!state.proxy.enabled?'预览：当前未开启系统代理，请按接管方式决定。':'预览检查结果，仅用于界面交互。'}));return{status:checks.every(c=>c.status==='passed')?'passed':'needs_action',reason:'这是隔离预览结果，不表示真实网络状态。',checks,checkedAt:Date.now()};}
  function finish(){
    if(state.nextResult==='auto'&&state.readyAt&&Date.now()<state.readyAt){const elapsed=Date.now()-state.autoStartedAt,stage=elapsed>500?'verifying':elapsed>200?'repairing':'checking';state.doctor.codex.autoRepair.stage=stage;state.doctor.task.step=({checking:'正在查找反复重连的原因',repairing:'正在尝试可恢复的连接设置',verifying:'正在用新的连接验证完整回复'})[stage];return;}
    if(!state.readyAt||Date.now()<state.readyAt)return;
    const scope=state.doctor.task?.scope||'proxy';
    if(scope==='proxy')state.doctor.base=baseResult();
    else if(state.nextResult==='auto'){
      const supported=['desktop','cli'].includes(state.doctor.task.client)&&state.doctor.task.symptom!=='tool'&&state.doctor.task.pathMode==='system';
      const stage=!supported?'unsupported':state.scenario==='error'?'needs_action':state.doctor.task.client==='desktop'?'awaiting_activation':'probe_passed';
      const detail=({unsupported:'当前入口尚未接入自动修复，预览没有修改设置。',needs_action:'本轮尝试未能恢复连接，已撤回本轮无效改动。',awaiting_activation:'修复设置已保存，两次连接测试通过；当前桌面窗口是否采用新设置尚未确认。为保护正在进行的任务，没有强制关闭窗口。',probe_passed:'两次独立请求测试通过，原会话的运行结果单独记录。'})[stage];
      state.doctor.codex={status:stage,client:state.doctor.task.client,symptom:state.doctor.task.symptom,checkedAt:new Date().toISOString(),sessionConfirmed:false,checks:[{id:'preview',name:'隔离预览',status:'unknown',detail:'本页使用示例数据，不会修改真实设置或发送模型请求。'}],autoRepair:{stage,detail,verification:stage==='awaiting_activation'||stage==='probe_passed'?'probe_passed':'none',requests:supported?2:0,requestLimit:5,actions:supported?[{id:'identify',title:'已找到反复重连的连接记录',status:'passed'},{id:'repair',title:stage==='needs_action'?'已恢复本轮无效改动':'已备份并保存连接设置',status:'passed'},{id:'verify',title:stage==='needs_action'?'本轮测试仍有异常':'两个全新连接均收到完整回复',status:stage==='needs_action'?'failed':'passed'}]:[],tests:[],activation:'unsupported'}};
    }
    else {
      const reconnect=state.doctor.task.symptom==='reconnect',request=state.nextResult==='request';
      const recent={status:reconnect?'needs_action':'unknown',windowMinutes:30,counts:{timeout:reconnect?5:0,reconnect:reconnect?5:0},lastErrorAt:reconnect?new Date().toISOString():null,detail:reconnect?'预览：最近30分钟发现5条超时、5条重连记录；同一故障可能产生多条记录，可能来自其他本机会话。':'预览：本次读取范围内未发现最近30分钟的超时记录，仍需试发消息。'};
      state.doctor.codex={status:reconnect?'needs_action':request?'probe_passed':'needs_user',client:state.doctor.task.client||'desktop',symptom:state.doctor.task.symptom||'send',sessionConfirmed:false,recent,canRepairPort:false,nextSteps:[{title:'回到刚才出问题的聊天试一次',detail:'发一句“你好”，等它回复完。如果仍出现“正在重新连接”或“request timed out（请求超时）”，说明还没恢复。即使最终有回复，也记下是否反复重连。'},{title:'仍然重连时，换一条线路再试',detail:'在 SusuClash 底部点“线路”，选另一条可用线路，再回同一聊天发一句话。若换线后改善，说明原线路可能不稳定。'},{title:'还没恢复，再正常重开 Codex',detail:'先复制保存未发送的文字，正常退出 Codex 后重新打开，再回原聊天重试。'}],checks:[{id:'path',name:'Codex 的代理设置',status:'unknown',detail:'隔离预览：配置内容不代表已加载。'},{id:'recent',name:'最近的超时与重连',status:recent.status,detail:recent.detail},{id:'target',name:'ChatGPT 网页连接',status:'unknown',detail:'预览：网页响应不能证明消息可以完整回复。'},{id:'request',name:'发送消息测试',status:request?'probe_passed':'needs_user',detail:'这里只演示检查流程，不会发送模型请求。'}],checkedAt:Date.now()};
    }
    state.doctor.task={...state.doctor.task,phase:'completed',step:'预览流程完成'};
    const result=scope==='proxy'?state.doctor.base:state.doctor.codex;state.doctor.history.unshift({scope,at:Date.now(),status:result.status,checks:result.checks});state.readyAt=0;state.nextResult=null;
  }
  function request(endpoint,method='GET',payload={}){
    finish();const post=method!=='GET';
    if(endpoint==='theme'){if(post&&['cat','fish','whale'].includes(payload.theme))state.theme=payload.theme;return{theme:state.theme};}
    if(endpoint==='profiles')return{profiles:clone(state.profiles)};
    if(endpoint==='runtime')return clone(state.runtime);
    if(endpoint==='state'){if(state.runtime.state!=='running')return{};state.core.sampledAt=Date.now();state.core.connections.downloaded+=14000;return clone(state.core);}
    if(endpoint==='system-proxy'){if(post)state.proxy.enabled=payload.enabled;return clone(state.proxy);}
    if(endpoint==='autostart'){if(post)state.autostart.enabled=payload.enabled;return clone(state.autostart);}
    if(endpoint==='tray'){if(post)state.tray.closeToTray=payload.closeToTray;return clone(state.tray);}
    if(endpoint==='groups')return{groups:state.runtime.state==='running'?clone(state.groups):[]};
    if(endpoint==='connections'){if(state.scenario==='error')return{error:'预览：连接数据暂不可用',httpStatus:503};return{connections:clone(state.connections)};}
    if(endpoint==='logs')return{entries:clone(state.logs)};
    if(endpoint==='automation'){if(post)Object.assign(state.automation,payload);state.automation.scope=state.profiles.find(p=>p.active)?.id||'';return clone(state.automation);}
    if(endpoint==='select'){const g=state.groups.find(g=>g.name===payload.group);if(g)g.current=payload.member;return{ok:true};}
    if(endpoint==='delay')return{delay:state.groups.flatMap(g=>g.members).find(m=>m.name===payload.member)?.delay||96};
    if(endpoint==='mode'){state.core.mode=payload.mode;return{ok:true};}
    if(endpoint==='port'){state.core.port=payload.port;return{port:payload.port};}
    if(endpoint==='core-stop'){state.runtime.state='stopped';state.proxy.enabled=false;return clone(state.runtime);}
    if(endpoint==='core-start'){state.runtime.state='running';return clone(state.runtime);}
    if(endpoint==='disconnect'){state.connections=state.connections.filter(c=>c.id!==payload.id);return{ok:true};}
    if(endpoint==='profiles/url'||endpoint==='profiles/local'){const p={id:'preview-'+(++state.sequence),name:payload.name||'导入配置',kind:endpoint.endsWith('local')?'local':'url',loaded:true,active:false,url:payload.url};state.profiles.push(p);return clone(p);}
    if(endpoint==='profiles/edit'){const p=state.profiles.find(p=>p.id===payload.id);if(p)Object.assign(p,{name:payload.name,url:payload.url});return clone(p||{});}
    if(endpoint==='profiles/update'){const p=state.profiles.find(p=>p.id===payload.id);if(p)p.lastSuccess=new Date().toISOString();return clone(p||{});}
    if(endpoint==='profiles/activate'){for(const p of state.profiles)p.active=p.id===payload.id;state.runtime.state='running';state.automation.scope=payload.id;return{ok:true};}
    if(endpoint==='profiles/delete'){state.profiles=state.profiles.filter(p=>p.id!==payload.id||p.active);return{ok:true};}
    if(endpoint==='diagnose')return{title:'预览检测结果',tone:'warn',detail:'示例状态用于展示页面，不会读取真实网络。',checkedAt:Date.now(),checks:[{id:'core',value:'运行中',tone:'ok',detail:'本地预览数据'},{id:'port',value:String(state.core.port),tone:'ok'},{id:'web',value:'待确认'},{id:'codex',value:'需应用验证'}],steps:[]};
    if(endpoint==='update-settings'){if(post)state.updateEnabled=payload.enabled;return{enabled:state.updateEnabled,intervalMs:86400000,checking:false,lastCheckedAt:Date.now(),lastResult:{status:'up_to_date',currentVersion:APP_VERSION,latestVersion:APP_VERSION}};}
    if(endpoint==='update-check')return state.scenario==='error'?{status:'network_error',currentVersion:APP_VERSION}:{status:'up_to_date',currentVersion:APP_VERSION,latestVersion:APP_VERSION,checkedAt:Date.now()};
    if(endpoint==='codex-repair/preview')return{supported:true,token:'preview-only',changes:[],detail:'仅预览，无真实变更'};
    if(endpoint==='codex-repair/apply')return{applied:false,detail:'预览不会修改实际配置'};
    if(endpoint==='doctor')return clone(state.doctor);
    if(endpoint.startsWith('doctor/')){
      const action=endpoint.slice(7);
      if(action==='auto-start'){
        if(payload.consent!==true)return{error:'请先了解本轮自动处理范围',httpStatus:400};
        if(['checking','repairing'].includes(state.doctor.task?.phase))return clone(state.doctor);
        state.doctor.task={id:'task-'+(++state.sequence),phase:'repairing',scope:'codex',client:payload.client||'desktop',symptom:payload.symptom||'send',pathMode:payload.pathMode||'system',step:'正在识别本次连接设置'};
        state.doctor.codex={client:state.doctor.task.client,symptom:state.doctor.task.symptom,checks:[],sessionConfirmed:false,autoRepair:{stage:'checking',detail:'正在读取预览状态',actions:[],requests:0,requestLimit:5,verification:'none'}};
        state.readyAt=Date.now()+1200;state.autoStartedAt=Date.now();state.nextResult='auto';
      }
      if(action==='start'||action==='request'){const old=state.doctor.task;state.doctor.task={id:'task-'+(++state.sequence),phase:'checking',scope:action==='request'?'codex':payload.scope||'proxy',client:payload.client||old?.client||'desktop',symptom:payload.symptom||old?.symptom||'send',pathMode:payload.pathMode||'system',step:'正在读取预览状态'};if(action==='start')state.doctor[state.doctor.task.scope==='codex'?'codex':'base']=null;state.readyAt=Date.now()+650;state.nextResult=action;}
      if(action==='cancel'){state.readyAt=0;state.nextResult=null;state.doctor.task={...state.doctor.task,phase:'cancelled'};if(state.doctor.codex?.autoRepair){state.doctor.codex.status='cancelled';state.doctor.codex.autoRepair={...state.doctor.codex.autoRepair,stage:'cancelled',detail:'已停止处理并完成本轮恢复。',verification:'none'};}}
      if(action==='preview')state.doctor.plan={id:'plan-'+(++state.sequence),kind:payload.kind,detail:'预览：'+({'system-proxy':'启用系统代理','core-restart':'重新启动受控内核','port-migrate':'验证并迁移代理入口','candidates':'验证候选线路','codex-port':'核对并更新固定代理端口','client-restart':'正常重开客户端'}[payload.kind]||'核对实际变更')+'。本预览只改变内存状态，不执行真实操作。',expiresAt:Date.now()+60000};
      if(action==='apply'){if(!payload.confirmed||payload.id!==state.doctor.plan?.id)return{error:'预览方案无效',httpStatus:409};const kind=state.doctor.plan.kind;if(kind==='system-proxy')state.proxy.enabled=true;if(kind==='core-restart')state.runtime.state='running';if(kind==='port-migrate')state.core.port=7891;if(kind==='candidates'){const g=state.groups.find(g=>g.name===state.automation.group);const next=g?.members.find(m=>state.automation.backups.includes(m.name)&&m.name!==g.current&&m.delay>0);if(next)g.current=next.name;}state.doctor.task={id:'task-'+(++state.sequence),phase:'repairing',scope:kind==='codex-port'?'codex':'proxy',client:state.doctor.codex?.client||'desktop',handoffReady:kind==='client-restart',step:'正在模拟处理与复查'};state.readyAt=Date.now()+650;}
      if(action==='confirm'&&state.doctor.codex){state.doctor.codex.sessionConfirmed=true;state.doctor.codex.status='verified';}
      if(action==='invalidate'){if(state.doctor.base)state.doctor.base.status='stale';if(state.doctor.codex)state.doctor.codex.status='stale';}
      return clone(state.doctor);
    }
    return{error:'未覆盖的预览接口：'+endpoint,httpStatus:404};
  }
  return{state,request};
}
module.exports={createFixture};
