import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectionDoctor} from '../src/connection-doctor.mjs';

function fixture(overrides={}) {
 let enabled=true,port=7890,runtime='running',current='A',version=0,stops=0,starts=0,probeFail=false;
 const core={directory:null,status:()=>({state:runtime}),processId:()=>123,preferences:async()=>({expectedPort:port}),stop:async()=>{stops++;runtime='stopped';},start:async()=>{starts++;runtime='running';},setPort:async p=>{port=p;},call:async(method,route,body)=>{
  if(route==='/configs')return {'mixed-port':port,mode:'rule'};
  if(route==='/version')return {version:'test'};
  if(route==='/proxies')return {proxies:{Test:{name:'Test',type:'Selector',all:['A','B','C','D'],now:current},A:{},B:{},C:{},D:{}}};
  if(route==='/proxies/Test'&&method==='PUT'){current=body.name;return {};}
  if(route==='/proxies/Test')return {now:current};
 }};
 const proxy={getStatus:async()=>({enabled,managed:enabled}),enable:async()=>{enabled=true;},disable:async()=>{enabled=false;}};
 const system={probe:async()=>probeFail?{code:0,exit:28}:{code:204,exit:0},listeners:async()=>[{port,pid:'123'}],codexProxy:async()=>({kind:'local',port,url:'http://127.0.0.1:'+port}),codexEvidence:async()=>({status:'unknown',detail:'fixture: no recent errors'}),interfaces:()=>({eth:[{address:'192.0.2.1',internal:false}]}),lookup:async()=>({address:'192.0.2.2'}),...overrides.system};
 const d=createConnectionDoctor({core,proxy,profiles:{list:async()=>({activeId:'test'})},codexRepair:{preview:async()=>({eligible:true,oldPort:7888,newPort:port,token:'env-token'}),apply:async()=>({ok:true})},health:{verify:async()=> 'ok'},configuration:async()=>({port,enabled,current,version,automation:{group:'Test',backups:['B','C','D','A']}}),serialize:async f=>f(),system,requestProbe:async()=>({status:'probe_passed',detail:'complete fixture response'}),...Object.fromEntries(Object.entries(overrides).filter(([k])=>k!=='system'))});
 return {d,core,change:()=>version++,off:()=>{enabled=false;},fail:()=>{probeFail=true;},counts:()=>({stops,starts,port,current}),status:()=>enabled};
}
function deferred(){let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};}
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));

async function done(d){for(let i=0;i<200;i++){const s=await d.get();if(!['checking','repairing'].includes(s.task?.phase))return s;await new Promise(r=>setTimeout(r,2));}throw new Error('task did not finish');}

