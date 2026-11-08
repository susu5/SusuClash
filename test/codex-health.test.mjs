import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexHealth, codexTarget } from '../src/codex-health.mjs';

test('explicit Codex local proxy target is checked without exposing credentials', async () => {
  const calls=[];
  const checker=createCodexHealth({readProxy:async()=>({kind:'local',port:7890,url:'http://127.0.0.1:7890/'}),probe:async(url,proxy)=>{calls.push([url,proxy]);return 200;}, now:()=>10000});
  const result=await checker.inspect({corePort:7890,portStatus:'ok'});
  assert.equal(result.result,'ok'); assert.match(result.detail,/应用内发送/);
  assert.deepEqual(calls,[[codexTarget,'http://127.0.0.1:7890/']]);
  assert.doesNotMatch(JSON.stringify(result),/127\.0\.0\.1|\.env/);
});

test('stale Codex proxy identifies missing listener without probing other processes', async () => {
  let calls=0;
  const missing=createCodexHealth({readProxy:async()=>({kind:'local',port:7897,url:'http://127.0.0.1:7897/'}),readListeners:async()=>[],probe:async()=>{calls++;return 200;},now:()=>10000});
  const a=await missing.inspect({corePort:7890,portStatus:'ok'});
  assert.equal(a.result,'failed'); assert.match(a.detail,/没有监听/); assert.equal(calls,0);
  const occupied=createCodexHealth({readProxy:async()=>({kind:'local',port:7897,url:'http://127.0.0.1:7897/'}),readListeners:async()=>[{port:7897,name:'some-process'}],probe:async()=>{calls++;return 200;},now:()=>10000});
  const b=await occupied.inspect({corePort:7890,portStatus:'ok'});
  assert.equal(b.result,'unknown'); assert.match(b.detail,/其他程序/); assert.equal(calls,0);
});

test('unknown settings and status codes are distinguished from a failed site', async () => {
  let state={kind:'custom'}, code=200, clock=10000, calls=0;
  const checker=createCodexHealth({readProxy:async()=>state,readSystemProxy:async()=>({enabled:false,managed:false}),probe:async()=>{calls++;return code;},now:()=>clock});
  assert.equal((await checker.inspect({corePort:7890,portStatus:'ok'})).result,'unknown'); assert.equal(calls,0);
  state={kind:'none'}; clock+=5000; code=0;
  assert.equal((await checker.inspect({corePort:7890,portStatus:'ok'})).result,'failed');
  clock+=5000; code=401;
  assert.equal((await checker.inspect({corePort:7890,portStatus:'ok'})).result,'unknown');
  clock+=5000; code=403;
  assert.equal((await checker.inspect({corePort:7890,portStatus:'ok'})).result,'failed');
  clock+=5000; code=null;
  assert.equal((await checker.inspect({corePort:7890,portStatus:'ok'})).result,'unknown');
});

test('system proxy managed by a different application is never probed as ours', async () => {
  let calls=0;
  const checker=createCodexHealth({readProxy:async()=>({kind:'none'}),readSystemProxy:async()=>({enabled:true,managed:false}),probe:async()=>{calls++;return 200;},now:()=>10000});
  assert.equal((await checker.inspect({corePort:7890,portStatus:'ok'})).result,'unknown');
  assert.equal(calls,0);
});
