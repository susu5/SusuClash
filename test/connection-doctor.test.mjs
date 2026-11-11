import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectionDoctor} from '../src/connection-doctor.mjs';
import {summarizeCodexLogs} from '../src/codex-evidence.mjs';

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
 return {d,change:()=>version++,off:()=>{enabled=false;},fail:()=>{probeFail=true;},counts:()=>({stops,starts,port,current}),status:()=>enabled};
}
function automaticFixture(extra={}){
 let probes=0,applied=0,rolled=0;
 const adapter={recover:async()=>({ok:true}),discover:async()=>({supported:true,public:{client:'desktop',version:'test'},target:{},strategies:[{id:'system-proxy'}]}),probe:async()=>++probes===1?{status:'failed',reason:'transport'}:{status:'probe_passed',retries:0,fallback:false,fresh:true},prepare:async()=>({record:{id:'test'},apply:async()=>{applied++;},readback:async()=>({ok:true}),rollback:async()=>{rolled++;return {ok:true};},commit:async()=>{}}),activate:async()=>({status:'awaiting_idle'}),...extra};
 return {...fixture({codexTargetAdapter:adapter}),counts:()=>({probes,applied,rolled})};
}
test('one authorized automatic call performs fresh detection, repair and verification without manual actions',async()=>{
 const f=automaticFixture();await assert.rejects(f.d.autoStart({}),/启动前/);await f.d.autoStart({client:'desktop',consent:true});const r=await done(f.d);assert.equal(r.codex.autoRepair.stage,'awaiting_activation');assert.equal(r.codex.sessionConfirmed,false);assert.equal(r.codex.autoRepair.verification,'probe_passed');assert.equal(r.codex.nextSteps.length,0);assert.deepEqual(f.counts(),{probes:3,applied:1,rolled:0});await f.d.close();
});
test('double click joins existing automatic task and cancellation waits for cleanup',async()=>{
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let calls=0;
 const f=automaticFixture({probe:async()=>{calls++;entered();await gate;return {status:'failed'};}});
 const one=await f.d.autoStart({consent:true});await started;const two=await f.d.autoStart({consent:true});assert.equal(one.task.id,two.task.id);f.d.cancel();assert.equal((await f.d.get()).task.phase,'repairing');release();const r=await done(f.d);assert.equal(r.codex.autoRepair.stage,'cancelled');assert.equal(calls,1);await f.d.close();
});
async function done(d){for(let i=0;i<100;i++){const s=await d.get();if(!['checking','repairing'].includes(s.task?.phase))return s;await new Promise(r=>setTimeout(r,2));}throw new Error('task did not finish');}
test('base checks are independent of Codex and record eight actual adapter results',async()=>{
 const {d}=fixture();await d.start();const s=await done(d);assert.equal(s.base.status,'passed');assert.equal(s.base.checks.length,8);assert.equal(s.codex,null);assert.equal(s.history[0].scope,'proxy');await d.close();
});
test('Codex-only check never turns untested base green; .env does not prove loaded settings',async()=>{
 const {d}=fixture();await d.start({scope:'codex',client:'desktop'});let s=await done(d);assert.equal(s.base,null);assert.equal(s.codex.checks[0].status,'unknown');assert.equal(s.codex.status,'needs_user');s=d.confirm();assert.equal(s.codex.status,'verified');assert.equal(s.base,null);await d.close();
});
test('base passed and application needs user stay visible together',async()=>{
 const {d}=fixture();await d.start();await done(d);await d.start({scope:'codex'});const s=await done(d);assert.equal(s.base.status,'passed');assert.equal(s.codex.status,'needs_user');await d.close();
});
test('system proxy disabled requires a decision, never claims computer offline',async()=>{
 const {d,off}=fixture();off();await d.start();const s=await done(d);assert.equal(s.base.checks.find(c=>c.id==='network').status,'passed');assert.equal(s.base.checks.find(c=>c.id==='system').status,'needs_user');assert.equal(s.base.status,'needs_action');await d.close();
});
test('unknown direct reachability preserves unknown network; TLS failures have a separate cause',async()=>{
 const {d}=fixture({system:{probe:async()=>({code:0,exit:60})}});await d.start();const s=await done(d);assert.equal(s.base.checks.find(c=>c.id==='network').status,'unknown');assert.equal(s.base.checks.find(c=>c.id==='dns').status,'failed');await d.close();
});
test('preview requires confirmation and stale configuration prevents applying a repair',async()=>{
 const f=fixture();const s=await f.d.preview({kind:'core-restart'});f.change();await assert.rejects(f.d.apply({id:s.plan.id,confirmed:true}),/失效/);assert.equal(f.counts().stops,0);await f.d.close();
});
test('explicit core restart calls stop then start even when running, then rechecks',async()=>{
 const f=fixture();const s=await f.d.preview({kind:'core-restart'});const result=await f.d.apply({id:s.plan.id,confirmed:true});assert.deepEqual(f.counts(),{stops:1,starts:1,port:7890,current:'A'});assert.equal(result.base.status,'passed');assert.deepEqual(result.history[0].actions,['core-restart']);await f.d.close();
});
test('system proxy repair is previewed, read back, and followed by eight-item recheck',async()=>{
 const f=fixture();f.off();const s=await f.d.preview({kind:'system-proxy'});assert.equal(f.status(),false);const result=await f.d.apply({id:s.plan.id,confirmed:true});assert.equal(f.status(),true);assert.equal(result.base.status,'passed');await f.d.close();
});
test('candidates can be actively tested without proof that the local network is offline',async()=>{
 const f=fixture();const s=await f.d.preview({kind:'candidates'});assert.equal(s.plan.candidates.length,3);await f.d.apply({id:s.plan.id,confirmed:true});assert.equal(f.counts().current,'B');await f.d.close();
});
test('failed candidates restore the prior selection rather than claiming success',async()=>{
 const f=fixture();f.fail();const s=await f.d.preview({kind:'candidates'});const r=await f.d.apply({id:s.plan.id,confirmed:true});assert.equal(r.task.phase,'error');assert.equal(f.counts().current,'A');await f.d.close();
});
test('separate CLI request requires explicit invocation and keeps original session unconfirmed',async()=>{
 const f=fixture();await f.d.start({scope:'codex',client:'cli'});await done(f.d);await f.d.request();const s=await done(f.d);assert.equal(s.codex.status,'probe_passed');assert.equal(s.codex.sessionConfirmed,false);assert.equal(s.base,null);await f.d.close();
});
test('unsupported tools/remote environments do not trigger a default model request',async()=>{
 const {d}=fixture();await d.start({scope:'codex',client:'wsl',symptom:'tool'});const s=await done(d);assert.equal(s.codex.status,'needs_user');await assert.rejects(d.request(),/只验证/);await d.close();
});
test('cancel prevents a late probe from resurrecting a result; setting changes stale both scopes',async()=>{
 let resolveProbe;const slow=new Promise(r=>resolveProbe=r);const f=fixture({system:{probe:()=>slow}});await f.d.start();f.d.cancel();resolveProbe({code:204,exit:0});await new Promise(r=>setTimeout(r,20));let s=await f.d.get();assert.equal(s.base,null);assert.equal(s.task.phase,'cancelled');await f.d.close();
 const x=fixture();await x.d.start();await done(x.d);await x.d.start({scope:'codex'});await done(x.d);x.d.invalidate();s=await x.d.get();assert.equal(s.base.status,'stale');assert.equal(s.codex.status,'stale');await x.d.close();
});
test('second start resumes the existing task rather than starting a parallel check',async()=>{
 let resolveProbe;const slow=new Promise(r=>resolveProbe=r);const f=fixture({system:{probe:()=>slow}});const a=await f.d.start();const b=await f.d.start({scope:'codex'});assert.equal(a.task.id,b.task.id);assert.equal(b.task.scope,'proxy');resolveProbe({code:204,exit:0});await done(f.d);await f.d.close();
});

