import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../src/server.mjs';

test('real automatic HTTP endpoint authorizes once, blocks competing writes, cancels and records cleanup',async t=>{
 let probes=0,release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const core={status:()=>({state:'running'}),processId:()=>123,preferences:async()=>({expectedPort:7890}),call:async(_method,route)=>route==='/configs'?{'mixed-port':7890,mode:'rule'}:route==='/proxies'?{proxies:{}}:{}};
 const systemProxy={getStatus:async()=>({enabled:true,managed:true,port:7890}),restoreOnExit:async()=>{}};
 const doctorSystem={probe:async()=>({code:204,exit:0}),listeners:async()=>[{port:7890,pid:123}],codexEvidence:async()=>({counts:{timeout:5},transport:{fiveRetriesThenHttp:true}}),codexProxy:async()=>({kind:'none'}),interfaces:()=>({test:[{internal:false,address:'192.0.2.1'}]}),lookup:async()=>({address:'192.0.2.2'})};
 const codexTargetAdapter={recover:async()=>({ok:true}),discover:async()=>({supported:true,public:{client:'desktop'},target:{},strategies:[{id:'system-proxy'}]}),probe:async()=>{probes++;entered();await gate;return {status:'failed',reason:'transport'};}};
 const app=await startServer({core,systemProxy,doctorSystem,codexTargetAdapter,dailyUpdate:false});
 t.after(async()=>{release();await app.close();});
 const post=(route,body,origin=app.origin)=>fetch(app.url+'api/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post('doctor/auto-start',{})).status,400);
 assert.equal((await post('doctor/auto-start',{consent:true},'https://untrusted.invalid')).status,403);
 const first=await (await post('doctor/auto-start',{client:'desktop',symptom:'reconnect',consent:true})).json();assert.equal(first.task.phase,'repairing');await started;
 const next=await (await post('doctor/auto-start',{consent:true})).json();assert.equal(first.task.id,next.task.id);assert.equal(probes,1);
 assert.equal((await post('core-start',{})).status,409);
 assert.equal((await post('doctor/cancel',{})).status,200);release();
 let result;
 for(let i=0;i<100;i++){result=await (await fetch(app.url+'api/doctor')).json();if(result.task.phase==='result')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(result.codex.autoRepair.stage,'cancelled');assert.equal(result.codex.sessionConfirmed,false);assert.equal(result.history[0].scope,'codex');assert.equal(probes,1);
});
