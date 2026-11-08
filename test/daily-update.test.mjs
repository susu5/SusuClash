import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDailyUpdate} from '../src/daily-update.mjs';
import {createUpdateChecker,RELEASE_PAGE} from '../src/update-check.mjs';
import {startServer} from '../src/server.mjs';

const DAY=86400000;
const fixture=(status='unreleased')=>({status,currentVersion:'0.1.7',latestVersion:status==='available'?'0.1.8':null,releaseUrl:'https://malicious.example/',downloadUrl:'https://malicious.example/file'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function clock(start=Date.parse('2026-11-08T00:00:00Z')){
  let value=start,id=0;const tasks=new Map();
  return {now:()=>value,set:value_=>value=value_,schedule:(fn,delay)=>{const task=++id;tasks.set(task,{fn,delay});return task},clear:task=>tasks.delete(task),tasks,
    fire:()=>{assert.equal(tasks.size,1);const [key,task]=[...tasks][0];tasks.delete(key);task.fn();return task.delay;}};
}
async function eventually(fn){for(let i=0;i<150;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,5))}throw Error('expected state did not occur')}
async function temp(t){const directory=await mkdtemp(path.join(os.tmpdir(),'susu-daily-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100}));return directory}
const make=(directory,checker,c,options={})=>createDailyUpdate({directory,checker,currentVersion:'0.1.7',now:c.now,setTimer:c.schedule,clearTimer:c.clear,...options});

test('starts after core recovery, checks once, waits 24h and persists across restart',async t=>{
 const directory=await temp(t), c=clock(), gate=deferred();let calls=0;
 const checker={check:async()=>{calls++;return fixture('available')}};
 const first=make(directory,checker,c,{waitUntilReady:()=>gate.promise});first.start();await first.get();assert.equal(c.tasks.size,0);assert.equal(calls,0);
 gate.resolve();await eventually(()=>c.tasks.size===1);assert.equal(c.fire(),0);
 await eventually(async()=>{const s=await first.get();return s.lastResult?.status==='available'&&!s.checking});
 assert.equal(calls,1);const result=await first.get();assert.equal(result.enabled,true);assert.equal(result.lastCheckedAt,'2026-11-08T00:00:00.000Z');assert.equal(result.nextCheckAt,'2026-11-09T00:00:00.000Z');assert.equal(result.lastResult.releaseUrl,RELEASE_PAGE);assert.equal(result.lastResult.downloadUrl,null);
 assert.equal(c.tasks.size,1);assert.equal([...c.tasks.values()][0].delay,DAY);first.stop();assert.equal(c.tasks.size,0);
 c.set(Date.parse('2026-11-08T06:00:00Z'));const second=make(directory,checker,c);second.start();await eventually(()=>c.tasks.size===1);assert.equal([...c.tasks.values()][0].delay,18*60*60*1000);assert.equal(calls,1);
 c.set(Date.parse('2026-11-09T00:00:00Z'));c.fire();await eventually(async()=>(await second.get()).lastCheckedAt==='2026-11-09T00:00:00.000Z'&&!(await second.get()).checking);assert.equal(calls,2);second.stop();
 const stored=JSON.parse(await readFile(path.join(directory,'application-update.json'),'utf8'));assert.deepEqual(Object.keys(stored).sort(),['enabled','lastCheckedAt','lastResult']);assert(!JSON.stringify(stored).includes('malicious'));
});

test('disabling persists across restart; manual check is still available and resets the 24h schedule',async t=>{
 const directory=await temp(t),c=clock();let calls=0;const checker={check:async()=>{calls++;return fixture()}};
 const one=make(directory,checker,c);await one.set({enabled:false});one.start();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(c.tasks.size,0);assert.equal(calls,0);
 assert.equal((await one.checkNow()).status,'unreleased');assert.equal(calls,1);assert.equal((await one.get()).enabled,false);one.stop();
 c.set(c.now()+DAY*2);const two=make(directory,checker,c);two.start();await new Promise(resolve=>setTimeout(resolve,20));assert.equal((await two.get()).enabled,false);assert.equal(c.tasks.size,0);assert.equal(calls,1);
 await two.set({enabled:true});await eventually(()=>c.tasks.size===1);assert.equal([...c.tasks.values()][0].delay,0);c.fire();await eventually(async()=>calls===2&&!(await two.get()).checking);two.stop();
});

test('failure still records an attempt and never loops on restart',async t=>{
 const directory=await temp(t),c=clock();let calls=0;const checker={check:async()=>{calls++;return fixture('network_error')}};
 const one=make(directory,checker,c);one.start();await eventually(()=>c.tasks.size===1);c.fire();await eventually(async()=>(await one.get()).lastResult?.status==='network_error'&&!(await one.get()).checking);one.stop();
 c.set(c.now()+1000);const two=make(directory,checker,c);two.start();await eventually(()=>c.tasks.size===1);assert.equal(calls,1);assert.equal([...c.tasks.values()][0].delay,DAY-1000);two.stop();
});

test('a newly installed version does not report an older version result as an available update',async t=>{
 const directory=await temp(t),c=clock();let calls=0;const checker={check:async()=>{calls++;return fixture()}};
 await writeFile(path.join(directory,'application-update.json'),JSON.stringify({enabled:true,lastCheckedAt:'2026-11-08T00:00:00.000Z',lastResult:{status:'available',currentVersion:'0.1.6',latestVersion:'0.1.7'}}));
 const service=make(directory,checker,c);service.start();const state=await service.get();assert.equal(state.lastResult,null);assert.equal(state.lastCheckedAt,null);await eventually(()=>c.tasks.size===1);assert.equal([...c.tasks.values()][0].delay,0);assert.equal(calls,0);service.stop();
});

test('manual and automatic requests share one operation; disabling during a request prevents the next schedule',async t=>{
 const directory=await temp(t),c=clock(),gate=deferred();let calls=0;const checker={check:async()=>{calls++;return gate.promise}};
 const service=make(directory,checker,c);service.start();await eventually(()=>c.tasks.size===1);c.fire();await eventually(()=>calls===1);
 assert.equal((await service.get()).checking,true);const manual=service.checkNow();await service.set({enabled:false});gate.resolve(fixture('available'));
 assert.equal((await manual).status,'available');assert.equal(calls,1);assert.equal((await service.get()).enabled,false);assert.equal(c.tasks.size,0);service.stop();
});

test('clock rollback triggers a fresh check; corrupt preferences fail closed until explicitly reset',async t=>{
 const directory=await temp(t),c=clock();let calls=0;const checker={check:async()=>{calls++;return fixture()}};
 const one=make(directory,checker,c);await one.checkNow();one.stop();c.set(c.now()-DAY*2);
 const two=make(directory,checker,c);two.start();await eventually(()=>c.tasks.size===1);assert.equal([...c.tasks.values()][0].delay,0);two.stop();
 await writeFile(path.join(directory,'application-update.json'),'{bad');const three=make(directory,checker,c);three.start();const invalid=await three.get();assert.equal(invalid.enabled,false);assert.match(invalid.error,/无法读取/);assert.equal(c.tasks.size,0);await three.set({enabled:true});await eventually(()=>c.tasks.size===1);three.stop();
});

test('closing cancels an in-flight checker and clears timers without waiting',async t=>{
 const directory=await temp(t),c=clock(),gate=deferred();let cancelled=0,calls=0;const checker={check:()=>{calls++;return gate.promise},cancel:()=>cancelled++};
 const service=make(directory,checker,c);service.start();await eventually(()=>c.tasks.size===1);c.fire();await eventually(()=>calls===1);service.stop();assert.equal(cancelled,1);assert.equal(c.tasks.size,0);gate.resolve(fixture());await new Promise(resolve=>setTimeout(resolve,20));assert.equal(c.tasks.size,0);
});

test('manual check still works when persistence fails and automatic checks pause',async t=>{
 const root=await temp(t),invalid=path.join(root,'not-a-directory');await writeFile(invalid,'fixture');const c=clock();let calls=0;
 const service=make(invalid,{check:async()=>{calls++;return fixture()}},c);service.start();const r=await service.checkNow();assert.equal(r.status,'unreleased');assert.equal(calls,1);assert.equal((await service.get()).enabled,false);assert.match((await service.get()).error,/无法保存/);service.stop();
});

test('update preference API validates input and leaves manual proxy-operation guard unchanged',async t=>{
 let state={enabled:true,lastCheckedAt:null,nextCheckAt:null,lastResult:null,checking:false,error:null},manualCalls=0;
 const daily={start(){},stop(){},get:async()=>state,set:async({enabled})=>(state={...state,enabled}),checkNow:async()=>{manualCalls++;return fixture()}};
 const core={preferences:async()=>({expectedPort:7890}),call:async()=>({})};
 const app=await startServer({core,dailyUpdate:daily,readSystemProxy:async()=>false});t.after(app.close);
 const get=()=>fetch(app.url+'api/update-settings'),post=(value,origin=app.origin)=>fetch(app.url+'api/update-settings',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await (await get()).json()).enabled,true);assert.equal((await post({enabled:'false'})).status,400);assert.equal((await post({enabled:false},'https://example.test')).status,403);
 assert.equal((await (await post({enabled:false})).json()).enabled,false);assert.equal((await (await fetch(app.url+'api/update-check')).json()).status,'unreleased');assert.equal(manualCalls,1);
});

test('cancelling the underlying update checker stops a hanging network request promptly',async()=>{
 const checker=createUpdateChecker({currentVersion:'0.1.7',timeoutMs:10000,request:()=>new Promise(()=>{})});const pending=checker.check();checker.cancel();
 const value=await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('cancel did not stop request')),100))]);assert.equal(value.status,'timeout');
});
