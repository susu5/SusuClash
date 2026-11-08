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

export function windowsProxyAdapter() {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  async function invoke(action, state) {
    if (process.platform !== 'win32') throw new Error('系统代理控制仅支持 Windows。');
    const args = ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', script, '-Action', action];
    if (state) args.push('-Payload', Buffer.from(JSON.stringify(state), 'utf8').toString('base64'));
    const { stdout } = await execute(executable, args, { windowsHide:true, timeout:10000, maxBuffer:65536 });
    return stdout;
  }
  return {
    async read() { const state = JSON.parse(await invoke('read')); if (!valid(state)) throw new Error('无法读取系统代理状态。'); return state; },
    async write(state) { if (!valid(state)) throw new Error('无效的系统代理状态。'); await invoke('write', state); }
  };
}

// Ownership survives a crash so that a later run can offer to restore it.
// Never disable or restore another application's subsequently changed settings.
export function createSystemProxy({ directory, adapter = windowsProxyAdapter() }) {
  if (!directory) throw new Error('缺少系统代理状态目录。');
  const recordPath = path.join(directory, 'owned-system-proxy.json');
  let busy = false;
  async function exclusive(fn) {
    if (busy) throw new Error('系统代理正在更改，请稍后重试。');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }
  async function getRecord() {
    try {
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      if (!valid(record.before) || !valid(record.applied)) throw new Error('系统代理恢复记录无效，请手动检查系统代理。');
      return record;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function saveRecord(record) {
    await mkdir(directory, { recursive:true });
    // The ownership record is created exactly once before touching the registry.
    await writeFile(recordPath, JSON.stringify(record), { mode:0o600, flag:'wx', flush:true });
  }
  async function status() {
    const [actual, record] = await Promise.all([adapter.read(), getRecord()]);
    return { enabled: actual.enable.present && actual.enable.value === 1, managed: Boolean(record && isSame(actual, record.applied)), externalChanged: Boolean(record && !isSame(actual, record.applied)), recoveryAvailable: Boolean(record) };
  }
  async function restore() {
    const record = await getRecord();
    if (!record) return { restored:false, reason:'not-managed' };
    const actual = await adapter.read();
    if (isSame(actual, record.before) && !isSame(actual, record.applied)) {
      await rm(recordPath, {force:true});
      return {restored:false, reason:'not-applied'};
    }
    if (!isSame(actual, record.applied)) return { restored:false, reason:'changed-externally' };
    await adapter.write(clone(record.before));
    if (!isSame(await adapter.read(), record.before)) throw new Error('未能确认系统代理已恢复，请手动检查。');
    await rm(recordPath, {force:true});
    return { restored:true };
  }
  return {
    getStatus: status,
    enable: port => exclusive(async () => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口无效。');
      const actual = await adapter.read();
      const existing = await getRecord();
      if (existing && !isSame(actual, existing.applied)) throw new Error('系统代理已被其他程序更改，请先检查现有设置。');
      if (existing) {
        if (actual.server.value === '127.0.0.1:' + port) return status();
        throw new Error('修改代理端口前，请先关闭本软件管理的系统代理。');
      }
      const before = existing ? existing.before : actual;
      const desired = { enable:{present:true,value:1}, server:{present:true,value:'127.0.0.1:' + port} };
      const record = { before:clone(before), applied:clone(desired) };
      await saveRecord(record);
      try {
        await adapter.write(desired);
        if (!isSame(await adapter.read(), desired)) throw new Error('未能确认系统代理已开启。');
      } catch (error) {
        // Never overwrite a concurrently changed proxy on a failed write. If
        // nothing changed, the unused record is safe to remove; otherwise keep
        // it so the next run can expose the uncertain state to the user.
        try { if (isSame(await adapter.read(), actual)) await rm(recordPath, {force:true}); }
        catch { /* Keep the record for explicit recovery. */ }
        throw error;
      }
      return status();
    }),
    disable: () => exclusive(restore),
    restoreOnExit: () => exclusive(restore)
  };
}
