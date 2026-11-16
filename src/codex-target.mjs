import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,lstat,realpath,readdir,rename,rm,open} from 'node:fs/promises';
import path from 'node:path';
import {runTargetProbe} from './codex-target-probe.mjs';
import {listeners} from './diagnostics.mjs';
import {inspectCodexProxyEnv,patchCodexProxyPort,safeCodexNoProxy} from './codex-proxy-context.mjs';
import {readMetadataSnapshot,writeAtomicMetadata} from './atomic-metadata.mjs';

const execute=promisify(execFile),hash=x=>createHash('sha256').update(x).digest('hex');
const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const unsupported=reason=>({supported:false,reason,public:{client:null},strategies:[]});
const safeKey=/^[A-Za-z_][A-Za-z0-9_-]*$/;
const projectedRootKeys=['model','model_provider','model_reasoning_effort','service_tier','cli_auth_credentials_store','forced_login_method','forced_chatgpt_workspace_id'];
const stringValue=s=>{if(/^"(?:[^"\\]|\\["\\bnfrt])*"$/.test(s))return JSON.parse(s);if(/^'[^']*'$/.test(s))return s.slice(1,-1);throw new Error('unsupported_config');};

// Conservative editing, not a permissive TOML reserializer. Unrecognized syntax
// on a transport-bearing field is refused, and unrelated bytes remain untouched.
export function inspectTargetConfig(content){
  if(content.length>1048576||content.includes('"""')||content.includes("'''"))throw new Error('unsupported_config');
  const rows=content.split(/(?<=\n)/),root={},features={},providers={},positions={};let section='',seen=new Set();
  for(let i=0;i<rows.length;i++){
    const line=rows[i].replace(/^\uFEFF/,'').trim();if(!line||line.startsWith('#'))continue;
    if(line.startsWith('[')){
      const m=/^\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line);if(!m)throw new Error('unsupported_config');section=m[1].trim();
      // Quoted/dotted alternate spellings of relevant TOML keys must not be
      // silently ignored and then misidentified as the default OpenAI provider.
      if(/^["']/.test(section)||/^features(?:\s|\.)/.test(section)||/^model_providers(?:\s|\.|$)/.test(section)&&!/^model_providers\.[A-Za-z_][A-Za-z0-9_-]*$/.test(section))throw new Error('unsupported_config');
      if(section==='features'||/^model_providers\.[A-Za-z_][A-Za-z0-9_-]*$/.test(section)){if(seen.has(section))throw new Error('unsupported_config');seen.add(section);}
      continue;
    }
    const m=/^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);if(!m){if(!section||section==='features'||section.startsWith('model_providers.'))throw new Error('unsupported_config');continue;}
    const key=m[1];let value=m[2].trim();
    // Strip only a trailing comment outside a one-line quoted value.
    const token=/^("(?:[^"\\]|\\.)*"|'[^']*'|true|false|\d+)\s*(?:#.*)?$/.exec(value);if(token)value=token[1];
    if(!section&&(['openai_base_url','chatgpt_base_url','experimental_realtime_ws_base_url','auth_env_key'].includes(key)||/^model_request(?:_|\.|$)/.test(key)))throw new Error('unsupported_transport_context');
    if(!section&&[...projectedRootKeys,'profile'].includes(key)){if(root[key]!==undefined)throw new Error('unsupported_config');root[key]=stringValue(value);}
    if(!section&&(key==='features'||key.startsWith('features.')||key==='model_providers'||key.startsWith('model_providers.')))throw new Error('unsupported_config');
    if(section==='features'){if(!safeKey.test(key)||!['true','false'].includes(value)||features[key]!==undefined)throw new Error('unsupported_config');features[key]=value==='true';positions['features.'+key]=i;}
    if(/^model_providers\.[A-Za-z_][A-Za-z0-9_-]*$/.test(section)){const id=section.slice(16);providers[id]??={};if(!safeKey.test(key)||providers[id][key]!==undefined)throw new Error('unsupported_config');providers[id][key]=value;positions[section+'.'+key]=i;}
  }
  if(root.profile)throw new Error('profile_not_supported');
  const provider=root.model_provider||'openai';if(!safeKey.test(provider))throw new Error('unsupported_provider');
  const selected=providers[provider];
  if(selected&&['openai','ollama','lmstudio'].includes(provider))throw new Error('reserved_provider_override');
  if(provider!=='openai'&&!selected)throw new Error('unsupported_provider');
  if(selected){for(const [key,value]of Object.entries(selected)){
    if(!['name','base_url','env_key','requires_openai_auth','wire_api','supports_websockets','request_max_retries','stream_max_retries','stream_idle_timeout_ms','websocket_connect_timeout_ms'].includes(key))throw new Error('unsupported_provider');
    if(['name','base_url','env_key','wire_api'].includes(key)){const text=stringValue(value);if(key==='base_url'){const url=new URL(text);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('unsupported_provider');}if(key==='wire_api'&&text!=='responses')throw new Error('unsupported_provider');}
    else if(!/^(?:true|false|\d+)$/.test(value))throw new Error('unsupported_provider');
  }}
  return {root,features,provider,selected,positions,rows,content};
}
export function patchTargetConfig(content,strategy){
  strategy=typeof strategy==='string'?strategy:strategy?.id;
  if(strategy==='current')return content;
  const parsed=inspectTargetConfig(content),eol=content.includes('\r\n')?'\r\n':'\n';
  let field,section,value;
  if(strategy==='system-proxy'){field='respect_system_proxy';section='features';value='true';}
  else if(strategy==='http'&&parsed.selected&&parsed.selected.supports_websockets!==undefined){field='supports_websockets';section='model_providers.'+parsed.provider;value='false';}
  else throw new Error('unsupported_strategy');
  const position=parsed.positions[section+'.'+field];
  if(position!==undefined){parsed.rows[position]=parsed.rows[position].replace(/(=\s*)(true|false)/,`$1${value}`);return parsed.rows.join('');}
  const index=parsed.rows.findIndex(x=>new RegExp('^\\s*\\['+section.replaceAll('.','\\.')+'\\]\\s*(?:#.*)?(?:\\r?\\n)?$').test(x));
  if(index>=0){parsed.rows.splice(index+1,0,`${field} = ${value}${eol}`);return parsed.rows.join('');}
  return content+(content.endsWith('\n')?'':eol)+`${eol}[${section}]${eol}${field} = ${value}${eol}`;
}