test('base checks remain independent: eight checks and no application success',async()=>{
 const {d}=fixture();await d.start();const s=await done(d);assert.equal(s.base.status,'passed');assert.equal(s.base.checks.length,8);assert.equal(s.codex,null);assert.equal(s.history[0].scope,'proxy');await d.close();
});
test('retired Codex entry cannot activate old adapters or create a second verdict',async()=>{
 let calls=0;const {d}=fixture({codexTargetAdapter:{recover:async()=>{calls++;},discover:async()=>{calls++;},probe:async()=>{calls++;}},requestProbe:async()=>{calls++;}});
 await assert.rejects(d.start({scope:'codex',client:'desktop'}),e=>e.status===410);
 await assert.rejects(d.autoStart({consent:true}),e=>e.status===410);
 await assert.rejects(d.request(),e=>e.status===410);assert.throws(()=>d.confirm(),e=>e.status===410);
 await assert.rejects(d.preview({kind:'codex-port'}),e=>e.status===410);
 const s=await d.get();assert.equal(s.base,null);assert.equal(s.codex,null);assert.equal(s.task,null);assert.equal(calls,0);await d.close();
});
test('retired application calls do not invalidate a completed base inspection',async()=>{
 const {d}=fixture();await d.start();await done(d);await assert.rejects(d.start({scope:'codex'}),e=>e.status===410);assert.equal((await d.get()).base.status,'passed');assert.equal((await d.get()).codex,null);await d.close();
});
test('disabled system proxy requires a scope decision without claiming computer offline',async()=>{
 const {d,off}=fixture();off();await d.start();const s=await done(d);assert.equal(s.base.checks.find(c=>c.id==='network').status,'passed');assert.equal(s.base.checks.find(c=>c.id==='system').status,'needs_user');await d.close();
});
test('direct or fixed scope does not require enabling Windows system proxy',async()=>{
 for(const pathMode of ['fixed','direct']){const f=fixture();f.off();await f.d.start({pathMode});const s=await done(f.d);assert.equal(s.base.checks.find(c=>c.id==='system').status,'passed');await f.d.close();}
});
test('unconfirmed targets remain unknown while TLS errors are independently classified',async()=>{
 const {d}=fixture({system:{probe:async()=>({code:0,exit:60}),lookup:async()=>null}});await d.start();const s=await done(d);assert.equal(s.base.checks.find(c=>c.id==='network').status,'unknown');assert.equal(s.base.checks.find(c=>c.id==='dns').status,'failed');await d.close();
});
test('a changed configuration fingerprint rejects a previously previewed repair',async()=>{
 const f=fixture();await f.d.start();await done(f.d);const p=await f.d.preview({kind:'system-proxy'});f.change();await assert.rejects(f.d.apply({id:p.plan.id,confirmed:true}),/失效|变化/);assert.equal(f.status(),true);await f.d.close();
});
test('base repair requires exact plan identity and explicit confirmation',async()=>{
 const f=fixture();const p=await f.d.preview({kind:'core-restart'});await assert.rejects(f.d.apply({id:p.plan.id,confirmed:false}),/失效|确认/);assert.deepEqual(f.counts(),{stops:0,starts:0,port:7890,current:'A'});await f.d.close();
});
test('owned core restart is still available through the base repair plan',async()=>{
 const f=fixture();await f.d.start();await done(f.d);const p=await f.d.preview({kind:'core-restart'});const s=await f.d.apply({id:p.plan.id,confirmed:true});assert.equal(s.task.phase,'result');assert.equal(s.base.status,'passed');assert.equal(f.counts().stops,1);assert.equal(f.counts().starts,1);await f.d.close();
});
test('base candidate action stays separate from Netfix and restores an ineffective route',async()=>{
 const f=fixture();f.fail();const p=await f.d.preview({kind:'candidates'});const s=await f.d.apply({id:p.plan.id,confirmed:true});assert.equal(s.task.phase,'error');assert.equal(f.counts().current,'A');assert.equal(s.codex,null);await f.d.close();
});
test('a second base start joins its active read task; retired scope cannot hijack it',async()=>{
 let release;const gate=new Promise(r=>release=r);const f=fixture({system:{probe:()=>gate}});const first=await f.d.start();const second=await f.d.start();assert.equal(first.task.id,second.task.id);await assert.rejects(f.d.start({scope:'codex'}),e=>e.status===410);release({code:204,exit:0});await done(f.d);await f.d.close();
});
test('cancelled base read cannot publish late successful evidence',async()=>{
 let release;const gate=new Promise(r=>release=r);const f=fixture({system:{probe:()=>gate}});await f.d.start();f.d.cancel();release({code:204,exit:0});await new Promise(r=>setTimeout(r,10));const s=await f.d.get();assert.equal(s.task.phase,'cancelled');assert.equal(s.base,null);await f.d.close();
});
test('connection changes stale base evidence and reject its old plans',async()=>{
 const f=fixture();await f.d.start();await done(f.d);const p=await f.d.preview({kind:'system-proxy'});f.d.invalidate('background route changed');const s=await f.d.get();assert.equal(s.base.status,'stale');assert(s.base.checks.every(c=>c.status==='stale'));await assert.rejects(f.d.apply({id:p.plan.id,confirmed:true}),/失效/);await f.d.close();
});
test('unsupported base mutation names cannot call the retired file writer',async()=>{
 let applied=0;const f=fixture({codexRepair:{preview:async()=>{applied++;},apply:async()=>{applied++;}}});for(const kind of ['codex-port','fix-port','lock','restore'])await assert.rejects(f.d.preview({kind}));assert.equal(applied,0);await f.d.close();
});
test('SusuClash restart helper remains a separate explicitly confirmed base action',async()=>{
 let handed=0;const f=fixture({restartClient:async()=>{handed++;return{helperPid:4321};}});const p=await f.d.preview({kind:'client-restart'});const s=await f.d.apply({id:p.plan.id,confirmed:true});assert.equal(s.task.phase,'handoff');assert.equal(handed,1);assert.equal(s.codex,null);await f.d.close();
});

