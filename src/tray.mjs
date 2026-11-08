import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./tray.ps1', import.meta.url));

export function createTrayPreferences({directory} = {}) {
  if (!directory) throw new TypeError('directory is required');
  const filename = path.join(directory, 'window.json');
  let tail = Promise.resolve();
  let available = null;
  async function get() {
    try {
      const parsed = JSON.parse(await readFile(filename,'utf8'));
      if (typeof parsed.closeToTray !== 'boolean') throw new Error('invalid preference');
      return {closeToTray:parsed.closeToTray, available};
    } catch (error) {
      if (error.code === 'ENOENT') return {closeToTray:true, available};
      throw new Error('无法读取窗口关闭设置。');
    }
  }
  function set(input) {
    if (typeof input?.closeToTray !== 'boolean') return Promise.reject(new TypeError('closeToTray must be boolean'));
    const next = tail.then(async()=>{
      if (available !== true) throw new Error('系统托盘尚不可用。');
      await mkdir(directory,{recursive:true});
      const temp=filename+'.'+randomBytes(8).toString('hex')+'.tmp';
      try { await writeFile(temp,JSON.stringify({closeToTray:input.closeToTray}),{mode:0o600,flag:'wx'}); await rename(temp,filename); }
      finally { await rm(temp,{force:true}).catch(()=>{}); }
      return {closeToTray:input.closeToTray, available};
    });
    tail=next.catch(()=>{});
    return next;
  }
  function setAvailability(value) {
    if (value !== null && typeof value !== 'boolean') throw new TypeError('availability must be true, false or null');
    available = value;
  }
  return {get,set,setAvailability};
}

export function createTray({onOpen=()=>{}, onExit=()=>{}, onFailure=()=>{}, launch=spawn, startupTimeoutMs=8000} = {}) {
  let child=null, stream=null, stopping=false, started=false, closed=null;
  const stopFile=path.join(os.tmpdir(),'clash-tray-stop-'+randomBytes(16).toString('hex'));
  function notifyFailure() { if (!stopping) onFailure(new Error('系统托盘不可用，客户端将安全退出。')); }
  async function start() {
    if (started) return;
    if (process.platform !== 'win32' && launch === spawn) throw new Error('系统托盘仅支持 Windows。');
    const exe=path.win32.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    child=launch(exe,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-STA','-File',script,'-ParentPid',String(process.pid),'-StopFile',stopFile],
      {windowsHide:true,stdio:['ignore','pipe','ignore']});
    const processHandle=child;
    closed=new Promise(resolve=>processHandle.once('close',resolve));
    stream=readline.createInterface({input:processHandle.stdout});
    await new Promise((resolve,reject)=>{
      let settled=false;
      const timer=setTimeout(()=>finish(new Error('系统托盘启动超时。')),startupTimeoutMs);
      function finish(error) { if(settled)return; settled=true; clearTimeout(timer); if(error)reject(error);else resolve(); }
      processHandle.once('error',()=>{finish(new Error('系统托盘启动失败。')); if(started)notifyFailure();});
      processHandle.once('close',()=>{if(!started)finish(new Error('系统托盘启动失败。')); else notifyFailure();});
      stream.on('line',line=>{
        if(line==='READY'){started=true;finish();}
        else if(line==='OPEN' && started && !stopping)onOpen();
        else if(line==='EXIT' && started && !stopping)onExit();
      });
    }).catch(error=>{stopping=true;processHandle.kill();stream?.close();throw error;});
  }
  async function stop() {
    if (!child) return;
    stopping=true;
    const processHandle=child;
    child=null;
    try { await writeFile(stopFile,'stop',{flag:'wx'}); } catch { /* Kill below if marker creation fails. */ }
    let timeout;
    await Promise.race([closed, new Promise(resolve=>{timeout=setTimeout(()=>{processHandle.kill();resolve();},2500);})]);
    clearTimeout(timeout);
    stream?.close(); stream=null;
    await rm(stopFile,{force:true}).catch(()=>{});
  }
  return {start,stop};
}
