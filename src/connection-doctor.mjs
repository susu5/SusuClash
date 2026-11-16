import os from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { listeners } from './diagnostics.mjs';
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
export function createConnectionDoctor({core,proxy,profiles,health,configuration,serialize,restartClient,directory=core.directory,system={probe,listeners,interfaces:()=>os.networkInterfaces(),lookup:host=>dns.lookup(host)}}) {
  let epoch=0, task=null, base=null, codex=null, history=[], plan=null,pathMode='system';
  let checkWork=null,applyWork=null,closeWork=null,closing=false;
  const assertOpen=()=>{if(closing)throw new AppError('客户端正在退出，暂时不能开始新的检查或修复。',503);};
  const retired=()=>{throw new AppError('Codex 专项已改用 Netfix，请重新进入网络修复工具箱。',410);};
  const historyFile=directory?path.join(directory,'connection-checks.json'):null;
  let persistence=Promise.resolve();
  const ready=historyFile?readFile(historyFile,'utf8').then(s=>{const v=JSON.parse(s);if(Array.isArray(v))history=v.slice(0,40);}).catch(()=>{}):Promise.resolve();
  function record(scope,result) {
    history.unshift({id:randomUUID(),at:new Date().toISOString(),scope,status:result.status,checks:result.checks.map(({id,name,status,detail})=>({id,name,status,detail})),actions:result.actions||[]});history=history.slice(0,40);
    if(historyFile){const saved=JSON.stringify(history);persistence=persistence.then(async()=>{await mkdir(directory,{recursive:true});const tmp=historyFile+'.tmp';await writeFile(tmp,saved,{mode:0o600});await rename(tmp,historyFile);}).catch(()=>{});}
  }
  const snapshot=()=>({task:task?{id:task.id,scope:task.scope,phase:task.phase,step:task.step,error:task.error,handoffReady:task.handoffReady===true}:null,base,codex,plan,history});
  function invalidate(reason='连接设置已变化，请重新检查。') {epoch++;task?.controller?.abort();if(task)task.phase='cancelled';plan=null;if(base)base={...base,status:'stale',reason,checks:base.checks.map(c=>({...c,status:'stale'}))};if(codex)codex={...codex,status:'stale',sessionConfirmed:false,reason,checks:codex.checks.map(c=>({...c,status:'stale'}))};}
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
  async function start({scope='proxy',client='desktop',symptom='send',pathMode:requestedPath=pathMode}={}) {
    await ready;
    if(scope==='codex')return retired();
    assertOpen();
    if(applyWork)throw new AppError('请等待当前修复步骤和复查完成。',409);
    if(!['proxy'].includes(scope)||!['desktop','cli','ide','wsl','remote'].includes(client)||!['send','stream','reconnect','tool'].includes(symptom)||!['system','fixed','direct'].includes(requestedPath))throw new AppError('请选择有效检测范围。',400);
    if(task && ['checking','repairing'].includes(task.phase))return snapshot();
    pathMode=requestedPath;const mine=++epoch;plan=null;const controller=new AbortController();task={id:randomUUID(),scope,phase:'checking',step:'正在核对网络、受控内核与入口',controller};
    if(scope==='proxy')base=null;else codex=null;
    checkWork=(async()=>{
      try {
        const before=await fingerprint();
        const result=await inspect(controller.signal);
        if(mine!==epoch)return;
        base=result;
        if(before!==await fingerprint()) {invalidate();return;}
        if(mine!==epoch)return;
        task.phase='result';task.step='本轮检查已结束';record(scope,scope==='proxy'?base:codex);
      }catch(e){if(mine!==epoch)return;task.phase='error';task.error='检查未完成，请重新检查本地状态。';}
    })().finally(()=>{if(mine===epoch)checkWork=null;});
    return snapshot();
  }
  async function preview({kind}) {
    if(kind==='codex-port')return retired();
    assertOpen();
    if(applyWork||task && ['checking','repairing'].includes(task.phase))throw new AppError('请等待当前任务完成。',409);
    const allowed=['system-proxy','core-restart','port-migrate','candidates','client-restart'];
    if(!allowed.includes(kind))throw new AppError('未知修复项目。',400);
    let detail='',extra={};
    if(kind==='system-proxy') {const s=await proxy.getStatus();if(s.enabled && !s.managed)throw new AppError('当前系统代理归属外部，请先在原工具核对。',409);detail='启用本软件系统代理，写入后读取验证；原设置保存在代理归属记录中。';}
    if(kind==='core-restart')detail='短暂中断代理。正常停止本软件受控内核，约 2.5 秒未退出时可能强制结束该受控进程；确认退出后才重新启动。';
    if(kind==='port-migrate'){const s=await proxy.getStatus();if(s.enabled&&!s.managed)throw new AppError('外部系统代理正在使用，请先核对归属。',409);extra.port=await unusedPort();detail=`把内核入口迁移到 ${extra.port}，同步本软件管理的系统代理。失败时尝试恢复原端口与归属。固定使用旧端口的应用需单独确认引用。`;}
    if(kind==='candidates'){const c=await configuration();const a=c.automation;if(!a?.group||!a.backups?.length)throw new AppError('请先在设置中选择策略组与允许的备用线路。',409);extra.group=a.group;extra.candidates=a.backups.slice(0,3);detail='依次预检测最多 3 条已允许的备用线路，再切换并复查固定目标。若无有效改善，按归属恢复原选择。Codex 登录或额度错误不通过换线处理。';}
    if(kind==='client-restart'){if(!restartClient)throw new AppError('当前启动方式没有独立恢复助手，请正常退出并重新启动 SusuClash。',409);detail='独立恢复助手保存本次进度，等待当前客户端正常退出，再重新打开并复查。代理连接会短暂中断。';}
    assertOpen();const expected=await fingerprint();assertOpen();
    plan={id:randomUUID(),kind,detail,...extra,expires:Date.now()+60000,fingerprint:expected};return snapshot();
  }
  async function performApply({id,confirmed=false},acceptedEpoch) {
    assertOpen();
    const p=plan;plan=null;
    if(!confirmed||!p||p.id!==id||p.expires<Date.now()||p.fingerprint!==await fingerprint())throw new AppError('方案已失效或尚未确认，请重新预览。',409);
    assertOpen();
    if(acceptedEpoch!==epoch)throw new AppError('设置已变化，请重新检查并预览方案。',409);
    const scope='proxy';
    if(base && scope==='proxy')base={...base,status:'stale',reason:'正在执行变更，等待复查。'};
    if(codex && scope==='proxy')codex={...codex,status:'stale',sessionConfirmed:false,reason:'连接设置已变化，需重新检查 Codex。'};
    const mine=++epoch;
    const currentTask={id:randomUUID(),scope,phase:'repairing',step:'正在执行确认的方案',controller:new AbortController()};task=currentTask;
    const interrupted=()=>closing||mine!==epoch||currentTask.controller.signal.aborted;
    const stopped=()=>{currentTask.phase='cancelled';currentTask.step='本轮已停止，未继续发布复查结果';return snapshot();};
    try {
      await serialize(async()=>{
        assertOpen();
        if(p.fingerprint!==await fingerprint())throw new AppError('设置已变化，请重新检查并预览方案。',409);
        assertOpen();
        if(interrupted())throw new AppError('本轮方案已停止，请重新检查。',409);
        if(p.kind==='system-proxy'){
          const cfg=await core.call('GET','/configs'),old=await proxy.getStatus();
          if(old.enabled&&!old.managed)throw new AppError('系统代理归属已变化，请重新核对。',409);
          if(old.managed&&old.port&&old.port!==cfg['mixed-port'])await proxy.disable();
          await proxy.enable(cfg['mixed-port']);const after=await proxy.getStatus();
          if(!after.managed||!after.enabled||(after.port&&after.port!==cfg['mixed-port']))throw new AppError('系统代理写回未确认，请核对 Windows 代理。',409);
        }
        if(p.kind==='core-restart'){await core.stop();await core.start();await core.call('GET','/version');}
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
        if(p.kind==='client-restart'){const handoff=await restartClient();if(!Number.isInteger(handoff?.helperPid))throw new AppError('独立恢复助手尚未确认接手，请手动重开。',503);currentTask.handoffReady=true;}
      });
      if(interrupted())return stopped();
      if(p.kind==='client-restart'){currentTask.phase='handoff';currentTask.step='独立恢复进程已接手，等待客户端正常退出';return snapshot();}
      const result=await inspect(currentTask.controller.signal);
      if(interrupted())return stopped();
      base=result;base.actions=[p.kind];record(scope,base);currentTask.phase='result';
      return snapshot();
    }catch(e){if(interrupted())return stopped();currentTask.phase='error';currentTask.error=e instanceof AppError?e.message:'修复未确认完成，请重新检查；不会把已执行的操作当作验证成功。';return snapshot();}
  }
  function apply(input) {
    if(closing)return Promise.reject(new AppError('客户端正在退出，暂时不能开始新的修复。',503));
    if(applyWork)return Promise.reject(new AppError('请等待当前修复步骤和复查完成。',409));
    // Register the entire operation before its first asynchronous fingerprint
    // check, including queueing, compensation, post-write inspection and record.
    const tracked=performApply(input,epoch).finally(()=>{if(applyWork===tracked)applyWork=null;});
    applyWork=tracked;return tracked;
  }
  function close() {
    if(closeWork)return closeWork;
    closing=true;plan=null;epoch++;task?.controller?.abort();
    if(task?.phase==='checking')task.phase='cancelled';
    closeWork=(async()=>{await ready;await Promise.allSettled([checkWork,applyWork].filter(Boolean));await persistence;})();
    return closeWork;
  }
  return {async get(){await ready;return snapshot();},start,preview,apply,invalidate,isRepairing:()=>!!applyWork||task?.phase==='repairing',
    autoStart:async()=>retired(),request:async()=>retired(),confirm:()=>retired(),
    cancel(){assertOpen();if(applyWork||task?.phase==='repairing')throw new AppError('当前变更正在完成，请等待复查；可先返回首页。',409);epoch++;task?.controller?.abort();if(task)task.phase='cancelled';plan=null;return snapshot();},close
  };
}
