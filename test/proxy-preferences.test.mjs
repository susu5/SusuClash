import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createProxyPreferences, ProxyPreferenceError } from '../src/proxy-preferences.mjs';
import { writeAtomicMetadata } from '../src/atomic-metadata.mjs';

async function fixture(t) {
  const root = path.join(process.cwd(), 'outputs', 'working');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'proxy-preferences-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'proxy-preferences.json') };
}

test('only an explicit boolean persists startup intent; absent and damaged preferences do not enable', async t => {
  const f = await fixture(t), prefs = createProxyPreferences(f);
  assert.deepEqual(await prefs.get(), { enabled: null, valid: true });
  await assert.rejects(prefs.change('true', async () => {}), TypeError);
  await prefs.change(true, async () => 'confirmed');
  assert.deepEqual(await createProxyPreferences(f).get(), { enabled: true, valid: true });
  await prefs.change(false, async () => {});
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { version: 1, enabled: false });
  for (const invalid of ['{broken', '{"version":2,"enabled":true}', '{"version":1,"enabled":"true"}']) {
    await writeFile(f.file, invalid);
    assert.deepEqual(await prefs.get(), { enabled: null, valid: false });
  }
});

test('preference save failure performs no OS operation and exposes only a fixed reason', async t => {
  const f = await fixture(t); let actions = 0;
  const prefs = createProxyPreferences({ ...f, writeMetadata: async () => { throw Error('PRIVATE_PATH'); } });
  await assert.rejects(prefs.change(true, async () => { actions++; }), error => error instanceof ProxyPreferenceError && error.code === 'save' && !error.message.includes('PRIVATE_PATH'));
  assert.equal(actions, 0);
  assert.deepEqual(await prefs.get(), { enabled: null, valid: true });
});

test('failed OS changes restore the exact prior intent, including damaged or previously absent preferences', async t => {
  const f = await fixture(t), prefs = createProxyPreferences(f);
  const denied = Error('OS denied');
  await assert.rejects(prefs.change(true, async () => { throw denied; }), error => error === denied);
  assert.deepEqual(await prefs.get(), { enabled: null, valid: true });
  const original = Buffer.from(' {"version":1,"enabled":false}\r\n');
  await writeFile(f.file, original);
  await assert.rejects(prefs.change(true, async () => { throw denied; }), error => error === denied);
  assert.deepEqual(await readFile(f.file), original);
  await writeFile(f.file, 'malformed user data');
  await assert.rejects(prefs.change(true, async () => { throw denied; }), error => error === denied);
  assert.equal(await readFile(f.file, 'utf8'), 'malformed user data');
});

test('compensation preserves a concurrently replaced preference and reports incomplete recovery', async t => {
  const f = await fixture(t), prefs = createProxyPreferences(f);
  const external = '{"version":1,"enabled":false,"external":true}';
  await assert.rejects(prefs.change(true, async () => {
    await writeFile(f.file, external);
    throw Error('PRIVATE_OS_ERROR');
  }), error => error instanceof ProxyPreferenceError && error.code === 'rollback' && !error.message.includes('PRIVATE_OS_ERROR'));
  assert.equal(await readFile(f.file, 'utf8'), external);
});

test('an externally changed file before metadata replacement prevents the OS action', async t => {
  const f = await fixture(t); let actions = 0;
  const external = '{"version":1,"enabled":false}';
  const prefs = createProxyPreferences({ ...f, writeMetadata: (file, bytes, options) => writeAtomicMetadata(file, bytes, {
    ...options, hook: async ({ phase }) => { if (phase === 'beforeMetadataReplace') await writeFile(file, external); }
  }) });
  await assert.rejects(prefs.change(true, async () => { actions++; }), error => error.code === 'save');
  assert.equal(actions, 0);
  assert.equal(await readFile(f.file, 'utf8'), external);
});