test('fixed-proxy mode can pass with system proxy off without silently enabling it',async()=>{
 const f=fixture();f.off();await f.d.start({pathMode:'fixed'});const s=await done(f.d);assert.equal(s.base.status,'passed');assert.equal(f.status(),false);assert.equal(s.base.pathMode,'fixed');await f.d.close();
});

test('cancel of an application check preserves a completed independent base result',async()=>{
 const f=fixture();await f.d.start();await done(f.d);await f.d.start({scope:'codex'});f.d.cancel();assert.equal((await f.d.get()).base.status,'passed');await f.d.close();
});

test('a new Codex configuration write clears an earlier session confirmation on success and failure',async()=>{
 for(const ok of [true,false]){
  const f=fixture({codexRepair:{preview:async()=>({eligible:true,oldPort:7888,newPort:7890,token:'x'}),apply:async()=>({ok,message:'fixture denied write'})}});
  await f.d.start({scope:'codex'});await done(f.d);f.d.confirm();const p=await f.d.preview({kind:'codex-port'});const r=await f.d.apply({id:p.plan.id,confirmed:true});
  assert.equal(r.codex.sessionConfirmed,false);assert.notEqual(r.codex.status,'verified');assert.equal(r.task.phase,ok?'result':'error');await f.d.close();
 }
});

