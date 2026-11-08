import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createProfileStore, parseSubscriptionUsage } from '../src/profiles.mjs';

test('subscription usage accepts only safe numeric values and never returns raw fields', () => {
  assert.deepEqual(parseSubscriptionUsage('upload=10; download=25; total=100; expire=1700000000; token=secret'),
    { used: 35, total: 100, remaining: 65, exceeded: false, expiresAt: 1700000000 });
  assert.deepEqual(parseSubscriptionUsage('upload=10; download=25; total=0'),
    { used: 35, total: null, remaining: null, exceeded: false, expiresAt: null });
  assert.equal(parseSubscriptionUsage('download=3; total=20'), null);
  assert.equal(parseSubscriptionUsage('upload=1; upload=2; download=3'), null);
  assert.equal(parseSubscriptionUsage('upload=1; upload=invalid; download=3'), null);
  assert.equal(parseSubscriptionUsage('upload=1; download=3; total=invalid'), null);
  assert.equal(parseSubscriptionUsage('upload=9007199254740992; download=3'), null);
  assert.equal(parseSubscriptionUsage('upload=9007199254740991; download=3'), null);
});

test('profile usage follows validated subscription and survives failed updates without leaking a URL', async () => {
  await mkdir(path.join(process.cwd(), 'outputs', 'working'), { recursive: true });
  const dir = await mkdtemp(path.join(process.cwd(), 'outputs', 'working', 'clash-quota-'));
  let body = 'valid: true\n';
  let header = 'upload=10; download=25; total=100';
  const store = createProfileStore({directory: dir, validateConfig: async file => {
    const {readFile} = await import('node:fs/promises');
    if (!(await readFile(file, 'utf8')).startsWith('valid: true')) throw Error('invalid');
  }, applyConfig:async()=>{}, fetchImpl:async()=>new Response(body,{status:200,headers:{'subscription-userinfo':header}})});
  try {
    const added = await store.addUrl({name:'测试',url:'https://example.com/?token=private'});
    assert.equal(added.usage.used,35); assert.equal(added.usage.remaining,65);
    assert(!JSON.stringify(added).includes('private'));
    body='invalid: true\n'; header='upload=90; download=20; total=100';
    await assert.rejects(store.update(added.id));
    let listed=(await store.list()).profiles[0];
    assert.equal(listed.usage.used,35); assert.equal(listed.usage.remaining,65);
    body='valid: true\n'; await store.update(added.id);
    listed=(await store.list()).profiles[0];
    assert.equal(listed.usage.used,110); assert.equal(listed.usage.remaining,0); assert.equal(listed.usage.exceeded,true);
    assert(!JSON.stringify(listed).includes('private'));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
