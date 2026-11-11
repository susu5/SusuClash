import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, rm } from 'node:fs/promises';
import path from 'node:path';

const clean = r => r?.status === 'probe_passed' && !r.reason && r.retries === 0 && !r.connectionFailures && !r.otherTransportErrors && r.fallback !== true && r.fresh === true;
const terminal = new Set(['app_verified','probe_passed','awaiting_activation','needs_action','unsupported','cancelled','rollback_conflict','waiting_user','waiting_service']);
const messages = {
 auth:'Codex 需要本人完成登录。已停止修改设置，登录完成后可重新运行自动修复。',
 quota:'账号额度或请求频率受限。已停止换线和重复发送测试消息。',
 service:'Codex 服务暂时没有正常响应。本轮未继续修改连接设置。',
 tls:'连接的证书验证未通过。本轮保留证书保护，没有继续更改连接方式。',
 deadline:'本轮处理时间已到，已停止尝试并恢复未验证的改动。',
 cancelled:'本轮已停止，未验证的改动已恢复。',
 conflict:'检测到其他程序改变了设置，已停止覆盖这些设置。',
 failed:'本轮尚未找到通过验证的修复方式，未验证的改动已恢复。'
};

/** One bounded, serialized repair. No original task is replayed. Adapters own
 * credential handling and process capabilities; this ledger contains no config
 * content, prompts, access tokens, or raw log bodies. */
