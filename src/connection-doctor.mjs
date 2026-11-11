import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { listeners, codexProxy } from './diagnostics.mjs';
import { codexEvidence } from './codex-evidence.mjs';
import { createCodexAutoRepair } from './codex-auto-repair.mjs';
import { createCodexTargetAdapter } from './codex-target.mjs';
import { AppError, routingGroups } from './mihomo.mjs';

const execute = promisify(execFile);
const targets = ['https://www.gstatic.com/generate_204','https://www.cloudflare.com/cdn-cgi/trace'];
export const checkNames = {network:'本机网络',core:'代理内核',port:'本机端口',system:'系统代理',config:'订阅与配置',routing:'模式与选路',line:'线路与目标连通',dns:'DNS 与证书'};
const appNames={path:'Codex 的代理设置',appPort:'Codex 配置中的代理端口',recent:'最近的连接问题',target:'ChatGPT 网页连接',request:'发送消息测试',session:'出问题的聊天',restart:'重新打开 Codex',automatic:'自动处理结果'};
const item = (id,status,detail) => ({id,name:checkNames[id] || appNames[id] || id,status,detail});
const settled = fn => Promise.resolve().then(fn).catch(() => null);
export async function probe(url,port,signal) {
  const executable=path.join(process.env.SystemRoot || 'C:\\Windows','System32','curl.exe');
  const args=['-q','--silent','--output','NUL','--write-out','%{http_code}','--connect-timeout','3','--max-time','7','--noproxy',port?'':'*'];
  if(port)args.push('--proxy','http://127.0.0.1:'+port);
  args.push('--',url);
  try {const r=await execute(executable,args,{windowsHide:true,timeout:8500,signal,maxBuffer:8192});return {code:Number(r.stdout),exit:0};}
  catch(e){return {code:Number(e.stdout)||0,exit:typeof e.code==='number'?e.code:null};}
}
const reachable = r => r && [200,204].includes(r.code) && r.exit===0;
async function unusedPort() {return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}

