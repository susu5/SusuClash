import { TextDecoder } from 'node:util';
import { inspectCodexProxyEnv, patchCodexProxyPort, safeCodexNoProxy } from './codex-proxy-context.mjs';

export function parseNetfixEnv(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > 1048576) throw new Error();
    new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    const content=bytes.toString('utf8'), parsed=inspectCodexProxyEnv(content);
    if (!safeCodexNoProxy(parsed.noProxy)) throw new Error();
    return {supported:true,hasProxy:parsed.hasProxy,port:parsed.port,proxyKeys:Object.keys(parsed.env).filter(k=>k!=='NO_PROXY'),content,reason:null};
  } catch { return {supported:false,hasProxy:false,port:null,proxyKeys:[],reason:'代理文件不是可安全处理的一致本机 HTTP 代理，保持原样。'}; }
}

export function patchNetfixPort(bytes, port) {
  const parsed=parseNetfixEnv(bytes);
  if(!parsed.supported||!parsed.hasProxy)throw new Error('unsupported_env');
  const changed=Buffer.from(patchCodexProxyPort(parsed.content,port),'utf8');
  if(!parseNetfixEnv(changed).supported)throw new Error('unsupported_env');
  return changed;
}

export const NETFIX_ADVICE={
  restart:{title:'A2 处理指引：重启 Codex',sub:'无自动修复动作，请按步骤人工处理',steps:['完全退出 Codex（含托盘图标，不是只关窗口）','重新打开 Codex，再检查进程环境是否与 .env 一致','回本工具点「重新诊断」确认三方一致','工具不代劳重启，避免丢草稿']},
  transport:{title:'B 类处理指引（无自动修复）',sub:'检测到传输异常，本工具不自动换节点',steps:['在正在使用的代理客户端中检查当前节点','确认分流规则和目标链路','调整后回本工具点「重新诊断」复测成功率','禁止改 Codex provider / WebSocket 配置规避异常']}
};

export function candidatePorts(host={}) {
  const ports=[];
  const add=p=>{if(Number.isInteger(Number(p))&&Number(p)>0&&Number(p)<65536&&!ports.includes(Number(p)))ports.push(Number(p));};
  for(const port of host.vergePorts||[])add(port);
  const proxy=host.systemProxy;
  if(proxy?.enabled&&proxy.supported!==false&&!proxy.automatic&&['127.0.0.1','localhost','::1','[::1]'].includes(proxy.host))add(proxy.port);
  for(const port of [7897,7890,10808])add(port);
  return ports;
}

export function candidateIdentity(host,port) {
  const owners=(host?.listeners||[]).filter(x=>Number(x.port)===port&&['127.0.0.1','0.0.0.0','::','::1','[::]','[::1]'].includes(x.address));
  // A name alone is not a protocol check, but an unowned TCP listener must
  // never become a writable repair candidate. HTTP is verified separately.
  if(!owners.length||owners.some(x=>!Number.isInteger(Number(x.pid))||Number(x.pid)<=0||!String(x.name||'')))return null;
  return JSON.stringify(owners.map(x=>({port,pid:Number(x.pid),name:String(x.name).toLowerCase(),address:x.address})).sort((a,b)=>a.pid-b.pid||a.address.localeCompare(b.address)));
}

