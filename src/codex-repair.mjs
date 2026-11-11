import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listeners, webProbe } from './diagnostics.mjs';
import { codexTarget } from './codex-health.mjs';

const PROXY_KEY = /^(\uFEFF?\s*(?:export\s+)?(?:HTTPS_PROXY|HTTP_PROXY|ALL_PROXY)\s*=\s*)(.*?)(\s*(?:#.*)?)$/i;
const digest = data => createHash('sha256').update(data).digest('hex');
const runFile = promisify(execFile);
// On Windows, a replacement file must have the same security descriptor as the
// original before it ever contains secrets. Fail closed if ACLs cannot be copied.
async function matchFilePermissions(source, targets) {
  if (process.platform !== 'win32') return;
  const executable=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const command = '$ErrorActionPreference="Stop"; $a=Get-Acl -LiteralPath $env:CLASH_REPAIR_ACL_SOURCE; foreach($p in @($env:CLASH_REPAIR_ACL_BACKUP,$env:CLASH_REPAIR_ACL_TEMP)){Set-Acl -LiteralPath $p -AclObject $a; if((Get-Acl -LiteralPath $p).Sddl -ne $a.Sddl){throw "ACL verification failed"}}';
  await runFile(executable,['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,maxBuffer:65536,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules'),CLASH_REPAIR_ACL_SOURCE:source,CLASH_REPAIR_ACL_BACKUP:targets[0],CLASH_REPAIR_ACL_TEMP:targets[1]}});
}
async function plainDirectory(directory){
  try {const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())return false;const real=await realpath(directory);return path.resolve(real).toLowerCase()===path.resolve(directory).toLowerCase()}catch{return false}
}


// Only explicit local URLs without credentials, paths, or extra syntax are eligible.
export function inspectProxyLines(content) {
  const lines = content.split(/(?<=\n)/), entries = [];
  for (const line of lines) {
    const match = PROXY_KEY.exec(line.replace(/\r?\n$/, ''));
    if (!match) continue;
    let raw = match[2].trim(), quote = '';
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) { quote = raw[0]; raw = raw.slice(1,-1); }
    const local = /^(https?|socks5h?):\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})(\/?)$/i.exec(raw);
    if (!local || Number(local[3])<1 || Number(local[3])>65535) return null;
    entries.push({oldPort:Number(local[3]), original:raw, quote});
  }
  if (!entries.length || entries.some(x=>x.oldPort!==entries[0].oldPort)) return null;
  return entries;
}
function replacePort(content, oldPort, newPort) {
  return content.split(/(?<=\n)/).map(line=>{
    const ending = /\r?\n$/.exec(line)?.[0] || '', body = ending ? line.slice(0,-ending.length) : line;
    const match = PROXY_KEY.exec(body); if (!match) return line;
    const replaced = match[2].replace(new RegExp(':'+oldPort+'(?=/|[\'"\\s]*$)'), ':'+newPort);
    if (replaced === match[2]) throw new Error('代理配置未能安全识别。');
    return match[1]+replaced+match[3]+ending;
  }).join('');
}

