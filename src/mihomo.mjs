import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const pipeRoot = '\\\\.\\pipe\\';
const pipeName = /^verge-mihomo(?:-[a-z0-9-]+)?$/i;
const maxReply = 16 * 1024 * 1024;

export class AppError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

export const modes = new Set(['rule', 'global', 'direct']);
export const probeUrl = 'https://www.gstatic.com/generate_204';

export function portNumber(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

async function readConfig(dir, name) {
  try { return await readFile(path.join(dir, name), 'utf8'); }
  catch { return ''; }
}

// Only the top-level scalar keys emitted by Clash Verge are needed here.
function scalar(source, key) {
  const raw = source.replace(/^\uFEFF/, '').match(new RegExp('^' + key + ':[ \\t]*([^\\r\\n]*)', 'm'))?.[1]?.trim() ?? '';
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); }
    catch { return ''; }
  }
  return raw.split(/\s+#/, 1)[0].trim();
}

function trustedPipe(value) {
  return value.startsWith(pipeRoot) && pipeName.test(value.slice(pipeRoot.length));
}

function loopbackController(value) {
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/i.exec(value);
  const port = match && portNumber(match[2]);
  if (!port) return null;
  const host = match[1].toLowerCase();
  return { hostname: host === '[::1]' ? '::1' : '127.0.0.1', port };
}

export function requestCore(target, method, route, payload, timeout) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? null : JSON.stringify(payload);
    const headers = { Host: 'localhost', Accept: 'application/json', Connection: 'close' };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (target.secret) headers.Authorization = 'Bearer ' + target.secret;
    const req = http.request({ ...target.address, method, path: route, headers, agent: false }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxReply) req.destroy(new AppError('内核返回的数据超出本次读取上限。', 502));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new AppError('内核未完成请求（HTTP ' + res.statusCode + '）。', 502));
          return;
        }
        try { resolve(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); }
        catch { reject(new AppError('内核返回的数据无法读取。', 502)); }
      });
    });
    const timer = setTimeout(() => req.destroy(new AppError('等待内核响应超时。', 504)), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
}

export function createMihomo(dir = path.join(process.env.APPDATA ?? '', 'io.github.clash-verge-rev.clash-verge-rev')) {
  let controller;
  let pendingDiscovery;
  let retryAfter = 0;

  async function discover() {
    const config = await readConfig(dir, 'clash-verge.yaml') || await readConfig(dir, 'config.yaml');
    const configured = scalar(config, 'external-controller-pipe');
    const secret = scalar(config, 'secret');
    const tcp = loopbackController(scalar(config, 'external-controller'));
    const targets = [];
    if (trustedPipe(configured)) {
      targets.push({ address: { socketPath: configured }, transport: '命名管道', secret });
    }
    if (tcp) targets.push({ address: tcp, transport: '本机 HTTP', secret });
    let available = [];
    try { available = (await readdir(pipeRoot)).filter(name => pipeName.test(name)); }
    catch { /* The configured endpoint is still worth trying. */ }
    // If Verge changed its generated name, use the single active core pipe.
    if (available.length === 1 && pipeRoot + available[0] !== configured) {
      targets.push({ address: { socketPath: pipeRoot + available[0] }, transport: '命名管道' });
    }
    for (const target of targets) {
      try {
        const version = await requestCore(target, 'GET', '/version', null, 1300);
        if (typeof version?.version === 'string' && version.version) {
          return { ...target, version: version.version };
        }
      } catch { /* Try the next local endpoint. */ }
    }
    throw new AppError('无法连接 Mihomo。请确认 Clash Verge 已打开且内核正在运行。');
  }

  async function connect() {
    if (controller) return controller;
    if (Date.now() < retryAfter) throw new AppError('等待 Clash Verge 的本机控制接口。');
    pendingDiscovery ??= discover().then(target => {
      controller = target;
      return target;
    }).catch(error => {
      retryAfter = Date.now() + 1600;
      throw error;
    }).finally(() => { pendingDiscovery = null; });
    return pendingDiscovery;
  }

  async function call(method, route, body, timeout = 3500) {
    const target = await connect();
    try {
      return await requestCore(target, method, route, body, timeout);
    } catch (error) {
      if (controller === target && !(error instanceof AppError && error.status === 502)) {
        controller = null;
      }
      if (error instanceof AppError) throw error;
      throw new AppError('与 Mihomo 的连接中断，请重新读取。');
    }
  }

  return {
    call,
    async identity() {
      const target = await connect();
      return { version: target.version, transport: target.transport };
    },
    async preferences() {
      const [verge, config] = await Promise.all([readConfig(dir, 'verge.yaml'), readConfig(dir, 'config.yaml')]);
      return {
        expectedPort: portNumber(scalar(verge, 'verge_mixed_port')) ?? portNumber(scalar(config, 'mixed-port')),
        autoLaunch: ({ true: true, false: false })[scalar(verge, 'enable_auto_launch')] ?? null
      };
    }
  };
}

export function routingGroups(response, mode) {
  const proxies = response?.proxies ?? {};
  return Object.values(proxies).filter(group =>
    group?.type === 'Selector' && !group.hidden && Array.isArray(group.all) && typeof group.name === 'string'
  ).map(group => ({
    name: group.name,
    current: typeof group.now === 'string' ? group.now : null,
    members: group.all.filter(name => typeof name === 'string').map(name => {
      const delay = Object.hasOwn(proxies, name) ? proxies[name]?.history?.at(-1)?.delay : null;
      return { name, delay: Number.isFinite(delay) && delay > 0 ? delay : null };
    })
  })).sort((a, b) => {
    const order = Number(b.name === 'GLOBAL') - Number(a.name === 'GLOBAL');
    return mode === 'global' ? order : -order;
  });
}

export async function selectableMember(core, group, member) {
  if (typeof group !== 'string' || !group || group.length > 1024 ||
      typeof member !== 'string' || !member || member.length > 1024) {
    throw new AppError('请选择有效的策略组和线路。', 400);
  }
  const encoded = encodeURIComponent(group);
  const target = await core.call('GET', '/proxies/' + encoded);
  if (target?.type !== 'Selector' || target.hidden || !Array.isArray(target.all) || !target.all.includes(member)) {
    throw new AppError('此线路已不在可切换的策略组中，请刷新。', 409);
  }
  return encoded;
}