export function createCodexAutoRepair({core, profiles, configuration, inspect, system, health, adapter,
 directory=core?.directory, now=()=>Date.now(), budgetMs=180000, requestBudget=5}={}) {
 const file=directory?path.join(directory,'codex-auto-repair.json'):null;
 let current=null, busy=false;
 const snapshot=()=>current?structuredClone(current):null;
 async function save() {
  if(!file)return;
  await mkdir(directory,{recursive:true});
  if((await lstat(directory)).isSymbolicLink())throw new Error('journal_directory');
  const tmp=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(tmp,JSON.stringify(current),{mode:0o600,flag:'wx',flush:true});await rename(tmp,file);}
  finally{await rm(tmp,{force:true}).catch(()=>{});}
 }
 async function readPrevious() {
  if(!file)return null;
  try {const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>262144)throw new Error('journal_invalid');return JSON.parse(await readFile(file,'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
 }
 async function restoreRoute(record) {
  if(!record)return true;
  if(typeof record.group!=='string'||typeof record.before!=='string'||typeof record.after!=='string')return false;
  const cfg=await configuration();
  if(cfg.profile!==record.profile)return false;
  const route='/proxies/'+encodeURIComponent(record.group), state=await core.call('GET',route);
  if(state.now===record.before)return true;
  if(state.now!==record.after)return false;
  await core.call('PUT',route,{name:record.before});
  return (await core.call('GET',route)).now===record.before;
 }
 async function reconcile() {
  const old=await readPrevious();
  const recovered=await adapter.recover?.();
  if(recovered?.ok===false||recovered?.status==='conflict')return false;
  if(old?.schema===1&&old.route&&!old.route.committed){
   if(!await restoreRoute(old.route))return false;
  }else if(old&&old.schema!==1)return false;
  return true;
 }
 async function run({client='desktop',symptom='reconnect',pathMode='system',signal,onUpdate=()=>{}}={}) {
  if(busy)return snapshot();busy=true;current=null;
  let tx=null,route=null,committed=false,rollbackFailed=false,timer;
  const controller=new AbortController();
  const cancel=()=>controller.abort('cancelled');
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const deadline=now()+budgetMs;
  timer=setTimeout(()=>controller.abort('deadline'),budgetMs);
  const check=()=>{if(controller.signal.aborted||now()>=deadline)throw new Error(controller.signal.reason==='cancelled'?'cancelled':'deadline');};
  async function update(stage,detail,extra={}) {
   current={...current,stage,detail,...extra,updatedAt:new Date(now()).toISOString()};
   await save();onUpdate(snapshot());
  }
  async function event(id,title,status='running') {
   const old=current.actions.find(a=>a.id===id);
   if(old){old.status=status;old.title=title;}else current.actions.push({id,title,status});
   await update(current.stage,current.detail);
  }
  async function rollback() {
   let ok=true;
   if(tx){try{const r=await tx.rollback();ok=r!==false&&r?.ok!==false;}catch{ok=false;}tx=null;}
   if(route){try{ok=(await restoreRoute(route))&&ok;}catch{ok=false;}if(ok){route=null;current.route=null;}}
   if(!ok)rollbackFailed=true;
   current.verification='route_ok';
   return ok&&!rollbackFailed;
  }
  async function probe(target,strategy,persisted=false) {
   check();if(current.requests>=requestBudget)throw new Error('budget');
   current.requests++;await update(persisted?'verifying':current.requests===1?'checking':'repairing',persisted?'正在用已保存的设置，再建立一个全新连接验证':'正在试发诊断消息，检查能否完整回复');
   const r=await adapter.probe(target,{strategy,port:current.port,signal:controller.signal,deadline,persisted});
   check();
   current.tests.push({attempt:current.requests,status:r.status,reason:r.reason||null,retries:Number(r.retries)||0,connectionFailures:Number(r.connectionFailures)||0,otherTransportErrors:Number(r.otherTransportErrors)||0,fallback:r.fallback===true,fresh:r.fresh===true});
   await save();
   return r;
  }
  try {
   const recovered=await reconcile();
   current={schema:1,id:randomUUID(),client,symptom,pathMode,stage:'checking',detail:'正在识别 Codex 入口和本次连接问题',startedAt:new Date(now()).toISOString(),updatedAt:new Date(now()).toISOString(),actions:[],tests:[],requests:0,requestLimit:requestBudget,verification:'none',route:null,sessionConfirmed:false};
   if(!recovered){current.stage='rollback_conflict';current.detail='上次未完成的变更与当前设置不一致，已停止自动覆盖。';onUpdate(snapshot());return snapshot();}
   await update('checking',current.detail);check();
   if(symptom==='tool'||!['desktop','cli'].includes(client)||pathMode!=='system'){await update('unsupported','当前自动修复覆盖使用受控系统代理的本机 Codex 连接；所选入口或工具问题尚无可验证的修复适配器。');return snapshot();}
   const found=await adapter.discover({client,signal:controller.signal});check();
   current.target=found.public;
   if(!found.supported){await update('unsupported',found.reason||'尚不能准确识别当前 Codex 入口，本轮没有修改配置。');return snapshot();}
   const target=found.target;
   const evidence=await system.codexEvidence?.(controller.signal);
   current.diagnosis={fiveRetriesThenHttp:evidence?.transport?.fiveRetriesThenHttp===true,correlation:evidence?.transport?.correlation||'none',counts:evidence?.counts||{},watermark:evidence?.watermark||null};
   await event('identify','已识别本机 Codex 入口并重新读取运行记录','passed');
   let env=await inspect(controller.signal);check();
   // Restore only the owned core. A listener belonging to another program is
   // never stopped, and a missing active profile is not invented.
   if(env.checks.find(c=>c.id==='core')?.status!=='passed'){
    const active=(await profiles?.list())?.activeId, owners=await system.listeners([env.port]);
    if(!active||owners?.some(o=>o.port===env.port&&Number(o.pid)!==core.processId?.())){await update('needs_action','代理入口被占用或没有可用订阅，本轮保留其他程序和现有配置。');return snapshot();}
    check();await event('core','正在恢复本软件的代理内核');
    current.coreAttempted=true;await save();
    if(core.status?.().state==='running')await core.stop();
    await core.start();env=await inspect(controller.signal);check();
    await event('core',env.checks.find(c=>c.id==='core')?.status==='passed'?'代理内核已恢复':'代理内核尚未恢复',env.checks.find(c=>c.id==='core')?.status==='passed'?'passed':'failed');
   }
   if(env.checks.find(c=>c.id==='port')?.status!=='passed'){await update('needs_action','尚未确认本软件的代理入口，已停止后续配置修改。');return snapshot();}
   current.port=env.port;current.verification='route_ok';
   const initial=await configuration();let expected=JSON.stringify(initial);
   const contextCheck=async()=>{check();if(JSON.stringify(await configuration())!==expected)throw new Error('conflict');};
   const blocked=async r=>{
    if(['auth','quota','service','tls'].includes(r.reason)){await update(r.reason==='service'?'waiting_service':'waiting_user',messages[r.reason]);return true;}
    if(r.status==='unsupported'||['proxy_context','proxy_override','context_changed'].includes(r.reason)){await update('unsupported',r.detail||'当前连接环境尚不能被准确复现，已停止配置修改和换线。');return true;}
    if(['model','configuration','tool'].includes(r.reason)){await update('unsupported',({model:'独立诊断环境无法使用当前模型，尚不能验证原客户端。已停止修改连接设置。',configuration:'诊断环境的配置尚未被当前版本接受，已停止修改连接设置。',tool:'诊断请求出现了工具活动，已停止测试，没有继续换线或修改连接设置。'})[r.reason]);return true;}
    if(r.reason==='transport_unknown'){await update('needs_action','本轮测试出现了尚未识别原因的连接错误，已保留检测结果，暂不自动改设置。');return true;}
    if(r.status!=='probe_passed'&&!['transport','timeout'].includes(r.reason)&&!r.retries&&!r.fallback){await update('needs_action','诊断没有完整完成，尚无足够依据将其判为连接故障。本轮不继续修改设置。');return true;}
    return false;
   };
   // A candidate must improve a reproduced failure. Do not enable a setting
   // merely because a new connection was already healthy before changing it.
   const baseline=await probe(target,{id:'current'});await contextCheck();
   if(await blocked(baseline))return snapshot();
   if(clean(baseline)){
    const repeated=await probe(target,{id:'current'},true);await contextCheck();
    if(await blocked(repeated))return snapshot();
    if(clean(repeated)){await update('probe_passed','两次新连接均正常，本轮未复现原来的重连问题，因此没有更改设置。当前桌面窗口和原聊天仍未验证。',{verification:'probe_passed',changed:false});return snapshot();}
    await update('needs_action','新连接出现间歇性异常，本轮没有提交配置更改。');return snapshot();
   }
   const strategies=(found.strategies||[]).slice(0,3);
   const choices=strategies.map(strategy=>({strategy}));
   // Candidate routes must already be explicitly allowed in SusuClash settings.
   // Changing them is serialized with all UI/background writers. Preflight is
   // isolated; failed model attempts are compensated before trying another.
   const allowed=initial.automation;
   if(allowed?.group&&Array.isArray(allowed.backups))for(const node of [...new Set(allowed.backups)].slice(0,3))choices.push({strategy:{id:'current',label:'保留当前连接方式'},node,group:allowed.group});
   if(!choices.length){await update('unsupported','当前 Codex 版本没有可安全应用的连接修复方式，本轮保留原配置。');return snapshot();}
   let candidates=0;
   for(const choice of choices){
    // Reserve a second independent request for persisted-config verification.
    if(current.requests+2>requestBudget||candidates>=3)break;
    await contextCheck();
    if(choice.node){
     if(await health?.verify(choice.node,controller.signal)!=='ok')continue;
     await contextCheck();
     const url='/proxies/'+encodeURIComponent(choice.group),g=await core.call('GET',url);
     if(g.now===choice.node||!g.all?.includes(choice.node))continue;
     route={group:choice.group,before:g.now,after:choice.node,profile:initial.profile,committed:false};current.route=route;
     await update('repairing','正在测试已允许的备用线路');
     await core.call('PUT',url,{name:choice.node});
     if((await core.call('GET',url)).now!==choice.node)throw new Error('conflict');
     expected=JSON.stringify(await configuration());
    }
    candidates++;
    const actionId='candidate-'+current.requests;
    await event(actionId,choice.node?'正在验证备用线路':'正在验证可用的连接设置');
    const first=await probe(target,choice.strategy);
    await contextCheck();
    if(!clean(first)){
     if(!await rollback())throw new Error('conflict');expected=JSON.stringify(await configuration());
     await event(actionId,'此方案未通过，未保留无效改动','failed');
     if(await blocked(first))return snapshot();
     continue;
    }
    await event(actionId,choice.node?'备用线路的诊断请求已通过':'候选连接设置的诊断请求已通过','passed');
    current.verification='probe_passed';
    if(choice.strategy.id!=='current'){
     tx=await adapter.prepare(target,{strategy:choice.strategy,port:current.port,runId:current.id});
     if(!tx)throw new Error('unsupported');
     current.transaction=tx.record;await update('repairing','已找到有效设置，正在备份并保存最小改动');
     await contextCheck();await tx.apply();check();
     const readback=await tx.readback?.();if(readback===false||readback?.ok===false)throw new Error('readback');
    }
    const second=await probe(target,choice.strategy,true);
    await contextCheck();
    if(!clean(second)){if(!await rollback())throw new Error('conflict');expected=JSON.stringify(await configuration());if(await blocked(second))return snapshot();continue;}
    const changedConfig=Boolean(tx);
    const activation=changedConfig?await adapter.activate(target,{signal:controller.signal}):{status:'applied'};check();await contextCheck();
    // Two exact-runtime probes establish the candidate, not an unrelated live
    // desktop's reload or the failed conversation's completion.
    if(tx)await tx.commit();
    if(route){route.committed=true;current.route=route;}
    committed=true;tx=null;
    await event('verify','两个全新连接均收到完整回复，未发生重试','passed');
    const appVerified=activation?.status==='verified'&&activation?.verification==='app_verified';
    const stage=appVerified?'app_verified':changedConfig&&client==='desktop'?'awaiting_activation':'probe_passed';
    await update(stage,appVerified?'当前 Codex 入口已通过自动验证。':!changedConfig?'已切换到通过验证的备用线路，两次测试均完整回复。当前 Codex 窗口与原任务仍未验证。':client==='desktop'?'修复设置已保存，两次连接测试通过；当前桌面窗口是否采用新设置尚未确认。为保护正在进行的任务，没有强制关闭窗口。':'修复设置已保存，两次独立命令行请求均已通过。已有会话的运行结果单独记录。',{verification:appVerified?'app_verified':'probe_passed',changed:true,activation:activation?.status||'unsupported'});
    return snapshot();
   }
   await update('needs_action',messages.failed);return snapshot();
  }catch(e){
   if(!current){current={schema:1,stage:'rollback_conflict',detail:'无法核对上次恢复记录，已停止修改并保留原记录。',actions:[],tests:[],verification:'none',sessionConfirmed:false};onUpdate(snapshot());return snapshot();}
   const restored=committed?true:await rollback();
   const reason=e.message;
   try{await update(restored?(reason==='cancelled'?'cancelled':'needs_action'):'rollback_conflict',restored?(messages[reason]||messages.failed):'自动恢复没有全部完成，已保留恢复记录并停止继续修改。');}catch{if(current){current.stage='rollback_conflict';current.detail='修复记录无法保存，已停止处理；不能确认全部改动已恢复。';onUpdate(snapshot());}}
   return snapshot();
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);busy=false;}
 }
 return {run,get:snapshot,isRunning:()=>busy,isTerminal:stage=>terminal.has(stage)};
}
