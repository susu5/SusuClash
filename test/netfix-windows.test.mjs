import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm } from 'node:fs/promises';
import { createNetfixTransaction, readNetfixFileAttributes, setNetfixFileAttributes } from '../src/netfix-transaction.mjs';
import { patchNetfixPort } from '../src/netfix-rules.mjs';

const original = Buffer.from('\uFEFF# Windows 实际文件事务夹具\r\nHTTP_PROXY="http://127.0.0.1:43127"\r\nHTTPS_PROXY="http://localhost:43127"\r\nNO_PROXY=localhost,127.0.0.1\r\nKEEP="完整保留字节"\r\n');
async function fixture(t, attributes = 33) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'susu-netfix-windows-'));
  const directory = path.join(root, 'codex'), stateDirectory = path.join(root, 'state');
  await mkdir(directory); await mkdir(stateDirectory);
  const file = path.join(directory, '.env'); await writeFile(file, original);
  await setNetfixFileAttributes(file, attributes);
  t.after(async () => {
    assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert(path.basename(root).startsWith('susu-netfix-windows-'));
    for (const name of await readdir(directory).catch(() => [])) await chmod(path.join(directory, name), 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, stateDirectory, file, tx: createNetfixTransaction({ directory, stateDirectory }) };
}

test('real Windows ACL and read-only atomic replacement preserve BOM, CRLF and restorable backup', { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
  const f = await fixture(t), before = await f.tx.inspect();
  assert.equal(before.locked, true); assert.equal(before.attributes, 33);
  const changed = patchNetfixPort(before.bytes, 7897);
  const record = await f.tx.change({ before, bytes: changed, action: 'fix-port' });
  const after = await f.tx.inspect();
  assert.equal(after.port, 7897); assert.equal(after.locked, true);
  assert.equal(after.permissions, before.permissions); assert.equal(after.attributes, before.attributes);
  assert.deepEqual(await readFile(f.file), changed);
  await f.tx.commit(record);
  const backups = await f.tx.listBackups();
  const backup = backups.find(x => x.sha256 === before.sha256);
  assert(backup?.restorable); assert.equal(backup.port, 43127);
  assert.deepEqual(await f.tx.readBackup(backup.name, backup.sha256), original);
  const restored = await f.tx.change({ before: await f.tx.inspect(), bytes: original, action: 'restore' });
  await f.tx.commit(restored);
  const final = await f.tx.inspect();
  assert.deepEqual(await readFile(f.file), original); assert.equal(final.locked, true);
  assert.equal(final.permissions, before.permissions); assert.equal(await readNetfixFileAttributes(f.file), before.attributes);
});

test('real Windows restart recovery compares owned replacement and restores original attributes and ACL', { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
  const f = await fixture(t, 35), before = await f.tx.inspect(); // hidden + archive + read-only
  await f.tx.change({ before, bytes: patchNetfixPort(before.bytes, 7897), action: 'fix-port' });
  // A fresh transaction controller represents a new service after a process
  // interruption; it may undo only the owned, uncommitted replacement.
  const fresh = createNetfixTransaction({ directory: f.directory, stateDirectory: f.stateDirectory });
  const result = await fresh.recover(); assert.equal(result.ok, true); assert.equal(result.pending, true);
  const after = await fresh.inspect();
  assert.deepEqual(await readFile(f.file), original); assert.equal(after.attributes, before.attributes);
  assert.equal(after.permissions, before.permissions); assert.equal(after.locked, true);
});
