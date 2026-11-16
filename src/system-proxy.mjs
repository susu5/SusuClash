import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./system-proxy.ps1', import.meta.url));
const clone = value => structuredClone(value);
const isSame = (a, b) => ['enable','server'].every(key =>
  a?.[key]?.present === b?.[key]?.present && (!a?.[key]?.present || a[key].value === b[key].value));
const valid = state => state && ['enable','server'].every(key => typeof state[key]?.present === 'boolean') &&
  (!state.enable.present || [0, 1].includes(state.enable.value)) &&
  (!state.server.present || typeof state.server.value === 'string');
const enabled = state => state.enable.present && state.enable.value === 1;
const errors = {
  unsupported: [503, '系统代理控制仅支持 Windows。'],
  busy: [409, '系统代理正在更改，请稍后重试。'],
  read: [503, '无法读取 Windows 系统代理状态，请检查当前用户的代理权限。'],
  invalid: [400, '无效的系统代理状态。'],
  directory: [503, '缺少系统代理状态目录。'],
  record: [409, '系统代理恢复记录无法读取，请先检查本软件的数据目录。'],
  save: [503, '无法保存系统代理恢复记录，尚未更改 Windows 代理。'],
  cleanup: [503, '系统代理恢复记录清理失败，请稍后重试。'],
  external: [409, '当前系统代理由其他程序管理，请先关闭该程序的系统代理后重试。'],
  changed: [409, '系统代理在操作期间发生变化，已停止修改。'],
  port: [400, '代理端口无效。'],
  migrate: [409, '修改代理端口前，请先关闭本软件管理的系统代理。'],
  write: [503, '系统代理写入失败，请检查当前用户的 Windows 代理权限。'],
  refresh: [503, 'Windows 未确认系统代理设置刷新，已尝试恢复原设置，请重新检查代理状态。'],
  verify: [503, '未能确认系统代理已开启，已尝试恢复原设置。'],
  restore: [503, '未能确认系统代理已恢复，请重新检查 Windows 代理状态。'],
  rollback: [503, '系统代理开启失败，原设置恢复尚未确认，请重新检查 Windows 代理状态。']
};

// Only fixed messages cross the local API; child-process errors can contain
// registry values, command lines or other private machine details.
export class ProxyError extends Error {
  constructor(code) {
    const key = Object.hasOwn(errors, code) ? code : 'write';
    const [status, message] = errors[key];
    super(message);
    this.name = 'ProxyError';
    this.status = status;
    this.code = key;
  }
}

export function windowsProxyAdapter({ executeFile = execute } = {}) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  async function invoke(action, payload) {
    if (process.platform !== 'win32') throw new ProxyError('unsupported');
    const args = ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', script, '-Action', action];
    if (payload) args.push('-Payload', Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'));
    try {
      const { stdout } = await executeFile(executable, args, { windowsHide:true, timeout:10000, maxBuffer:65536, encoding:'utf8' });
      return stdout;
    } catch (error) {
      if (String(error?.stderr || '').includes('SC_PROXY_CHANGED')) throw new ProxyError('changed');
      if (String(error?.stderr || '').includes('SC_PROXY_REFRESH_FAILED')) throw new ProxyError('refresh');
      throw new ProxyError(action === 'read' ? 'read' : 'write');
    }
  }
  return {
    async read() {
      const output = await invoke('read');
      let state;
      try { state = JSON.parse(output.replace(/^\uFEFF/, '')); } catch { throw new ProxyError('read'); }
      if (!valid(state)) throw new ProxyError('read');
      return state;
    },
    async write(state, { expected } = {}) {
      if (!valid(state) || (expected && !valid(expected))) throw new ProxyError('invalid');
      await invoke('write', {state, expected});
    }
  };
}

