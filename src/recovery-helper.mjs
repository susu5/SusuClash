import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const self=fileURLToPath(import.meta.url),desktop=fileURLToPath(new URL('./desktop.mjs',import.meta.url));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

/** Independent process acknowledges handoff before its parent starts shutdown. */
export async function prepareClientRestart(directory,{launch=spawn,pid=process.pid}={}) {
  await mkdir(directory,{recursive:true});
  const nonce=randomBytes(16).toString('hex'),file=path.join(directory,'restart-'+nonce+'.json');
  await writeFile(file,JSON.stringify({parentPid:pid,nonce,at:new Date().toISOString()}),{mode:0o600,flag:'wx'});
  const helper=launch(process.execPath,[self,'--recover',file,nonce],{detached:true,windowsHide:true,stdio:'ignore'});
  let error=false;helper.once('error',()=>{error=true;});helper.unref();
  const end=Date.now()+5000;
  while(Date.now()<end&&!error){
    const ack=await readFile(file+'.ready','utf8').catch(()=>null);
    if(ack===nonce)return {helperPid:helper.pid,checkpoint:'客户端重开后将重新检查代理基础连接。'};
    await wait(80);
  }
  await unlink(file).catch(()=>{});
  throw new Error('独立恢复助手未确认接手，当前客户端保持运行。请手动重开。');
}

async function recover(file,nonce){
  if(!path.isAbsolute(file)||!/^[a-f0-9]{32}$/.test(nonce)||path.basename(file)!=='restart-'+nonce+'.json')return;
  const state=JSON.parse(await readFile(file,'utf8'));
  if(state.nonce!==nonce||!Number.isSafeInteger(state.parentPid)||state.parentPid<=0||Date.now()-Date.parse(state.at)>10000)return;
  await writeFile(file+'.ready',nonce,{mode:0o600,flag:'wx'});
  const end=Date.now()+30000;
  while(alive(state.parentPid)&&Date.now()<end)await wait(200);
  if(alive(state.parentPid))return; // Never force-end an uncertain or unresponsive client.
  await writeFile(path.join(path.dirname(file),'restart-receipt.json'),JSON.stringify({at:new Date().toISOString(),source:'independent-helper',needsRecheck:true}),{mode:0o600});
  const child=spawn(process.execPath,[desktop],{detached:true,windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();
  await unlink(file+'.ready').catch(()=>{});await unlink(file).catch(()=>{});
}
if(process.argv[2]==='--recover')recover(process.argv[3],process.argv[4]).catch(()=>{});
