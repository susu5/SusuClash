import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createCodexAutoRepair} from '../src/codex-auto-repair.mjs';
import {createCodexTargetAdapter} from '../src/codex-target.mjs';

const pass=()=>({status:'probe_passed',retries:0,fallback:false,fresh:true,transportClean:true});
function runner(adapter,options={}) {
  let node='A';
  return createCodexAutoRepair({
    core:{directory:null,status:()=>({state:'running'}),processId:()=>7,call:async(method,_url,body)=>{if(method==='PUT')node=body.name;return {now:node,all:['A','B']};}},
    configuration:async()=>({profile:'p',node,automation:{group:'G',backups:['B']}}),
    inspect:async()=>({port:7890,checks:[{id:'core',status:'passed'},{id:'port',status:'passed'}]}),
    system:{codexEvidence:async()=>({counts:{},transport:{}})},health:{verify:async()=> 'ok'},
    adapter,...options
  });
}
function fakeAdapter(options={}) {
  return {
    recover:async()=>({ok:true}),
    discover:async()=>({supported:true,public:{client:'desktop'},target:{},strategies:[{id:'system-proxy',label:'代理修复'}]}),
    probe:async()=>pass(),
    activate:async()=>({status:'awaiting_idle'}),
    prepare:async()=>({record:{},apply:async()=>{},readback:async()=>({ok:true}),rollback:async()=>({ok:true}),commit:async()=>{}}),
    ...options
  };
}

test('real target adapter accepts the orchestrator strategy contract and verifies saved configuration',async t=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'susu-auto-contract-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const binary=path.join(home,'codex.exe');await writeFile(binary,'test executable');
  await writeFile(path.join(home,'config.toml'),'model="gpt-test"\n');
  let probes=0;
  const adapter=createCodexTargetAdapter({home,locateBinary:async()=>binary,checkSystemProxy:async()=>true,copyPermissions:async()=>{},
    run:async(_binary,args)=>({stdout:args[0]==='--version'?'codex-cli 0.167.0':args[0]==='exec'?'--ignore-user-config --strict-config --ephemeral --json':'respect_system_proxy experimental false\nhooks stable true\nplugins stable true\nshell_tool stable true\n'}),
    probeProcess:async(_target,{args})=>{probes++;if(!args.includes('features.respect_system_proxy=true'))return {status:'failed',reason:'transport',retries:1,fresh:true};return pass();}
  });
  const result=await runner(adapter).run();
  assert.equal(result.stage,'awaiting_activation',JSON.stringify(result));assert.equal(probes,3);
  assert.match(await readFile(path.join(home,'config.toml'),'utf8'),/respect_system_proxy = true/);
});

test('failed object readback stops before second request and never commits or retains passing verification',async()=>{
  let calls=0,commits=0,rollbacks=0;
  const adapter=fakeAdapter({probe:async()=>++calls===1?{status:'failed',reason:'transport',retries:1,fresh:true}:pass(),prepare:async()=>({record:{},apply:async()=>{},readback:async()=>({ok:false}),rollback:async()=>{rollbacks++;return {ok:true};},commit:async()=>{commits++;}})});
  const result=await runner(adapter).run();
  assert.equal(result.stage,'needs_action');assert.equal(calls,2);assert.equal(commits,0);assert.equal(rollbacks,1);
  assert.notEqual(result.verification,'probe_passed');
});

test('authentication rejection on persisted verification retains the blocking reason after rollback',async()=>{
  let calls=0;
  const adapter=fakeAdapter({probe:async()=>++calls===1?{status:'failed',reason:'transport',retries:1,fresh:true}:calls===2?pass():{status:'needs_user',reason:'auth',retries:0,fresh:true}});
  const result=await runner(adapter).run();
  assert.equal(result.stage,'waiting_user');assert.equal(calls,3);assert.match(result.detail,/登录/);
  assert.notEqual(result.verification,'probe_passed');
});

test('failed persisted request clears verification for the reverted settings',async()=>{
  let calls=0;
  const adapter=fakeAdapter({probe:async()=>++calls===2?pass():{status:'failed',reason:'transport',retries:1,fresh:true}});
  const result=await runner(adapter).run();
  assert.equal(result.stage,'needs_action');assert.notEqual(result.verification,'probe_passed');
});
