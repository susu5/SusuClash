import path from 'node:path';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import tls from 'node:tls';
import { candidateIdentity } from './netfix-rules.mjs';

const execute=promisify(execFile);
export const NETFIX_TARGETS=['https://api.openai.com/v1/models','https://chatgpt.com/backend-api/','https://api.openai.com/v1/models'];
const transportTarget=/^codex_(?:core::(?:responses_retry(?:$|::)|client(?:$|::)|session::startup_prewarm(?:$|::))|api::|client::)/;
const cPattern=/\b(?:401|403|429|unauthorized|invalid_token|quota|subscription)\b|token[^\n]{0,16}expir|rate[\s_-]?limit/i;
const bPattern=/responses_websocket|websocket|error_is_connect|tls|handshake|connection reset|broken pipe|etimedout|econnrefused|timed?\s?out|failed to connect/i;

export function summarizeNetfixLogs(rows,{now=Date.now(),truncated=false}={}) {
  const result={available:true,complete:!truncated,cHits24h:0,bHits15m:0,samples:[],scope:'local_unattributed',truncated};
  for(const row of rows||[]) {
    const at=Number(row.ts)*1000;
    if(!Number.isFinite(at)||at<now-86400000||at>now+5000||!['WARN','ERROR'].includes(row.level)||!transportTarget.test(String(row.target||'')))continue;
    const body=String(row.feedback_log_body||'').slice(0,4096),c=cPattern.test(body),b=at>=now-900000&&bPattern.test(body);
    if(c)result.cHits24h++;
    if(b)result.bHits15m++;
    if((c||b)&&result.samples.length<8)result.samples.push({at:new Date(at).toISOString(),type:c?'auth_or_quota':'transport'});
  }
  return result;
}

async function plainFile(file,max=1048576) {
  const meta=await lstat(file);
  if(!meta.isFile()||meta.isSymbolicLink()||meta.size>max||path.resolve(await realpath(file)).toLowerCase()!==path.resolve(file).toLowerCase())throw new Error('unsafe_file');
  return meta;
}

export async function readNetfixAuth({directory,now=Date.now()}={}) {
  const unavailable={available:false,present:false,expired:null,expAt:null};
  if(!directory)return unavailable;
  const file=path.join(directory,'auth.json');
  try {
    await plainFile(file,262144);
    const data=JSON.parse(await readFile(file,'utf8'));
    // Only exp leaves this function. No credential or payload is returned.
    const token=data?.tokens?.access_token;
    if(typeof token!=='string'||token.split('.').length!==3)return {...unavailable,present:true};
    const payload=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
    if(!Number.isFinite(payload.exp)||payload.exp<0||payload.exp>253402300799)return {...unavailable,present:true};
    return {available:true,present:true,expired:payload.exp*1000<now,expAt:new Date(payload.exp*1000).toISOString()};
  }catch(error){return error.code==='ENOENT'?{available:true,present:false,expired:null,expAt:null}:unavailable;}
}

export async function readNetfixLogs({directory,now=Date.now()}={}) {
  let db;
  try {
    const files=(await readdir(directory)).filter(n=>/^logs_\d+\.sqlite$/.test(n)).sort((a,b)=>Number(b.match(/\d+/)[0])-Number(a.match(/\d+/)[0]));
    if(!files.length)throw new Error();
    const file=path.join(directory,files[0]);await plainFile(file,512*1024*1024);
    const {DatabaseSync}=await import('node:sqlite');
    db=new DatabaseSync(file,{readOnly:true,timeout:300});
    const columns=new Set(db.prepare('PRAGMA table_info(logs)').all().map(x=>x.name));
    if(!['id','ts','level','target','feedback_log_body'].every(x=>columns.has(x)))throw new Error();
    db.exec('BEGIN');
    const rows=db.prepare(`SELECT ts,level,target,substr(feedback_log_body,1,4096) AS feedback_log_body FROM logs WHERE ts>=? AND level IN ('WARN','ERROR') AND (target LIKE 'codex_core::responses_retry%' OR target LIKE 'codex_core::client%' OR target LIKE 'codex_core::session::startup_prewarm%' OR target LIKE 'codex_api::%' OR target LIKE 'codex_client::%') ORDER BY id DESC LIMIT 4001`).all(Math.floor((now-86400000)/1000));
    return summarizeNetfixLogs(rows.slice(0,4000),{now,truncated:rows.length>4000});
  }catch{return {available:false,complete:false,cHits24h:0,bHits15m:0,samples:[],scope:'local_unattributed'};}
  finally{db?.close();}
}

