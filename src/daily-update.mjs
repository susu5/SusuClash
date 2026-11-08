import {randomBytes} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {RELEASE_PAGE} from './update-check.mjs';

const DAY=24*60*60*1000;
const statuses=new Set(['available','up_to_date','unreleased','invalid_release','network_error','timeout','service_error','rate_limited']);
const validVersion = value => typeof value==='string' && /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/.test(value);

// Only non-sensitive update preferences and sanitized release status are stored.
// A failed storage operation never enables an automatic network request.
export function createDailyUpdate({directory,checker,currentVersion,now=()=>Date.now(),intervalMs=DAY,
  setTimer=setTimeout,clearTimer=clearTimeout,waitUntilReady=async()=>{}}={}) {
  if(!directory || !checker || typeof checker.check!=='function' || !validVersion(currentVersion)) throw new TypeError('invalid update service configuration');
  if(!Number.isFinite(intervalMs) || intervalMs<1) throw new TypeError('invalid interval');
  const file=path.join(directory,'application-update.json');
  let state={enabled:true,lastCheckedAt:null,lastResult:null}, storageError=null, started=false, schedulerReady=false, stopped=false, timer=null, pending=null, tail=Promise.resolve();
  function sanitize(value) {
    if(!value || !statuses.has(value.status)) return null;
    const current=validVersion(value.currentVersion)?value.currentVersion:null;
    const latest=validVersion(value.latestVersion)?value.latestVersion:null;
    if(current!==currentVersion || (['available','up_to_date'].includes(value.status) && !latest)) return null;
    return {status:value.status,currentVersion:current,latestVersion:latest,releaseUrl:RELEASE_PAGE,downloadUrl:null};
  }
  const ready=(async()=>{
    try {
      const parsed=JSON.parse(await readFile(file,'utf8'));
      if(!parsed || typeof parsed.enabled!=='boolean' || !(parsed.lastCheckedAt===null || (typeof parsed.lastCheckedAt==='string' && Number.isFinite(Date.parse(parsed.lastCheckedAt))))) throw Error('invalid data');
      const lastResult=parsed.lastResult===null?null:sanitize(parsed.lastResult);
      // A new installed version should get a fresh check instead of displaying
      // stale results from an older version.
      const oldVersion=parsed.lastResult && parsed.lastResult.currentVersion!==currentVersion;
      state={enabled:parsed.enabled,lastCheckedAt:oldVersion?null:parsed.lastCheckedAt,lastResult:oldVersion?null:lastResult};
    } catch(error) {
      if(error.code!=='ENOENT') { state={enabled:false,lastCheckedAt:null,lastResult:null};storageError='无法读取自动检查设置，请重新设置。'; }
    }
  })();
  function serial(fn) { const next=tail.then(()=>ready).then(fn);tail=next.catch(()=>{});return next; }
  async function save(next) {
    await mkdir(directory,{recursive:true});
    const temporary=file+'.'+randomBytes(8).toString('hex')+'.tmp';
    try {await writeFile(temporary,JSON.stringify(next),{flag:'wx',mode:0o600});await rename(temporary,file);}
    finally {await rm(temporary,{force:true}).catch(()=>{});}
  }
  function delay() {
    const previous=state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : null;
    const current=now();
    if(previous===null || previous>current) return 0;
    return Math.min(intervalMs,Math.max(0,previous+intervalMs-current));
  }
  function view() {
    const next=state.enabled ? new Date(now()+delay()).toISOString() : null;
    return {enabled:state.enabled,lastCheckedAt:state.lastCheckedAt,nextCheckAt:next,lastResult:state.lastResult,checking:!!pending,error:storageError};
  }
  function reschedule() {
    if(timer!==null) clearTimer(timer);timer=null;
    if(!started || !schedulerReady || stopped || !state.enabled || pending) return;
    timer=setTimer(()=>{timer=null;void checkNow({automatic:true}).catch(()=>{});},delay());
    timer?.unref?.();
  }
  async function get(){await ready;await tail;return view();}
  async function set({enabled}={}) {
    if(typeof enabled!=='boolean') throw new TypeError('自动更新设置无效。');
    return serial(async()=>{
      if(stopped) throw new Error('客户端正在退出。');
      const next={...state,enabled};await save(next);state=next;storageError=null;reschedule();return view();
    });
  }
  async function begin(automatic){
    const run=await serial(async()=>{
      if(stopped || (automatic && (!state.enabled || delay()>0))) return false;
      const next={...state,lastCheckedAt:new Date(now()).toISOString(),lastResult:null};
      try {await save(next);} catch {
        storageError='无法保存检查时间，自动检查已暂停。';
        state={...state,enabled:false};
        if(automatic)return false;
        // An explicit manual check remains available despite storage failure.
        state={...next,enabled:false};return true;
      }
      state=next;storageError=null;return true;
    });
    if(!run || stopped) return null;
    let result;
    try {result=sanitize(await checker.check());} catch {result=null;}
    result ||= {status:'service_error',currentVersion,latestVersion:null,releaseUrl:RELEASE_PAGE,downloadUrl:null};
    if(!stopped) await serial(async()=>{const next={...state,lastResult:result};try{await save(next);state=next;storageError=null}catch{storageError='无法保存检查结果。';}});
    return result;
  }
  function checkNow({automatic=false}={}) {
    if(pending) return automatic?pending:pending.then(value=>value??checkNow());
    const operation=begin(automatic);
    pending=operation.finally(()=>{pending=null;reschedule();});
    return pending;
  }
  function start() {
    if(started || stopped)return;
    started=true;
    void ready.then(()=>waitUntilReady()).then(()=>{if(!stopped){schedulerReady=true;reschedule();}}).catch(()=>{});
  }
  function stop() {stopped=true;if(timer!==null)clearTimer(timer);timer=null;checker.cancel?.();}
  return {start,stop,get,set,checkNow};
}
