import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';

// The test uses an invisible native window, a disposable WebView2 data
// directory and a synthetic loopback page; no real app state is accessed.
test('native WebView2 host loads isolated page and handles allowed window messages', {skip:process.platform!=='win32',timeout:30000}, async () => {
  const folder=path.join(process.cwd(),'outputs','working');await mkdir(folder,{recursive:true});
  const profile=await mkdtemp(path.join(folder,'webview-host-test-'));
  let requests=0;
  const server=createServer((req,res)=>{requests++;res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end('<!doctype html><title>synthetic test</title>');});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${server.address().port}/synthetic/`;
    const exe=path.resolve('runtime','webview2','SusuClashWindow.exe');
    // Closing to tray and opening again reuses this isolated profile.
    for (let launch=0;launch<2;launch++) {
      const child=spawn(exe,[url,profile,String(process.pid),'--test'],{stdio:'ignore'});
      const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
      assert.deepEqual(result,{code:0,signal:null});
    }
    assert(requests>=2,'synthetic page loaded on first open and reopening');
    const [left,top,right,bottom,clientX,clientY,clientWidth,clientHeight]=(await readFile(path.join(profile,'window-metrics.txt'),'utf8')).split(',').map(Number);
    assert.equal(clientX,left,'window must not have a native left frame');
    assert.equal(clientY,top,'window must not have a native title bar');
    assert.equal(clientWidth,right-left,'window must not have a native right frame');
    assert.equal(clientHeight,bottom-top,'window must not have a native bottom frame');
  } finally {await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:200});}
});