export function evaluateNetfix({env={},host={},logs={},auth={},currentProbes=[],candidate=null,candidateProbe=null,backups=[]}={}) {
  const proc=host.process||{},oldOwners=(host.listeners||[]).filter(x=>Number(x.port)===env.port),dead=!!env.port&&!oldOwners.length;
  const mismatch=!!env.port&&proc.running&&Number.isInteger(proc.port)&&proc.port!==env.port;
  const cHit=auth.expired===true||Number(logs.cHits24h)>0;
  const success=currentProbes.filter(x=>x.ok===true).length,rate=currentProbes.length===3?success/3:null;
  const transportErr=currentProbes.some(p=>!p.ok&&/tls|certificate|handshake|timeout|timed|reset|eof/i.test(p.error||''));
  const bHit=Number(logs.bHits15m)>=3||rate!==null&&rate<0.9||transportErr;
  const systemPathUnknown=!env.hasProxy&&(host.systemProxy?.available===false||host.systemProxy?.automatic||host.systemProxy?.enabled&&(host.systemProxy.supported===false||!['127.0.0.1','localhost','::1','[::1]'].includes(host.systemProxy.host)||!Number.isInteger(host.systemProxy.port)));
  const unknown=!env.supported||!env.exists&&env.hasProxy||!host.available||!proc.available||proc.ambiguous===true||proc.unsupported===true||systemPathUnknown||!logs.available||logs.complete===false||!auth.available||currentProbes.length!==3||currentProbes.some(x=>x.cancelled);
  const recurrence=host.actualRewrite===true||new Set(backups.map(x=>x.port).filter(Number.isInteger)).size>=2;
  let verdict;
  const make=(level,tag,title,detail,fixMode,fixLabel,advice)=>({level,tag,title,detail,fixMode,fixLabel,...(advice?{advice}: {})});
  if(unknown)verdict=make('warn','证据不足 · 待确认','尚不能确认 Codex 网络状态','缺失、读取失败或不支持的证据保留待确认，不按“全部正常”处理。','copy-report','复制诊断报告');
  else if(dead)verdict=candidate&&candidateProbe?.ok?
    make('error','根因：A 链路配置 · B 为连带','固定代理指向无人监听的死端口 '+env.port,'文件中的本机固定代理端口无人监听；候选已核对监听归属并通过 HTTP 链路探测。','fix-port','一键修复到 '+candidate):
    make('error','根因：A 链路配置 · 无可用端口','死端口 '+env.port+'，且本机没有已验证可用的代理端口','工具拒绝写入未经验证或同样不可用的端口。请先启动或检查代理客户端，再重新诊断。','none','禁止自动修复');
  else if(mismatch)verdict=make('warn','A2 配置漂移 · 待重启','配置已指向 '+env.port+'，但运行中的 Codex 仍使用 '+proc.port,'进程环境与文件不一致。工具不代劳重启；当前窗口和原任务尚未验证。','advice','查看处理指引',NETFIX_ADVICE.restart);
  else if(cHit)verdict=make('warn','C 身份配额 · 只诊断','需要核实登录或额度状态','检测到 token 过期或近 24h 鉴权／额度相关记录；这不能证明当前请求已被拒绝。C 类禁止自动改配置。','none','禁止自动修复');
  else if(bHit)verdict=make('warn','B 传输 · 检测到传输异常','链路检查检测到传输异常','近 15min 活跃传输异常 '+Number(logs.bHits15m||0)+' 条；当前链路 3 次探测中 '+success+' 次取得 HTTP 响应。原因尚需确认。','advice','查看处理指引',NETFIX_ADVICE.transport);
  else if(env.exists&&!env.locked&&recurrence)verdict=make('warn','A5 多写者冲突 · 复发源','链路当前可用，但 .env 未锁，可能再次被改写','历史备份出现至少两种代理端口或观察到实际外部改写。SusuClash 自身存在或运行不作为复发依据。','lock-only','锁定防复发');
  else verdict=make('ok','本轮链路检查','链路检查未发现异常','本轮文件、监听及独立 HTTP 链路未发现异常。HTTP 响应不等于模型请求完成；当前窗口和原任务尚未验证。','copy-report','复制诊断报告');
  const safe=!unknown&&env.exists;
  const allowedActions=safe?[...(verdict.fixMode==='fix-port'?['fix-port']:[]),env.locked?'unlock':'lock',...(backups.some(x=>x.restorable)?['restore']:[])]:[];
  const rows=[
    {tag:'A 链路配置',level:unknown?'warn':dead?'error':mismatch?'warn':'ok',value:!env.hasProxy?'无固定代理':dead?env.port+' · 死端口':mismatch?env.port+' · 进程漂移':env.port+' · 配置正常',note:unknown?'部分证据未确认':mismatch?'进程端口 '+proc.port+'；需正常重开后再检查':'仅描述本轮文件、端口和进程证据'},
    {tag:'B 传输',level:unknown?'warn':dead?'error':bHit?'warn':'ok',value:unknown?'待确认':dead?'连接失败（A 类连带）':'成功率 '+Math.round((rate||0)*100)+'%',note:'当前链路 3 次样本；近 15min 传输异常 '+Number(logs.bHits15m||0)+' 条。候选和直连对照不计入。'},
    {tag:'C 身份配额',level:unknown||cHit?'warn':'ok',value:!auth.available?'未确认':auth.expired?'token 已过期':auth.present?'token 未过期':'未检测到登录态',note:'近 24h 鉴权／额度命中 '+Number(logs.cHits24h||0)+' 条；只诊断，不写认证。'}
  ];
  return {verdict,rows,unknown,allowedActions,rate,dead,mismatch,recurrence};
}
