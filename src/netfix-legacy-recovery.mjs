import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { copyNetfixPermissions, readNetfixPermissionFingerprint, readNetfixFileAttributes, setNetfixFileAttributes } from './netfix-transaction.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const failure = reason => ({ ok: false, reason });
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function plainDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), path.resolve(directory))) throw new Error('unsafe_directory');
}
const identity = info => JSON.stringify({ dev: info.dev.toString(), ino: info.ino.toString(), size: info.size.toString(), mode: info.mode.toString(), mtimeNs: info.mtimeNs.toString() });
async function readRecord(file, permissionFingerprint, fileAttributes) {
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size > 262144n || info.nlink !== 1n || !samePath(await realpath(file), path.resolve(file))) throw new Error('unsafe_record');
  const permissions = await permissionFingerprint(file), attributes = await fileAttributes(file);
  const bytes = await readFile(file);
  const after = await lstat(file, { bigint: true });
  if (identity(info) !== identity(after) || permissions !== await permissionFingerprint(file) || attributes !== await fileAttributes(file)) throw new Error('record_changed');
  return { info, bytes, permissions, attributes, record: JSON.parse(bytes.toString('utf8')), fingerprint: JSON.stringify({ identity: identity(info), sha256: digest(bytes), permissions, attributes }) };
}

/** Reconcile only pre-Netfix owned transactions. This does not construct or run
 * the retired automatic strategy chain, send model requests, or select a new
 * route. A conflicting external value is always left untouched. */
export function createNetfixLegacyRecovery({ directory, core, configuration,
  recoverTransport = async () => ({ ok: true }), copyPermissions = copyNetfixPermissions,
  permissionFingerprint = readNetfixPermissionFingerprint, fileAttributes = readNetfixFileAttributes, setFileAttributes = setNetfixFileAttributes } = {}) {
  const snapshot = file => readRecord(file, permissionFingerprint, fileAttributes);
  return async function recover() {
    if (!directory) return { ok: true, recovered: false };
    try {
      try { await plainDirectory(directory); }
      catch (error) { return error.code === 'ENOENT' ? { ok: true, recovered: false } : failure('legacy_directory_unavailable'); }
      const file = path.join(directory, 'codex-auto-repair.json');
      let saved = null;
      try { saved = await snapshot(file); }
      catch (error) { if (error.code !== 'ENOENT') return failure('legacy_record_invalid'); }
      if (saved && (!saved.record || saved.record.schema !== 1)) return failure('legacy_record_invalid');
      const transport = await recoverTransport();
      if (transport?.ok === false || transport?.status === 'conflict') return failure('legacy_transport_conflict');
      const route = saved?.record?.route;
      if (!route || route.committed === true || route.recovered === true) return { ok: true, recovered: false };
      if (typeof route.group !== 'string' || !route.group || route.group.length > 200 ||
          !['before', 'after', 'profile'].every(key => typeof route[key] === 'string' && route[key].length > 0 && route[key].length <= 2048) ||
          !core || typeof configuration !== 'function') return failure('legacy_route_invalid');
      const config = await configuration();
      if (config?.profile !== route.profile) return failure('legacy_route_conflict');
      const endpoint = '/proxies/' + encodeURIComponent(route.group);
      let current = await core.call('GET', endpoint);
      if (current?.now !== route.before && current?.now !== route.after) return failure('legacy_route_conflict');
      if (current.now === route.after && route.before !== route.after) {
        // Check the profile and route again immediately before compensation.
        if ((await configuration())?.profile !== route.profile) return failure('legacy_route_conflict');
        current = await core.call('GET', endpoint);
        if (current?.now !== route.after) return failure('legacy_route_conflict');
        if ((await snapshot(file)).fingerprint !== saved.fingerprint) return failure('legacy_record_changed');
        await core.call('PUT', endpoint, { name: route.before });
        if ((await core.call('GET', endpoint))?.now !== route.before) return failure('legacy_route_recovery_failed');
      }
      // Keep the old evidence, marking only the completed compensation. Never
      // silently delete an old journal or replace a concurrently changed one.
      const latest = await snapshot(file);
      if (latest.fingerprint !== saved.fingerprint) return failure('legacy_record_changed');
      const next = { ...saved.record, route: { ...route, recovered: true, committed: true }, netfixMigration: { recoveredAt: new Date().toISOString(), engine: 'netfix' } };
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, '', { flag: 'wx', mode: Number(saved.info.mode & 0o777n) });
        await copyPermissions(file, [temp]);
        await writeFile(temp, JSON.stringify(next), { flush: true });
        await chmod(temp, Number(saved.info.mode & 0o777n));
        await setFileAttributes(temp, saved.attributes);
        const owned = await snapshot(temp);
        if (digest(owned.bytes) !== digest(Buffer.from(JSON.stringify(next))) || owned.permissions !== saved.permissions || owned.attributes !== saved.attributes) return failure('legacy_record_save_failed');
        await plainDirectory(directory);
        if ((await snapshot(file)).fingerprint !== saved.fingerprint || (await snapshot(temp)).fingerprint !== owned.fingerprint) return failure('legacy_record_changed');
        await rename(temp, file);
        const confirmed = await snapshot(file);
        if (confirmed.fingerprint !== owned.fingerprint || confirmed.record.route?.recovered !== true || confirmed.record.route?.before !== route.before) return failure('legacy_record_save_failed');
      } finally { await rm(temp, { force: true }).catch(() => {}); }
      return { ok: true, recovered: true };
    } catch { return failure('legacy_recovery_unavailable'); }
  };
}