async function plainFile(file){const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink>1||s.size>1048576)throw new Error('unsafe_file');return s;}
async function plainDirectory(dir){const s=await lstat(dir);if(!s.isDirectory()||s.isSymbolicLink()||path.resolve(await realpath(dir)).toLowerCase()!==path.resolve(dir).toLowerCase())throw new Error('unsafe_directory');}
async function permissions(source,files){
  if(process.platform!=='win32')return;
  await execute(ps,['-NoProfile','-NonInteractive','-Command','$ErrorActionPreference="Stop"; $acl=Get-Acl -LiteralPath $env:SUSU_ACL_SOURCE; foreach($file in ($env:SUSU_ACL_TARGETS | ConvertFrom-Json)){Set-Acl -LiteralPath $file -AclObject $acl; if((Get-Acl -LiteralPath $file).Sddl -ne $acl.Sddl){throw "ACL mismatch"}}'],{windowsHide:true,timeout:10000,maxBuffer:4096,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/Modules'),SUSU_ACL_SOURCE:source,SUSU_ACL_TARGETS:JSON.stringify(files)}});
}
async function locate(client){
  if(process.platform!=='win32')return null;
  if(client==='cli'){const r=await execute('where.exe',['codex.exe'],{windowsHide:true,timeout:5000,maxBuffer:8192});return r.stdout.split(/\r?\n/).find(x=>path.isAbsolute(x)&&/codex\.exe$/i.test(x))||null;}
  if(client!=='desktop')return null;
  const r=await execute(ps,['-NoProfile','-NonInteractive','-Command','@((Get-Process -Name Codex -ErrorAction SilentlyContinue | ForEach-Object {$_.Path}) | Sort-Object -Unique) | ConvertTo-Json -Compress'],{windowsHide:true,timeout:5000,maxBuffer:16384});
  const paths=JSON.parse(r.stdout||'[]'),candidates=new Set();
  for(const file of Array.isArray(paths)?paths:[paths]){
    if(typeof file!=='string'||!/[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/](?:resources[\\/])?codex\.exe$/i.test(file))continue;
    const binary=/[\\/]resources[\\/]codex\.exe$/i.test(file)?file:path.join(path.dirname(file),'resources','codex.exe');
    candidates.add(binary.toLowerCase());
  }
  return candidates.size===1?[...candidates][0]:null;
}
// Windows normally bypasses loopback/LAN hosts. These rules do not invalidate
// an Internet Codex route, but a rule that can bypass a target must fail closed.
export function safeProxyBypass(value,hosts=['chatgpt.com','api.openai.com','auth.openai.com']){
  if(value==null||value==='')return true;
  if(typeof value!=='string'||value.length>8192||/[\r\n\0]/.test(value)||!Array.isArray(hosts)||!hosts.length)return false;
  const patterns=value.split(';').map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(patterns.length>256)return false;
  const destinations=hosts.map(x=>String(x).toLowerCase());
  for(const pattern of patterns){
    if(pattern==='<local>'){if(destinations.some(x=>!x.includes('.')))return false;continue;}
    const labels=pattern.split('.');
    const ipPattern=labels.length>=2&&labels.length<=4&&labels.every(x=>x==='*'||/^\d{1,3}$/.test(x)&&Number(x)<=255)&&
      (['127','10'].includes(labels[0])||labels[0]==='192'&&labels[1]==='168'||labels[0]==='169'&&labels[1]==='254'||labels[0]==='172'&&/^\d+$/.test(labels[1])&&Number(labels[1])>=16&&Number(labels[1])<=31);
    if(!ipPattern&&!['localhost','*.localhost','*.local','::1','[::1]'].includes(pattern))return false;
    const matches=new RegExp('^'+pattern.split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$','i');
    if(destinations.some(x=>matches.test(x)))return false;
  }
  return true;
}
async function systemProxy(port,hosts){
  if(process.platform!=='win32')return false;
  const r=await execute(ps,['-NoProfile','-NonInteractive','-Command','$p=Get-ItemProperty -LiteralPath "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"; @{enabled=($p.ProxyEnable -eq 1);server=$p.ProxyServer;pac=$p.AutoConfigURL;override=$p.ProxyOverride} | ConvertTo-Json -Compress'],{windowsHide:true,timeout:5000,maxBuffer:8192});
  const p=JSON.parse(r.stdout);return p.enabled&&!p.pac&&p.server===`127.0.0.1:${port}`&&safeProxyBypass(p.override,hosts);
}

export function createCodexTargetAdapter({home=process.env.CODEX_HOME||(process.env.USERPROFILE?path.join(process.env.USERPROFILE,'.codex'):null),locateBinary=locate,run=execute,probeProcess=runTargetProbe,copyPermissions=permissions,checkSystemProxy=systemProxy,readListeners=listeners,env=process.env,activateTarget=null,system={}}={}){
  const targets=new WeakSet();
  async function proxyFile(){
    const file=path.join(home,'.env');
    try{await plainFile(file);const content=await readFile(file,'utf8');
      // Keep a fingerprint even without proxy fields. Other dotenv values may
      // legitimately use syntax that our narrow proxy editor does not handle.
      const relevant=/(?:^|[\r\n])\s*(?:export\s+|unset\s+)?(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)\b/i.test(content);
      return {content,hash:hash(content),parsed:inspectCodexProxyEnv(relevant?content:'')};}
    catch(e){if(e.code==='ENOENT')return {content:'',hash:null,parsed:inspectCodexProxyEnv('')};throw e;}
  }
  async function unchanged(target){
    if(!targets.has(target))throw new Error('invalid_target');await plainDirectory(target.home);await plainFile(target.file);
    const s=await lstat(target.binary);if(s.isSymbolicLink()||s.size!==target.binarySize||s.mtimeMs!==target.binaryTime)throw new Error('binary_changed');
    if(hash(await readFile(target.file,'utf8'))!==target.expectedHash)throw new Error('config_changed');
    const proxy=await proxyFile();if(proxy.hash!==target.proxyHash)throw new Error('proxy_changed');return proxy;
  }
  const hostsFor=target=>['chatgpt.com','api.openai.com','auth.openai.com',...(target.config.selected?.base_url?[new URL(stringValue(target.config.selected.base_url)).hostname]:[])];
  async function proxyContext(target,port,proxy){
    if(!Number.isInteger(port)||port<1||port>65535||!await checkSystemProxy(port,hostsFor(target)))return {status:'unsupported',reason:'proxy_context',detail:'尚未确认 Codex 使用的系统代理与本次入口一致。',fresh:false,transportClean:false};
    if(!safeCodexNoProxy(proxy.parsed.noProxy,hostsFor(target)))return {status:'unsupported',reason:'proxy_override',detail:'应用代理包含无法安全确认的绕过规则，已保留原设置。',fresh:false,transportClean:false};
    if(proxy.parsed.hasProxy&&proxy.parsed.port!==port){
      const owners=await readListeners([proxy.parsed.port]);
      if(!Array.isArray(owners)||owners.some(x=>Number(x.port)===proxy.parsed.port))return {status:'unsupported',reason:'proxy_override',detail:'应用代理的旧端口仍被程序使用或无法核对归属，已保留该程序和原设置。',fresh:false,transportClean:false};
    }
    return null;
  }
  async function discover({client='desktop',signal}={}){
    if(!['cli','desktop'].includes(client)||!home)return unsupported('当前使用入口还没有安全的本机自动修复适配器。');
    try{
      await plainDirectory(home);const file=path.join(home,'config.toml');await plainFile(file);const content=await readFile(file,'utf8'),config=inspectTargetConfig(content);
      let proxy;try{proxy=await proxyFile();}catch{return unsupported('应用代理包含自定义地址、冲突语法或无法安全读取的文件，已保留原设置。');}
      const binary=await locateBinary(client);if(!binary||!path.isAbsolute(binary))return unsupported('未能唯一确认当前 Codex 程序，已保留现有设置。');
      const bs=await lstat(binary);if(!bs.isFile()||bs.isSymbolicLink())return unsupported('当前 Codex 程序入口无法安全确认。');
      const options={windowsHide:true,timeout:7000,maxBuffer:65536,signal};
      const [version,help,featureResult]=await Promise.all([run(binary,['--version'],options),run(binary,['exec','--help'],options),run(binary,['features','list'],options)]);
      if(!['--ignore-user-config','--strict-config','--ephemeral','--json'].every(x=>help.stdout.includes(x)))return unsupported('当前 Codex 版本缺少隔离验证能力，未修改设置。');
      const capabilities=new Map();for(const line of featureResult.stdout.split(/\r?\n/)){const m=/^(\S+)\s+(.*?)\s+(true|false)\s*$/.exec(line);if(m&&!/removed|deprecated/.test(m[2]))capabilities.set(m[1],m[3]==='true');}
      if(!['shell_tool','hooks','plugins'].every(x=>capabilities.has(x)))return unsupported('当前版本不能确认关闭诊断工具和启动钩子，未发送测试请求。');
      let strategies=[];if(capabilities.has('respect_system_proxy')&&!config.features.respect_system_proxy)strategies.push({id:'system-proxy',label:'让 Codex 正确使用系统代理'});
      // Do not remap built-in OpenAI identity to a synthetic provider. HTTP is
      // eligible only when that exact provider already declares the capability.
      if(config.selected?.supports_websockets==='true')strategies.push({id:'http',label:'使用当前服务支持的备用连接方式'});
      if(proxy.parsed.hasProxy)strategies.unshift({id:'local-proxy-port',label:'将未使用的本机旧代理端口同步到受控入口'});
      const target={client,home,file,binary,binarySize:bs.size,binaryTime:bs.mtimeMs,hash:hash(content),expectedHash:hash(content),proxyHash:proxy.hash,config,capabilities,strategies};targets.add(target);
      return {supported:true,public:{client,version:/codex-cli\s+(\S+)/.exec(version.stdout)?.[1]||'unknown',provider:config.provider,model:config.root.model||'客户端默认',contextScope:proxy.parsed.hasProxy?'user_config_and_proxy_file_projection':'user_config_projection',proxyFileLoadVerified:false,runtimeSelectionVerified:false,safeActivation:client==='cli'&&!proxy.parsed.hasProxy,capabilities:{systemProxy:capabilities.has('respect_system_proxy'),http:!!config.selected,desktopRestart:false}},target,strategies};
    }catch{return unsupported('当前配置、版本或权限暂不满足安全修复条件，已保留现有设置。');}
  }
  async function probe(target,{strategy,port,signal,deadline,persisted=false}={}){
    try{
      const proxy=await unchanged(target),blocked=await proxyContext(target,port,proxy);if(blocked)return blocked;
      const strategyId=typeof strategy==='string'?strategy:strategy?.id;
      const config=inspectTargetConfig(await readFile(target.file,'utf8'));
      if(config.root.model!==target.config.root.model||config.provider!==target.config.provider)return {status:'failed',reason:'context_changed',fresh:false,transportClean:false};
      if(!persisted&&hash(config.content)!==target.hash)return {status:'failed',reason:'context_changed',fresh:false,transportClean:false};
      const candidate=persisted||strategyId==='local-proxy-port'?config:inspectTargetConfig(patchTargetConfig(config.content,strategy));
      const args=[];for(const key of projectedRootKeys)if(candidate.root[key]!==undefined)args.push('-c',key+'='+JSON.stringify(candidate.root[key]));
      if(candidate.selected)for(const[key,value]of Object.entries(candidate.selected))args.push('-c',`model_providers.${candidate.provider}.${key}=${value}`);
      for(const feature of ['shell_tool','hooks','plugins','apps','browser_use','computer_use','multi_agent','image_generation','code_mode','code_mode_host','in_app_browser','web_search_request','standalone_web_search'])if(target.capabilities.has(feature))args.push('-c',`features.${feature}=false`);
      for(const feature of ['respect_system_proxy','system_proxy_fallback','enable_request_compression'])if(candidate.features[feature]!==undefined&&target.capabilities.has(feature))args.push('-c',`features.${feature}=${candidate.features[feature]}`);
      // The port candidate explicitly projects only verified local proxy fields.
      // It does not prove that an already-open desktop loaded the .env file.
      // Ordinary system-proxy candidates still inject no proxy variables.
      let proxyEnv;
      if(strategyId==='local-proxy-port'){
        if(!proxy.parsed.hasProxy)throw new Error('no_proxy');
        proxyEnv=inspectCodexProxyEnv(persisted?proxy.content:patchCodexProxyPort(proxy.content,port)).env;
      }
      const result=await probeProcess(target,{args,signal,deadline,env,...(proxyEnv?{proxyEnv,proxyPort:port,proxyHosts:hostsFor(target)}:{})});
      const afterProxy=await unchanged(target),afterBlocked=await proxyContext(target,port,afterProxy);return afterBlocked||result;
    }catch{return {status:'failed',reason:'context_changed',fresh:false,transportClean:false,detail:'验证环境已变化，本轮未认定修复成功。'};}
  }
  async function prepare(target,{strategy,port,runId}={}){
    strategy=typeof strategy==='string'?strategy:strategy?.id;
    if(strategy==='system-proxy'&&!target?.capabilities?.has('respect_system_proxy'))throw new Error('unsupported_strategy');
    const proxy=await unchanged(target);
    const local=strategy==='local-proxy-port',file=local?path.join(home,'.env'):target.file;
    if((local||port!==undefined)&&await proxyContext(target,port,proxy))throw new Error('proxy_context');
    const stat=await plainFile(file),before=await readFile(file,'utf8');if(hash(before)!==(local?target.proxyHash:target.hash))throw new Error('config_changed');
    const after=local?patchCodexProxyPort(before,port):patchTargetConfig(before,strategy);if(before===after)throw new Error('no_change');
    const id=randomUUID(),prefix='.susuclash-transport-'+id,journal=path.join(home,prefix+'.json'),backup=path.join(home,prefix+'.bak'),tmp=path.join(home,prefix+'.tmp');
    let applied=false,journalFingerprint=null;const artifacts=new Map();const record={id,strategy,file:local?'.env':'config.toml',runId:typeof runId==='string'?runId:null,beforeHash:hash(before),afterHash:hash(after),state:'prepared'};
    async function save(){const saved=await writeAtomicMetadata(journal,JSON.stringify(record),{expected:journalFingerprint,renameMetadata:system.renameMetadata,hook:system.hook,maxBytes:262144});journalFingerprint=saved.fingerprint;}
    async function journalOwned(){return JSON.stringify((await readMetadataSnapshot(journal,{maxBytes:262144})).fingerprint)===JSON.stringify(journalFingerprint);}
    async function createArtifact(name){const handle=await open(name,'wx',stat.mode&0o777);let created;try{created=await handle.stat({bigint:true});}finally{await handle.close();}const saved=await readMetadataSnapshot(name);if(!saved.bytes||saved.bytes.length!==0||saved.fingerprint.dev!==created.dev.toString()||saved.fingerprint.ino!==created.ino.toString())throw new Error('artifact_changed');artifacts.set(name,saved.fingerprint);}
    async function rememberArtifact(name,content){const saved=await readMetadataSnapshot(name),previous=artifacts.get(name);if(!saved.bytes||hash(saved.bytes)!==hash(content)||previous&&(saved.fingerprint.dev!==previous.dev||saved.fingerprint.ino!==previous.ino))throw new Error('artifact_changed');artifacts.set(name,saved.fingerprint);}
    async function removeArtifact(name){const saved=await readMetadataSnapshot(name);if(saved.fingerprint===null)return true;const expected=artifacts.get(name);if(!expected||JSON.stringify(saved.fingerprint)!==JSON.stringify(expected))return false;await rm(name,{force:true});return true;}
    async function matches(digest){await plainDirectory(home);await plainFile(file);return hash(await readFile(file,'utf8'))===digest;}
    const expect=digest=>{if(local){target.proxyHash=digest;target.proxyPortUpdated=digest!==record.beforeHash;}else target.expectedHash=digest;};
    const handle={record:{id,strategy},
      async apply(){await unchanged(target);if((local||port!==undefined)&&await proxyContext(target,port,await proxyFile()))throw new Error('proxy_context');if(!await matches(record.beforeHash))throw new Error('config_changed');
        await createArtifact(backup);await createArtifact(tmp);await copyPermissions(file,[backup,tmp]);await rememberArtifact(backup,'');await rememberArtifact(tmp,'');
        await writeFile(backup,before,{flush:true});if(hash(await readFile(backup,'utf8'))!==record.beforeHash)throw new Error('backup_failed');await rememberArtifact(backup,before);await save();
        await writeFile(tmp,after,{flush:true});await rememberArtifact(tmp,after);await unchanged(target);if((local||port!==undefined)&&await proxyContext(target,port,await proxyFile()))throw new Error('proxy_context');if(!await matches(record.beforeHash))throw new Error('config_changed');
        // WAL says prepared before rename; recovery compares hashes rather than
        // trusting an applied bit, including a crash immediately after rename.
        await rename(tmp,file);applied=true;expect(record.afterHash);record.state='applied';await save();return {ok:true};},
      async readback(){await unchanged(target);return {ok:await matches(record.afterHash)};},
      async rollback(){if(!applied&&!await matches(record.afterHash)){if(await matches(record.beforeHash)){if(!await journalOwned())return {ok:false,reason:'conflict'};for(const artifact of [backup,tmp])if(!await removeArtifact(artifact))return {ok:false,reason:'conflict'};if(!await journalOwned())return {ok:false,reason:'conflict'};if(journalFingerprint!==null)await rm(journal,{force:true});expect(record.beforeHash);return {ok:true};}return {ok:false,reason:'conflict'};}if(!await journalOwned())return {ok:false,reason:'conflict'};const r=await recoverRecord(id,journalFingerprint);if(r.ok){applied=false;expect(record.beforeHash);}return r;},
      async commit(){const currentProxy=await unchanged(target);if((local||port!==undefined)&&await proxyContext(target,port,currentProxy))throw new Error('proxy_context');if(!await matches(record.afterHash))throw new Error('config_changed');record.state='committed';await save();
        // The durable commit is the boundary. Cleanup failure after it must not
        // be reported as an uncommitted transaction which can still be undone.
        if(!await journalOwned())return {ok:true,cleanupDeferred:true};const cleaned=await removeArtifact(backup).catch(()=>false);if(cleaned&&await journalOwned())await rm(journal,{force:true}).catch(()=>{});return {ok:true};}
    };return handle;
  }
  async function recoverRecord(id,expectedJournal){
    if(!/^[\da-f-]{36}$/.test(id))return {ok:false,reason:'invalid_record'};
    const prefix=path.join(home,'.susuclash-transport-'+id);
    try{await plainDirectory(home);const journal=await readMetadataSnapshot(prefix+'.json',{maxBytes:262144});if(journal.bytes===null)throw new Error();if(expectedJournal!==undefined&&JSON.stringify(journal.fingerprint)!==JSON.stringify(expectedJournal))return {ok:false,reason:'conflict'};const r=JSON.parse(journal.bytes.toString('utf8'));
      if(r.id!==id||!['prepared','applied','committed'].includes(r.state)||![r.beforeHash,r.afterHash].every(x=>/^[a-f0-9]{64}$/.test(x))||r.file!==undefined&&!['config.toml','.env'].includes(r.file))throw new Error();
      const file=path.join(home,r.file||'config.toml');
      await plainFile(file);const actual=hash(await readFile(file,'utf8'));
      if(r.state!=='committed'&&actual!==r.beforeHash){if(actual!==r.afterHash)return {ok:false,reason:'conflict'};
        await plainFile(prefix+'.bak');const old=await readFile(prefix+'.bak','utf8');if(hash(old)!==r.beforeHash)throw new Error();
        // A crash after creating a recovery temp must not permanently block the
        // next recovery with EEXIST. Every attempt owns a fresh temporary name.
        const restore=prefix+'.restore-'+randomUUID();
        try{await writeFile(restore,'',{flag:'wx',mode:0o600});await copyPermissions(file,[restore]);await writeFile(restore,old,{flush:true});
          if(hash(await readFile(file,'utf8'))!==r.afterHash||JSON.stringify((await readMetadataSnapshot(prefix+'.json',{maxBytes:262144})).fingerprint)!==JSON.stringify(journal.fingerprint))return {ok:false,reason:'conflict'};await rename(restore,file);
        }finally{await rm(restore,{force:true}).catch(()=>{});}
      }
      if(JSON.stringify((await readMetadataSnapshot(prefix+'.json',{maxBytes:262144})).fingerprint)!==JSON.stringify(journal.fingerprint))return {ok:false,reason:'conflict'};
      for(const [suffix,expectedHash]of [['.bak',r.beforeHash],['.tmp',r.afterHash],['.restore',r.beforeHash]]){const artifact=await readMetadataSnapshot(prefix+suffix);if(artifact.bytes&&hash(artifact.bytes)===expectedHash&&JSON.stringify((await readMetadataSnapshot(prefix+suffix)).fingerprint)===JSON.stringify(artifact.fingerprint)){if(JSON.stringify((await readMetadataSnapshot(prefix+'.json',{maxBytes:262144})).fingerprint)!==JSON.stringify(journal.fingerprint))return {ok:false,reason:'conflict'};await rm(prefix+suffix,{force:true});}}
      if(JSON.stringify((await readMetadataSnapshot(prefix+'.json',{maxBytes:262144})).fingerprint)!==JSON.stringify(journal.fingerprint))return {ok:false,reason:'conflict'};await rm(prefix+'.json',{force:true});return {ok:true};
    }catch{return {ok:false,reason:'recovery_failed'};}
  }
  async function recover(){if(!home)return {ok:true,records:[]};try{await plainDirectory(home);const files=(await readdir(home)).filter(x=>/^\.susuclash-transport-[\da-f-]{36}\.json$/.test(x));const records=[];for(const file of files)records.push(await recoverRecord(file.slice('.susuclash-transport-'.length,-5)));return {ok:records.every(x=>x.ok),records};}catch(e){return e.code==='ENOENT'?{ok:true,records:[]}:{ok:false,reason:'recovery_unavailable'};}}
  async function activate(target,{signal}={}){await unchanged(target);if(activateTarget)return activateTarget(target,{signal});if(target.proxyPortUpdated)return {status:'awaiting_proxy_load',detail:'两次代理文件投影请求已通过；原 Codex 启动入口是否加载该文件尚未确认，已保留原任务。'};return target.client==='cli'?{status:'applied',detail:'后续新启动的命令行会读取已验证的设置；已打开的会话未被中断。'}:{status:'awaiting_idle',detail:'连接测试已通过，当前 Codex 窗口尚未确认采用新设置；已保护正在进行的任务和输入内容。'};}
  async function strategies(target,{port}={}){
    const proxy=await unchanged(target);
    return target.strategies.filter(x=>x.id==='local-proxy-port'?proxy.parsed.port!==port:!proxy.parsed.hasProxy||proxy.parsed.port===port);
  }
  return {discover,probe,prepare,activate,recover,strategies};
}
