import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './mihomo.mjs';
import { readMetadataSnapshot, writeAtomicMetadata } from './atomic-metadata.mjs';

const messages = {
  read: '无法读取系统代理启动偏好，本次不会自动开启系统代理。',
  save: '系统代理启动偏好保存未确认，尚未执行本次代理操作。',
  rollback: '系统代理操作失败，启动偏好恢复尚未确认，请检查代理状态后重试。'
};

export class ProxyPreferenceError extends AppError {
  constructor(code) {
    super(messages[code] || messages.save, 503);
    this.code = code;
  }
}

function preference(bytes) {
  if (bytes === null) return { enabled: null, valid: true };
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value?.version === 1 && (typeof value.enabled === 'boolean' || value.enabled === null)) {
      return { enabled: value.enabled, valid: true };
    }
  } catch { /* Damaged or unsupported data never authorizes startup writes. */ }
  return { enabled: null, valid: false };
}

// This records explicit user intent separately from crash-recovery ownership.
// Persist before touching Windows, and compensate only our exact saved file if
// the OS operation fails. No subscription or operating-system values are saved.
export function createProxyPreferences({ directory, readSnapshot = readMetadataSnapshot, writeMetadata = writeAtomicMetadata } = {}) {
  if (!directory) throw new TypeError('directory is required');
  const file = path.join(directory, 'proxy-preferences.json');
  let tail = Promise.resolve();
  async function snapshot() {
    try { return await readSnapshot(file, { maxBytes: 4096 }); }
    catch { throw new ProxyPreferenceError('read'); }
  }
  async function get() { return preference((await snapshot()).bytes); }
  function change(enabled, action) {
    if (typeof enabled !== 'boolean' || typeof action !== 'function') return Promise.reject(new TypeError('明确的系统代理开关与操作不可缺少。'));
    const task = tail.then(async () => {
      const before = await snapshot();
      let saved;
      try {
        await mkdir(directory, { recursive: true });
        saved = await writeMetadata(file, JSON.stringify({ version: 1, enabled }), { expected: before.fingerprint, maxBytes: 4096 });
      } catch { throw new ProxyPreferenceError('save'); }
      try { return await action(); }
      catch (error) {
        try {
          // A null intent has the same startup behavior as an absent file. A
          // compare-protected replacement avoids a racy compare-then-unlink.
          const original = before.bytes ?? JSON.stringify({ version: 1, enabled: null });
          await writeMetadata(file, original, { expected: saved.fingerprint, maxBytes: 4096 });
        } catch { throw new ProxyPreferenceError('rollback'); }
        throw error;
      }
    });
    tail = task.catch(() => {});
    return task;
  }
  return { get, change };
}
