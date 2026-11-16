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
  // Netfix UI fixtures stay entirely in this isolated preview service.
  const netfixScenes=['dead-port','no-candidate','drift','auth','transport','recurrence','normal','unknown','verify-fail','rollback-conflict','long-content'];
  let netfixSequence=0,netfixDiagnosis=0,netfixBackupSequence=0,netfixRun=null,netfixPlan=null,netfixHoldAfterWrite=false,netfix;
  function setNetfixScenario(id='dead-port'){
    const scene=netfixScenes.includes(id)?id:'dead-port',fixed=['drift','auth','transport','recurrence','normal'].includes(scene);
    netfixRun=null;netfixPlan=null;netfixHoldAfterWrite=false;
    netfix={scenario:scene,revision:++netfixSequence,stage:'result',busy:false,diagnosisId:++netfixDiagnosis,checkedAt:new Date().toISOString(),env:{path:scene==='long-content'?'C:\\Users\\隔离预览用户\\Documents\\很长的目录名称用于验证窄窗口中的完整内容换行\\.codex\\.env':'C:\\Users\\隔离预览用户\\.codex\\.env',port:fixed?7897:43127,processPort:fixed&&scene!=='drift'?7897:43127,locked:scene==='normal',sha256:scene==='unknown'?null:'preview-fingerprint-'+netfixSequence},candidate:scene==='no-candidate'?null:7897,backups:[{name:'.env.netfix-bak-preview-01',port:43127,at:'14:58:27',restorable:true},{name:'.env.netfix-bak-preview-02',port:7897,at:'11-13 21:06',restorable:true}],audit:[{at:'15:22:13',action:'诊断',result:'隔离预览 · 未读取真实网络与配置'}],progress:[],verification:'none',waitingRestart:false};
    state.netfix=netfix;return netfixSnapshot();
  }
  function netfixVerdict(){
    const n=netfix,scene=n.scenario,dead=n.env.port===43127;
    if(n.stage==='idle')return{level:'neutral',tag:'就绪',title:'点「重新诊断」检查 Codex 网络状态',detail:'诊断只读取证据不做修改。',fixMode:'none',fixLabel:'一键修复'};
    if(n.stage==='diagnosing')return{level:'neutral',tag:'诊断中',title:n.progress.find(p=>p.status==='running')?.name||'正在读取本地状态',detail:'正在收集证据，不做任何修改…',fixMode:'none',fixLabel:'诊断中…'};
    if(n.stage==='rollback_conflict')return{level:'error',tag:'恢复未完成',title:'链路验证失败，恢复改动尚未完成',detail:'恢复前检测到外部变更，已停止覆盖。未确认修复或恢复成功。',fixMode:'copy-report',fixLabel:'复制诊断报告'};
    if(n.stage==='rolled_back')return{level:'warn',tag:'链路验证未通过 · 已回滚',title:'链路验证失败，已恢复原配置',detail:'本轮端口改动已撤回，原只读属性已保留。',fixMode:'copy-report',fixLabel:'复制诊断报告'};
    if(n.stage==='cancelled')return{level:'warn',tag:'本轮已停止',title:'处理已停止，原配置已保留',detail:'已完成必要的恢复。本轮没有确认 Codex 应用内请求恢复。',fixMode:'copy-report',fixLabel:'复制诊断报告'};
    if(scene==='unknown')return{level:'warn',tag:'证据不足 · 待确认',title:'尚不能确认 Codex 网络状态',detail:'进程环境和日志窗口未读取到有效证据，缺失项不按正常处理。',fixMode:'copy-report',fixLabel:'复制诊断报告'};
    if(dead)return{level:'error',tag:n.candidate?'根因：A 链路配置 · B 为连带':'根因：A 链路配置 · 无可用端口',title:n.candidate?'固定代理指向无人监听的死端口 '+n.env.port:'死端口 '+n.env.port+'，且本机没有活跃的代理端口可同步',detail:n.candidate?'.env 固定到 127.0.0.1:'+n.env.port+'，该端口 CLOSED，每个请求在 TCP 阶段失败。':'工具拒绝写入一个同样不可用的端口。请先启动代理客户端，再重新诊断。',fixMode:n.candidate?'fix-port':'none',fixLabel:n.candidate?'一键修复到 '+n.candidate:'禁止自动修复'};
    if(n.env.port!==n.env.processPort)return{level:'warn',tag:'A2 配置漂移 · 待重启',title:'配置已指向 '+n.env.port+'，但运行中的 Codex 仍使用 '+n.env.processPort,detail:'进程环境与 .env 不一致，当前窗口和原任务尚未验证。',fixMode:'advice',fixLabel:'查看处理指引',advice:{title:'A2 处理指引：重启 Codex',sub:'无自动修复动作，请按步骤人工处理',steps:['完全退出 Codex（含托盘图标，不是只关窗口）','重新打开 Codex，再检查进程环境是否与 .env 一致','回本工具点「重新诊断」确认三方一致','工具不代劳重启（避免丢草稿）']}};
    if(scene==='auth')return{level:'warn',tag:'C 身份配额 · 只诊断',title:'请求被鉴权/配额拒绝：需人工处理',detail:'C 类禁止任何自动改配置。token 已过期，近 24h 鉴权类命中 3 条。',fixMode:'none',fixLabel:'禁止自动修复'};
    if(scene==='transport')return{level:'warn',tag:'B 传输 · 检测到传输异常',title:'链路可用但检测到传输异常（TLS/超时）',detail:'近 15min 活跃传输异常 4 条；当前链路 3 次探测中 2 次取得 HTTP 响应，原因尚需确认。',fixMode:'advice',fixLabel:'查看处理指引',advice:{title:'B 类处理指引（无自动修复）',sub:'检测到传输异常，本工具不自动换节点',steps:['核对代理节点与分流规则','切换后回本工具点「重新诊断」复测成功率','禁止改 Codex provider / WebSocket 配置规避']}};
    if(!n.env.locked&&new Set(n.backups.map(b=>b.port)).size>=2)return{level:'warn',tag:'A5 多写者冲突 · 复发源',title:'链路当前可用，但 .env 未锁，可能再被写入死端口',detail:'多份历史备份出现不同端口，建议锁定只读（可逆）。不会因 SusuClash 自身存在或运行触发。',fixMode:'lock-only',fixLabel:'锁定防复发'};
    return{level:'ok',tag:'本轮链路检查',title:'链路检查未发现异常',detail:'.env / 端口监听一致，token 未过期。当前窗口和原任务尚未验证。',fixMode:'copy-report',fixLabel:'复制诊断报告'};
  }
  function netfixSnapshot(){
    const n=netfix,unknown=n.scenario==='unknown',dead=n.env.port===43127,auth=n.scenario==='auth',transport=n.scenario==='transport';
    n.revision=++netfixSequence;n.verdict=netfixVerdict();
    n.rows=[{tag:'A 链路配置',level:unknown?'warn':dead?'error':n.env.port!==n.env.processPort?'warn':'ok',value:unknown?'证据不足':dead?n.env.port+' · 死端口':n.env.port!==n.env.processPort?n.env.port+' · 进程漂移':n.env.port+' · 配置正常',note:unknown?'未读取到有效的进程环境':dead?'端口 CLOSED，每个请求 TCP 阶段失败':'监听本机代理；'+(n.env.locked?'已只读锁定':'未锁定')},{tag:'B 传输',level:unknown||transport?'warn':dead?'error':'ok',value:unknown?'待确认':dead?'全线失败（连带）':transport?'成功率 67%':'成功率 100%',note:unknown?'日志窗口暂不可用':'近 15min 活跃传输异常 '+(transport?4:dead?8:0)+' 条'},{tag:'C 身份配额',level:unknown||auth?'warn':'ok',value:unknown?'未读取到登录态':auth?'token 已过期':'token 未过期',note:unknown?'缺失证据不按正常处理':'近 24h 401/429/额度 '+(auth?3:0)+' 条'}];
    n.evidence=[{label:'.env 配置（文件 · 高）',value:'HTTPS_PROXY=http://127.0.0.1:'+n.env.port,note:n.env.path+' · '+(n.env.locked?'只读锁定':'可写')},{label:'端口监听（系统 · 高）',value:n.env.port+(dead?' CLOSED':' LISTEN 本机代理'),note:'候选顺序：Verge 固定 mixed-port → Windows 系统代理 → 7897 / 7890 / 10808；候选：'+(n.candidate||'未检测到')},{label:'进程环境（进程 · 高）',value:unknown?'未读取到 env':'HTTPS_PROXY=http://127.0.0.1:'+n.env.processPort,note:'隔离预览数据'},{label:'日志窗口（日志 · 中）',value:unknown?'未读取到有效日志窗口':'近 24h 鉴权命中 '+(auth?3:0)+' 条 · 近 15min 传输异常 '+(transport?4:dead?8:0)+' 条',note:'C 精确正则 24h 窗口 · B 活跃窗口 15min（全周期仅展示不判定）'},{label:'token 状态（文件 · 高）',value:unknown?'无法解析':auth?'exp 2026-11-13 · 已过期':'exp 2026-11-15 · 未过期',note:'不返回 token 明文'},{label:'禁改清单（规则 · 高）',value:'model_provider / [model_providers.*] / auth.json / config.toml',note:'修复仅限 .env 代理行；不修改注册表、服务或计划任务'}];
    n.probes=[0,1,2].map(i=>({kind:'current',target:i===1?'chatgpt.com/backend-api/':'api.openai.com/v1/models',channel:'当前 '+n.env.port+' · '+(i+1)+'/3',result:unknown?'未确认':dead?'失败 · CLOSED':transport&&i===1?'失败 · TLS Timeout':'通过 · '+(i===1?'403':'401'),ms:unknown?null:dead?3:transport&&i===1?6004:482+i*110}));
    n.probes.push({kind:'candidate',target:'chatgpt.com/backend-api/',channel:'候选 '+(n.candidate||'无')+'（对照）',result:unknown?'未确认':n.candidate?'通过 · 403':'未执行',ms:unknown||!n.candidate?null:713},{kind:'direct',target:'api.openai.com/v1/models',channel:'直连（对照）',result:unknown?'未确认':'失败 · Timeout',ms:unknown?null:4004});
    n.allowedActions=n.busy||unknown?[]:[n.env.locked?'unlock':'lock',...(n.backups.some(b=>b.restorable)?['restore']:[]),...(n.verdict.fixMode==='fix-port'?['fix-port']:[])];
    n.report='Codex 网络修复工具箱\n隔离预览数据，不代表真实网络状态。\n'+n.verdict.title+'\n'+n.verdict.detail+'\n'+n.rows.map(r=>r.tag+'：'+r.value+'；'+r.note).join('\n')+'\n当前窗口和原任务未验证。';
    const result=clone(n);delete result.scenario;delete result.candidate;return result;
  }
  function netfixAudit(action,result){netfix.audit.push({at:new Date().toLocaleTimeString('zh-CN',{hour12:false}),action,result});}
  function advanceNetfix(){
    if(!netfixRun)return;
    const run=netfixRun,elapsed=Date.now()-run.started,n=netfix;
    if(run.type==='diagnose'){
      const index=Math.min(4,Math.floor(elapsed/130));n.progress.forEach((p,i)=>p.status=i<index?'done':i===index?'running':'pending');
      if(elapsed>=700){n.progress.forEach(p=>p.status='done');n.stage=n.waitingRestart?'awaiting_restart':'result';n.busy=false;n.diagnosisId=++netfixDiagnosis;n.checkedAt=new Date().toISOString();netfixAudit('诊断','只读采集完成 · 隔离预览');netfixRun=null;}
      return;
    }
    if(run.cancelAt){
      if(Date.now()<run.cancelAt)return;
      Object.assign(n.env,run.before);n.waitingRestart=run.waitingRestart;n.stage='cancelled';n.busy=false;n.progress.push({name:'恢复原配置与属性',status:'done',detail:'已完成必要恢复 · 隔离预览'});netfixAudit('停止处理','原配置与只读属性已保留');netfixRun=null;return;
    }
    const index=Math.min(n.progress.length-1,Math.floor(elapsed/160));
    n.progress.forEach((p,i)=>p.status=i<index?'done':i===index?'running':'pending');
    if(elapsed>=160&&!run.backed&&['fix-port','restore'].includes(run.action)){run.backed=true;netfixBackupSequence++;n.backups.unshift({name:run.backupName,port:run.before.port,at:new Date().toLocaleTimeString('zh-CN',{hour12:false}),restorable:true});n.progress[0].detail=run.backupName;}
    if(elapsed>=480&&!run.changed){run.changed=true;if(run.action==='fix-port')n.env.port=n.candidate;else if(run.action==='restore')n.env.port=run.selected.port;else n.env.locked=run.action==='lock';n.env.sha256='preview-fingerprint-'+netfixSequence;n.progress[2].detail=run.action==='restore'?'恢复所选 .env 备份；原只读锁位保留':run.action==='fix-port'?'仅代理行变更；原只读锁位保留':'只读属性已回读';}
    if(netfixHoldAfterWrite&&run.changed)return;
    if(elapsed<1000)return;
    n.progress.forEach(p=>p.status='done');n.busy=false;
    if(run.action==='fix-port'&&['verify-fail','rollback-conflict'].includes(n.scenario)){
      n.progress[4].status='failed';n.progress[4].detail='链路验证未通过';
      if(n.scenario==='rollback-conflict'){n.stage='rollback_conflict';n.verification='rollback_conflict';n.progress.push({name:'恢复原配置',status:'failed',detail:'检测到外部变更，停止覆盖'});}
      else{Object.assign(n.env,run.before);n.stage='rolled_back';n.verification='none';n.progress.push({name:'恢复原配置',status:'done',detail:'已恢复原配置与原只读属性'});}
    }else{n.waitingRestart=['fix-port','restore'].includes(run.action)?n.env.port!==n.env.processPort:run.waitingRestart;n.stage=n.waitingRestart?'awaiting_restart':'result';n.verification=run.action==='fix-port'?'route_ok':run.action==='restore'?'file_restored':run.verification;}
    netfixAudit(run.action,n.stage==='rolled_back'?'验证失败 · 已回滚':n.stage==='rollback_conflict'?'恢复未完成':'操作完成 · 隔离预览');netfixRun=null;
  }
  function netfixPreview(payload){
    const action=payload.action,n=netfix;
    if(!netfixSnapshot().allowedActions.includes(action))return{error:'当前证据不足或操作不可用，请重新诊断。',httpStatus:409};
    const selected=n.backups.find(b=>b.name===payload.backupName&&b.restorable);
    if(action==='restore'&&!selected)return{error:'备份未通过完整性核对。',httpStatus:409};
    const backupName='.env.netfix-bak-preview-new-'+String(netfixBackupSequence+1).padStart(2,'0');
    const attrs=['lock','unlock'].includes(action),rows=[['目标文件',n.env.path],['变更内容',action==='fix-port'?'HTTP(S)_PROXY 127.0.0.1:'+n.env.port+' → 127.0.0.1:'+n.candidate:action==='restore'?'从 '+selected.name+' 恢复 .env；原只读锁位保留':action==='lock'?'writable → readonly；外部写入将被拒绝':'readonly → writable；外部工具可再次改写 .env'],[attrs?'属性恢复点':'自动备份',attrs?'记录本次操作前的只读属性；不创建文件内容备份':backupName+'，写入前先备份当前配置'],['并发改动检测','写入前核对文件指纹与候选归属，不一致即中止'],['回滚方式',attrs?'恢复原只读属性':'比较本次写入归属后恢复；冲突时保留现场'],['生效条件',attrs?'立即生效，无需重启':'完全退出 Codex 后重开，再检查当前入口']];
    netfixPlan={token:'isolated-netfix-plan-'+(++netfixSequence),action,selected,backupName,title:({'fix-port':'确认修复：同步代理端口',restore:'确认从备份恢复',lock:'确认：锁定 .env 为只读',unlock:'确认解除只读锁'})[action],sub:'以下为将要发生的全部改动',confirmLabel:({'fix-port':'确认执行修复',restore:'确认恢复',lock:'确认锁定',unlock:'确认解锁'})[action],rows,expiresAt:Date.now()+60000};
    const result=clone(netfixPlan);delete result.selected;delete result.backupName;return result;
  }
  function netfixRequest(endpoint,payload){
    advanceNetfix();
    if(endpoint==='netfix')return netfixSnapshot();
    if(endpoint==='__preview/netfix-scenario')return setNetfixScenario(payload.scenario);
    if(endpoint==='netfix/diagnose'){
      if(netfix.busy)return netfixSnapshot();netfixPlan=null;netfix.busy=true;netfix.stage='diagnosing';netfix.progress=['读取 .env 与备份','检测端口监听','读取进程 env','扫描日志窗口','并发链路探测'].map((name,i)=>({name,status:i===0?'running':'pending',detail:''}));netfixRun={type:'diagnose',started:Date.now()};return netfixSnapshot();
    }
    if(endpoint==='netfix/preview')return netfixPreview(payload);
    if(endpoint==='netfix/apply'){
      if(!payload.confirmed||!netfixPlan||payload.token!==netfixPlan.token||netfixPlan.expiresAt<Date.now()||netfix.busy)return{error:'方案已失效，请重新诊断。',httpStatus:409};
      const plan=netfixPlan;netfixPlan=null;netfixRun={type:'apply',action:plan.action,selected:plan.selected,backupName:plan.backupName,before:clone(netfix.env),waitingRestart:netfix.waitingRestart,verification:netfix.verification,started:Date.now(),changed:false,backed:false};netfix.busy=true;netfix.stage='executing';netfix.progress=['备份／属性恢复点','并发改动检测','原子写入／属性调整','回读校验',plan.action==='restore'?'生效范围说明':'链路验证','落审计日志'].map((name,i)=>({name,status:i===0?'running':'pending',detail:''}));return netfixSnapshot();
    }
    if(endpoint==='netfix/cancel'){
      if(netfixRun?.type==='apply')netfixRun.cancelAt=Date.now()+160;else{netfixRun=null;netfix.busy=false;netfix.stage='cancelled';netfixAudit('停止诊断','未修改配置');}return netfixSnapshot();
    }
    return{error:'未覆盖的 Netfix 预览接口',httpStatus:404};
  }
  setNetfixScenario('normal');
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
    if(endpoint==='netfix'||endpoint.startsWith('netfix/')||endpoint==='__preview/netfix-scenario')return netfixRequest(endpoint,payload);
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
  return{state,request,setNetfixScenario,holdNetfixExecutionAfterWrite(on=true){netfixHoldAfterWrite=on===true;return netfixHoldAfterWrite;}};
}
module.exports={createFixture};
