import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, realpath, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const fields = ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'sha256'];
const same = (a, b) => a === null || b === null ? a === b : Boolean(a && b && fields.every(key => a[key] === b[key]));
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const error = message => Object.assign(new Error(message), { code: message.toUpperCase() });

async function plainDirectory(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(directory), directory)) throw error('metadata_directory_changed');
}

/** Read bytes and their exact local-file identity together; missing is a fact,
 * not permission to replace a later file created by another writer. */
export async function readMetadataSnapshot(filename, { maxBytes = 16 * 1024 * 1024 } = {}) {
  const file = path.resolve(filename);
  try { await plainDirectory(path.dirname(file)); }
  catch (cause) { if (cause.code === 'ENOENT') return { bytes: null, fingerprint: null }; throw cause; }
  let before;
  try { before = await lstat(file, { bigint: true }); }
  catch (cause) { if (cause.code === 'ENOENT') return { bytes: null, fingerprint: null }; throw cause; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes) || !samePath(await realpath(file), file)) throw error('metadata_file_unsafe');
  const bytes = await readFile(file), after = await lstat(file, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || ['dev', 'ino', 'mode', 'size', 'mtimeNs'].some(key => before[key] !== after[key]) || !samePath(await realpath(file), file) || BigInt(bytes.length) !== after.size) throw error('metadata_read_changed');
  return { bytes, fingerprint: { dev: after.dev.toString(), ino: after.ino.toString(), mode: after.mode.toString(), size: after.size.toString(), mtimeNs: after.mtimeNs.toString(), sha256: createHash('sha256').update(bytes).digest('hex') } };
}

/** Metadata only. Never use this to retry replacement of user configuration.
 * Each Windows sharing retry rechecks both the prior destination and the exact
 * temporary file created here. Foreign files are neither overwritten nor
 * deleted during cleanup. Callers can bind expected to an earlier snapshot. */
export async function writeAtomicMetadata(filename, value, { expected, renameMetadata = rename, hook, maxBytes = 16 * 1024 * 1024 } = {}) {
  const file = path.resolve(filename), directory = path.dirname(file);
  await plainDirectory(directory);
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : typeof value === 'string' ? Buffer.from(value, 'utf8') : null;
  if (!bytes || bytes.length > maxBytes) throw error('metadata_value_invalid');
  const previous = expected === undefined ? (await readMetadataSnapshot(file, { maxBytes })).fingerprint : expected;
  const temp = file + '.tmp-' + randomUUID(); let owned = null;
  try {
    const handle = await open(temp, 'wx', 0o600);
    let created, written;
    try { created = await handle.stat({ bigint: true }); await handle.writeFile(bytes); await handle.sync(); written = await handle.stat({ bigint: true }); } finally { await handle.close(); }
    await hook?.({ phase: 'afterMetadataWrite', file, temp });
    const captured = (await readMetadataSnapshot(temp, { maxBytes })).fingerprint;
    if (!captured || created.dev !== written.dev || created.ino !== written.ino || ['dev', 'ino', 'mode', 'size', 'mtimeNs'].some(key => captured[key] !== written[key].toString()) || captured.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw error('metadata_temp_changed');
    owned = captured;
    for (let attempt = 0; ; attempt++) {
      await hook?.({ phase: 'beforeMetadataReplace', file, temp, attempt });
      await plainDirectory(directory);
      if (!same((await readMetadataSnapshot(file, { maxBytes })).fingerprint, previous)) throw error('metadata_target_changed');
      if (!same((await readMetadataSnapshot(temp, { maxBytes })).fingerprint, owned)) throw error('metadata_temp_changed');
      try { await renameMetadata(temp, file); break; }
      catch (cause) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(cause.code) || attempt >= 5) throw cause;
        await new Promise(resolve => setTimeout(resolve, 16 * 2 ** attempt));
      }
    }
    const saved = await readMetadataSnapshot(file, { maxBytes });
    if (!same(saved.fingerprint, owned)) throw error('metadata_write_changed');
    return saved;
  } finally {
    if (owned) {
      try { if (same((await readMetadataSnapshot(temp, { maxBytes })).fingerprint, owned)) await rm(temp, { force: true }); }
      catch { /* Preserve anything whose ownership can no longer be proved. */ }
    }
  }
}
