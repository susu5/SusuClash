import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

// A manual check only. The release page is fixed rather than trusting links in
// remote metadata, and no installer is fetched or executed by the client.
export const RELEASE_PAGE = 'https://github.com/susu5/SusuClash/releases';
const API_URL = 'https://api.github.com/repos/susu5/SusuClash/releases/latest';
const execute = promisify(execFile);
const MAX_RESPONSE = 256 * 1024;

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}
function compare(a, b) {
  for (let i=0;i<3;i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

// Use only a fixed HTTPS URL and either an explicitly validated local proxy or
// direct networking. Ignore user curl config and ambient proxy credentials.
async function githubRequest({proxyPort, signal, timeoutMs}) {
  const executable = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe') : 'curl';
  const args = ['-q','--silent','--show-error','--connect-timeout','4',
    '--max-time',String(Math.max(1, Math.ceil(timeoutMs/1000))), '--max-filesize',String(MAX_RESPONSE),
    '--header','Accept: application/vnd.github+json', '--user-agent','SusuClash-update-check',
    '--write-out','\n%{http_code}'];
  if (Number.isInteger(proxyPort) && proxyPort >= 1 && proxyPort <= 65535) {
    args.push('--proxy','http://127.0.0.1:' + proxyPort, '--noproxy','');
  } else args.push('--noproxy','*');
  args.push(API_URL);
  const env = {};
  for (const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP']) if (process.env[key]) env[key]=process.env[key];
  try {
    const {stdout} = await execute(executable,args,{windowsHide:true,timeout:timeoutMs,signal,maxBuffer:MAX_RESPONSE+1024,env});
    const match = /\n(\d{3})$/.exec(stdout);
    if (!match) throw new Error('invalid response');
    return {status:Number(match[1]),body:stdout.slice(0,match.index)};
  } catch(error) {
    if (signal?.aborted || error?.killed || error?.code === 28 || error?.name === 'AbortError') {
      const timed = new Error('timeout');timed.code='UPDATE_TIMEOUT';throw timed;
    }
    throw new Error('request failed');
  }
}

export function createUpdateChecker({currentVersion, request = githubRequest, getManagedProxy = async()=>null, timeoutMs=10000}={}) {
  const installed = parseVersion(currentVersion);
  let pending = null;
  const result = (status, latestVersion=null) => ({status,currentVersion:installed ? installed.join('.') : null,latestVersion,releaseUrl:RELEASE_PAGE,downloadUrl:null});
  async function run() {
    if (!installed) return result('service_error');
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();const error=new Error('timeout');error.code='UPDATE_TIMEOUT';reject(error)},timeoutMs)});
    try {
      const response = await Promise.race([(async()=>{
        let proxyPort=null;
        try { const value=await getManagedProxy();if(Number.isInteger(value)&&value>=1&&value<=65535)proxyPort=value; } catch { /* Fall back to a direct request. */ }
        if(controller.signal.aborted){const error=new Error('timeout');error.code='UPDATE_TIMEOUT';throw error}
        return request({proxyPort,signal:controller.signal,timeoutMs});
      })(),deadline]);
      if (response?.status===404) return result('unreleased');
      if (response?.status===429) return result('rate_limited');
      if (response?.status===403) {
        let info;try{info=JSON.parse(response.body)}catch{}
        return result(typeof info?.message==='string' && /rate limit/i.test(info.message) ? 'rate_limited':'service_error');
      }
      if (response?.status!==200 || typeof response.body!=='string' || Buffer.byteLength(response.body,'utf8')>MAX_RESPONSE) return result('service_error');
      let release;try{release=JSON.parse(response.body)}catch{return result('invalid_release')}
      const latest=parseVersion(release?.tag_name);
      if(!latest || release?.draft!==false || release?.prerelease!==false) return result('invalid_release');
      return result(compare(latest,installed)>0?'available':'up_to_date',latest.join('.'));
    } catch(error) {
      return result(error?.code==='UPDATE_TIMEOUT' || controller.signal.aborted ? 'timeout':'network_error');
    } finally {clearTimeout(timer)}
  }
  function check(){
    if (!pending) pending=run().finally(()=>{pending=null});
    return pending;
  }
  return {check};
}