/** A single live task, with independent base/application evidence. No synthetic successes. */
export function createConnectionDoctor({core,proxy,profiles,codexRepair,health,configuration,serialize,requestProbe,restartClient,codexTargetAdapter,autoRepairOptions={},directory=core.directory,system={probe,listeners,codexProxy,codexEvidence,interfaces:()=>os.networkInterfaces(),lookup:host=>dns.lookup(host)}}) {
  let epoch=0, task=null, base=null, codex=null, history=[], plan=null,pathMode='system';
  let autoWork=null;
  const automatic=createCodexAutoRepair({core,profiles,configuration,inspect,system,health,directory,adapter:codexTargetAdapter||createCodexTargetAdapter(),...autoRepairOptions});
  const historyFile=directory?path.join(directory,'connection-checks.json'):null;
  let persistence=Promise.resolve();
  const ready=historyFile?readFile(historyFile,'utf8').then(s=>{const v=JSON.parse(s);if(Array.isArray(v))history=v.slice(0,40);}).catch(()=>{}):Promise.resolve();
  function record(scope,result) {
    history.unshift({id:randomUUID(),at:new Date().toISOString(),scope,status:result.status,checks:result.checks.map(({id,name,status,detail})=>({id,name,status,detail})),actions:result.actions||[]});history=history.slice(0,40);
    if(historyFile){const saved=JSON.stringify(history);persistence=persistence.then(async()=>{await mkdir(directory,{recursive:true});const tmp=historyFile+'.tmp';await writeFile(tmp,saved,{mode:0o600});await rename(tmp,historyFile);}).catch(()=>{});}
  }
  const snapshot=()=>({task:task?{id:task.id,scope:task.scope,phase:task.phase,step:task.step,error:task.error,handoffReady:task.handoffReady===true}:null,base,codex,plan,history});
  function invalidate(reason='连接设置已变化，请重新检查。') {if(autoWork){task?.controller?.abort();return;}epoch++;task?.controller?.abort();if(task)task.phase='cancelled';plan=null;if(base)base={...base,status:'stale',reason,checks:base.checks.map(c=>({...c,status:'stale'}))};if(codex)codex={...codex,status:'stale',sessionConfirmed:false,reason,checks:codex.checks.map(c=>({...c,status:'stale'}))};}
  async function fingerprint(){return JSON.stringify(await configuration());}
  async function inspect(signal) {
    const [config,profileState,proxyState,prefs]=await Promise.all([settled(()=>core.call('GET','/configs')),settled(()=>profiles?.list()),settled(()=>proxy?.getStatus()),settled(()=>core.preferences())]);
    const port=config?.['mixed-port']||prefs?.expectedPort;
    const [owners,direct,via,lookup,groups]=await Promise.all([settled(()=>system.listeners([port])),Promise.all(targets.map(url=>system.probe(url,null,signal))),port?Promise.all(targets.map(url=>system.probe(url,port,signal))):Promise.resolve([]),settled(()=>system.lookup('www.cloudflare.com')),config?settled(()=>core.call('GET','/proxies')):null]);
    const interfaces=Object.values(system.interfaces()).flat().filter(x=>!x.internal && !x.address.startsWith('169.254.') && !x.address.startsWith('fe80:'));
    const own=owners?.filter(x=>x.port===port),pid=core.processId?.();
    const viaOK=via.some(reachable),directOK=direct.some(reachable);
    const routing=config? routingGroups(groups||{},config.mode):[];
    const checks=[
      item('network',directOK||viaOK?'passed':interfaces.length?'unknown':'failed',directOK?'外部固定测试目标有响应。':viaOK?'通过代理收到外部目标响应。':interfaces.length?'网卡有地址，但外部目标未确认；请核对认证页面、Wi-Fi 或上游网络。':'没有发现可用网卡地址，请先连接 Wi-Fi 或网线。'),
      item('core',config?'passed':core.status?.().state==='running'?'failed':'failed',config?'本软件控制接口有响应。':'受控内核未运行或控制接口无响应。'),
      item('port',own==null?'unknown':own.some(x=>Number(x.pid)===pid)?'passed':own.length?'failed':'failed',own==null?'无法读取监听归属。':own.some(x=>Number(x.pid)===pid)?'当前监听属于本软件的受控内核。':own.length?'当前预设入口由其他进程监听，保留占用程序。':'当前入口没有监听。'),
      item('system',pathMode!=='system'&&proxyState?.enabled===false?'passed':proxyState?.managed && proxyState.enabled && (!proxyState.port||proxyState.port===port)?'passed':proxyState?.managed && proxyState.port!==port?'failed':proxyState?.enabled?'unknown':proxyState?.enabled===false?'needs_user':'unknown',pathMode!=='system'&&proxyState?.enabled===false?'本次按用户选择的固定代理或直连方式检查，无需开启系统代理。应用实际路径仍需专项核对。':proxyState?.managed && proxyState.port && proxyState.port!==port?'本软件系统代理仍指向旧端口，需要协调迁移并重新验证。':proxyState?.managed && proxyState.enabled?'系统代理由本软件管理，已启用。':proxyState?.enabled?'当前代理不归本软件管理，需核对实际路径。':proxyState?.enabled===false?'系统代理未开启；固定代理或直连可能不需要它，可在综合检查的范围中选择实际方式。':'无法读取 Windows 系统代理。'),
      item('config',config && profileState?.activeId?'passed':profileState?.activeId?'unknown':'needs_user',config && profileState?.activeId?'已启用配置，内核已接受运行配置。':profileState?.activeId?'已选择配置，但当前内核尚未确认加载。':'请在订阅管理启用有效配置。'),
      item('routing',config?.mode==='direct'&&pathMode==='direct'?'passed':config && ['rule','global'].includes(config.mode) && routing.length?'passed':config?.mode==='direct'?'needs_user':'unknown',config?.mode==='direct'&&pathMode==='direct'?'当前直连模式与本次选择一致。':config?.mode==='direct'?'当前为直连模式，请确认是否符合本次目标。':routing.length?'当前模式和可选择策略组已读回。':'无法确认有效选路，请核对模式和策略组。'),
      item('line',viaOK?'passed':via.length?'failed':'unknown',viaOK?'通过当前混合端口收到固定目标的预期响应。':'当前代理路径未收到预期响应；不据此判断所有线路失效。'),
      item('dns',(direct.concat(via)).some(r=>[35,51,58,60,77].includes(r.exit))?'failed':lookup && (viaOK||directOK)?'passed':'unknown',(direct.concat(via)).some(r=>[35,51,58,60,77].includes(r.exit))?'检测到 TLS/证书错误，请核对系统时间、证书链和网络拦截。':lookup && (viaOK||directOK)?'本机 DNS 解析与本次 HTTPS 证书验证通过。':'DNS 或 TLS 尚无充分结果；不会关闭证书校验。')
    ];
    return {checks,status:checks.every(c=>c.status==='passed')?'passed':checks.some(c=>c.status==='failed'||c.status==='needs_user')?'needs_action':'unknown',pathMode,checkedAt:new Date().toISOString(),port,groups:routing.map(g=>({name:g.name,current:g.current,members:g.members.map(m=>m.name)}))};
  }
  async function inspectCodex(environment,client,symptom,signal){
    const local=!['wsl','remote'].includes(client);
    const [setting,recent]=await Promise.all([local?settled(()=>system.codexProxy()):null,local?settled(()=>system.codexEvidence?.(signal)):null]);
    if(signal.aborted)return null;
    const checks=[item('path','unknown',!local?'这次使用 WSL 或远端。本机检查读不到那里的代理设置。':setting?.kind==='local'?`配置文件写着使用本机端口 ${setting.port}。这只说明文件内容，当前打开的 Codex 是否采用它还不能确认。`:'还不能确认当前 Codex 使用哪份代理设置。')];
    let canRepairPort=false,routePort=null,routeKnown=false;
    if(local&&setting?.kind==='local'){
      const owners=await settled(()=>system.listeners([setting.port]));
      const alive=owners?.some(x=>x.port===setting.port);
      canRepairPort=setting.port!==environment.port;
      checks.push(item('appPort',owners===null?'unknown':!alive?'failed':setting.port===environment.port?'passed':'unknown',owners===null?'暂时读不到端口状态。请稍后重新检测。':!alive?`端口 ${setting.port} 没有程序接收连接；如果 Codex 正在使用它，消息会发不出去。`:`端口 ${setting.port} 有程序接收连接。${canRepairPort?'它与 SusuClash 当前端口不同，请先核对。':'这不代表消息一定能发送成功。'}`));
      if(alive&&setting.port===environment.port&&environment.checks.find(c=>c.id==='port')?.status==='passed'&&/^http:\/\//i.test(setting.url||'')){routePort=setting.port;routeKnown=true;}
    }else if(local&&setting?.kind==='none'){
      const s=await settled(()=>proxy?.getStatus());
      if(s?.enabled&&s.managed&&(!s.port||s.port===environment.port)&&environment.checks.find(c=>c.id==='port')?.status==='passed'){routePort=environment.port;routeKnown=true;}
      else if(s?.enabled===false){routeKnown=true;}
    }
    const evidence=recent||{status:'unknown',detail:local?'未能读取最近的运行记录，无法排除超时或重连。':'需要在 WSL 或远端查看那里的运行记录。'};
    checks.push(item('recent',evidence.status,evidence.detail));
    // Three fresh samples can reveal intermittent reachability; even three
    // successes are explicitly only web evidence, never a model/stream verdict.
    const samples=[];
    if(routeKnown)for(let i=0;i<3&&!signal.aborted;i++)samples.push(await settled(()=>system.probe('https://chatgpt.com/',routePort,signal)));
    if(signal.aborted)return null;
    const ok=samples.filter(r=>r?.exit===0&&r.code>=200&&r.code<400).length;
    const failures=samples.filter(r=>r&&(r.code===0||r.code>=500)).length;
    checks.push(item('target',failures?'failed':'unknown',!samples.length?'代理路径还没确认，没有用其他路径的网页结果替代。':failures?`本次连续检查 3 次，${failures} 次没有成功收到网页响应。可能存在连接不稳定，具体原因还需继续核对。`:`本次 3 次网页检查中 ${ok} 次收到正常响应。网页能打开，也可能在发送消息或接收长回复时超时。`));
    checks.push(item('request','needs_user',symptom==='tool'?'聊天回复和工具运行是两回事。请回到出错的工具，重试一次并查看提示。':'本次没有替你发送消息，登录、使用额度和完整回复还没验证。'));
    checks.push(item('session','needs_user','请回到刚才出问题的聊天发一句“你好”，观察是否仍显示重连。收到完整回复且不再重连后，再确认恢复。'));
    const issue=checks.some(c=>['failed','needs_action'].includes(c.status));
    const nextSteps=[];
    if(canRepairPort)nextSteps.push({title:'先核对 Codex 的代理端口',detail:`配置中的端口是 ${setting.port}，SusuClash 当前端口是 ${environment.port}。点下方“查看端口修复方案”可先查看要修改的内容，确认后才会执行。`});
    if(evidence.counts?.auth)nextSteps.push({title:'在 Codex 里重新登录',detail:'运行记录提示登录验证失败。先保存内容，再退出账号并重新登录，然后试发一句“你好”。'});
    if(evidence.counts?.quota)nextSteps.push({title:'查看 Codex 的额度或等待提示',detail:'运行记录提示使用次数或额度限制。按 Codex 显示的时间再试；更换线路不能增加额度。'});
    if(evidence.counts?.tls)nextSteps.push({title:'核对电脑时间',detail:'打开 Windows 设置中的“时间和语言”，同步日期、时间和时区，再重新检测。若仍提示证书问题，请联系网络管理员。'});
    if(symptom==='tool')nextSteps.push({title:'重试刚才失败的工具',detail:'先确认聊天能完整回复，再运行刚才失败的命令或工具。把工具显示的错误提示作为后续排查依据。'});
    else {
      nextSteps.push({title:'回到刚才出问题的聊天试一次',detail:'发一句“你好”，等它回复完。如果仍出现“正在重新连接”或“request timed out（请求超时）”，说明还没恢复。即使最终有回复，也记下是否反复重连。'});
      if(!evidence.counts?.auth&&!evidence.counts?.quota)nextSteps.push({title:'仍然重连时，换一条线路再试',detail:'在 SusuClash 底部点“线路”，选另一条可用线路，再回同一聊天发一句话。若换线后改善，说明原线路可能不稳定。'});
    }
    if(['wsl','remote'].includes(client))nextSteps.push({title:'在实际使用的环境中检查',detail:'请在 WSL 或远端运行环境检查连接和登录。本机线路正常不能代表那个环境正常。'});
    else nextSteps.push({title:'还没恢复，再正常重开 Codex',detail:client==='ide'?'先保存编辑器内容，重载对应窗口或扩展，再回原聊天重试。':'先复制保存未发送的文字，正常退出 Codex 后重新打开，再回原聊天重试。'});
    return {status:issue?'needs_action':client==='cli'?'unknown':'needs_user',client,symptom,checks,nextSteps,canRepairPort,recent:evidence,samples:samples.map(r=>r?{code:r.code,exit:r.exit}:null),checkedAt:new Date().toISOString(),environment,sessionConfirmed:false};
  }
  async function start({scope='proxy',client='desktop',symptom='send',pathMode:requestedPath=pathMode}={}) {
    await ready;
    if(!['proxy','codex'].includes(scope)||!['desktop','cli','ide','wsl','remote'].includes(client)||!['send','stream','reconnect','tool'].includes(symptom)||!['system','fixed','direct'].includes(requestedPath))throw new AppError('请选择有效检测范围。',400);
    if(task && ['checking','repairing'].includes(task.phase))return snapshot();
    pathMode=requestedPath;const mine=++epoch;plan=null;const controller=new AbortController();task={id:randomUUID(),scope,phase:'checking',step:'正在核对网络、受控内核与入口',controller};
    if(scope==='proxy')base=null;else codex=null;
    void (async()=>{
      try {
        const before=await fingerprint();
        const result=await inspect(controller.signal);
        if(mine!==epoch)return;
        if(scope==='proxy')base=result;
        else {
          task.step='正在读取最近的超时、重连记录，并重新检查网页连接';
          const application=await inspectCodex(result,client,symptom,controller.signal);
          if(mine!==epoch||!application)return;
          codex=application;
        }
        if(before!==await fingerprint()) {invalidate();return;}
        if(mine!==epoch)return;
        task.phase='result';task.step='本轮检查已结束';record(scope,scope==='proxy'?base:codex);
      }catch(e){if(mine!==epoch)return;task.phase='error';task.error='检查未完成，请重新检查本地状态。';}
    })();
    return snapshot();
  }
  async function preview({kind}) {
    if(task && ['checking','repairing'].includes(task.phase))throw new AppError('请等待当前任务完成。',409);
    const allowed=['system-proxy','core-restart','port-migrate','codex-port','candidates','client-restart'];
    if(!allowed.includes(kind))throw new AppError('未知修复项目。',400);
    let detail='',extra={};
    if(kind==='system-proxy') {const s=await proxy.getStatus();if(s.enabled && !s.managed)throw new AppError('当前系统代理归属外部，请先在原工具核对。',409);detail='启用本软件系统代理，写入后读取验证；原设置保存在代理归属记录中。';}
    if(kind==='core-restart')detail='短暂中断代理。正常停止本软件受控内核，约 2.5 秒未退出时可能强制结束该受控进程；确认退出后才重新启动。';
    if(kind==='port-migrate'){const s=await proxy.getStatus();if(s.enabled&&!s.managed)throw new AppError('外部系统代理正在使用，请先核对归属。',409);extra.port=await unusedPort();detail=`把内核入口迁移到 ${extra.port}，同步本软件管理的系统代理。失败时尝试恢复原端口与归属。固定使用旧端口的应用需单独确认引用。`;}
    if(kind==='codex-port'){extra.repair=await codexRepair.preview({allowOccupiedOldPort:true});if(!extra.repair.eligible)throw new AppError(extra.repair.reason||'无法安全自动修改，请手动核对。',409);detail=`备份并把 .codex/.env 端口从 ${extra.repair.oldPort} 更新为 ${extra.repair.newPort}。${extra.repair.oldPortOccupied?'旧端口的占用程序会保留。':''}仅在你确认当前客户端确实使用此文件后执行；随后需正常重开 Codex。`;}
    if(kind==='candidates'){const c=await configuration();const a=c.automation;if(!a?.group||!a.backups?.length)throw new AppError('请先在设置中选择策略组与允许的备用线路。',409);extra.group=a.group;extra.candidates=a.backups.slice(0,3);detail='依次预检测最多 3 条已允许的备用线路，再切换并复查固定目标。若无有效改善，按归属恢复原选择。Codex 登录或额度错误不通过换线处理。';}
    if(kind==='client-restart'){if(!restartClient)throw new AppError('当前启动方式没有独立恢复助手，请正常退出并重新启动 SusuClash。',409);detail='独立恢复助手保存本次进度，等待当前客户端正常退出，再重新打开并复查。代理连接会短暂中断。';}
    plan={id:randomUUID(),kind,detail,...extra,expires:Date.now()+60000,fingerprint:await fingerprint()};return snapshot();
  }
  async function apply({id,confirmed=false}) {
    const p=plan;plan=null;
    if(!confirmed||!p||p.id!==id||p.expires<Date.now()||p.fingerprint!==await fingerprint())throw new AppError('方案已失效或尚未确认，请重新预览。',409);
    const scope=p.kind==='codex-port'?'codex':'proxy';const previousCodex=codex;
    if(p.kind==='codex-port'&&codex)codex={...codex,status:'stale',sessionConfirmed:false,checks:codex.checks.map(c=>({...c,status:'stale'}))};
    if(base && scope==='proxy')base={...base,status:'stale',reason:'正在执行变更，等待复查。'};
    if(codex && scope==='proxy')codex={...codex,status:'stale',sessionConfirmed:false,reason:'连接设置已变化，需重新检查 Codex。'};
    task={id:randomUUID(),scope,phase:'repairing',step:'正在执行确认的方案',controller:new AbortController()};
    try {
      await serialize(async()=>{
        if(p.fingerprint!==await fingerprint())throw new AppError('设置已变化，请重新检查并预览方案。',409);
        if(p.kind==='system-proxy'){
          const cfg=await core.call('GET','/configs'),old=await proxy.getStatus();
          if(old.enabled&&!old.managed)throw new AppError('系统代理归属已变化，请重新核对。',409);
          if(old.managed&&old.port&&old.port!==cfg['mixed-port'])await proxy.disable();
          await proxy.enable(cfg['mixed-port']);const after=await proxy.getStatus();
          if(!after.managed||!after.enabled||(after.port&&after.port!==cfg['mixed-port']))throw new AppError('系统代理写回未确认，请核对 Windows 代理。',409);
        }
        if(p.kind==='core-restart'){await core.stop();await core.start();await core.call('GET','/version');}
        if(p.kind==='codex-port'){const r=await codexRepair.apply(p.repair.token);if(!r.ok)throw new AppError(r.message||'配置未确认更新，请重新检查。',409);}
        if(p.kind==='port-migrate'){
          const prefs=await core.preferences(),s=await proxy.getStatus(),wasRunning=core.status().state==='running';
          if(s.enabled&&!s.managed)throw new AppError('系统代理归属已变化，请停止并核对。',409);
          if(s.managed)await proxy.disable();
          try {await core.setPort(p.port);if(!wasRunning)await core.start();const c=await core.call('GET','/configs');if(c['mixed-port']!==p.port)throw new Error('readback');if(s.managed)await proxy.enable(p.port);}
          catch(e){try{const current=await proxy.getStatus();if(current.managed)await proxy.disable();await core.setPort(prefs.expectedPort);if(s.managed)await proxy.enable(prefs.expectedPort);}catch{throw new AppError('迁移未完成，恢复原设置也未确认。请核对端口和系统代理。',503);}throw new AppError('入口迁移未完成，已恢复原设置。',409);}
        }
        if(p.kind==='candidates'){
          const group=encodeURIComponent(p.group),old=(await core.call('GET','/proxies/'+group)).now;let switched=null;
          try {for(const candidate of p.candidates){if(candidate===old)continue;if(await health.verify(candidate)!=='ok')continue;await core.call('PUT','/proxies/'+group,{name:candidate});switched=candidate;if((await core.call('GET','/proxies/'+group)).now!==candidate)throw new Error('readback');const cfg=await core.call('GET','/configs');if((await Promise.all(targets.map(u=>system.probe(u,cfg['mixed-port'])))).some(reachable))return;}throw new AppError('允许的候选线路未确认改善，已尝试恢复原选择。',409);}
          catch(e){if(switched&&(await core.call('GET','/proxies/'+group)).now===switched)await core.call('PUT','/proxies/'+group,{name:old});throw e;}
        }
        if(p.kind==='client-restart'){const handoff=await restartClient();if(!Number.isInteger(handoff?.helperPid))throw new AppError('独立恢复助手尚未确认接手，请手动重开。',503);task.handoffReady=true;}
      });
      if(p.kind==='client-restart'){task.phase='handoff';task.step='独立恢复进程已接手，等待客户端正常退出';return snapshot();}
      task.phase='result';
      if(scope==='codex'){codex={...previousCodex,status:'needs_user',sessionConfirmed:false,checks:[item('restart','needs_user','磁盘配置已更新，请保存内容、正常完全退出并重开 Codex，再验证原任务。')]};record(scope,codex);}
      else {base=await inspect(task.controller.signal);base.actions=[p.kind];record(scope,base);}
      return snapshot();
    }catch(e){task.phase='error';task.error=e instanceof AppError?e.message:'修复未确认完成，请重新检查；不会把已执行的操作当作验证成功。';return snapshot();}
  }
  async function autoStart({client='desktop',symptom='reconnect',pathMode:requestedPath='system',consent=false}={}) {
    await ready;
    if(!['desktop','cli','ide','wsl','remote'].includes(client)||!['send','stream','reconnect','tool'].includes(symptom)||!['system','fixed','direct'].includes(requestedPath))throw new AppError('请选择有效的 Codex 使用方式。',400);
    if(consent!==true)throw new AppError('启动前需了解自动修复范围和诊断消息用量。',400);
    if(task&&['checking','repairing'].includes(task.phase))return snapshot();
    pathMode=requestedPath;plan=null;const mine=++epoch;
    task={id:randomUUID(),scope:'codex',phase:'repairing',step:'正在准备自动检查与修复',controller:new AbortController(),automatic:true};
    codex={client,symptom,status:'unknown',checks:[],nextSteps:[],sessionConfirmed:false,autoRepair:{stage:'checking',detail:task.step,actions:[]}};
    if(base)base={...base,status:'stale',reason:'正在自动修复，结束后重新检查基础状态。',checks:base.checks.map(c=>({...c,status:'stale'}))};
    const onUpdate=r=>{if(mine!==epoch)return;task.step=r.detail;codex={...codex,autoRepair:r,sessionConfirmed:false};};
    autoWork=serialize(()=>automatic.run({client,symptom,pathMode,signal:task.controller.signal,onUpdate})).then(r=>{
      if(mine!==epoch)return;
      const status=r.stage==='app_verified'?'app_verified':r.verification==='probe_passed'&&['probe_passed','awaiting_activation'].includes(r.stage)?'probe_passed':r.stage==='unsupported'?'unknown':'needs_action';
      codex={...codex,status,checkedAt:new Date().toISOString(),autoRepair:r,actions:(r.actions||[]).filter(a=>a.status==='passed').map(a=>a.id),checks:[item('automatic',status,r.detail),item('session','unknown','本轮未向原聊天重复发送任务，原任务完成情况单独记录。')],nextSteps:[],sessionConfirmed:false};
      task.phase='result';task.step=r.detail;record('codex',codex);
    }).catch(()=>{if(mine===epoch){task.phase='error';task.error='自动处理未完成，恢复结果尚未确认。';}}).finally(()=>{autoWork=null;});
    return snapshot();
  }
  return {async get(){await ready;return snapshot();},start,autoStart,preview,apply,invalidate,isRepairing:()=>task?.phase==='repairing',
    cancel(){if(autoWork){task?.controller?.abort();task.step='正在停止并恢复未验证的改动';return snapshot();}if(task?.phase==='repairing')throw new AppError('当前变更正在完成，请等待复查；可先返回首页。',409);epoch++;task?.controller?.abort();if(task)task.phase='cancelled';plan=null;return snapshot();},
    async request(){
      if(!codex||codex.status==='stale'||codex.client!=='cli'||codex.symptom==='tool')throw new AppError('此入口只验证独立 CLI 实例。请先重新检测，再选择测试。',409);
      if(!requestProbe)throw new AppError('当前没有可用的 Codex CLI 测试适配器。',503);
      if(task&&['checking','repairing'].includes(task.phase))throw new AppError('请等待当前任务。',409);
      const cfg=await core.call('GET','/configs'),owners=await system.listeners([cfg['mixed-port']]);
      if(!owners?.some(x=>x.port===cfg['mixed-port']&&Number(x.pid)===core.processId?.()))throw new AppError('无法确认本次受控代理入口，请先检查内核和端口。',409);
      const before=await fingerprint();
      if(task&&['checking','repairing'].includes(task.phase))throw new AppError('请等待当前任务。',409);
      codex={...codex,sessionConfirmed:false};const mine=++epoch;
      task={id:randomUUID(),scope:'codex',phase:'checking',step:'正在等待命令行测试消息完整回复',controller:new AbortController()};
      void requestProbe(task.controller.signal,{port:cfg['mixed-port']}).then(async r=>{
        if(mine!==epoch)return;if(before!==await fingerprint()){invalidate();return;}if(mine!==epoch)return;
        codex={...codex,status:codex.recent?.status==='needs_action'?'needs_action':r.status,checkedAt:new Date().toISOString(),checks:[...codex.checks.filter(c=>!['request','session'].includes(c.id)),item('request',r.status,r.detail),item('session','needs_user','命令行的短消息测试不代表出问题的聊天或长回复已经恢复。')],sessionConfirmed:false};
        task.phase='result';record('codex',codex);
      },()=>{if(mine===epoch){task.phase='error';task.error='测试消息没有完整回复，请重新检测。';}});
      return snapshot();
    },
    confirm(){if(task&&['checking','repairing'].includes(task.phase))throw new AppError('请等待当前检查完成，再确认原任务。',409);if(!codex||codex.status==='stale')throw new AppError('请先重新检查 Codex 专项。',409);codex={...codex,sessionConfirmed:true,status:'verified',checks:codex.checks.map(c=>c.id==='session'?item('session','verified','你已确认在原聊天收到完整回复且不再重连。'):c)};record('codex',codex);return snapshot();},
    async close(){task?.controller?.abort();if(autoWork)await autoWork;epoch++;await persistence;}
  };
}
