import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readMetadataSnapshot, writeAtomicMetadata } from '../src/atomic-metadata.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'susu-metadata-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert(path.basename(directory).startsWith('susu-metadata-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file: path.join(directory, 'state.json') };
}
const denied = code => Object.assign(new Error('Injected sharing denial'), { code });

test('metadata snapshots bind exact bytes and full string file identity, including a missing target', async t => {
  const f = await fixture(t); assert.deepEqual(await readMetadataSnapshot(f.file), { bytes: null, fingerprint: null });
  const bytes = Buffer.from('{"名称":"配置"}\n');
  const result = await writeAtomicMetadata(f.file, bytes, { expected: null });
  assert.deepEqual(result.bytes, bytes); assert.deepEqual(result, await readMetadataSnapshot(f.file));
  for (const field of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'sha256']) assert.equal(typeof result.fingerprint[field], 'string');
  assert.equal((await readdir(f.directory)).length, 1, 'successful operation leaves no temporary file');
});

test('Windows metadata sharing retry is bounded and never changes its expected baseline', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await writeFile(f.file, 'old'); const previous = await readMetadataSnapshot(f.file);
  let attempts = 0; const phases = [];
  const result = await writeAtomicMetadata(f.file, 'new', { expected: previous.fingerprint,
    renameMetadata: async (source, target) => { if (++attempts < 3) throw denied('EPERM'); return rename(source, target); },
    hook: value => { if (value.phase === 'beforeMetadataReplace') phases.push(value.attempt); } });
  assert.equal(attempts, 3); assert.deepEqual(phases, [0, 1, 2]); assert.equal(result.bytes.toString(), 'new');
});

test('persistent Windows metadata denial stops after six attempts and removes only its own temporary file', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await writeFile(f.file, 'old'); const before = await readMetadataSnapshot(f.file); let attempts = 0;
  await assert.rejects(writeAtomicMetadata(f.file, 'new', { expected: before.fingerprint, renameMetadata: async () => { attempts++; throw denied('EACCES'); } }), { code: 'EACCES' });
  assert.equal(attempts, 6); assert.deepEqual(await readMetadataSnapshot(f.file), before);
  assert.deepEqual(await readdir(f.directory), ['state.json']);
});

test('an expected earlier read rejects a file changed before saving', async t => {
  const f = await fixture(t); await writeFile(f.file, 'old'); const before = await readMetadataSnapshot(f.file);
  await writeFile(f.file, 'foreign'); let calls = 0;
  await assert.rejects(writeAtomicMetadata(f.file, 'new', { expected: before.fingerprint, renameMetadata: async () => { calls++; } }), /metadata_target_changed/);
  assert.equal(calls, 0); assert.equal(await readFile(f.file, 'utf8'), 'foreign');
});

test('Windows retry preserves a destination replaced by another writer during the wait', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await writeFile(f.file, 'old'); const before = await readMetadataSnapshot(f.file); let calls = 0;
  await assert.rejects(writeAtomicMetadata(f.file, 'new', { expected: before.fingerprint, renameMetadata: async (_source, target) => {
    calls++; await rm(target); await writeFile(target, 'foreign', { flag: 'wx' }); throw denied('EBUSY');
  } }), /metadata_target_changed/);
  assert.equal(calls, 1); assert.equal(await readFile(f.file, 'utf8'), 'foreign');
});

test('a replaced temporary file is never renamed or removed as though it were owned', async t => {
  const f = await fixture(t); await writeFile(f.file, 'old'); let temp, calls = 0;
  await assert.rejects(writeAtomicMetadata(f.file, 'new', {
    hook: async value => { if (value.phase !== 'beforeMetadataReplace') return; temp = value.temp; await rm(temp); await writeFile(temp, 'foreign-temp', { flag: 'wx' }); },
    renameMetadata: async () => { calls++; }
  }), /metadata_temp_changed/);
  assert.equal(calls, 0); assert.equal(await readFile(f.file, 'utf8'), 'old'); assert.equal(await readFile(temp, 'utf8'), 'foreign-temp');
});

test('first ownership capture rejects replacement after closing the created handle', async t => {
  const f = await fixture(t); await writeFile(f.file, 'old'); let temp, calls = 0;
  await assert.rejects(writeAtomicMetadata(f.file, 'intended', { hook: async value => {
    if (value.phase !== 'afterMetadataWrite') return;
    temp = value.temp; const external=temp+'.foreign';await writeFile(external,'intended',{flag:'wx'});await rm(temp);await rename(external,temp);
  }, renameMetadata: async () => { calls++; } }), /metadata_temp_changed/);
  assert.equal(calls, 0); assert.equal(await readFile(f.file, 'utf8'), 'old'); assert.equal(await readFile(temp, 'utf8'), 'intended');
});

test('first ownership capture rejects in-place payload tampering after sync', async t=>{
  const f=await fixture(t);await writeFile(f.file,'old');let temp;
  await assert.rejects(writeAtomicMetadata(f.file,'intended',{hook:async value=>{if(value.phase==='afterMetadataWrite'){temp=value.temp;await writeFile(temp,'foreign');}}}),/metadata_temp_changed/);
  assert.equal(await readFile(f.file,'utf8'),'old');assert.equal(await readFile(temp,'utf8'),'foreign');
});

test('Windows retry detects an in-place edit of its own temporary bytes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await writeFile(f.file, 'old'); let calls = 0, temp;
  await assert.rejects(writeAtomicMetadata(f.file, 'new', { renameMetadata: async source => {
    calls++; temp = source; await writeFile(source, 'foreign-temp'); throw denied('EPERM');
  } }), /metadata_temp_changed/);
  assert.equal(calls, 1); assert.equal(await readFile(f.file, 'utf8'), 'old'); assert.equal(await readFile(temp, 'utf8'), 'foreign-temp');
});

test('junction or symbolic parent paths are rejected without writing through the alias', async t => {
  const f = await fixture(t), real = path.join(f.directory, 'real'), alias = path.join(f.directory, 'alias'); await mkdir(real);
  try { await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (cause) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(cause.code)) { t.skip('Windows denied creating the temporary link fixture'); return; } throw cause; }
  await assert.rejects(writeAtomicMetadata(path.join(alias, 'state.json'), 'new'), /metadata_directory_changed/);
  assert.deepEqual(await readdir(real), []);
});