export async function netfixLogs(options={}) {
  try {
    const result=await execute(process.execPath,[fileURLToPath(import.meta.url),'--netfix-logs',JSON.stringify({directory:options.directory,now:options.now})],{windowsHide:true,timeout:4000,signal:options.signal,maxBuffer:16384});
    return JSON.parse(result.stdout);
  }catch{return {available:false,complete:false,cHits24h:0,bHits15m:0,samples:[]};}
}

// No ambient proxy, authentication, cookies, redirects or disabled certificate
// verification. The CONNECT destination and URLs are a fixed allowlist.
export function probeNetfix({port=null,target=NETFIX_TARGETS[0],signal,timeoutMs=6000}={}) {
  if(!NETFIX_TARGETS.includes(target)||port!==null&&(!Number.isInteger(port)||port<1||port>65535))return Promise.resolve({ok:false,error:'unsupported_target',code:null,ms:0});
  return new Promise(resolve=>{
    const started=Date.now(),url=new URL(target);let request,socket,done=false,buffer='';
    const finish=(ok,code=null,error=null,cancelled=false)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);request?.destroy();socket?.destroy();resolve({ok,code,error,ms:Date.now()-started,cancelled});};
    const abort=()=>finish(false,null,'cancelled',true);
    const timer=setTimeout(()=>finish(false,null,'Timeout'),Math.max(50,Math.min(10000,timeoutMs)));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();
    const secure=underlying=>{
      socket=tls.connect({...underlying?{socket:underlying}:{host:url.hostname,port:443},servername:url.hostname,rejectUnauthorized:true,ALPNProtocols:['http/1.1']});
      socket.once('secureConnect',()=>socket.write('GET '+url.pathname+' HTTP/1.1\r\nHost: '+url.hostname+'\r\nUser-Agent: susuclash-netfix/1.0\r\nConnection: close\r\n\r\n'));
      socket.on('data',data=>{buffer+=data.toString('latin1');const end=buffer.indexOf('\r\n');if(end>=0){if(end>8192)return finish(false,null,'invalid_http');const match=/^HTTP\/1\.[01] ([0-9]{3})(?: |$)/.exec(buffer.slice(0,end));if(!match)return finish(false,null,'invalid_http');const code=Number(match[1]);finish(code>=200&&code<500,code,code>=500?'HTTP '+code:null);}else if(buffer.length>8192)finish(false,null,'invalid_http');});
      socket.once('error',error=>finish(false,null,/CERT|TLS|SSL/.test(error.code||'')?'TLS certificate or handshake failed':'connection_failed'));
      socket.once('end',()=>finish(false,null,'incomplete_http'));
    };
    if(port===null)secure(null);
    else {
      request=http.request({host:'127.0.0.1',port,method:'CONNECT',path:url.hostname+':443',headers:{Host:url.hostname+':443'},agent:false});
      request.once('connect',(response,tunnel,head)=>{if(response.statusCode!==200){tunnel.destroy();return finish(false,response.statusCode,'proxy_connect_failed');}if(head.length)tunnel.unshift(head);secure(tunnel);});
      request.once('response',()=>finish(false,null,'proxy_protocol_failed'));
      request.once('error',()=>finish(false,null,'connection_failed'));
      request.end();
    }
  });
}

