import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomation } from '../src/automation.mjs';

const observation = overrides => ({scope:'profile-a',group:'日常代理',current:'香港',core:'ok',port:'ok',network:'ok',node:'ok',codex:'ok',...overrides});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };

test('Codex target failure and unknown prerequisites never trigger node switch', async () => {
  let actual = observation({codex:'failed'}), selected = 0, repaired = 0;
  const monitor = createAutomation({probe:async()=>actual,repair:async()=>{ repaired++; return {ok:false}; },select:async()=>{selected++;},verify:async()=> 'ok'});
  await monitor.configure({scope:'profile-a',group:'日常代理',backups:['日本'],autoSwitch:true,autoRepair:true});
  await monitor.runNow(); await monitor.runNow();
  assert.equal(monitor.status().problem,'codex'); assert.equal(selected,0); assert.equal(repaired,0);
  actual = observation({node:'failed',network:'unknown'});
  await monitor.runNow(); await monitor.runNow();
  assert.equal(selected,0); assert.equal(repaired,0);
  assert.match(monitor.status().message,/基础环境/);
});

test('two failures, ordered candidates, skip unavailable and verify after switch', async () => {
  const calls = []; let selection;
  const monitor = createAutomation({
    probe:async()=>observation({node:'failed'}), repair:async()=>{throw Error('disabled');},
    verify:async({node,phase})=> { calls.push(node+':'+phase); return node === '日本' ? 'failed' : 'ok'; },
    select:async({node,isCurrent})=> { assert(isCurrent()); selection=node; }
  });
  await monitor.configure({scope:'profile-a',group:'日常代理',backups:['香港','日本','新加坡'],autoSwitch:true});
  await monitor.runNow(); assert.equal(selection,undefined); assert.equal(monitor.status().phase,'confirming');
  await monitor.runNow();
  assert.equal(selection,'新加坡'); assert.equal(monitor.status().phase,'recovered');
  assert.deepEqual(calls,['日本:candidate','新加坡:candidate','新加坡:selected']);
  assert.deepEqual(monitor.status().attempts.map(x=>x.result),['不可用','复查通过']);
});

test('manual operation invalidates pending automatic switch before commit', async () => {
  const entered = deferred(), resume = deferred(); let selection = '香港';
  const monitor = createAutomation({
    probe:async()=>observation({node:'failed'}),repair:async()=>({ok:false}),verify:async()=> 'ok',
    select:async({node,signal,isCurrent})=> { entered.resolve(); await resume.promise; if (!signal.aborted && isCurrent()) selection=node; }
  });
  await monitor.configure({scope:'profile-a',group:'日常代理',backups:['日本'],autoSwitch:true});
  await monitor.runNow();
  const run = monitor.runNow(); await entered.promise;
  monitor.invalidate(); selection = '手动选择'; resume.resolve(); await run;
  assert.equal(selection,'手动选择');
});

test('repair is independent, rechecks and prevents unnecessary switching', async () => {
  let probes = 0, repairs = 0, selected = 0;
  const monitor = createAutomation({
    probe:async()=>observation({node:++probes < 3 ? 'failed' : 'ok'}),
    repair:async()=>{ repairs++; return {ok:true}; }, select:async()=>{selected++;}, verify:async()=> 'ok'
  });
  await monitor.configure({scope:'profile-a',group:'日常代理',backups:['日本'],autoSwitch:true,autoRepair:true});
  await monitor.runNow(); await monitor.runNow();
  assert.equal(repairs,1); assert.equal(selected,0); assert.equal(monitor.status().phase,'recovered');
});

test('no overlap, persistent scope isolation and failed candidates remain visible', async () => {
  let writes, calls = 0; const gate = deferred();
  const monitor = createAutomation({probe:async()=>{calls++; return gate.promise;},repair:async()=>({ok:false}),select:async()=>{},verify:async()=> 'ok',persist:async config=>{writes=config;}});
  await monitor.configure({scope:'profile-a',group:'日常代理',backups:['日本'],autoSwitch:true});
  await monitor.configure({scope:'profile-b',group:'日常代理',backups:['新加坡']});
  assert.deepEqual(writes.backups[JSON.stringify(['profile-a','日常代理'])],['日本']);
  assert.deepEqual(writes.backups[JSON.stringify(['profile-b','日常代理'])],['新加坡']);
  const first = monitor.runNow(); await Promise.resolve(); await monitor.runNow();
  assert.equal(calls,1); gate.resolve(observation()); await first;
});

test('a stalled probe times out and permits a later health check', async () => {
  let calls = 0;
  const monitor = createAutomation({timeoutMs:10,probe:async()=>{calls++; if (calls === 1) return new Promise(()=>{}); return observation();},repair:async()=>({ok:false}),select:async()=>{},verify:async()=> 'unknown'});
  await monitor.runNow();
  assert.equal(monitor.status().phase,'unknown');
  assert.match(monitor.status().message,/超时/);
  await monitor.runNow();
  assert.equal(calls,2);
  assert.equal(monitor.status().phase,'monitoring');
});

test('unknown between two independent checks does not invent or lose a confirmation', async () => {
  let result = 'failed', now = 1, switched = 0;
  const monitor = createAutomation({now:()=>now, probe:async()=>observation({node:result}), repair:async()=>({ok:false}), verify:async()=> 'ok', select:async()=>{switched++;}});
  await monitor.configure({scope:'profile-a',group:'日常代理',backups:['日本'],autoSwitch:true});
  await monitor.runNow(); assert.equal(switched,0);
  result = 'unknown'; now += 5000; await monitor.runNow(); assert.equal(switched,0);
  result = 'failed'; now += 5000; await monitor.runNow(); assert.equal(switched,1);
});
