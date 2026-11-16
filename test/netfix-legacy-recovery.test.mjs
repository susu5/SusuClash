import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm, rename, lstat } from 'node:fs/promises';
import { createNetfixLegacyRecovery } from '../src/netfix-legacy-recovery.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'susu-netfix-legacy-'));
  const file = path.join(directory, 'codex-auto-repair.json');
  const original = { schema: 1, id: 'legacy-fixture', route: { profile: 'profile-1', group: 'Test / route', before: 'A', after: 'B', committed: false } };
  if (options.record !== false) await writeFile(file, JSON.stringify(options.record || original));
  let current = options.current || 'B', writes = 0, transportCalls = 0;
  const recover = createNetfixLegacyRecovery({ directory, copyPermissions: options.copyPermissions || (async () => {}),
    permissionFingerprint: options.permissionFingerprint || (async () => 'fixture-acl'), fileAttributes: async () => null, setFileAttributes: async () => {},
    configuration: async () => ({ profile: options.profile || 'profile-1' }),
    recoverTransport: async () => { transportCalls++; return options.transport || { ok: true }; },
    core: { call: async (method, endpoint, body) => { assert.equal(endpoint, '/proxies/Test%20%2F%20route'); if (method === 'PUT') { writes++; current = body.name; } return { now: current }; } }
  });
  t.after(async () => {
    assert.equal(path.dirname(directory).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert(path.basename(directory).startsWith('susu-netfix-legacy-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { recover, file, current: () => current, writes: () => writes, transportCalls: () => transportCalls };
}

test('legacy recovery compensates only the owned old route and preserves its record', async t => {
  const f = await fixture(t); assert.equal((await f.recover()).ok, true); assert.equal(f.current(), 'A'); assert.equal(f.writes(), 1);
  const saved = JSON.parse(await readFile(f.file, 'utf8')); assert.equal(saved.id, 'legacy-fixture'); assert.equal(saved.route.recovered, true); assert.equal(saved.netfixMigration.engine, 'netfix');
  assert.equal((await f.recover()).ok, true); assert.equal(f.writes(), 1);
});
test('legacy external route changes are never overwritten or deleted', async t => {
  const f = await fixture(t, { current: 'external-C' }), before = await readFile(f.file);
  assert.equal((await f.recover()).ok, false); assert.equal(f.writes(), 0); assert.equal(f.current(), 'external-C'); assert.deepEqual(await readFile(f.file), before);
});
test('legacy profile change and unsupported schema remain explicit recovery conflicts', async t => {
  const profile = await fixture(t, { profile: 'different-profile' }); assert.equal((await profile.recover()).ok, false); assert.equal(profile.writes(), 0);
  const schema = await fixture(t, { record: { schema: 999 } }); const before = await readFile(schema.file); assert.equal((await schema.recover()).ok, false); assert.equal(schema.transportCalls(), 0); assert.deepEqual(await readFile(schema.file), before);
});
test('legacy transport recovery is separate and a conflict cannot start a new route operation', async t => {
  const f = await fixture(t, { transport: { ok: false } }); assert.equal((await f.recover()).ok, false); assert.equal(f.transportCalls(), 1); assert.equal(f.writes(), 0);
});
test('missing legacy ledger still reconciles old owned file journals without inventing routes', async t => {
  const f = await fixture(t, { record: false }); assert.equal((await f.recover()).ok, true); assert.equal(f.transportCalls(), 1); assert.equal(f.writes(), 0);
});

test('legacy final replacement rejects a same-content file with a different exact identity', async t => {
  let replacementIdentity;
  const f = await fixture(t, { copyPermissions: async file => {
    const bytes = await readFile(file);
    await rename(file, file + '.external-held');
    await writeFile(file, bytes);
    replacementIdentity = (await lstat(file, { bigint: true })).ino.toString();
  } });
  const before = await readFile(f.file), identity = (await lstat(f.file, { bigint: true })).ino.toString();
  const result = await f.recover();
  assert.equal(result.ok, false); assert.equal(result.reason, 'legacy_record_changed');
  assert.notEqual(replacementIdentity, identity); assert.equal((await lstat(f.file, { bigint: true })).ino.toString(), replacementIdentity);
  assert.deepEqual(await readFile(f.file), before); assert.equal(JSON.parse(before).netfixMigration, undefined);
});

test('legacy final replacement rejects a concurrent ACL change without rewriting its record', async t => {
  let permissions = 'fixture-acl';
  const f = await fixture(t, { permissionFingerprint: async () => permissions, copyPermissions: async () => { permissions = 'external-acl'; } });
  const before = await readFile(f.file), result = await f.recover();
  assert.equal(result.ok, false); assert.deepEqual(await readFile(f.file), before); assert.equal(permissions, 'external-acl');
});