const windowsCollection=String.raw`
$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class NetfixEnv {
 [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr r1,peb,r2,r3,pid,r4; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint a,bool b,int p);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,int n,out IntPtr r);
 [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h,out bool wow);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int c,ref PBI p,int n,out int r);
 static long Ptr(IntPtr h,long a){byte[] b=new byte[8];IntPtr r;return ReadProcessMemory(h,new IntPtr(a),b,8,out r)&&r.ToInt64()==8?BitConverter.ToInt64(b,0):0;}
 static bool SafeBypass(string value){if(value.Length>8192)return false;if(String.IsNullOrWhiteSpace(value))return true;string[] patterns=value.Split(',');if(patterns.Length>256)return false;foreach(string s in patterns){string p=s.Trim().ToLowerInvariant();if(p=="localhost"||p==".localhost"||p==".local"||p=="127.0.0.1"||p=="::1"||p=="[::1]")continue;System.Net.IPAddress address;if(!System.Net.IPAddress.TryParse(p,out address)||address.AddressFamily!=System.Net.Sockets.AddressFamily.InterNetwork)return false;byte[] b=address.GetAddressBytes();if(!(b[0]==127||b[0]==10||b[0]==172&&b[1]>=16&&b[1]<=31||b[0]==192&&b[1]==168||b[0]==169&&b[1]==254))return false;}return true;}
 public static string Proxy(int pid){IntPtr h=OpenProcess(0x410,false,pid);if(h==IntPtr.Zero)return null;try{bool wow;if(!IsWow64Process(h,out wow)||wow||IntPtr.Size!=8)return null;PBI p=new PBI();int r;if(NtQueryInformationProcess(h,0,ref p,Marshal.SizeOf(p),out r)!=0)return null;long pp=Ptr(h,p.peb.ToInt64()+0x20),env=Ptr(h,pp+0x80);if(pp==0||env==0)return null;byte[] all=new byte[131072];int count=0;bool end=false;while(count<all.Length&&!end){byte[] b=new byte[4096];IntPtr got;ReadProcessMemory(h,new IntPtr(env+count),b,b.Length,out got);int n=(int)got.ToInt64();if(n<=0)break;Array.Copy(b,0,all,count,n);for(int i=Math.Max(0,count-2);i<count+n-3;i+=2)if(all[i]==0&&all[i+1]==0&&all[i+2]==0&&all[i+3]==0){count=i;end=true;break;}if(!end)count+=n;}if(!end)return null;int port=0;var seen=new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);foreach(string s in Encoding.Unicode.GetString(all,0,count).Split('\0')){int e=s.IndexOf('=');if(e<=0)continue;string k=s.Substring(0,e),v=s.Substring(e+1);bool no=k.Equals("NO_PROXY",StringComparison.OrdinalIgnoreCase),proxy=k.Equals("HTTP_PROXY",StringComparison.OrdinalIgnoreCase)||k.Equals("HTTPS_PROXY",StringComparison.OrdinalIgnoreCase)||k.Equals("ALL_PROXY",StringComparison.OrdinalIgnoreCase);if(!no&&!proxy)continue;if(!seen.Add(k))return "unsupported";if(no){if(!SafeBypass(v))return "unsupported";continue;}if(v.Length==0)continue;var m=System.Text.RegularExpressions.Regex.Match(v,@"^http://(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})/?$",System.Text.RegularExpressions.RegexOptions.IgnoreCase);int found;if(!m.Success||!Int32.TryParse(m.Groups[1].Value,out found)||found<1||found>65535||port!=0&&port!=found)return "unsupported";port=found;}return port==0?"none":"port:"+port;}finally{CloseHandle(h);}}
}
'@
$names=@{}; Get-Process -ErrorAction SilentlyContinue | ForEach-Object {$names[[int]$_.Id]=$_.ProcessName}
$listeners=@(); foreach($line in (& "$env:SystemRoot\System32\netstat.exe" -ano -p TCP)) { $p=$line.Trim() -split '\s+'; if($p.Length -ge 5 -and $p[3] -eq 'LISTENING' -and $p[1] -match '^(.*):(\d+)$'){ $a=$matches[1].Trim('[',']'); $port=[int]$matches[2]; $owner=[int]$p[4]; $listeners+=@{port=$port;pid=$owner;name=[string]$names[$owner];address=$a} } }
$processes=@(); foreach($p in (Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.ProcessName -match '^(?:codex|OpenAI\.Codex)$'})) { $summary=[NetfixEnv]::Proxy($p.Id);$port=$null;$known=$null -ne $summary -and $summary -ne 'unsupported';if($summary -match '^port:([0-9]{1,5})$'){$port=[int]$matches[1]}; $processes+=@{available=$known;port=$port;unsupported=$summary -eq 'unsupported'} }
$proxy=@{available=$false;enabled=$false;automatic=$false;supported=$false;host=$null;port=$null};try{$r=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings';$automatic=!!$r.AutoConfigURL -or $r.AutoDetect -eq 1;try{$connections=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Connections';$flags=$connections.DefaultConnectionSettings;if($flags -and $flags.Length -gt 8){$automatic=$automatic -or (($flags[8] -band 12) -ne 0)}}catch{};$enabled=$r.ProxyEnable -eq 1;$proxy=@{available=$true;enabled=$enabled;automatic=$automatic;supported=(-not $enabled -and -not $automatic);host=$null;port=$null};if($enabled -and -not $automatic -and $r.ProxyServer -match '^(?:http://)?(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$'){$hostValue=$matches[1];$portValue=[int]$matches[2];$safe=$true;foreach($b in ([string]$r.ProxyOverride -split ';')){if($b.Trim() -and $b.Trim() -notmatch '^(?:<local>|localhost|127\.0\.0\.1|\[::1\]|10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+)$'){$safe=$false}};$proxy.host=$hostValue;$proxy.port=$portValue;$proxy.supported=$safe}}catch{}
$verge=@();foreach($n in @('verge.yaml','clash-verge.yaml')){$f=Join-Path $env:APPDATA ('io.github.clash-verge-rev.clash-verge-rev\'+$n);if(Test-Path -LiteralPath $f -PathType Leaf){$raw=Get-Content -LiteralPath $f -Raw;if($raw.Length -lt 1048576 -and $raw -match '(?m)^\s*(?:verge_)?mixed-port:\s*([0-9]{1,5})\s*$'){$verge += [int]$matches[1]}}}
$ports=@($processes|ForEach-Object {$_.port}|Select-Object -Unique);$available=@($processes|Where-Object {-not $_.available}).Count -eq 0;$missingProxy=@($processes|Where-Object {$null -eq $_.port}).Count;$proc=@{available=$available;running=$processes.Count -gt 0;port=$(if($ports.Count -eq 1){$ports[0]}else{$null});ambiguous=$ports.Count -gt 1 -or ($missingProxy -gt 0 -and $ports.Count -gt 0);unsupported=@($processes|Where-Object {$_.unsupported}).Count -gt 0}
@{available=$true;listeners=$listeners;process=$proc;systemProxy=$proxy;vergePorts=$verge;actualRewrite=$false}|ConvertTo-Json -Compress -Depth 6
`;

export async function collectNetfixHost({signal}={}) {
  if(process.platform!=='win32')return {available:false,listeners:[],process:{available:false},systemProxy:{enabled:false},vergePorts:[]};
  try {
    const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const result=await execute(ps,['-NoProfile','-NonInteractive','-Command',windowsCollection],{windowsHide:true,timeout:10000,maxBuffer:1024*1024,signal,encoding:'utf8'});
    const data=JSON.parse(result.stdout.replace(/^\uFEFF/,''));
    if(!Array.isArray(data.listeners)||!Array.isArray(data.vergePorts))throw new Error();
    return data;
  }catch{return {available:false,listeners:[],process:{available:false},systemProxy:{enabled:false},vergePorts:[]};}
}

export function hostFingerprint(host,port) {
  return JSON.stringify({candidate:candidateIdentity(host,port),process:host.process,systemProxy:host.systemProxy,vergePorts:host.vergePorts});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--netfix-logs') {
  let options={};try{options=JSON.parse(process.argv[3]||'{}');}catch{}
  process.stdout.write(JSON.stringify(await readNetfixLogs(options)));
}
