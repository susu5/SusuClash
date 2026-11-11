import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCodexAutoRepair } from '../src/codex-auto-repair.mjs';

const pass={status:'probe_passed',retries:0,fallback:false,fresh:true};
function fixture(extra={}) {
 let node='A',applied=false,commits=0,rollbacks=0,starts=0,stops=0,probeCalls=[],version=0;
 const config=()=>({profile:'p',port:7890,node,version,automation:{group:'G',backups:['B','C','D','E']}});
 const core={directory:null,status:()=>({state:'running'}),processId:()=>12,start:async()=>{starts++;},stop:async()=>{stops++;},call:async(method,route,body)=>{if(route==='/proxies/G'){if(method==='PUT')node=body.name;return {now:node,all:['A','B','C','D','E']};}}};
 const adapter={
  recover:async()=>({ok:true}),
  discover:async()=>({supported:true,public:{client:'desktop',version:'test'},target:{private:'not-public'},strategies:[{id:'respect_system_proxy'}]}),
  probe:async(target,options)=>{probeCalls.push(options);return probeCalls.length===1?{status:'failed',reason:'transport',retries:5,fresh:true}:{...pass};},
  prepare:async()=>({record:{strategy:'respect_system_proxy'},apply:async()=>{applied=true;},readback:async()=>true,rollback:async()=>{rollbacks++;applied=false;return {ok:true};},commit:async()=>{commits++;}}),
  activate:async()=>({status:'awaiting_idle'}),...extra.adapter
 };
 const inspection=async()=>({port:7890,checks:[{id:'core',status:'passed'},{id:'port',status:'passed'}]});
 const options={core,profiles:{list:async()=>({activeId:'p'})},configuration:async()=>config(),inspect:inspection,system:{codexEvidence:async()=>({counts:{timeout:5},transport:{fiveRetriesThenHttp:true},watermark:{id:10}}),listeners:async()=>[{port:7890,pid:12}]},health:{verify:async()=> 'ok'},adapter,requestBudget:3,...extra};
 options.adapter=adapter;
 return {repair:createCodexAutoRepair(options),counts:()=>({node,applied,commits,rollbacks,starts,stops,probeCalls}),change:()=>{version++;},select:n=>{node=n;},adapter};
}
test('two fresh exact-runtime requests surround a guarded persistent repair; desktop stays unverified',async()=>{
 const f=fixture();const result=await f.repair.run();
 assert.equal(result.stage,'awaiting_activation');assert.equal(result.verification,'probe_passed');assert.equal(result.sessionConfirmed,false);
 const c=f.counts();assert.equal(c.applied,true);assert.equal(c.commits,1);assert.equal(c.probeCalls.length,3);assert.equal(c.probeCalls[0].strategy.id,'current');assert.equal(c.probeCalls[1].persisted,false);assert.equal(c.probeCalls[2].persisted,true);
 assert(!JSON.stringify(result).includes('not-public'));assert.equal(result.diagnosis.fiveRetriesThenHttp,true);
});
test('only a verified actual application adapter can claim app_verified',async()=>{
 const f=fixture({adapter:{activate:async()=>({status:'verified',verification:'app_verified'})}});
 const r=await f.repair.run();assert.equal(r.stage,'app_verified');assert.equal(r.sessionConfirmed,false);
});
test('healthy current connections do not cause a speculative transport change',async()=>{
 const f=fixture({adapter:{probe:async()=>pass}});const r=await f.repair.run();assert.equal(r.stage,'probe_passed');assert.equal(r.changed,false);assert.equal(r.requests,2);assert.equal(f.counts().applied,false);assert.equal(f.counts().commits,0);
});
test('a failed readback object rolls back without a third model request',async()=>{
 let calls=0,rolled=false;
 const f=fixture({adapter:{probe:async()=>++calls===1?{status:'failed',reason:'transport'}:pass,prepare:async()=>({record:{},apply:async()=>{},readback:async()=>({ok:false}),rollback:async()=>{rolled=true;return {ok:true};}})}});
 const r=await f.repair.run();assert.equal(r.stage,'needs_action');assert.equal(r.verification,'route_ok');assert.equal(calls,2);assert.equal(rolled,true);
});
test('authentication after persistence rolls back and preserves its precise blocker',async()=>{
 let calls=0;const f=fixture({requestBudget:6,adapter:{probe:async()=>++calls===1?{status:'failed',reason:'transport'}:calls===2?pass:{status:'needs_user',reason:'auth'}}});
 const r=await f.repair.run();assert.equal(r.stage,'waiting_user');assert.equal(r.verification,'route_ok');assert.equal(r.requests,3);assert.equal(f.counts().applied,false);
});
test('fixed/direct selections are not silently repaired as Windows system proxy',async()=>{
 for(const pathMode of ['fixed','direct']){const f=fixture();assert.equal((await f.repair.run({pathMode})).stage,'unsupported');assert.equal(f.counts().probeCalls.length,0);}
});
test('eventual success with five retries or fallback is not accepted as a repair',async()=>{
 for(const props of [{retries:5},{connectionFailures:1},{otherTransportErrors:1},{fallback:true},{fresh:false}]){
  const f=fixture({adapter:{probe:async()=>({...pass,...props})}});const r=await f.repair.run();assert.equal(r.stage,'needs_action');assert.equal(f.counts().applied,false);assert.equal(f.counts().node,'A');assert(r.requests<=3);
 }
});
test('failed persisted-config verification rolls back before finishing',async()=>{
 let calls=0;const f=fixture({adapter:{probe:async()=>++calls===2?pass:{status:'failed',retries:5,fresh:true}}});
 const r=await f.repair.run();assert.equal(r.stage,'needs_action');assert.equal(f.counts().applied,false);assert.equal(f.counts().rollbacks,1);assert.equal(f.counts().commits,0);
});
test('old aggregate authentication errors do not stop a fresh successful test',async()=>{
 const f=fixture({system:{codexEvidence:async()=>({counts:{auth:2,quota:3}})}});assert.equal((await f.repair.run()).stage,'awaiting_activation');
});
test('fresh auth/quota/service errors stop further model requests or route switching',async()=>{
 for(const reason of ['auth','quota','service']){
  const f=fixture({adapter:{probe:async()=>({status:'needs_user',reason})}});const r=await f.repair.run();assert.equal(r.requests,1);assert.equal(f.counts().node,'A');assert.equal(f.counts().applied,false);assert.equal(r.stage,reason==='service'?'waiting_service':'waiting_user');
 }
});
test('model, configuration, tool and unexplained failures never start network repair candidates',async()=>{
 for(const reason of ['model','configuration','tool','transport_unknown','incomplete',null]){
  const f=fixture({adapter:{probe:async()=>({status:'failed',reason})}});const r=await f.repair.run();
  assert.equal(r.requests,1);assert.equal(f.counts().applied,false);assert.equal(f.counts().node,'A');assert.notEqual(r.verification,'probe_passed');
 }
});
test('unsupported remote and tool flows never launch model probes or edit configuration',async()=>{
 for(const args of [{client:'wsl'},{client:'remote'},{client:'ide'},{symptom:'tool'}]){const f=fixture();assert.equal((await f.repair.run(args)).stage,'unsupported');assert.equal(f.counts().probeCalls.length,0);assert.equal(f.counts().applied,false);}
});
test('at most three authorized model calls, with two reserved for any successful candidate',async()=>{
 let calls=0;const f=fixture({adapter:{discover:async()=>({supported:true,public:{},target:{},strategies:[]}),probe:async()=>++calls===1?{status:'failed',reason:'transport'}:pass}});const r=await f.repair.run();assert.equal(r.requests,3);assert.equal(r.stage,'probe_passed');assert.equal(f.counts().node,'B');assert.equal(r.activation,'applied');assert.match(r.detail,/备用线路/);
});
test('five-message default budget can try a second transport after the first fails',async()=>{
 let calls=0;const strategies=[];
 const f=fixture({requestBudget:5,adapter:{discover:async()=>({supported:true,public:{},target:{},strategies:[{id:'system-proxy'},{id:'http'}]}),probe:async(_,{strategy})=>{strategies.push(strategy.id);return ++calls<3?{status:'failed',reason:'transport'}:pass;}}});
 const r=await f.repair.run();assert.equal(r.stage,'awaiting_activation');assert.equal(r.requests,4);assert.deepEqual(strategies,['current','system-proxy','http','http']);
});
test('external config changes prevent saving a candidate and roll back its temporary route',async()=>{
 let f;f=fixture({adapter:{probe:async()=>{f.change();return pass;}}});const r=await f.repair.run();assert.equal(r.stage,'needs_action');assert.equal(f.counts().applied,false);assert.equal(f.counts().commits,0);
});
test('external route change is never overwritten by rollback',async()=>{
 let calls=0,f;f=fixture({adapter:{discover:async()=>({supported:true,public:{},target:{},strategies:[]}),probe:async()=>{if(++calls===2)f.select('C');return {status:'failed',reason:'transport'};}}});const r=await f.repair.run();assert.equal(r.stage,'rollback_conflict');assert.equal(f.counts().node,'C');
});
test('cancellation after apply restores config and never verifies or resends an original task',async()=>{
 const c=new AbortController();let n=0;const f=fixture({adapter:{probe:async()=>{if(++n===3)c.abort();return n===1?{status:'failed',reason:'transport'}:pass;}}});const r=await f.repair.run({signal:c.signal});assert.equal(r.stage,'cancelled');assert.equal(f.counts().applied,false);assert.equal(f.counts().commits,0);
});
test('timeout aborts a cooperative request and bounds attempts',async()=>{
 const f=fixture({budgetMs:15,adapter:{probe:async(_,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve({status:'failed',reason:'transport'}),{once:true}))}});const r=await f.repair.run();assert.equal(r.stage,'needs_action');assert.equal(r.requests,1);assert.match(r.detail,/时间已到/);
});
test('a second simultaneous run cannot duplicate a model request',async()=>{
 let release;const gate=new Promise(r=>release=r);let count=0;const f=fixture({adapter:{probe:async()=>{count++;await gate;return pass;}}});const first=f.repair.run();await new Promise(r=>setTimeout(r,5));await f.repair.run();release();await first;assert.equal(count,2);
});
test('failed rollback remains a conflict instead of a success',async()=>{
 let calls=0;const f=fixture({adapter:{probe:async()=>++calls===2?pass:{status:'failed',reason:'transport'},prepare:async()=>({record:{},apply:async()=>{},readback:async()=>true,rollback:async()=>({ok:false}),commit:async()=>{throw new Error('must not commit');}})}});
 assert.equal((await f.repair.run()).stage,'rollback_conflict');
});
test('uncompleted route transaction is reconciled before a new request',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'susu-auto-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await writeFile(path.join(directory,'codex-auto-repair.json'),JSON.stringify({schema:1,stage:'verifying',route:{profile:'p',group:'G',before:'A',after:'B',committed:false}}));
 const f=fixture({directory});f.select('B');const r=await f.repair.run();assert.equal(r.stage,'awaiting_activation',JSON.stringify(r));assert.equal(f.counts().node,'A');
 const saved=JSON.parse(await readFile(path.join(directory,'codex-auto-repair.json'),'utf8'));assert.equal(saved.stage,'awaiting_activation');assert(!JSON.stringify(saved).includes('not-public'));
});
test('recovery conflict keeps the previous journal, with no new write or request',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'susu-auto-conflict-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const raw=JSON.stringify({schema:1,route:{profile:'p',group:'G',before:'A',after:'B',committed:false}}),file=path.join(directory,'codex-auto-repair.json');await writeFile(file,raw);
 const f=fixture({directory});f.select('C');assert.equal((await f.repair.run()).stage,'rollback_conflict');assert.equal(await readFile(file,'utf8'),raw);assert.equal(f.counts().probeCalls.length,0);
});
test('journal parse failure does not overwrite forensic recovery information',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'susu-auto-invalid-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'codex-auto-repair.json');await writeFile(file,'{invalid');const f=fixture({directory});assert.equal((await f.repair.run()).stage,'rollback_conflict');assert.equal(await readFile(file,'utf8'),'{invalid');
});
