import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createManagedCore} from '../src/managed-core.mjs';
import {createProfileStore} from '../src/profiles.mjs';
import {startServer} from '../src/server.mjs';

for(const scenario of ['node','core'])test(`automatic ${scenario} action invalidates base, application and original-session evidence`,async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'susuclash-doctor-api-'));let app;
 const real=createManagedCore({directory:dir});let fail=false,coreError=false,stopCount=0;
 const core={...real,status:()=>coreError?{state:'error'}:real.status(),stop:async()=>{stopCount++;return real.stop();},start:async()=>{const r=await real.start();coreError=false;return r;}};
 t.after(async()=>{await app?.close();await real.stop();await rm(dir,{recursive:true,force:true});});
 const profiles=createProfileStore({directory:path.join(dir,'profiles'),validateConfig:core.validateConfig,applyConfig:core.applyConfig});
 let enabled=true;
 const systemProxy={getStatus:async()=>({enabled,managed:enabled}),enable:async()=>{enabled=true;},disable:async()=>{enabled=false;},restoreOnExit:async()=>{enabled=false;}};
 const healthProbe={force(){},inspect:async node=>({network:'ok',node:fail&&node==='DIRECT'?'failed':'ok'}),verify:async()=> 'ok'};
 const doctorSystem={probe:async()=>({code:204,exit:0}),listeners:async ports=>ports.map(port=>({port,pid:String(real.processId())})),codexProxy:async()=>({kind:'none'}),interfaces:()=>({test:[{address:'192.0.2.1',internal:false}]}),lookup:async()=>({address:'192.0.2.2'})};
 app=await startServer({core,profileStore:profiles,systemProxy,healthProbe,doctorSystem,codexHealth:{inspect:async()=>({result:'unknown'})},dailyUpdate:false,autostart:{getStatus:async()=>({enabled:false,conflict:false})},automationIntervalMs:30});
 const get=async route=>{const r=await fetch(app.url+'api/'+route);assert.equal(r.status,200);return r.json();};
 const post=async(route,value)=>{const r=await fetch(app.url+'api/'+route,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(value)});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;};
 const p=await post('profiles/local',{name:'isolated evidence fixture',content:'mode: rule\nproxies: []\nproxy-groups:\n  - name: Test\n    type: select\n    proxies: [DIRECT, REJECT]\nrules:\n  - MATCH,Test\n'});
 await post('profiles/activate',{id:p.id});enabled=true;
 await post('automation',{group:'Test',autoRepair:scenario==='core',autoSwitch:scenario==='node',backups:['REJECT']});
 const done=async()=>{for(let i=0;i<100;i++){const d=await get('doctor');if(d.task?.phase==='result')return d;await new Promise(r=>setTimeout(r,10));}throw new Error('doctor did not complete');};
 await post('doctor/start',{scope:'proxy'});await done();await post('doctor/start',{scope:'codex'});await done();await post('doctor/confirm',{});
 let d=await get('doctor');assert.equal(d.base.status,'passed');assert.equal(d.codex.sessionConfirmed,true);
 if(scenario==='node')fail=true;else coreError=true;
 const end=Date.now()+6000;
 while(Date.now()<end){d=await get('doctor');if(d.base.status==='stale'&&d.codex.status==='stale')break;await new Promise(r=>setTimeout(r,30));}
 assert.equal(d.base.status,'stale');assert.equal(d.codex.status,'stale');assert.equal(d.codex.sessionConfirmed,false);assert(d.base.checks.every(c=>c.status==='stale'));
 if(scenario==='core')assert(stopCount>0,'explicitly stops the owned core before starting');
});
