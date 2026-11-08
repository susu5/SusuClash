import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthProbe } from '../src/health-probe.mjs';
import { AppError } from '../src/mihomo.mjs';

test('line failure requires direct evidence and both independent node probes', async () => {
  let clock=0, directOK=true, nodeMode='fail', calls=0;
  const core = { call:async () => { calls++; if (nodeMode === 'fail') throw new AppError('内核未完成请求（HTTP 500）。',502); return {delay:61}; } };
  const health = createHealthProbe({core,now:()=>clock,direct:async ({expected})=>directOK && expected===204 ? 'ok' : 'unknown'});
  assert.deepEqual(await health.inspect('node'),{network:'ok',node:'failed'});
  assert.equal(calls,2);
  clock=1000;
  assert.deepEqual(await health.inspect('node'),{network:'unknown',node:'unknown'});
  assert.equal(calls,2);
  clock=5000;
  assert.deepEqual(await health.inspect('node'),{network:'ok',node:'failed'});
  clock=10000; directOK=false; health.force();
  assert.deepEqual(await health.inspect('node'),{network:'unknown',node:'unknown'});
  directOK=true; nodeMode='ok'; health.force();
  assert.deepEqual(await health.inspect('node'),{network:'unknown',node:'ok'});
  assert.equal(await health.verify('node'),'ok');
});

test('controller/network errors cannot be misreported as failed node', async () => {
  const core = { call:async ()=> { throw new AppError('与本软件内核的连接中断。',503); } };
  const health = createHealthProbe({core,direct:async()=> 'ok'});
  assert.deepEqual(await health.inspect('node'),{network:'unknown',node:'unknown'});
  assert.equal(await health.verify('node'),'unknown');
});