test('helper readiness is explicit and failed handoff never advertises readiness',async()=>{
 for(const succeeds of [true,false]){
  const f=fixture({restartClient:async()=>{if(!succeeds)throw new Error('fixture helper never ready');return {helperPid:456};}});
  const p=await f.d.preview({kind:'client-restart'}),r=await f.d.apply({id:p.plan.id,confirmed:true});
  assert.equal(r.task.handoffReady,succeeds);assert.equal(r.task.phase,succeeds?'handoff':'error');await f.d.close();
 }
});

test('changed settings clear both verdicts, per-item pass marks and session confirmation',async()=>{
 const f=fixture();await f.d.start();await done(f.d);await f.d.start({scope:'codex'});await done(f.d);f.d.confirm();f.d.invalidate('background switched node');const s=await f.d.get();assert.equal(s.base.status,'stale');assert(s.base.checks.every(c=>c.status==='stale'));assert.equal(s.codex.sessionConfirmed,false);assert(s.codex.checks.every(c=>c.status==='stale'));await f.d.close();
});

test('every recheck creates a new task, rereads logs and targets, and clears user confirmation',async()=>{
 let reads=0,probes=0;
 const {d}=fixture({system:{codexEvidence:async()=>({status:++reads===1?'unknown':'needs_action',detail:'fresh '+reads,counts:{reconnect:5,timeout:5}}),probe:async()=>{probes++;return {code:200,exit:0};}}});
 const first=await d.start({scope:'codex',symptom:'reconnect'});await done(d);d.confirm();
 const next=await d.start({scope:'codex',symptom:'reconnect'});assert.notEqual(next.task.id,first.task.id);assert.equal(next.codex,null);
 const s=await done(d);assert.equal(reads,2);assert.equal(probes,14);assert.equal(s.codex.sessionConfirmed,false);assert.equal(s.codex.status,'needs_action');assert.equal(s.codex.recent.detail,'fresh 2');assert.equal(s.history[0].scope,'codex');await d.close();
});
test('successful web probes do not hide five recent timeouts or assert a desktop request passed',async()=>{
 const {d}=fixture({system:{codexEvidence:async()=>({status:'needs_action',detail:'5 retries',counts:{reconnect:5,timeout:5}})}});
 await d.start({scope:'codex',symptom:'reconnect'});const s=await done(d);
 assert.equal(s.codex.status,'needs_action');assert.equal(s.codex.samples.length,3);assert.equal(s.codex.checks.find(c=>c.id==='target').status,'unknown');assert.equal(s.codex.checks.find(c=>c.id==='request').status,'needs_user');assert(s.codex.nextSteps.some(s=>s.detail.includes('线路')));await d.close();
});

