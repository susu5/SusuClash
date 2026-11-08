import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const registryScript = path.join(sourceDir, 'autostart-registry.ps1');
const launchScript = path.join(sourceDir, 'autostart-launch.ps1');

function powershellPath() {
  return path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
export function defaultAutostartCommand() {
  // Windows file names cannot contain a quote, so both paths can be safely quoted.
  return '"' + powershellPath() + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + launchScript + '"';
}

export function windowsAutostartAdapter() {
  async function invoke(action, expected) {
    if (process.platform !== 'win32') throw new Error('开机启动仅支持 Windows。');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', registryScript, '-Action', action];
    if (expected !== undefined) args.push('-Payload', Buffer.from(expected, 'utf8').toString('base64'));
    try {
      const {stdout} = await execute(powershellPath(), args, {windowsHide:true, timeout:10000, maxBuffer:65536});
      return JSON.parse(stdout);
    } catch { throw new Error('无法更改开机启动，请检查同名启动项或 Windows 权限。'); }
  }
  return {
    async read() { const data = await invoke('read'); return data.present ? data.value : null; },
    async set(command) { return invoke('set', command); },
    async remove(command) { return invoke('remove', command); }
  };
}

export function createAutostart({adapter = windowsAutostartAdapter(), command = defaultAutostartCommand()} = {}) {
  if (!adapter || !['read','set','remove'].every(name => typeof adapter[name] === 'function') || typeof command !== 'string' || !command) throw new TypeError('invalid autostart adapter');
  let busy = false;
  async function exclusive(operation) {
    if (busy) throw new Error('开机启动正在更改，请稍后重试。');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  }
  async function status() {
    const current = await adapter.read();
    return {enabled:current === command, conflict:current !== null && current !== command};
  }
  return {
    getStatus:status,
    enable:() => exclusive(async () => {
      const current = await status();
      if (current.conflict) throw new Error('存在同名但不属于本软件的启动项，未更改。');
      if (!current.enabled) await adapter.set(command);
      const after = await status();
      if (!after.enabled) throw new Error('未能确认开机启动已开启。');
      return after;
    }),
    disable:() => exclusive(async () => {
      const current = await status();
      if (current.conflict) throw new Error('同名启动项已被修改，未将其删除。');
      if (current.enabled) await adapter.remove(command);
      const after = await status();
      if (after.enabled) throw new Error('未能确认开机启动已关闭。');
      return after;
    })
  };
}
