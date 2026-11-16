import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../src/server.mjs';
import {AppError} from '../src/mihomo.mjs';

function fixture(){
 let busy=false,stage='idle',closed=false,calls=[];
 const core={status:()=>({state:'running'}),identity:async()=>({version:'fixture'}),preferences:async()=>({expectedPort:7890}),call:async(_m,route)=>route==='/configs'?{'mixed-port':7890,mode:'rule'}:route==='/proxies'?{proxies:{}}:{}};
 const netfixService={get:async()=>({engine:'netfix',stage,busy}),diagnose:async()=>{calls.push('diagnose');stage='result';return{engine:'netfix',stage,busy};},preview:async input=>{calls.push('preview');if(input.action!=='fix-port')throw new AppError('不支持的修复动作。',400);return{engine:'netfix',plan:{token:'opaque-server-token',rows:Array.from({length:6},(_,i)=>['字段'+i,'值'])}};},apply:async input=>{calls.push('apply');if(input.token!=='opaque-server-token'||input.confirmed!==true)throw new AppError('方案已失效。',409);busy=true;stage='executing';return{engine:'netfix',busy,stage};},cancel:async()=>{calls.push('cancel');busy=false;stage='cancelled';return{engine:'netfix',busy,stage};},invalidate(){calls.push('invalidate');stage='stale';},isRepairing:()=>busy,close:async()=>{closed=true;busy=false;}};
 return{core,netfixService,reset:()=>{calls=[];},calls:()=>calls,closed:()=>closed};
}
const post=(app,route,body={},origin=app.origin,ctype='application/json')=>fetch(app.url+'api/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':ctype},body:JSON.stringify(body)});

test('retired Codex HTTP paths cannot invoke old strategies, requests or file writers',async t=>{
 const f=fixture();let probes=0;const app=await startServer({...f,dailyUpdate:false,codexTargetAdapter:{recover:async()=>({ok:true}),discover:async()=>{probes++;},probe:async()=>{probes++;}}});t.after(()=>app.close());
 for(const [route,body]of [['doctor/auto-start',{consent:true}],['doctor/start',{scope:'codex'}],['doctor/request',{}],['doctor/confirm',{}],['doctor/preview',{kind:'codex-port'}],['codex-repair/preview',{}],['codex-repair/apply',{token:'anything'}]]){const r=await post(app,route,body);assert.equal(r.status,410,route);assert.match((await r.json()).error,/Netfix/);}
 assert.equal(probes,0);assert.deepEqual(f.calls(),[]);assert.equal((await fetch(app.url+'codex-repair.js')).status,404);
});

test('Netfix routes use existing random path, origin and JSON authorization',async t=>{
 const f=fixture();const app=await startServer({...f,dailyUpdate:false});t.after(()=>app.close());
 assert.equal((await fetch(app.origin+'/api/netfix')).status,404);
 assert.equal((await post(app,'netfix/diagnose',{},'https://untrusted.invalid')).status,403);
 assert.equal((await post(app,'netfix/preview',{action:'fix-port'},app.origin,'text/plain')).status,415);
 const missingOrigin=await fetch(app.url+'api/netfix/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:true,token:'opaque-server-token'})});assert.equal(missingOrigin.status,403);
 assert.deepEqual(f.calls(),[]);
 assert.equal((await post(app,'netfix/diagnose')).status,200);
 const result=await(await fetch(app.url+'api/netfix')).json();assert.equal(result.engine,'netfix');assert.equal(result.stage,'result');
 const plan=await(await post(app,'netfix/preview',{action:'fix-port'})).json();assert.equal(plan.plan.token,'opaque-server-token');assert.equal(plan.plan.rows.length,6);
 assert.equal((await post(app,'netfix/apply',{confirmed:true,token:'forged'})).status,409);
 assert.equal((await post(app,'netfix/apply',{confirmed:true,token:plan.plan.token})).status,200);
 assert.equal((await post(app,'core-start')).status,409);assert.equal((await post(app,'doctor/start',{scope:'proxy'})).status,409);assert.equal((await post(app,'doctor/preview',{kind:'core-restart'})).status,409);
 assert.equal((await post(app,'netfix/cancel')).status,200);assert.equal((await(await fetch(app.url+'api/netfix')).json()).stage,'cancelled');
});

test('new production assets are served under the protected client prefix only',async t=>{
 const f=fixture();const app=await startServer({...f,dailyUpdate:false});t.after(()=>app.close());
 for(const file of ['netfix.js','netfix.css']){const r=await fetch(app.url+file);assert.equal(r.status,200);assert.match(r.headers.get('Content-Security-Policy'),/connect-src 'self'/);const text=await r.text();assert(text.length>100);assert(!text.includes('window.netfixPrototype'));}
 assert.equal((await fetch(app.origin+'/netfix.js')).status,404);assert.deepEqual(f.calls(),[]);
});

test('server shutdown waits for the Netfix close/recovery boundary',async()=>{
 const f=fixture();let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);f.netfixService.close=async()=>{entered();await gate;};
 const app=await startServer({...f,dailyUpdate:false});let finished=false;const closing=app.close().then(()=>{finished=true;});await started;
 try{assert.equal(finished,false);assert.equal((await post(app,'doctor/start',{scope:'proxy'})).status,503);assert.equal((await post(app,'netfix/diagnose')).status,503);}
 finally{release();await closing;}
 assert.equal(finished,true);
});
