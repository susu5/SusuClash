import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createCodexTargetAdapter,inspectTargetConfig,patchTargetConfig,safeProxyBypass} from '../src/codex-target.mjs';
import {runTargetProbe} from '../src/codex-target-probe.mjs';
import {createCodexAutoRepair} from '../src/codex-auto-repair.mjs';

const content='model = "gpt-test"\r\n# keep comment\r\n[desktop]\r\nvalue = "unchanged"\r\n';
const features='respect_system_proxy experimental false\nhooks stable true\nplugins stable true\nshell_tool stable true\napps stable true\n';
test('ordinary Windows LAN bypass rules do not disable an Internet Codex route',()=>{
  assert.equal(safeProxyBypass('127.*;10.*;172.16.*;172.31.*;192.168.*;169.254.*;*.local;<local>'),true);
  for(const bypass of ['*','*.openai.com','chatgpt.com','127.evil.example','10.*.evil.com','172.*','192.*','192.168.999.*','localhost\n*'])assert.equal(safeProxyBypass(bypass),false,bypass);
  assert.equal(safeProxyBypass('*.local',['model.local']),false);
  assert.equal(safeProxyBypass('192.168.*',['192.168.1.2']),false);
  assert.equal(safeProxyBypass('<local>',['internalserver']),false);
  assert.equal(safeProxyBypass('::1',['::1']),false);
});
async function fixture(t,options={}){
  const home=await mkdtemp(path.join(os.tmpdir(),'susu-target-test-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const binary=path.join(home,'codex.exe');await writeFile(binary,'test binary');await writeFile(path.join(home,'config.toml'),options.content||content);
  const run=async(_binary,args)=>({stdout:args[0]==='--version'?'codex-cli 0.167.0':args[0]==='exec'?'--ignore-user-config --strict-config --ephemeral --json':features});
  const adapter=createCodexTargetAdapter({home,locateBinary:async()=>binary,run,copyPermissions:async()=>{},checkSystemProxy:async()=>true,...options});
  const found=await adapter.discover({client:options.client||'desktop'});return {home,binary,adapter,found};
}
test('discovers exact binary and advertises only supported transport strategies',async t=>{
  const {found}=await fixture(t);assert.equal(found.supported,true);assert.deepEqual(found.strategies.map(x=>x.id),['system-proxy']);assert.equal(found.public.runtimeSelectionVerified,false);assert.equal(found.public.capabilities.desktopRestart,false);assert(!JSON.stringify(found.public).includes('codex.exe'));
});
test('missing isolation or hook suppression prevents test and mutation',async t=>{
  const {found}=await fixture(t,{run:async(_bin,args)=>({stdout:args[0]==='exec'?'--json':features})});assert.equal(found.supported,false);
});
test('minimal patch preserves unrelated content and CRLF; patches existing feature once',()=>{
  const patched=patchTargetConfig(content,'system-proxy');assert(patched.startsWith(content));assert(patched.endsWith('[features]\r\nrespect_system_proxy = true\r\n'));
  const before='[features]\nrespect_system_proxy = false # mine\nshell_tool = true\n';assert.equal(patchTargetConfig(before,'system-proxy'),'[features]\nrespect_system_proxy = true # mine\nshell_tool = true\n');
});
test('ambiguous or multiline configuration refuses mutation; no synthetic provider migration',()=>{
  for(const value of ['features.respect_system_proxy = false\n','[features]\nx=true\n[features]\ny=false\n','note="""\n[features]\n"""\n','profile="work"\n'])assert.throws(()=>inspectTargetConfig(value));
  assert.throws(()=>patchTargetConfig(content,'http'));
  for(const value of ['"model_provider" = "custom"\n','["features"]\nrespect_system_proxy=false\n','["model_providers"."custom"]\nname="custom"\n','[model_providers."openai"]\nsupports_websockets=false\n','[model_providers]\nopenai={supports_websockets=false}\n'])assert.throws(()=>inspectTargetConfig(value));
  const explicit='model_provider = "custom"\n[model_providers.custom]\nname="Mine"\nbase_url="https://example.test/v1"\nwire_api="responses"\nsupports_websockets=true\n';assert.equal(patchTargetConfig(explicit,'http'),explicit.replace('supports_websockets=true','supports_websockets=false'));
});
test('probe is exact executable config projection and persisted pass reads committed setting',async t=>{
  const captures=[];const {adapter,found}=await fixture(t,{probeProcess:async(target,args)=>{captures.push({target,args});return {status:'probe_passed',fresh:true,transportClean:true};}});
  assert.equal((await adapter.probe(found.target,{strategy:'system-proxy',port:7890})).status,'probe_passed');
  assert(captures[0].args.args.includes('model="gpt-test"'));assert(captures[0].args.args.includes('features.respect_system_proxy=true'));
  const tx=await adapter.prepare(found.target,{strategy:'system-proxy'});await tx.apply();assert.equal((await tx.readback()).ok,true);
  await adapter.probe(found.target,{strategy:'system-proxy',port:7890,persisted:true});assert(captures[1].args.args.includes('features.respect_system_proxy=true'));await tx.rollback();
});
test('transport endpoint overrides are refused while service tier and auth restrictions are preserved',async t=>{
  for(const field of ['openai_base_url','chatgpt_base_url','experimental_realtime_ws_base_url','auth_env_key','model_request_timeout_ms'])assert.throws(()=>inspectTargetConfig(`${field} = "override"\n`));
  assert.throws(()=>inspectTargetConfig('[model_providers.openai]\nbase_url="https://example.test"\n'));
  let args;const configured='model="gpt-test"\nservice_tier="fast"\nmodel_reasoning_effort="high"\nforced_login_method="chatgpt"\nforced_chatgpt_workspace_id="restricted-workspace"\n';
  const {adapter,found}=await fixture(t,{content:configured,probeProcess:async(_t,o)=>{args=o.args;return {status:'probe_passed'};}});
  assert.equal(found.supported,true);await adapter.probe(found.target,{strategy:'current',port:7890});
  for(const expected of ['service_tier="fast"','model_reasoning_effort="high"','forced_login_method="chatgpt"','forced_chatgpt_workspace_id="restricted-workspace"'])assert(args.includes(expected));
});
test('proxy path mismatch or .env override blocks false-positive system proxy verification',async t=>{
  let called=false;const {adapter,found,home}=await fixture(t,{probeProcess:async()=>{called=true;}});
  await writeFile(path.join(home,'.env'),'HTTPS_PROXY=http://127.0.0.1:1111\n');const r=await adapter.probe(found.target,{strategy:'system-proxy',port:7890});assert.equal(r.reason,'proxy_override');assert.equal(called,false);
  const other=await fixture(t,{checkSystemProxy:async()=>false});assert.equal((await other.adapter.probe(other.found.target,{strategy:'system-proxy',port:7890})).reason,'proxy_context');
});
test('apply then rollback restores exact original bytes',async t=>{
  const {adapter,found,home}=await fixture(t);const tx=await adapter.prepare(found.target,{strategy:'system-proxy'});await tx.apply();assert.equal((await tx.readback()).ok,true);assert.equal((await tx.rollback()).ok,true);assert.equal(await readFile(path.join(home,'config.toml'),'utf8'),content);
  assert(!(await readdir(home)).some(x=>x.startsWith('.susuclash-')));
});
test('external edits prevent apply and rollback never overwrites another writer',async t=>{
  const {adapter,found,home}=await fixture(t);const tx=await adapter.prepare(found.target,{strategy:'system-proxy'});await tx.apply();const external='model="new-choice"\n';await writeFile(path.join(home,'config.toml'),external);
  assert.deepEqual(await tx.rollback(),{ok:false,reason:'conflict'});assert.equal(await readFile(path.join(home,'config.toml'),'utf8'),external);
  await assert.rejects(adapter.prepare(found.target,{strategy:'system-proxy'}));
});
test('crash recovery rolls back applied journal using hashes and never replays requests',async t=>{
  const {adapter,found,home}=await fixture(t);const tx=await adapter.prepare(found.target,{strategy:'system-proxy'});await tx.apply();
  await writeFile(path.join(home,'.susuclash-transport-'+tx.record.id+'.restore'),'interrupted old restore');
  const fresh=createCodexTargetAdapter({home,copyPermissions:async()=>{}});assert.equal((await fresh.recover()).ok,true);assert.equal(await readFile(path.join(home,'config.toml'),'utf8'),content);
});
test('committed repair survives next startup; no secret configuration in transaction journal',async t=>{
  const {adapter,found,home}=await fixture(t,{content:content+'[unrelated]\nvalue="SECRET_VALUE"\n'});const tx=await adapter.prepare(found.target,{strategy:'system-proxy'});await tx.apply();
  const journal=(await readdir(home)).find(x=>x.endsWith('.json'));assert(!(await readFile(path.join(home,journal),'utf8')).includes('SECRET_VALUE'));await tx.commit();assert.equal((await adapter.recover()).ok,true);assert((await readFile(path.join(home,'config.toml'),'utf8')).includes('respect_system_proxy = true'));
});
test('desktop activation protects current work and never claims app verified',async t=>{
  const {adapter,found}=await fixture(t);const r=await adapter.activate(found.target);assert.equal(r.status,'awaiting_idle');assert(!('verification'in r));
});

const reply={type:'item.completed',item:{type:'agent_message',text:'SUSUCLASH_CONNECTION_OK'}};
function launchFixture(events,{stderr='',code=0,inspect=()=>{}}={}){return (binary,args,options)=>{
  inspect(binary,args,options);const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.exitCode=null;c.kill=()=>{c.exitCode=-1;c.emit('close',-1);};
  setImmediate(()=>{for(const e of events)c.stdout.write(JSON.stringify(e)+'\n');if(stderr)c.stderr.write(stderr);c.exitCode=code;c.emit('exit',code);c.emit('close',code);});return c;
};}
test('fresh process must complete without retry/fallback even when final reply succeeds',async()=>{
  const target={binary:'EXACT.exe',home:'test-home'};
  for(const stderr of ['retrying stream 5/5: request timed out\n','Falling back to HTTP after WebSocket failure\n']){const r=await runTargetProbe(target,{launch:launchFixture([reply,{type:'turn.completed'}],{stderr})});assert.equal(r.status,'failed');assert.equal(r.transportClean,false);}
  const r=await runTargetProbe(target,{launch:launchFixture([reply,{type:'turn.completed'}],{inspect:(binary,args,options)=>{assert.equal(binary,'EXACT.exe');assert(args.includes('--strict-config'));assert.equal(options.env.HTTPS_PROXY,undefined);assert.equal(options.env.CODEX_HOME,'test-home');assert.notEqual(options.env.RUST_LOG,'off');assert(options.env.RUST_LOG.includes('codex_core::client=info'));}}),env:{HTTPS_PROXY:'http://old:123',RUST_LOG:'off'}});assert.equal(r.status,'probe_passed');assert.equal(r.fresh,true);
});
test('real completion, exact reply and clean exit required; tools rejected',async()=>{
  const target={binary:'EXACT.exe',home:'test-home'};
  for(const events of [[reply],[{type:'turn.completed'}],[reply,{type:'turn.completed',status:'failed'}],[{type:'item.started',item:{type:'command_execution'}},reply,{type:'turn.completed'}]])assert.notEqual((await runTargetProbe(target,{launch:launchFixture(events)})).status,'probe_passed');
});
test('WebSocket connect failures are retained even if the diagnostic reply later completes',async()=>{
 const message='responses_websocket.connect{transport="responses_websocket" api.path="/responses"}: failed to connect to Responses WebSocket stage=Unknown';
 const target={binary:'EXACT.exe',home:'test-home'};
 for(const options of [
  {events:[reply,{type:'turn.completed'}],stderr:'2026-11-10T15:37:44Z ERROR codex_api::endpoint::responses_websocket: '+message+'\n'},
  {events:[{type:'item.completed',item:{type:'error',message}},reply,{type:'turn.completed'}],stderr:''}
 ]){
  const r=await runTargetProbe(target,{launch:launchFixture(options.events,{stderr:options.stderr})});
  assert.equal(r.status,'failed');assert.equal(r.reason,'transport');assert.equal(r.connectionFailures,1);
  assert.equal(r.retries,0);assert.equal(r.completed,true);assert.equal(r.transportClean,false);assert.match(r.detail,/连接失败/);
 }
});
test('unclassified transport ERROR cannot pass, while ordinary warnings and background errors remain separate',async()=>{
 const target={binary:'EXACT.exe',home:'test-home'};
 for(const [stderr,status,unknown] of [
  ['2026-11-10T15:37:44Z ERROR codex_api::endpoint::responses_websocket: new failure shape PRIVATE_TOKEN\n','failed',1],
  ['\u001b[31mERROR\u001b[0m codex_api::endpoint::responses_websocket: new failure shape\n','failed',1],
  ['WARN codex_api::endpoint::responses_websocket: optional capability unavailable\n','probe_passed',0],
  ['INFO codex_core::client: connection timeout=90\n','probe_passed',0],
  ['INFO codex_core::client: test example: failed to connect\n','probe_passed',0],
  ['ERROR codex_core::models_manager::manager: failed to connect to model catalog\n','probe_passed',0]
 ]){
  const r=await runTargetProbe(target,{launch:launchFixture([reply,{type:'turn.completed'}],{stderr})});
  assert.equal(r.status,status);assert.equal(r.otherTransportErrors,unknown);assert.equal(r.connectionFailures,0);
  if(unknown)assert.equal(r.reason,'transport_unknown');assert(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
 }
});
test('INFO HTTP fallback remains a failed connection test even with a complete reply',async()=>{
 const r=await runTargetProbe({binary:'EXACT.exe',home:'test-home'},{launch:launchFixture([reply,{type:'turn.completed'}],{stderr:'INFO codex_core::client: Falling back to HTTP after WebSocket failure\n'})});
 assert.equal(r.status,'failed');assert.equal(r.fallback,true);assert.equal(r.transportClean,false);
});
test('auth errors classified without returning raw error or tokens',async()=>{
  const r=await runTargetProbe({binary:'EXACT.exe',home:'home'},{launch:launchFixture([{type:'error',message:'401 unauthorized SECRET_TOKEN'}],{code:1})});assert.equal(r.status,'needs_user');assert.equal(r.reason,'auth');assert(!JSON.stringify(r).includes('SECRET_TOKEN'));
});
test('native error items are classified rather than mistaken for tool activity',async()=>{
 for(const [message,reason] of [['401 unauthorized PRIVATE_VALUE','auth'],['The model is not supported','model'],['Unknown field in configuration','configuration'],['stream disconnected: request timed out','transport']]){
  const r=await runTargetProbe({binary:'EXACT.exe',home:'home'},{launch:launchFixture([{type:'item.completed',item:{type:'error',message}}],{code:1})});
  assert.equal(r.reason,reason);assert.equal(r.blockedItemType,null);assert(!JSON.stringify(r).includes('PRIVATE_VALUE'));
 }
});
test('non-fatal runtime warnings and unrelated background timeouts do not invalidate a completed response',async()=>{
 const warning={type:'item.completed',item:{type:'error',message:'Under-development features enabled: respect_system_proxy.'}};
 const r=await runTargetProbe({binary:'EXACT.exe',home:'home'},{launch:launchFixture([warning,reply,{type:'turn.completed'}],{stderr:'WARN codex_core::models_manager::manager: refreshing model catalog timed out\n'})});
 assert.equal(r.status,'probe_passed');assert.equal(r.retries,0);assert.equal(r.warnings.experimental,1);assert.equal(r.warnings.background,1);
 const rerouted=await runTargetProbe({binary:'EXACT.exe',home:'home'},{launch:launchFixture([{type:'item.completed',item:{type:'error',message:'model rerouted: original -> fallback (reason)'}},reply,{type:'turn.completed'}])});
 assert.equal(rerouted.reason,'model');assert.equal(rerouted.status,'failed');
 const retry=await runTargetProbe({binary:'EXACT.exe',home:'home'},{launch:launchFixture([warning,reply,{type:'turn.completed'}],{stderr:'WARN codex_core::responses_retry: retrying stream 1/5: request timed out\n'})});
 assert.equal(retry.status,'failed');assert(retry.retries>0);
});
test('certificate and TLS handshake failures remain protected and stop transport retry plans',async()=>{
  for(const message of ['certificate verify failed','invalid certificate','TLS handshake failed: unexpected EOF']){const r=await runTargetProbe({binary:'EXACT.exe',home:'home'},{launch:launchFixture([{type:'error',message}],{code:1})});assert.equal(r.reason,'tls');assert.equal(r.transportClean,false);}
});
test('pre-aborted probes and expired deadline launch no process',async()=>{
  const c=new AbortController();c.abort();let invoked=false;for(const options of [{signal:c.signal},{deadline:Date.now()-1}])assert.equal((await runTargetProbe({},{...options,launch:()=>{invoked=true;}})).reason,'cancelled');assert.equal(invoked,false);
});
test('real adapter and orchestrator integrate baseline failure, candidate success and fresh persisted verification',async t=>{
  const captures=[];
  const {adapter,home}=await fixture(t,{content:content+'[features]\r\nrespect_system_proxy = false\r\n',probeProcess:async(target,options)=>{
    const enabled=options.args.includes('features.respect_system_proxy=true');captures.push([...options.args]);
    return runTargetProbe(target,{...options,launch:launchFixture([reply,{type:'turn.completed'}],{stderr:enabled?'':'retrying stream 5/5: request timed out\nFalling back to HTTP\n'})});
  }});
  const repair=createCodexAutoRepair({adapter,directory:null,core:{status:()=>({state:'running'})},configuration:async()=>({profile:'p'}),inspect:async()=>({port:7890,checks:[{id:'core',status:'passed'},{id:'port',status:'passed'}]}),system:{codexEvidence:async()=>({counts:{timeout:5}})}});
  const result=await repair.run({client:'desktop'});
  assert.equal(result.stage,'awaiting_activation',JSON.stringify(result));assert.equal(result.requests,3);assert(captures[0].includes('features.respect_system_proxy=false'));assert(captures[1].includes('features.respect_system_proxy=true'));assert(captures[2].includes('features.respect_system_proxy=true'));assert.equal(result.sessionConfirmed,false);assert((await readFile(path.join(home,'config.toml'),'utf8')).includes('respect_system_proxy = true'));
});
