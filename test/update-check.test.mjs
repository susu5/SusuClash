import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateChecker,RELEASE_PAGE} from '../src/update-check.mjs';
import {startServer} from '../src/server.mjs';
import path from 'node:path';

const response=(status,body)=>async()=>({status,body:typeof body==='string'?body:JSON.stringify(body)});
const release=(tag,extra={})=>({tag_name:tag,draft:false,prerelease:false,html_url:'https://malicious.example/?credential=fixture',assets:[{browser_download_url:'https://malicious.example/file.msi'}],...extra});

test('compares numeric stable versions and returns only the fixed public release page',async()=>{
  for(const [tag,status,latest] of [['v0.1.6','available','0.1.6'],['0.2.0','available','0.2.0'],['v0.1.5','up_to_date','0.1.5'],['v0.1.4','up_to_date','0.1.4'],['v1.0.0','available','1.0.0']]){
    const check=createUpdateChecker({currentVersion:'0.1.5',request:response(200,release(tag))});
    assert.deepEqual(await check.check(),{status,currentVersion:'0.1.5',latestVersion:latest,releaseUrl:RELEASE_PAGE,downloadUrl:null});
  }
});

test('reports no formal release, malformed metadata, server and rate-limit failures distinctly',async()=>{
  for(const [status,body,expected] of [[404,'','unreleased'],[429,'','rate_limited'],[403,{message:'API rate limit exceeded'},'rate_limited'],[403,{message:'Forbidden'},'service_error'],[500,'','service_error'],[302,'','service_error'],[200,'{broken','invalid_release'],[200,{tag_name:'v1.2.3'},'invalid_release'],[200,release('1.2.3-rc1'),'invalid_release'],[200,release('v1.2.3',{draft:true}),'invalid_release'],[200,release('v1.2.3',{prerelease:true}),'invalid_release'],[200,release('v01.2.3'),'invalid_release']]){
    const value=await createUpdateChecker({currentVersion:'0.1.5',request:response(status,body)}).check();
    assert.equal(value.status,expected);assert.equal(value.latestVersion,null);assert.equal(value.releaseUrl,RELEASE_PAGE);
  }
  assert.equal((await createUpdateChecker({currentVersion:'invalid',request:()=>{throw Error('must not request')}}).check()).status,'service_error');
});

test('distinguishes timeout and network error, without exposing upstream error text',async()=>{
  const bad=await createUpdateChecker({currentVersion:'0.1.5',request:async()=>{throw Error('private fixture message')}}).check();
  assert.equal(bad.status,'network_error');assert(!JSON.stringify(bad).includes('private'));
  const slow=await createUpdateChecker({currentVersion:'0.1.5',timeoutMs:20,request:()=>new Promise(()=>{})}).check();
  assert.equal(slow.status,'timeout');
});

test('limits proxy to a valid port supplied by the trusted ownership check',async()=>{
  for(const [supplied,expected] of [[7890,7890],[0,null],[65536,null],['7890',null],[null,null]]){
    let received;
    const check=createUpdateChecker({currentVersion:'0.1.5',getManagedProxy:async()=>supplied,request:async options=>{received=options;return {status:404,body:''}}});
    assert.equal((await check.check()).status,'unreleased');assert.equal(received.proxyPort,expected);assert(received.signal instanceof AbortSignal);
  }
  let received;
  const check=createUpdateChecker({currentVersion:'0.1.5',getManagedProxy:async()=>{throw Error('unavailable')},request:async options=>{received=options;return {status:404,body:''}}});
  await check.check();assert.equal(received.proxyPort,null);
});

test('concurrent checks share a request and future checks can retry',async()=>{
  let calls=0,finish;
  const checker=createUpdateChecker({currentVersion:'0.1.5',request:async()=>{calls++;return new Promise(resolve=>{finish=resolve})}});
  const first=checker.check(),second=checker.check();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);finish({status:404,body:''});assert.equal((await first).status,'unreleased');assert.equal((await second).status,'unreleased');
  const third=checker.check();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);finish({status:200,body:JSON.stringify(release('0.2.0'))});assert.equal((await third).status,'available');
});

test('server makes update requests only for the explicit local API endpoint',async t=>{
  let calls=0;
  const core={preferences:async()=>({expectedPort:7890}),call:async()=>({})};
  const checker={check:async()=>{calls++;return {status:'unreleased',currentVersion:'0.1.5',latestVersion:null,releaseUrl:RELEASE_PAGE,downloadUrl:null}}};
  const app=await startServer({core,updateChecker:checker,readSystemProxy:async()=>false});t.after(app.close);
  assert.equal((await fetch(app.url)).status,200);assert.equal(calls,0);
  assert.equal((await fetch(app.url+'update-check.js')).status,200);
  assert.equal((await fetch(app.url+'update-check.css')).status,200);assert.equal(calls,0);
  const result=await fetch(app.url+'api/update-check');assert.equal(result.status,200);assert.equal((await result.json()).status,'unreleased');assert.equal(calls,1);
});

test('server uses only its own enabled proxy and ignores externally managed proxies',async t=>{
  let enabled=true,managed=true,running=true,port=7890,seen=[];
  const core={directory:path.join(process.cwd(),'outputs','working','update-fixture'),applyConfig:async()=>{},status:()=>({state:running?'running':'stopped'}),call:async()=>({'mixed-port':port}),stop:async()=>{}};
  const systemProxy={getStatus:async()=>({enabled,managed}),restoreOnExit:async()=>{}};
  const profileStore={list:async()=>({activeId:null,profiles:[]}),restoreActive:async()=>{}};
  const monitor={status:()=>({preferences:{backups:{}}}),stop(){},invalidate(){}};
  const updateRequest=async({proxyPort})=>{seen.push(proxyPort);return {status:404,body:''}};
  const app=await startServer({core,systemProxy,profileStore,monitor,updateRequest});t.after(app.close);
  for(const config of [{enabled:true,managed:true,running:true,port:7890},{enabled:true,managed:false,running:true,port:7890},{enabled:false,managed:true,running:true,port:7890},{enabled:true,managed:true,running:false,port:7890},{enabled:true,managed:true,running:true,port:0}]){
    ({enabled,managed,running,port}=config);
    assert.equal((await (await fetch(app.url+'api/update-check')).json()).status,'unreleased');
  }
  assert.deepEqual(seen,[7890,null,null,null,null]);
});
