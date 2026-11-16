import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, lstat, realpath, mkdir, open, rename, rm } from 'node:fs/promises';
import { createNetfixTransaction, netfixBackupName } from './netfix-transaction.mjs';
import { evaluateNetfix, candidatePorts, candidateIdentity, patchNetfixPort } from './netfix-rules.mjs';
import { collectNetfixHost, netfixLogs, readNetfixAuth, probeNetfix, NETFIX_TARGETS, hostFingerprint } from './netfix-evidence.mjs';

const labels={diagnose:'诊断', 'fix-port':'同步代理端口',restore:'从备份恢复',lock:'锁定 .env',unlock:'解除只读锁',cancel:'停止处理',recovery:'启动恢复'};
const outcomes={complete:'完成',started:'开始',cancelled:'已停止，未确认应用恢复',rolled_back:'验证未通过，已回滚',rollback_conflict:'恢复未完成，停止覆盖',failed:'未完成，未确认恢复',saved:'配置已保存，当前入口待验证'};
const fail=(message,status=409)=>{const e=new Error(message);e.status=status;e.statusCode=status;return e;};
const copy=value=>structuredClone(value);

export function createNetfixService({directory,stateDirectory,system={},serialize=fn=>fn(),now=()=>Date.now(),legacyRecover}={}) {
  if(typeof directory!=='string'||!directory||typeof stateDirectory!=='string'||!stateDirectory)throw fail('当前运行方式无法提供独立的 Netfix 配置与恢复目录。',503);
  const tx=createNetfixTransaction({directory,stateDirectory,system,now});
  const collect=system.collect||collectNetfixHost,logsRead=system.logs||netfixLogs,authRead=system.auth||readNetfixAuth,probe=system.probe||probeNetfix;
  const auditPath=path.join(path.resolve(stateDirectory),'netfix-audit.json');
  let revision=0,diagnosisId=0,plan=null,context=null,work=null,controller=null,closing=false,recoveryBlocked=false,initializing=true,lastObserved=null,rewriteObserved=false;
  let state={engine:'netfix',stage:'idle',busy:false,diagnosticIndex:0,diagnosisId:null,checkedAt:null,verdict:{level:'neutral',tag:'就绪',title:'尚未进行 Netfix 检查',detail:'诊断只读取证据，不做修改。',fixMode:'none',fixLabel:'开始诊断'},rows:[],evidence:[],probes:[],env:null,backups:[],audit:[],allowedActions:[],verification:'not_verified',waitingRestart:false,progress:[],execution:null,report:''};
  const publicState=()=>copy({...state,revision});
  const update=patch=>{state={...state,...patch};revision++;};
  let auditRecords=[];
  async function auditFingerprint() {
    try {
      const s=await lstat(auditPath,{bigint:true});
      if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size>262144n)throw new Error('audit_file');
      return JSON.stringify({dev:s.dev.toString(),ino:s.ino.toString(),mode:s.mode.toString(),mtime:s.mtimeNs.toString(),sha:createHash('sha256').update(await readFile(auditPath)).digest('hex')});
    }catch(e){if(e.code==='ENOENT')return null;throw e;}
  }
  async function audit(action,result) {
    if(!labels[action]||!outcomes[result])return;
    const next=[...auditRecords,{at:new Date(now()).toISOString(),action,result}].slice(-80);
    await mkdir(stateDirectory,{recursive:true,mode:0o700});
    const dir=await lstat(stateDirectory);
    if(!dir.isDirectory()||dir.isSymbolicLink()||path.resolve(await realpath(stateDirectory)).toLowerCase()!==path.resolve(stateDirectory).toLowerCase())throw new Error('audit_directory');
    const expected=await auditFingerprint();
    const tmp=auditPath+'.tmp-'+randomUUID();
    try {
      const h=await open(tmp,'wx',0o600);try{await h.writeFile(JSON.stringify({version:1,items:next}));await h.sync();}finally{await h.close();}
      await system.hook?.({phase:'beforeAuditReplace',action,result});
      for(let attempt=0;;attempt++) {
        if(await auditFingerprint()!==expected)throw new Error('audit_changed');
        try{await (system.renameAudit||rename)(tmp,auditPath);break;}
        catch(error){
          if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=5)throw error;
          await new Promise(resolve=>setTimeout(resolve,16*2**attempt));
        }
      }
    }catch(error){await system.onError?.({scope:'audit',code:['EPERM','EACCES','EBUSY'].includes(error.code)?error.code:'audit_write_failed'});throw error;}
    finally{await rm(tmp,{force:true}).catch(()=>{});}
    auditRecords=next;update({audit:next.map(x=>({at:x.at,action:labels[x.action],result:outcomes[x.result]}))});
  }
  function conflict(detail='存在尚未完成的恢复记录，停止新的写操作。') {
    recoveryBlocked=true;plan=null;context=null;
    update({stage:'rollback_conflict',busy:false,allowedActions:[],verification:'rollback_conflict',waitingRestart:false,verdict:{level:'error',tag:'恢复未完成',title:'恢复改动尚未完成',detail,fixMode:'copy-report',fixLabel:'复制诊断报告'}});
    update({report:buildReport()});
  }
  const ready=Promise.resolve().then(()=>serialize(async()=>{
    try {
      try {
        const s=await lstat(auditPath);
        if(s.isFile()&&!s.isSymbolicLink()&&s.size<262144&&path.resolve(await realpath(auditPath)).toLowerCase()===path.resolve(auditPath).toLowerCase()){
          const data=JSON.parse(await readFile(auditPath,'utf8'));
          auditRecords=(Array.isArray(data.items)?data.items:[]).filter(x=>labels[x.action]&&outcomes[x.result]&&Number.isFinite(Date.parse(x.at))).slice(-80);
          update({audit:auditRecords.map(x=>({at:x.at,action:labels[x.action],result:outcomes[x.result]}))});
        }
      }catch{/* No history is not diagnostic evidence. */}
      const legacy=await legacyRecover?.();
      if(legacy===false||legacy?.ok===false){conflict('旧修复记录尚未安全恢复。新专项不会继续旧策略或覆盖当前配置。');return;}
      const recovered=await tx.recover();if(!recovered.ok)conflict();
      else if(recovered.pending){update({stage:'rolled_back',verdict:{level:'warn',tag:'启动恢复',title:'已恢复未完成操作的原配置',detail:'已比较写入归属并回读恢复结果；当前 Codex 和原任务未验证。',fixMode:'copy-report',fixLabel:'复制诊断报告'}});await audit('recovery','rolled_back');}
    }catch{conflict();}
  })).catch(()=>conflict()).finally(()=>{initializing=false;});

  const safeProbe=async args=>{
    try {
      const result=await probe(args);
      const code=Number.isInteger(result?.code)?result.code:null;
      // Injectable implementations obey the same public result constraints.
      const ok=result?.ok===true&&code!==null&&code>=200&&code<500;
      return {ok,code,ms:Math.max(0,Math.min(120000,Number(result?.ms)||0)),error:result?.cancelled?'cancelled':ok?null:/tls|certificate|handshake/i.test(String(result?.error||''))?'TLS handshake failed':/timeout|timed/i.test(String(result?.error||''))?'Timeout':code?'HTTP '+code:'connection_failed',cancelled:result?.cancelled===true||args.signal?.aborted===true};
    }catch{return {ok:false,code:null,ms:0,error:args.signal?.aborted?'cancelled':'connection_failed',cancelled:args.signal?.aborted===true};}
  };
  const probePublic=(p,target,port,kind,index)=>({kind,target:new URL(target).host+new URL(target).pathname,channel:port===null?'直连对照':(kind==='current'?'当前 ':'候选 ')+port+(kind==='current'?' · '+(index+1)+'/3':''),result:p.ok?'HTTP '+p.code+' · 链路响应':p.cancelled?'已停止':p.error,ms:p.ms,ok:p.ok,code:p.code});
  function buildReport() {
    return ['Codex 网络修复工具箱 · Netfix','检查时间：'+(state.checkedAt||'尚未检查'),'结论：'+state.verdict.title,state.verdict.detail,...state.rows.map(x=>x.tag+'：'+x.value+'；'+x.note),...state.evidence.map(x=>x.label+'：'+x.value+'；'+x.note),'验证范围：'+state.verification,'当前窗口和原任务未验证。','报告不含代理凭据、认证 token 或聊天正文。'].join('\n');
  }
  async function examine(signal,{retainStage=false}={}) {
    update({diagnosticIndex:0,progress:[{name:'读取文件、监听、进程及日志证据',status:'running',detail:'独立只读采集，不修改设置'}]});
    const options={directory,now:now(),signal};
    const results=await Promise.allSettled([tx.inspect(),collect(options),logsRead(options),authRead(options),tx.listBackups()]);
    if(signal?.aborted)throw fail('检查已停止。');
    const env=results[0].status==='fulfilled'?results[0].value:{exists:false,supported:false,path:path.join(directory,'.env'),port:null,locked:false};
    const host=results[1].status==='fulfilled'?results[1].value:{available:false,process:{available:false},listeners:[]};
    if(lastObserved?.hasProxy&&env.hasProxy&&lastObserved.port!==env.port&&lastObserved.sha256!==env.sha256)rewriteObserved=true;
    if(env.exists&&env.supported)lastObserved={hasProxy:env.hasProxy,port:env.port,sha256:env.sha256};
    host.actualRewrite=host.actualRewrite===true||rewriteObserved;
    const logs=results[2].status==='fulfilled'?results[2].value:{available:false,complete:false};
    const auth=results[3].status==='fulfilled'?results[3].value:{available:false};
    const backups=results[4].status==='fulfilled'?results[4].value:[];
    if(results[4].status==='rejected')env.supported=false;
    update({diagnosticIndex:4,progress:[{name:'读取文件、监听、进程及日志证据',status:'done',detail:'缺失项保留未确认'},{name:'当前链路、候选及直连对照探测',status:'running',detail:'只发送无认证 HTTP 请求，不发送模型消息'}]});
    const unsupportedSystemPath=!env.hasProxy&&(host.systemProxy?.available===false||host.systemProxy?.automatic||host.systemProxy?.enabled&&(host.systemProxy.supported===false||!['127.0.0.1','localhost','::1','[::1]'].includes(host.systemProxy.host)||!Number.isInteger(host.systemProxy.port)));
    const currentPort=env.hasProxy?env.port:host.systemProxy?.enabled&&['127.0.0.1','localhost','::1','[::1]'].includes(host.systemProxy.host)?host.systemProxy.port:null;
    const currentProbes=unsupportedSystemPath?NETFIX_TARGETS.map(()=>({ok:false,code:null,error:'当前系统代理路径不支持，未按直连替代',ms:0})):await Promise.all(NETFIX_TARGETS.map(target=>safeProbe({target,port:currentPort,signal})));
    const probes=currentProbes.map((p,i)=>probePublic(p,NETFIX_TARGETS[i],currentPort,'current',i));
    let candidate=null,candidateProbe=null,candidateOwner=null;
    for(const port of candidatePorts(host)) {
      if(signal?.aborted)throw fail('检查已停止。');
      const owner=candidateIdentity(host,port);if(!owner)continue;
      const p=await safeProbe({target:NETFIX_TARGETS[0],port,signal});probes.push(probePublic(p,NETFIX_TARGETS[0],port,'candidate',0));
      if(p.ok){candidate=port;candidateProbe=p;candidateOwner=owner;break;}
    }
    const direct=await safeProbe({target:NETFIX_TARGETS[0],port:null,signal});probes.push(probePublic(direct,NETFIX_TARGETS[0],null,'direct',0));
    if(signal?.aborted)throw fail('检查已停止。');
    const evaluated=evaluateNetfix({env,host,logs,auth,currentProbes,candidate,candidateProbe,backups});
    const safeEnv={path:env.path,exists:env.exists,supported:env.supported,port:env.port??null,processPort:host.process?.port??null,locked:!!env.locked,sha256:env.sha256||'',proxyKeys:env.proxyKeys||[]};
    const evidence=[
      {label:'.env 配置（文件 · 高）',value:env.supported?(env.hasProxy?'本机 HTTP 代理端口 '+env.port:'无固定代理行'):'未确认或不支持',note:(env.reason||'仅支持无凭据、一致端口的本机 HTTP 代理；保留其他字节。')},
      {label:'端口监听（系统 · 高）',value:env.port?(evaluated.dead?env.port+' CLOSED':env.port+' LISTEN'):'无固定端口',note:'候选顺序：Verge 固定 mixed-port → 已启用的 Windows 系统代理 → 7897 / 7890 / 10808；已验证候选 '+(candidate??'无')},
      {label:'进程环境（进程 · 高）',value:host.process?.available?(host.process.running?'进程代理端口 '+(host.process.port??'无显式值'):'Codex 进程未运行'):'未能确认',note:'仅收集代理端口；不返回进程环境、命令行或密钥。'},
      {label:'日志窗口（日志 · 中）',value:logs.available?'近 24h 鉴权／额度 '+Number(logs.cHits24h||0)+' 条；近 15min 传输 '+Number(logs.bHits15m||0)+' 条':'未读取到有效日志',note:'仅计传输目标白名单；本机记录未归属当前聊天。'+(logs.complete===false?'读取不完整，保留待确认。':'')},
      {label:'token 状态（文件 · 高）',value:auth.available?(auth.present?auth.expired?'已过期':'未过期':'无本机登录态文件'):'未确认',note:'只解析 exp，不刷新、不输出认证内容。'},
      {label:'防复发依据',value:evaluated.recurrence?'历史备份出现至少两种端口或实际外部改写':'未发现符合本规则的复发证据',note:'SusuClash 本身存在或运行不触发 A5。'}
    ];
    context={env,host,logs,auth,currentProbes,candidate,candidateProbe,candidateOwner,backups,evaluated,generation:++diagnosisId,createdAt:now()};
    update({diagnosisId,checkedAt:new Date(now()).toISOString(),...(!retainStage?{stage:'result'}:{}),verdict:evaluated.verdict,rows:evaluated.rows,evidence,probes,env:safeEnv,backups:backups.map(({name,port,at,restorable})=>({name,port,at,restorable})),allowedActions:recoveryBlocked?[]:evaluated.allowedActions,waitingRestart:evaluated.mismatch,verification:'http_route_only'});
    update({report:buildReport(),progress:[{name:'只读证据采集',status:'done',detail:evaluated.unknown?'部分证据未确认':'采集完成'},{name:'HTTP 链路探测',status:'done',detail:'仅验证独立链路，不代表原聊天恢复'}]});
    return context;
  }
  function start(task,{stage,repair=false}={}) {
    if(state.busy||closing)throw fail('已有任务正在进行，请等待安全结束。');
    controller=new AbortController();const signal=controller.signal;
    update({busy:true,stage,allowedActions:[],progress:[],execution:null,errorCode:null,...(stage==='diagnosing'?{rows:[],evidence:[],probes:[],env:null,backups:[],checkedAt:null,diagnosisId:null,waitingRestart:false,verification:'not_verified',report:'',verdict:{level:'neutral',tag:'诊断中',title:'正在读取本轮 Netfix 证据',detail:'只读采集与 HTTP 链路探测，不修改设置。',fixMode:'none',fixLabel:'诊断中…'}}:{})});
    work=Promise.resolve().then(()=>repair?serialize(()=>task(signal)):task(signal)).catch(async error=>{
      if(recoveryBlocked){conflict();return;}
      update({stage:signal.aborted?'cancelled':'result',allowedActions:[],errorCode:['EPERM','EACCES','EBUSY'].includes(error.code)?error.code:'operation_failed',verdict:{level:'warn',tag:signal.aborted?'本轮已停止':'未完成',title:signal.aborted?'检查已停止':'本轮检查或处理未完成',detail:'未确认 Codex 应用恢复；请重新诊断。',fixMode:'copy-report',fixLabel:'复制诊断报告'}});
      update({report:buildReport()});
    }).finally(()=>{update({busy:false});work=null;controller=null;});
  }
  async function get(){await ready;return publicState();}
  async function diagnose() {
    await ready;
    if(state.busy||closing)throw fail('已有任务正在进行，请等待安全结束。');
    plan=null;context=null;
    start(async signal=>{await audit('diagnose','started');await examine(signal);if(recoveryBlocked)conflict();await audit('diagnose','complete');},{stage:'diagnosing'});
    return publicState();
  }
  async function preview({action,backupName}={}) {
    await ready;
    if(state.busy||closing||recoveryBlocked||!context||now()-context.createdAt>60000||state.stage==='stale'||!state.allowedActions.includes(action))throw fail('当前没有可执行的已确认方案，请重新诊断。');
    const before=await tx.inspect();if(before.fingerprint!==context.env.fingerprint)throw fail('配置或属性已变化，请重新诊断。');
    const selected=action==='restore'?context.backups.find(x=>x.name===backupName&&x.restorable):null;
    if(action==='restore'&&!selected)throw fail('备份未受本工具记录或已变化，拒绝恢复。');
    if(selected)await tx.readBackup(selected.name,selected.sha256);
    const token=randomBytes(32).toString('base64url'),expires=now()+60000;
    const fileAction=['fix-port','restore'].includes(action);
    const backupNamePlanned=fileAction?netfixBackupName(now()):null;
    const change=action==='fix-port'?'HTTP(S)_PROXY 本机端口 '+before.port+' → '+context.candidate:action==='restore'?'从 '+selected.name+' 恢复 .env；先备份当前配置':action==='lock'?'writable → readonly；其他工具将无法写入':'readonly → writable；其他工具可再次写入';
    const disclosure={token,action,title:action==='fix-port'?'确认修复：同步代理端口':action==='restore'?'确认从备份恢复':action==='lock'?'确认：锁定 .env 为只读':'确认解除只读锁',sub:'以下为将要发生的全部改动',confirmLabel:action==='fix-port'?'确认执行修复':action==='restore'?'确认恢复':action==='lock'?'确认锁定':'确认解锁',rows:[['目标文件',before.path],['变更内容',change],[fileAction?'自动备份':'属性恢复点',fileAction?backupNamePlanned+'；执行时排他创建并验证':'记录操作前只读属性，不创建文件内容备份'],['并发改动检测','60 秒内有效；文件内容、只读属性、权限及候选归属变化即中止'],['回滚方式',fileAction?'失败时比较写入归属后恢复；成功后可选择本次备份恢复':'恢复原只读属性；锁定／解除只读锁可撤回'],['生效条件',fileAction?'文件保存后仍需正常重开并在原环境验证；工具不代劳重启':'立即改变文件属性，无需重启']],expiresAt:new Date(expires).toISOString()};
    plan={token,expires,action,before,generation:context.generation,candidate:context.candidate,candidateOwner:context.candidateOwner,hostKey:hostFingerprint(context.host,context.candidate),selected,backupName:backupNamePlanned,disclosure};
    return copy(disclosure);
  }
  async function apply({token,confirmed}={}) {
    await ready;
    if(confirmed!==true)throw fail('必须明确确认本次操作。',400);
    if(state.busy||closing||recoveryBlocked)throw fail('已有任务或恢复步骤正在进行。');
    const saved=plan;plan=null;
    if(!saved||typeof token!=='string'||token!==saved.token||now()>=saved.expires||context?.generation!==saved.generation)throw fail('修复预览已失效，请重新诊断。');
    const baseline=context;
    start(async signal=>{
      let record=null;
      const progress=[];
      const step=async(name,status,detail='')=>{const item=progress.find(x=>x.name===name);if(item)Object.assign(item,{status,detail});else progress.push({name,status,detail});update({progress:copy(progress),execution:{action:saved.action,steps:copy(progress)}});};
      try {
        if(now()>=saved.expires)throw new Error('plan_expired');
        const before=await tx.inspect();if(before.fingerprint!==saved.before.fingerprint)throw new Error('file_changed');
        const host=await collect({directory,now:now(),signal});
        if(!host.available||hostFingerprint(host,saved.candidate)!==saved.hostKey)throw new Error('candidate_changed');
        if(saved.action==='fix-port'){
          if((host.listeners||[]).some(x=>Number(x.port)===before.port)||candidateIdentity(host,saved.candidate)!==saved.candidateOwner)throw new Error('candidate_changed');
          const check=await safeProbe({port:saved.candidate,target:NETFIX_TARGETS[0],signal});if(!check.ok)throw new Error('candidate_protocol');
        }
        const bytes=saved.action==='fix-port'?patchNetfixPort(before.bytes,saved.candidate):saved.action==='restore'?await tx.readBackup(saved.selected.name,saved.selected.sha256):undefined;
        record=await tx.change({before,bytes,action:saved.action,locked:saved.action==='lock',backupName:saved.backupName??undefined,signal,onStep:step,isAuthorized:()=>now()<saved.expires&&!signal.aborted,validate:async()=>{
          if(now()>=saved.expires||signal.aborted)throw new Error('plan_expired');
          const finalHost=await collect({directory,now:now(),signal});
          if(!finalHost.available||hostFingerprint(finalHost,saved.candidate)!==saved.hostKey)throw new Error('candidate_changed');
          if(saved.action==='fix-port'&&(candidateIdentity(finalHost,saved.candidate)!==saved.candidateOwner||(finalHost.listeners||[]).some(x=>Number(x.port)===before.port)))throw new Error('candidate_changed');
          if(saved.selected)await tx.readBackup(saved.selected.name,saved.selected.sha256);
          if(now()>=saved.expires||signal.aborted)throw new Error('plan_expired');
        }});
        if(signal.aborted)throw new Error('cancelled');
        let freshProbes=baseline.currentProbes,latestHost=host;
        if(saved.action==='fix-port') {
          await step('链路验证','running','使用写后端口完成独立 HTTP 请求；不发送模型消息');
          freshProbes=await Promise.all(NETFIX_TARGETS.map(target=>safeProbe({port:saved.candidate,target,signal})));
          const hostAfter=await collect({directory,now:now(),signal});
          if(freshProbes.some(x=>!x.ok)||signal.aborted||!hostAfter.available||candidateIdentity(hostAfter,saved.candidate)!==saved.candidateOwner)throw new Error('link_verification');
          latestHost=hostAfter;
          await step('链路验证','done','当前端口 3 次 HTTP 响应；仅证明链路响应');
        }else if(saved.action==='restore')await step('生效范围说明','done','仅完成备份恢复与文件回读；未验证链路、当前 Codex 或原任务');
        if(signal.aborted)throw new Error('cancelled');
        await audit(saved.action,saved.action==='fix-port'?'saved':'complete');
        if(signal.aborted)throw new Error('cancelled');
        const current=await tx.inspect();
        const backups=await tx.listBackups();
        context={...baseline,env:current,host:latestHost,currentProbes:freshProbes,backups,createdAt:now()};
        const pending=current.hasProxy&&latestHost.process?.running&&current.port!==latestHost.process.port;
        const evaluated=evaluateNetfix(context);context.evaluated=evaluated;
        if(signal.aborted)throw new Error('cancelled');
        await tx.commit(record);record=null;
        lastObserved={hasProxy:current.hasProxy,port:current.port,sha256:current.sha256};
        const verification=saved.action==='fix-port'?'http_route_only':saved.action==='restore'?'file_restored':state.verification;
        const evidence=copy(state.evidence);
        if(evidence[0])evidence[0].value=current.hasProxy?'本机 HTTP 代理端口 '+current.port:'无固定代理行';
        if(evidence[1])evidence[1].value=current.port?current.port+((latestHost.listeners||[]).some(x=>Number(x.port)===current.port)?' LISTEN':' CLOSED'):'无固定端口';
        const probes=saved.action==='fix-port'?[...freshProbes.map((p,i)=>probePublic(p,NETFIX_TARGETS[i],saved.candidate,'current',i)),...state.probes.filter(x=>x.kind!=='current')]:state.probes;
        update({stage:pending?'awaiting_restart':'result',verdict:evaluated.verdict,rows:evaluated.rows,allowedActions:evaluated.allowedActions,evidence,probes,env:{...state.env,port:current.port,processPort:latestHost.process?.port??null,locked:current.locked,sha256:current.sha256},backups:backups.map(({name,port,at,restorable})=>({name,port,at,restorable})),waitingRestart:pending,verification});
        if(saved.action==='fix-port')update({verdict:{level:'warn',tag:pending?'A2 配置漂移 · 待重启':'仅完成链路验证',title:'代理端口已保存并通过链路探测',detail:'L1 文件回读、L2 HTTP 链路通过。当前窗口和原任务尚未验证；工具不代劳重启。',fixMode:pending?'advice':'copy-report',fixLabel:pending?'查看处理指引':'复制诊断报告',...(pending?{advice:evaluated.verdict.advice}: {})}});
        await step('落审计日志','done','仅记录动作、结果及验证范围');
        update({report:buildReport()});
      }catch(error) {
        const rollback=record?await tx.rollback(record):error.rollback;
        if(rollback?.ok===false){conflict();await step('恢复原配置','failed','检测到外部变更或恢复未通过回读，停止覆盖');await audit(saved.action,'rollback_conflict').catch(()=>{});}
        else {
          const changed=!!record||!!error.record;
          update({stage:signal.aborted?'cancelled':changed?'rolled_back':'result',allowedActions:[],verification:'not_verified',waitingRestart:false,verdict:{level:'warn',tag:signal.aborted?'本轮已停止':changed?'已回滚':'方案已失效',title:changed?'本轮处理未通过，已恢复原配置':'检测条件已变化或处理未开始',detail:'未确认当前 Codex 或原任务恢复。请重新诊断；不会覆盖无法确认归属的改动。',fixMode:'copy-report',fixLabel:'复制诊断报告'}});
          if(changed)await step('恢复原配置','done','已比较本次写入归属并回读确认');
          await audit(saved.action,signal.aborted?'cancelled':changed?'rolled_back':'failed').catch(()=>{});
        }
        plan=null;context=null;update({report:buildReport()});
      }
    },{stage:'executing',repair:true});
    return publicState();
  }
  async function cancel(){await ready;plan=null;controller?.abort();if(work)await work;return publicState();}
  function invalidate(reason='连接条件已变化') {
    plan=null;context=null;
    if(state.busy)controller?.abort();
    else if(!recoveryBlocked)update({stage:'stale',allowedActions:[],verification:'not_verified',verdict:{level:'warn',tag:'上次结果已失效',title:'连接条件已变化，请重新诊断',detail:'旧结果不代表当前网络或应用状态。',fixMode:'copy-report',fixLabel:'复制诊断报告'}});
  }
  async function close(){closing=true;await ready;plan=null;controller?.abort();if(work)await work;}
  return {get,diagnose,preview,apply,cancel,invalidate,isRepairing:()=>initializing||state.busy&&state.stage==='executing',close};
}