// Ownership survives a crash. Never disable or restore another application's
// subsequently changed settings; a disabled stale record can safely be retired.
export function createSystemProxy({ directory, adapter = windowsProxyAdapter() }) {
  if (!directory) throw new ProxyError('directory');
  const recordPath = path.join(directory, 'owned-system-proxy.json');
  let busy = false;
  async function exclusive(fn) {
    if (busy) throw new ProxyError('busy');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }
  async function readState() {
    try {
      const state = await adapter.read();
      if (!valid(state)) throw new ProxyError('read');
      return state;
    } catch (error) { throw error instanceof ProxyError ? error : new ProxyError('read'); }
  }
  async function writeState(state, expected) {
    try { await adapter.write(clone(state), {expected:clone(expected)}); }
    catch (error) { throw error instanceof ProxyError ? error : new ProxyError('write'); }
  }
  async function getRecord() {
    try {
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      if (!valid(record?.before) || !valid(record?.applied)) throw new ProxyError('record');
      return record;
    } catch (error) { if (error.code === 'ENOENT') return null; throw new ProxyError('record'); }
  }
  async function removeRecord() {
    try { await rm(recordPath, {force:true}); } catch { throw new ProxyError('cleanup'); }
  }
  async function saveRecord(record) {
    try {
      await mkdir(directory, { recursive:true });
      // Created exactly once and flushed before touching the registry.
      await writeFile(recordPath, JSON.stringify(record), { mode:0o600, flag:'wx', flush:true });
    } catch { throw new ProxyError('save'); }
  }
  function publicStatus(actual, record) {
    const managed = Boolean(record && isSame(actual, record.applied));
    const port = managed ? Number(/^127\.0\.0\.1:(\d+)$/.exec(actual.server.value)?.[1]) || null : null;
    return {enabled:enabled(actual), managed, port, externalChanged:Boolean(record && !isSame(actual, record.applied)), recoveryAvailable:Boolean(record)};
  }
  async function status() {
    const [actual, record] = await Promise.all([readState(), getRecord()]);
    return publicStatus(actual, record);
  }
  async function restore() {
    const record = await getRecord();
    if (!record) return { restored:false, reason:'not-managed' };
    const actual = await readState();
    if (isSame(actual, record.before) && !isSame(actual, record.applied)) {
      // A prior rollback may have written the registry but failed its WinINET
      // notification. Reapply the same values so cleanup also confirms refresh.
      await writeState(record.before, actual);
      if (!isSame(await readState(), record.before)) throw new ProxyError('restore');
      await removeRecord();
      return {restored:false, reason:'not-applied'};
    }
    if (!isSame(actual, record.applied)) return { restored:false, reason:'changed-externally' };
    await writeState(record.before, actual);
    if (!isSame(await readState(), record.before)) throw new ProxyError('restore');
    await removeRecord();
    return { restored:true };
  }
  return {
    getStatus: status,
    enable: port => exclusive(async () => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyError('port');
      let actual = await readState();
      let existing = await getRecord();
      if (existing && !isSame(actual, existing.applied)) {
        if (enabled(actual) && !isSame(actual, existing.before)) throw new ProxyError('external');
        // No registry write: the old ownership no longer applies. Always read
        // again after cleanup before deciding whether a new enable is allowed.
        await removeRecord();
        existing = null;
        actual = await readState();
      }
      if (existing) {
        if (actual.server.value === '127.0.0.1:' + port) return publicStatus(actual, existing);
        throw new ProxyError('migrate');
      }
      if (enabled(actual)) throw new ProxyError('external');
      const desired = { enable:{present:true,value:1}, server:{present:true,value:'127.0.0.1:' + port} };
      const record = { before:clone(actual), applied:clone(desired) };
      await saveRecord(record);
      try {
        // The PowerShell adapter checks this snapshot once more immediately
        // before writing, after the ownership record has safely reached disk.
        await writeState(desired, actual);
        const after = await readState();
        if (!isSame(after, desired)) throw new ProxyError('verify');
        return publicStatus(after, record);
      } catch (error) {
        let rollbackUnconfirmed = false;
        try {
          const current = await readState();
          if (isSame(current, desired)) {
            // A write/notification/readback can fail after the values changed.
            // Roll back only while the complete applied snapshot still matches.
            rollbackUnconfirmed = true;
            await writeState(actual, desired);
            if (isSame(await readState(), actual)) {
              await removeRecord();
              rollbackUnconfirmed = false;
            }
          } else if (isSame(current, actual)) await removeRecord();
        } catch { /* Retain the durable record whenever recovery is uncertain. */ }
        if (rollbackUnconfirmed) throw new ProxyError('rollback');
        throw error instanceof ProxyError ? error : new ProxyError('write');
      }
    }),
    disable: () => exclusive(restore),
    restoreOnExit: () => exclusive(restore)
  };
}
