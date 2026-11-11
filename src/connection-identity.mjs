import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const systemDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const unknown = { app: '未知应用', processSource: 'unknown' };

function filename(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return null;
  const name = path.win32.basename(value.trim());
  return name && name !== '.' && name !== '..' ? name.slice(0, 120) : null;
}

export function connectionProcessName(metadata) {
  return filename(metadata?.process) || filename(metadata?.processPath);
}

function port(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d{1,5}$/.test(value))) return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 65535 ? number : null;
}

function address(value) {
  if (typeof value !== 'string') return null;
  let ip = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(ip) === 4) return ip;
  if (net.isIP(ip) !== 6 || ip.includes('%')) return null;
  try { ip = new URL('http://[' + ip + ']/').hostname.slice(1, -1); }
  catch { return null; }
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(ip);
  if (mapped) {
    const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16);
    return [a >> 8, a & 255, b >> 8, b & 255].join('.');
  }
  return ip;
}

const loopback = ip => ip === '::1' || /^127\./.test(ip || '');
function endpoint(value) {
  const parts = /^(\[.*\]|[^:]+):(\d+)$/.exec(value);
  if (!parts) return null;
  const ip = address(parts[1]), number = port(parts[2]);
  return ip && number ? { address: ip, port: number } : null;
}

// No shell, command lines, credentials or executable paths are collected.
// netstat without -p also includes IPv6 TCP sockets on Windows.
export function parseWindowsConnectionOwners(sockets, processes) {
  const names = new Map();
  for (const line of String(processes).split(/\r?\n/)) {
    const row = /^"((?:[^"]|"")*)","(\d+)"(?:,|$)/.exec(line);
    const name = row && filename(row[1].replace(/""/g, '"'));
    if (name && Number(row[2]) > 0) names.set(row[2], name);
  }
  const owners = [];
  for (const line of String(sockets).split(/\r?\n/)) {
    const row = /^\s*TCP\s+(\S+)\s+(\S+)\s+ESTABLISHED\s+(\d+)\s*$/i.exec(line);
    if (!row || !names.has(row[3])) continue;
    const local = endpoint(row[1]), remote = endpoint(row[2]);
    if (local && remote) owners.push({ ...local, remoteAddress: remote.address, remotePort: remote.port, name: names.get(row[3]) });
  }
  return owners;
}

export async function windowsConnectionOwners() {
  if (process.platform !== 'win32') return [];
  const options = { windowsHide: true, timeout: 2500, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' };
  const results = await Promise.allSettled([
    execute(path.join(systemDir, 'netstat.exe'), ['-ano'], options),
    // tasklist uses the machine code page when redirected, corrupting Chinese
    // image names if Node decodes it as UTF-8. Emit Unicode process names with
    // an explicit UTF-8 encoding instead; never request paths or command lines.
    execute(path.join(systemDir, 'WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; Get-Process | Select-Object @{Name="Name";Expression={$_.ProcessName+".exe"}},Id | ConvertTo-Csv -NoTypeInformation'
    ], options)
  ]);
  if (results.some(result => result.status !== 'fulfilled')) return [];
  return parseWindowsConnectionOwners(results[0].value.stdout, results[1].value.stdout);
}

function key(item) {
  const m = item?.metadata;
  // Only an actual connection lifetime may retain a positive result. Never
  // cache by port: ephemeral ports are quickly reused by unrelated programs.
  return typeof item?.id === 'string' && typeof item?.start === 'string' && item.start
    ? JSON.stringify([item.id, item.start, m?.network, m?.sourceIP, m?.sourcePort]) : null;
}

export function createConnectionIdentity({ lookup = windowsConnectionOwners } = {}) {
  let remembered = new Map(), pending = null, previousPorts = '', epoch = 0;
  function known(items) {
    return items.map(item => {
      const app = connectionProcessName(item?.metadata);
      return { ...item, ...(app ? { app, processSource: 'core' } : remembered.get(key(item)) || unknown) };
    });
  }
  async function identify(items, { proxyPorts = [], recheck } = {}) {
    const ports = new Set(proxyPorts.map(port).filter(Boolean));
    const portKey = [...ports].sort((a, b) => a - b).join(',');
    if (portKey !== previousPorts) { remembered.clear(); previousPorts = portKey; epoch++; }
    const generation = epoch;
    const eligible = item => {
      const m = item?.metadata;
      return String(m?.network).toLowerCase() === 'tcp' && loopback(address(m?.sourceIP)) && port(m?.sourcePort);
    };
    const missing = known(items).filter(item => item.processSource === 'unknown' && eligible(item));
    let owners = [], initialKeys;
    if (ports.size && missing.length) {
      initialKeys = new Set(items.map(key).filter(Boolean));
      pending ??= Promise.resolve().then(lookup).catch(() => []).finally(() => { pending = null; });
      owners = await pending;
      if (!Array.isArray(owners)) owners = [];
      // Sampling may outlive a short connection. Require the same lifetime in
      // a fresh core snapshot before assigning the sampled endpoint's owner.
      if (recheck) {
        try { const current = await recheck(); if (Array.isArray(current)) items = current; else owners = []; }
        catch { owners = []; }
      }
    }
    const next = new Map();
    const result = known(items).map(item => {
      const lifetime = key(item);
      let identity = { app: item.app, processSource: item.processSource };
      if (identity.processSource === 'unknown' && eligible(item) && (!recheck || lifetime && initialKeys?.has(lifetime))) {
        const m = item.metadata, ip = address(m.sourceIP), sourcePort = port(m.sourcePort);
        const matches = owners.filter(owner => owner.address === ip && owner.port === sourcePort && loopback(owner.remoteAddress) && ports.has(owner.remotePort));
        // Multiple owners are ambiguous even when they share an image name.
        if (matches.length === 1 && filename(matches[0].name)) identity = { app: filename(matches[0].name), processSource: 'windows' };
      }
      if (lifetime && identity.processSource === 'windows' && next.size < 4096) next.set(lifetime, identity);
      return { ...item, ...identity };
    });
    if (generation === epoch) remembered = next;
    return result;
  }
  return { known, identify };
}