test('close tracks an apply already waiting for its first fingerprint and rejects new work',async t=>{
 const entered=deferred(),gate=deferred();let hold=false,applying;
 const f=fixture({configuration:async()=>{if(hold){entered.release();await gate.promise;}return {fixture:'stable'};}});
 t.after(async()=>{gate.release();await applying?.catch(()=>{});await f.d.close();});
 const p=await f.d.preview({kind:'core-restart'});hold=true;
 applying=f.d.apply({id:p.plan.id,confirmed:true});await entered.promise;
 assert.equal(f.d.isRepairing(),true);
 let finished=false;const closing=f.d.close();assert.equal(f.d.close(),closing);closing.then(()=>{finished=true;});
 await nextTurn();assert.equal(finished,false,'close must wait for the accepted preflight');
 await assert.rejects(f.d.start(),e=>e.status===503);
 await assert.rejects(f.d.preview({kind:'core-restart'}),e=>e.status===503);
 await assert.rejects(f.d.apply({id:p.plan.id,confirmed:true}),e=>e.status===503);
 gate.release();await assert.rejects(applying,e=>e.status===503);await closing;
 assert.equal(finished,true);assert.deepEqual(f.counts(),{stops:0,starts:0,port:7890,current:'A'});
 assert.equal(f.d.isRepairing(),false);assert.equal((await f.d.get()).history.length,0);
});

test('close waits for an already started base write to finish and skips its later inspection',async t=>{
 const entered=deferred(),gate=deferred();let applying,probes=0;
 const f=fixture({system:{probe:async()=>{probes++;return {code:204,exit:0};}}});
 const originalStop=f.core.stop;f.core.stop=async()=>{await originalStop();entered.release();await gate.promise;};
 t.after(async()=>{gate.release();await applying?.catch(()=>{});await f.d.close();});
 const p=await f.d.preview({kind:'core-restart'});applying=f.d.apply({id:p.plan.id,confirmed:true});await entered.promise;
 let finished=false;const closing=f.d.close().then(()=>{finished=true;});await nextTurn();
 assert.equal(finished,false);assert.equal(f.counts().starts,0);
 gate.release();const result=await applying;await closing;
 assert.equal(f.counts().stops,1);assert.equal(f.counts().starts,1,'the already accepted restart finishes its safe unit');
 assert.equal(probes,0,'closing must not start a new post-write network check');
 assert.equal(result.task.phase,'cancelled');assert.equal(result.base,null);assert.equal(result.history.length,0);
 assert.equal(f.d.isRepairing(),false);
});

test('close waits for a post-write inspection and discards its late success and history',async t=>{
 const entered=deferred(),gate=deferred();let applying,probes=0;
 const f=fixture({system:{probe:async()=>{probes++;entered.release();return gate.promise;}}});
 t.after(async()=>{gate.release({code:204,exit:0});await applying?.catch(()=>{});await f.d.close();});
 const p=await f.d.preview({kind:'core-restart'});applying=f.d.apply({id:p.plan.id,confirmed:true});await entered.promise;
 assert.equal(f.d.isRepairing(),true);assert.equal((await f.d.get()).task.phase,'repairing');
 let finished=false;const closing=f.d.close().then(()=>{finished=true;});await nextTurn();assert.equal(finished,false);
 gate.release({code:204,exit:0});const result=await applying;await closing;
 assert.equal(result.task.phase,'cancelled');assert.equal(result.base,null);assert.equal(result.history.length,0);
 const completeCount=probes;await nextTurn();assert.equal(probes,completeCount);assert.equal(f.d.isRepairing(),false);
});

test('invalidation during a base repair inspection cannot publish late successful evidence',async t=>{
 const entered=deferred(),gate=deferred();let applying;
 const f=fixture({system:{probe:async()=>{entered.release();return gate.promise;}}});
 t.after(async()=>{gate.release({code:204,exit:0});await applying?.catch(()=>{});await f.d.close();});
 const p=await f.d.preview({kind:'core-restart'});applying=f.d.apply({id:p.plan.id,confirmed:true});await entered.promise;
 await assert.rejects(f.d.start(),e=>e.status===409);
 await assert.rejects(f.d.preview({kind:'core-restart'}),e=>e.status===409);
 f.d.invalidate('connection changed during post-write inspection');gate.release({code:204,exit:0});
 const result=await applying;assert.equal(result.task.phase,'cancelled');assert.equal(result.base,null);assert.equal(result.history.length,0);
});
