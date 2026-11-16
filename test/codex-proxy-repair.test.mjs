import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,readdir,rm,symlink,link} from 'node:fs/promises';
import path from 'node:path';
import {createCodexTargetAdapter} from '../src/codex-target.mjs';
import {createCodexAutoRepair} from '../src/codex-auto-repair.mjs';

const config='model = "gpt-test"\r\n# retain user settings\r\n';
const before='\uFEFFexport HTTPS_PROXY="http://127.0.0.1:1111/" # local\r\nhttp_proxy=http://localhost:1111\r\nALL_PROXY=\'http://[::1]:1111\'\r\nNO_PROXY=127.0.0.1,localhost,::1\r\nSECRET_VALUE="private-preserved-value"\r\n';
const after=before.replaceAll(':1111',':7890');
const features='respect_system_proxy experimental false\nhooks stable true\nplugins stable true\nshell_tool stable true\n';
const pass=()=>({status:'probe_passed',reason:null,retries:0,connectionFailures:0,otherTransportErrors:0,fallback:false,fresh:true,transportClean:true});
const fail=()=>({status:'failed',reason:'transport',retries:1,fresh:true,transportClean:false});

async function fixture(t,{dotEnv=before,client='desktop',...options}={}){
  const root=path.resolve('outputs/working');await mkdir(root,{recursive:true});
  const home=await mkdtemp(path.join(root,'susu-proxy-repair-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const binary=path.join(home,'codex.exe'),file=path.join(home,'.env'),configFile=path.join(home,'config.toml');
  await writeFile(binary,'isolated executable fixture');await writeFile(configFile,config);
  if(dotEnv!==null)await writeFile(file,dotEnv);
  const adapter=createCodexTargetAdapter({home,locateBinary:async()=>binary,env:{},copyPermissions:async()=>{},checkSystemProxy:async()=>true,readListeners:async()=>[],
    run:async(_binary,args)=>({stdout:args[0]==='--version'?'codex-cli 0.167.0':args[0]==='exec'?'--ignore-user-config --strict-config --ephemeral --json':features}),
    probeProcess:async(_target,options)=>options.proxyEnv?pass():fail(),...options});
  const found=await adapter.discover({client});
  return {home,file,configFile,binary,adapter,found};
}
function runner(adapter){
  return createCodexAutoRepair({adapter,directory:null,core:{status:()=>({state:'running'}),processId:()=>7},configuration:async()=>({profile:'fixture'}),
    inspect:async()=>({port:7890,checks:[{id:'core',status:'passed'},{id:'port',status:'passed'}]}),system:{codexEvidence:async()=>({counts:{},transport:{}})}});
}
const artifacts=async home=>(await readdir(home)).filter(x=>x.startsWith('.susuclash-'));

test('same controlled proxy and local bypass keep ordinary system-proxy verification available',async t=>{
  const captures=[];
  const f=await fixture(t,{dotEnv:after,probeProcess:async(_target,options)=>{captures.push(options);return pass();}});
  assert.equal(f.found.supported,true);
  assert.deepEqual((await f.adapter.strategies(f.found.target,{port:7890})).map(x=>x.id),['system-proxy']);
  assert.equal((await f.adapter.probe(f.found.target,{strategy:'system-proxy',port:7890})).status,'probe_passed');
  assert.equal(captures.length,1);assert.equal(captures[0].proxyEnv,undefined);
  assert(captures[0].args.includes('features.respect_system_proxy=true'));
  assert.equal(await readFile(f.file,'utf8'),after);assert.deepEqual(await artifacts(f.home),[]);
});

test('complex unrelated dotenv content stays usable but remains fingerprint-bound',async t=>{
  const text='UNRELATED="first line\nsecond line"\n';
  const f=await fixture(t,{dotEnv:text,probeProcess:async()=>pass()});
  assert.equal(f.found.supported,true);
  assert.equal((await f.adapter.probe(f.found.target,{strategy:'current',port:7890})).status,'probe_passed');
  await writeFile(f.file,text+'OTHER=changed\n');
  assert.equal((await f.adapter.probe(f.found.target,{strategy:'current',port:7890})).reason,'context_changed');
  for(const dotEnv of ['\u00a0HTTPS_PROXY=http://outside.example:7890\n','OTHER=value\rHTTPS_PROXY=http://outside.example:7890\r']){
    assert.equal((await fixture(t,{dotEnv})).found.supported,false);
  }
});

test('proxy context changes during a completed request cannot pass or be committed',async t=>{
  let intact=true;
  const f=await fixture(t,{dotEnv:after,checkSystemProxy:async()=>intact,probeProcess:async()=>{intact=false;return pass();}});
  const result=await f.adapter.probe(f.found.target,{strategy:'current',port:7890});
  assert.equal(result.status,'unsupported');assert.equal(result.reason,'proxy_context');
  const g=await fixture(t,{checkSystemProxy:async()=>intact});intact=true;
  const tx=await g.adapter.prepare(g.found.target,{strategy:'local-proxy-port',port:7890});await tx.apply();
  intact=false;await assert.rejects(tx.commit());assert.equal((await tx.rollback()).ok,true);
  assert.equal(await readFile(g.file,'utf8'),before);
});

test('old-port baseline uses original settings and candidate projects only local proxy fields',async t=>{
  const captures=[];
  const f=await fixture(t,{probeProcess:async(_target,options)=>{captures.push(options);return options.proxyEnv?pass():fail();}});
  assert.equal(f.found.supported,true);
  const baseline=await f.adapter.probe(f.found.target,{strategy:{id:'current'},port:7890});
  assert.equal(baseline.status,'failed');assert.equal(baseline.reason,'transport');assert.equal(baseline.fresh,true);assert.equal(captures.length,1);assert.equal(captures[0].proxyEnv,undefined);
  assert.deepEqual((await f.adapter.strategies(f.found.target,{port:7890})).map(x=>x.id),['local-proxy-port']);
  assert.equal((await f.adapter.probe(f.found.target,{strategy:{id:'local-proxy-port'},port:7890})).status,'probe_passed');
  assert.deepEqual(captures[1].proxyEnv,{HTTPS_PROXY:'http://127.0.0.1:7890/',HTTP_PROXY:'http://localhost:7890',ALL_PROXY:'http://[::1]:7890',NO_PROXY:'127.0.0.1,localhost,::1'});
  assert.equal(captures[1].proxyPort,7890);assert(!JSON.stringify(captures[1]).includes('private-preserved-value'));
  assert.equal(await readFile(f.file,'utf8'),before);assert.equal(await readFile(f.configFile,'utf8'),config);
});

test('automatic local port repair saves minimal bytes only after candidate pass and verifies persisted projection',async t=>{
  let f,calls=0,baselines=0;
  f=await fixture(t,{probeProcess:async(_target,options)=>{
    if(!options.proxyEnv){baselines++;assert.equal(await readFile(f.file,'utf8'),before);return fail();}
    calls++;assert.equal(options.proxyPort,7890);
    assert.equal(await readFile(f.file,'utf8'),calls===1?before:after);
    return pass();
  }});
  const result=await runner(f.adapter).run({client:'desktop'});
  assert.equal(result.stage,'awaiting_activation',JSON.stringify(result));assert.equal(result.verification,'probe_passed');
  assert.equal(result.changed,true);assert.equal(result.sessionConfirmed,false);assert.equal(result.target.runtimeSelectionVerified,false);
  assert.equal(calls,2);assert.equal(baselines,1);assert.equal(result.requests,3);assert.equal(result.tests[0].fresh,true);
  assert.equal(await readFile(f.file,'utf8'),after);assert.equal(await readFile(f.configFile,'utf8'),config);
  assert(!JSON.stringify(result).includes('private-preserved-value'));assert.deepEqual(await artifacts(f.home),[]);
});

test('two healthy original-setting requests preserve a stale disk reference without assuming it is loaded',async t=>{
  let calls=0;const f=await fixture(t,{probeProcess:async(_target,options)=>{calls++;assert.equal(options.proxyEnv,undefined);return pass();}});
  const result=await runner(f.adapter).run();
  assert.equal(result.stage,'probe_passed');assert.equal(result.changed,false);assert.equal(result.sessionConfirmed,false);
  assert.equal(calls,2);assert.equal(await readFile(f.file,'utf8'),before);assert.deepEqual(await artifacts(f.home),[]);
});

test('CLI local file repair retains explicit awaiting-load boundary after projected probes pass',async t=>{
  const f=await fixture(t,{client:'cli'}),result=await runner(f.adapter).run({client:'cli'});
  assert.equal(result.stage,'awaiting_activation',JSON.stringify(result));assert.equal(result.activation,'awaiting_proxy_load');
  assert.equal(result.verification,'probe_passed');assert.equal(result.sessionConfirmed,false);assert.equal(await readFile(f.file,'utf8'),after);
});

test('failed persisted request restores the exact .env and never claims passing verification',async t=>{
  let calls=0;const f=await fixture(t,{probeProcess:async(_target,options)=>!options.proxyEnv?fail():++calls===1?pass():fail()});
  const result=await runner(f.adapter).run();
  assert.equal(result.stage,'needs_action',JSON.stringify(result));assert.notEqual(result.verification,'probe_passed');
  assert.equal(calls,2);assert.equal(await readFile(f.file,'utf8'),before);assert.equal(await readFile(f.configFile,'utf8'),config);
  assert.deepEqual(await artifacts(f.home),[]);
});

test('failed candidate leaves disk and transaction files untouched',async t=>{
  let calls=0;const f=await fixture(t,{probeProcess:async()=>{calls++;return fail();}});
  const result=await runner(f.adapter).run();
  assert.equal(result.stage,'needs_action');assert.equal(calls,2);
  assert.equal(await readFile(f.file,'utf8'),before);assert.deepEqual(await artifacts(f.home),[]);
});

test('cancellation during persisted request waits for restoration before returning',async t=>{
  const controller=new AbortController();let f,calls=0;
  f=await fixture(t,{probeProcess:async(_target,options)=>{if(!options.proxyEnv)return fail();if(++calls===2){assert.equal(await readFile(f.file,'utf8'),after);controller.abort();}return pass();}});
  const result=await runner(f.adapter).run({signal:controller.signal});
  assert.equal(result.stage,'cancelled',JSON.stringify(result));assert.notEqual(result.verification,'probe_passed');
  assert.equal(await readFile(f.file,'utf8'),before);assert.deepEqual(await artifacts(f.home),[]);
});

test('external edit during persisted request is retained and recovery conflict remains visible',async t=>{
  const external=after+'EXTERNAL="other-owner-value"\r\n';let f,calls=0;
  f=await fixture(t,{probeProcess:async(_target,options)=>{if(!options.proxyEnv)return fail();if(++calls===2)await writeFile(f.file,external);return pass();}});
  const result=await runner(f.adapter).run();
  assert.equal(result.stage,'rollback_conflict',JSON.stringify(result));assert.notEqual(result.verification,'probe_passed');
  assert.equal(await readFile(f.file,'utf8'),external);
  const journals=(await artifacts(f.home)).filter(x=>x.endsWith('.json'));assert.equal(journals.length,1);
  const journal=await readFile(path.join(f.home,journals[0]),'utf8');assert(!journal.includes('private-preserved-value'));assert(!journal.includes('other-owner-value'));
});

test('crash recovery restores .env from durable journal without changing config or sending requests',async t=>{
  const f=await fixture(t);const tx=await f.adapter.prepare(f.found.target,{strategy:'local-proxy-port',port:7890,runId:'isolated-recovery'});
  await tx.apply();assert.equal((await tx.readback()).ok,true);assert.equal(await readFile(f.file,'utf8'),after);
  const journal=JSON.parse(await readFile(path.join(f.home,'.susuclash-transport-'+tx.record.id+'.json'),'utf8'));
  assert.equal(journal.file,'.env');assert(!JSON.stringify(journal).includes('private-preserved-value'));
  const fresh=createCodexTargetAdapter({home:f.home,copyPermissions:async()=>{},probeProcess:()=>assert.fail('recovery must not probe')});
  assert.equal((await fresh.recover()).ok,true);assert.equal(await readFile(f.file,'utf8'),before);
  assert.equal(await readFile(f.configFile,'utf8'),config);assert.deepEqual(await artifacts(f.home),[]);
});

test('committed local proxy change survives recovery',async t=>{
  const f=await fixture(t);const tx=await f.adapter.prepare(f.found.target,{strategy:'local-proxy-port',port:7890});
  await tx.apply();await tx.commit();
  assert.equal((await createCodexTargetAdapter({home:f.home,copyPermissions:async()=>{}}).recover()).ok,true);
  assert.equal(await readFile(f.file,'utf8'),after);assert.deepEqual(await artifacts(f.home),[]);
});

test('permission-copy failure writes no private backup bytes and restores cleanly',async t=>{
  let f,copies=0;
  f=await fixture(t,{copyPermissions:async(_source,targets)=>{copies++;for(const file of targets)assert.equal(await readFile(file,'utf8'),'');throw new Error('fixture ACL failure');}});
  const result=await runner(f.adapter).run();
  assert.equal(result.stage,'needs_action',JSON.stringify(result));assert.equal(copies,1);
  assert.equal(await readFile(f.file,'utf8'),before);assert.deepEqual(await artifacts(f.home),[]);
});

test('occupied or unreadable old port never launches a request or changes files',async t=>{
  for(const owners of [[{port:1111,pid:900,name:'other.exe'}],null]){
    const f=await fixture(t,{readListeners:async()=>owners,probeProcess:()=>assert.fail('unowned proxy must not be contacted')});
    const r=await f.adapter.probe(f.found.target,{strategy:'local-proxy-port',port:7890});
    assert.equal(r.status,'unsupported');assert.equal(r.reason,'proxy_override');
    await assert.rejects(f.adapter.prepare(f.found.target,{strategy:'local-proxy-port',port:7890}));
    assert.equal(await readFile(f.file,'utf8'),before);assert.deepEqual(await artifacts(f.home),[]);
  }
});

test('external proxy, credentials, conflicting assignments and unsafe bypass fail closed',async t=>{
  for(const text of ['HTTPS_PROXY=http://public.example:1111\n','HTTPS_PROXY=http://user:private@127.0.0.1:1111\n','HTTPS_PROXY=http://127.0.0.1:1111\nhttps_proxy=http://127.0.0.1:1111\n','HTTPS_PROXY=socks5://127.0.0.1:1111\n']){
    const f=await fixture(t,{dotEnv:text,probeProcess:()=>assert.fail('unsupported proxy must not be contacted')});
    assert.equal(f.found.supported,false);assert(!JSON.stringify(f.found).includes('user:private'));
    assert.equal(await readFile(f.file,'utf8'),text);
  }
  for(const value of ['*','chatgpt.com','api.openai.com','*.local','10.0.0.0/8']){
    const text='HTTPS_PROXY=http://127.0.0.1:7890\nNO_PROXY='+value+'\n';
    const f=await fixture(t,{dotEnv:text,probeProcess:()=>assert.fail('unsafe bypass must not run')});
    assert.equal(f.found.supported,true);const r=await f.adapter.probe(f.found.target,{strategy:'current',port:7890});
    assert.equal(r.status,'unsupported');assert.equal(r.reason,'proxy_override');assert.equal(await readFile(f.file,'utf8'),text);
  }
});

test('proxy fingerprint detects additions, deletion and edits since discovery before any request',async t=>{
  for(const initial of [null,after,before]){
    const f=await fixture(t,{dotEnv:initial,probeProcess:()=>assert.fail('changed context must not be probed')});
    if(initial===after)await rm(f.file);else await writeFile(f.file,initial===null?after:before+'EXTERNAL=changed\r\n');
    const r=await f.adapter.probe(f.found.target,{strategy:'system-proxy',port:7890});
    assert.equal(r.reason,'context_changed');assert.equal(r.fresh,false);
    await assert.rejects(f.adapter.prepare(f.found.target,{strategy:'system-proxy'}));
  }
});

test('proxy edits while request runs invalidate an otherwise completed candidate',async t=>{
  let f;const external=before+'EXTERNAL=changed\r\n';
  f=await fixture(t,{probeProcess:async()=>{await writeFile(f.file,external);return pass();}});
  const r=await f.adapter.probe(f.found.target,{strategy:'local-proxy-port',port:7890});
  assert.equal(r.status,'failed');assert.equal(r.reason,'context_changed');assert.equal(await readFile(f.file,'utf8'),external);
  assert.deepEqual(await artifacts(f.home),[]);
});

test('config dependency changes block .env apply, while rollback preserves that other writer',async t=>{
  const f=await fixture(t),tx=await f.adapter.prepare(f.found.target,{strategy:'local-proxy-port',port:7890});
  const external='model="different-model"\n';await writeFile(f.configFile,external);
  await assert.rejects(tx.apply());assert.equal((await tx.rollback()).ok,true);
  assert.equal(await readFile(f.file,'utf8'),before);assert.equal(await readFile(f.configFile,'utf8'),external);assert.deepEqual(await artifacts(f.home),[]);
});

test('dependency changes after apply block commit but allow restoring only owned file',async t=>{
  const f=await fixture(t),tx=await f.adapter.prepare(f.found.target,{strategy:'local-proxy-port',port:7890});
  await tx.apply();const external='model="different-model"\n';await writeFile(f.configFile,external);
  await assert.rejects(tx.readback());await assert.rejects(tx.commit());assert.equal((await tx.rollback()).ok,true);
  assert.equal(await readFile(f.file,'utf8'),before);assert.equal(await readFile(f.configFile,'utf8'),external);
});

test('changing old port ownership after prepare blocks apply before writing',async t=>{
  let owners=[];const f=await fixture(t,{readListeners:async()=>owners}),tx=await f.adapter.prepare(f.found.target,{strategy:'local-proxy-port',port:7890});
  owners=[{port:1111,pid:900}];await assert.rejects(tx.apply());assert.equal((await tx.rollback()).ok,true);
  assert.equal(await readFile(f.file,'utf8'),before);assert.deepEqual(await artifacts(f.home),[]);
});

test('hard-linked .env cannot become an automatic repair target',async t=>{
  const f=await fixture(t,{dotEnv:null}),real=path.join(f.home,'original.env');await writeFile(real,before);
  try{await link(real,f.file);}catch(e){if(['EPERM','EACCES'].includes(e.code))return t.skip('creating a hard link requires privileges');throw e;}
  assert.equal((await f.adapter.discover({client:'desktop'})).supported,false);assert.equal(await readFile(real,'utf8'),before);
});

test('symbolic-linked .env cannot become an automatic repair target',async t=>{
  const f=await fixture(t,{dotEnv:null}),real=path.join(f.home,'original.env');await writeFile(real,before);
  try{await symlink(real,f.file,'file');}catch(e){if(['EPERM','EACCES'].includes(e.code))return t.skip('creating a symbolic link requires privileges');throw e;}
  assert.equal((await f.adapter.discover({client:'desktop'})).supported,false);assert.equal(await readFile(real,'utf8'),before);
});