test('fresh recheck exposes native connection and unknown transport errors even when every web probe passes',async()=>{
 for(const [body,category] of [
  ['responses_websocket.connect{transport="responses_websocket" api.path="/responses"}: failed to connect to Responses WebSocket stage=Unknown','connection'],
  ['unrecognised response protocol event','other']
 ]){
  const rows=[];let reads=0;
  const {d}=fixture({system:{codexEvidence:async()=>{reads++;return summarizeCodexLogs(rows);},probe:async()=>({code:200,exit:0})}});
  const before=await d.start({scope:'codex',symptom:'reconnect'});await done(d);d.confirm();
  rows.push({ts:Math.floor(Date.now()/1000),level:'ERROR',target:'codex_api::endpoint::responses_websocket',feedback_log_body:body});
  const after=await d.start({scope:'codex',symptom:'reconnect'});assert.notEqual(after.task.id,before.task.id);assert.equal(after.codex,null);
  const result=await done(d);assert.equal(reads,2);assert.equal(result.codex.status,'needs_action');assert.equal(result.codex.sessionConfirmed,false);
  assert.equal(result.codex.recent.counts[category],1);assert.equal(result.codex.recent.scope,'local_unattributed');
  assert.equal(result.codex.checks.find(c=>c.id==='recent').status,'needs_action');assert.equal(result.codex.samples.length,3);
  assert(result.codex.samples.every(s=>s.code===200));assert.notEqual(result.codex.checks.find(c=>c.id==='target').status,'passed');await d.close();
 }
});
test('unused fixed proxy port is detected and a repair preview is offered only as a next step',async()=>{
 const {d}=fixture({system:{codexProxy:async()=>({kind:'local',port:7888,url:'http://127.0.0.1:7888'})}});
 await d.start({scope:'codex'});const s=await done(d);assert.equal(s.codex.status,'needs_action');assert.equal(s.codex.checks.find(c=>c.id==='appPort').status,'failed');assert.equal(s.codex.canRepairPort,true);assert.equal(s.plan,null);assert.equal(s.codex.samples.length,0);await d.close();
});
test('intermittent web failure stays visible instead of passing after one successful response',async()=>{
 let n=0;const {d}=fixture({system:{probe:async url=>url==='https://chatgpt.com/'&&++n===2?{code:0,exit:28}:{code:200,exit:0}}});
 await d.start({scope:'codex'});const s=await done(d);assert.equal(s.codex.status,'needs_action');assert.equal(s.codex.checks.find(c=>c.id==='target').status,'failed');assert.equal(s.codex.samples.filter(x=>x.code===0).length,1);await d.close();
});
test('CLI short request success keeps earlier recent connection failures and evidence visible',async()=>{
 const {d}=fixture({system:{codexEvidence:async()=>({status:'needs_action',detail:'5 retries',counts:{reconnect:5}})}});
 await d.start({scope:'codex',client:'cli'});await done(d);await d.request();const s=await done(d);
 assert.equal(s.codex.status,'needs_action');assert.equal(s.codex.checks.find(c=>c.id==='request').status,'probe_passed');assert.equal(s.codex.checks.find(c=>c.id==='recent').status,'needs_action');assert.equal(s.codex.sessionConfirmed,false);await d.close();
});
test('late application evidence cannot resurrect a cancelled check',async()=>{
 let release,entered;const ready=new Promise(r=>entered=r);const evidence=new Promise(r=>release=r);
 const {d}=fixture({system:{codexEvidence:()=>{entered();return evidence;}}});await d.start({scope:'codex'});await ready;d.cancel();release({status:'needs_action',detail:'late retries'});await new Promise(r=>setTimeout(r,10));
 const s=await d.get();assert.equal(s.codex,null);assert.equal(s.history.length,0);assert.equal(s.task.phase,'cancelled');await d.close();
});

test('remote and WSL checks never attribute local reconnect logs to the other environment',async()=>{
 let reads=0;const {d}=fixture({system:{codexEvidence:async()=>{reads++;return {status:'needs_action',detail:'local retries'};}}});
 await d.start({scope:'codex',client:'wsl',symptom:'reconnect'});const s=await done(d);assert.equal(reads,0);assert.equal(s.codex.status,'needs_user');assert.equal(s.codex.samples.length,0);await d.close();
});