/** Explicit preview and confirmation only. Never emits environment contents or credentials. */
export function createCodexRepair({core, directory=process.env.USERPROFILE ? path.join(process.env.USERPROFILE,'.codex') : null, readListeners=listeners, probe=webProbe, copyPermissions=matchFilePermissions, now=()=>Date.now()}={}) {
  let plan = null;
  async function examine(allowOccupiedOldPort=false) {
    if (!directory || !core || typeof core.applyConfig !== 'function') return {eligible:false, reason:'当前客户端无法确认受控内核，未提供自动修改。'};
    if(!await plainDirectory(directory)) return {eligible:false,reason:'Codex 配置目录无法安全识别，请手动检查。'};
    const target = path.join(directory,'.env'); let content, stat;
    try { stat=await lstat(target); if(!stat.isFile() || stat.isSymbolicLink() || stat.size>1024*1024) return {eligible:false,reason:'Codex 配置文件无法安全识别，请手动检查。'}; content=await readFile(target,'utf8'); }
    catch { return {eligible:false,reason:'无法读取 Codex 代理配置，请手动检查。'}; }
    const entries=inspectProxyLines(content);
    if(!entries) return {eligible:false,reason:'未发现可安全处理的一致本机固定代理；自定义代理不会自动修改。'};
    let config; try { if (typeof core.status!=='function' || core.status()?.state!=='running') return {eligible:false,reason:'代理内核尚未运行，请先启动内核并复查。'}; config=await core.call('GET','/configs'); } catch { return {eligible:false,reason:'代理内核不可用，请先启动内核并复查。'}; }
    const newPort=Number(config?.['mixed-port']),oldPort=entries[0].oldPort;
    if(!Number.isInteger(newPort)||newPort<1||newPort>65535) return {eligible:false,reason:'无法确认当前代理端口。'};
    if(oldPort===newPort) return {eligible:false,reason:'Codex 固定代理端口与当前端口一致；请继续检查应用内连接。'};
    const owners=await readListeners([oldPort,newPort]);
    if(!owners || (!allowOccupiedOldPort && owners.some(x=>x.port===oldPort)) || !(typeof core.processId==='function' && Number.isInteger(core.processId()) && owners.some(x=>x.port===newPort && Number(x.pid)===core.processId()))) return {eligible:false,reason:'旧端口仍在使用或当前端口未确认；为避免覆盖其他代理，未提供自动修改。'};
    const status=await probe(codexTarget,'http://127.0.0.1:'+newPort+'/',{short:true});
    if(!(status>=200&&status<400)) return {eligible:false,reason:'当前代理访问目标站点尚未通过，未提供自动修改。'};
    return {eligible:true,target,content,oldPort,newPort,hash:digest(content),mode:stat.mode,dev:stat.dev,ino:stat.ino,oldOwners:JSON.stringify(owners.filter(x=>x.port===oldPort).map(x=>({pid:x.pid,address:x.address})).sort((a,b)=>String(a.pid).localeCompare(String(b.pid))))};
  }
  async function preview({allowOccupiedOldPort=false}={}){
    plan=null; const result=await examine(allowOccupiedOldPort===true); if(!result.eligible)return result;
    const token=randomBytes(24).toString('base64url'); plan={...result,token,allowOccupiedOldPort:allowOccupiedOldPort===true,expires:now()+60000};
    return {eligible:true,token,oldPort:result.oldPort,newPort:result.newPort,oldPortOccupied:result.oldOwners!=='[]',expiresAt:new Date(plan.expires).toISOString(),summary:'备份 Codex 配置，仅将已有本机固定代理端口同步到当前端口。请完全退出并重开 Codex 后，在应用内验证。'};
  }
  async function apply(token){
    const saved=plan; plan=null;
    if(!saved||typeof token!=='string'||token!==saved.token||now()>saved.expires) return {ok:false,message:'修复预览已失效，请重新检查。'};
    const current=await examine(saved.allowOccupiedOldPort);
    if(!current.eligible||current.hash!==saved.hash||current.oldOwners!==saved.oldOwners||current.oldPort!==saved.oldPort||current.newPort!==saved.newPort||current.dev!==saved.dev||current.ino!==saved.ino) return {ok:false,message:'检测条件或配置已变化，请重新检查；未修改配置。'};
    const backup=path.join(directory,'.env.clash-backup-'+now()+'-'+randomBytes(6).toString('hex'));
    const tmp=path.join(directory,'.env.clash-tmp-'+randomBytes(8).toString('hex'));
    let backupReady=false;
    try {
      const changed=replacePort(current.content,current.oldPort,current.newPort);
      // Empty files receive the original ACL before either is populated.
      await writeFile(backup,'',{flag:'wx',mode:current.mode & 0o777});
      await writeFile(tmp,'',{flag:'wx',mode:current.mode & 0o777});
      await copyPermissions(current.target,[backup,tmp]);
      if(!await plainDirectory(directory)) return {ok:false,message:'配置目录已变化；原配置未修改。'};
      const stat=await lstat(current.target);
      if(!stat.isFile() || stat.isSymbolicLink() || stat.dev!==current.dev || stat.ino!==current.ino || digest(await readFile(current.target,'utf8'))!==current.hash) return {ok:false,message:'配置已变化，请重新检查；原配置未修改。'};
      await writeFile(backup,current.content,{flag:'w'});
      if(digest(await readFile(backup,'utf8'))!==current.hash) return {ok:false,message:'配置备份校验失败；原配置未修改。'};
      backupReady=true;
      await writeFile(tmp,changed,{flag:'w'});
      const finalStat=await lstat(current.target);
      if(!await plainDirectory(directory) || !finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.dev!==current.dev || finalStat.ino!==current.ino || digest(await readFile(current.target,'utf8'))!==current.hash) return {ok:false,message:'配置已变化，请重新检查；原配置未修改。'};
      await rename(tmp,current.target);
      return {ok:true,backupName:path.basename(backup),message:'已备份并更新 Codex 的本机代理端口。请完全退出并重开 Codex，再在应用内验证。'};
    } catch { return {ok:false,message:'无法安全更新配置；请检查权限并手动处理。'}; }
    finally { await rm(tmp,{force:true}).catch(()=>{}); if(!backupReady) await rm(backup,{force:true}).catch(()=>{}); }
  }
  return {preview,apply};
}
