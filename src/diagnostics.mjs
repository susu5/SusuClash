import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { portNumber, probeUrl } from './mihomo.mjs';

const execute = promisify(execFile);
const systemDir = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const codexUrl = 'https://chatgpt.com/';

function run(name, args, timeout = 3500, signal) {
  return execute(path.join(systemDir, name), args, { timeout, signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

export async function listeners(ports) {
  const requested = new Set(ports.filter(Boolean));
  if (!requested.size) return [];
  let output;
  try { ({ stdout: output } = await run('netstat.exe', ['-ano', '-p', 'tcp'])); }
  catch { return null; }
  const matches = [];
  for (const line of output.split(/\r?\n/)) {
    const row = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (row && requested.has(Number(row[2]))) {
      matches.push({ address: row[1], port: Number(row[2]), pid: row[3] });
    }
  }
  const pids = [...new Set(matches.map(item => item.pid))].slice(0, 12);
  const names = new Map(await Promise.all(pids.map(async pid => {
    try {
      const { stdout } = await run('tasklist.exe', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']);
      return [pid, /^"([^"]+)","\d+"/m.exec(stdout)?.[1] ?? null];
    } catch { return [pid, null]; }
  })));
  return matches.map(item => ({ ...item, name: names.get(item.pid) }));
}

export async function systemProxyEnabled() {
  try {
    const { stdout } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable']);
    const value = /\bProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout)?.[1];
    return value == null ? null : Number.parseInt(value, 16) !== 0;
  } catch { return null; }
}

export async function codexProxy() {
  let content;
  try { content = await readFile(path.join(process.env.USERPROFILE ?? '', '.codex', '.env'), 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? { kind: 'none' } : { kind: 'unknown' }; }
  const values = new Map();
  for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const entry = /^\s*(?:export\s+)?(HTTPS_PROXY|ALL_PROXY|HTTP_PROXY)\s*=\s*(.*?)\s*$/i.exec(line);
    if (entry) values.set(entry[1].toUpperCase(), entry[2].split(/\s+#/, 1)[0].replace(/^(['"])(.*)\1$/, '$2'));
  }
  const value = values.get('HTTPS_PROXY') || values.get('ALL_PROXY') || values.get('HTTP_PROXY');
  if (!value) return { kind: 'none' };
  try {
    const url = new URL(value.includes('://') ? value : 'http://' + value);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
      return { kind: 'custom' };
    }
    const port = portNumber(url.port || ({ 'http:': 80, 'https:': 443 })[url.protocol]);
    if (port) return { kind: 'local', port, url: url.href };
  } catch { /* An unrecognized proxy is described without displaying or probing it. */ }
  return { kind: 'custom' };
}

export async function webProbe(url, proxy, {short = false, signal} = {}) {
  const args = ['-q', '--silent', '--output', 'NUL', '--write-out', '%{http_code}',
    '--connect-timeout', short ? '2' : '4', '--max-time', short ? '4' : '8', '--noproxy', proxy ? '' : '*'];
  if (proxy) args.push('--proxy', proxy);
  args.push('--', url);
  try {
    const { stdout } = await run('curl.exe', args, short ? 5000 : 9500, signal);
    return Number(stdout.trim()) || 0;
  } catch (error) {
    if (signal?.aborted) return null;
    if (error.code === 'ENOENT' || error.code === 'EACCES') return null;
    return Number(String(error.stdout ?? '').trim()) || 0;
  }
}

const check = (id, value, tone, detail) => ({ id, value, tone, detail });
const isCore = name => Boolean(name && /^(?:verge-mihomo|mihomo|clash)(?:[-_.]|$)/i.test(name));
const ownerLabel = owner => owner.name ?? 'PID ' + owner.pid;

export async function diagnose(core, system = { listeners, codexProxy, webProbe }) {
  const [coreResult, prefs, proxy] = await Promise.all([
    core.call('GET', '/configs').then(config => ({ config }), () => ({ config: null })),
    core.preferences(),
    system.codexProxy()
  ]);
  const config = coreResult.config;
  const actual = portNumber(config?.['mixed-port']);
  const httpPort = actual ?? portNumber(config?.port);
  const expected = prefs.expectedPort;
  const owners = await system.listeners([actual, expected, proxy.port]);
  const conflict = expected && owners?.find(owner => owner.port === expected && owner.name && !isCore(owner.name));
  const shifted = Boolean(actual && expected && actual !== expected);
  const proxyOwner = proxy.kind === 'local' && owners?.find(owner => owner.port === proxy.port && owner.name && !isCore(owner.name));
  const blocked = Boolean(proxyOwner && shifted && proxy.port === expected);

  const [externalCode, codexCode] = await Promise.all([
    httpPort ? system.webProbe(probeUrl, 'http://127.0.0.1:' + httpPort) : null,
    blocked || proxy.kind === 'custom' || proxy.kind === 'unknown' ? null : system.webProbe(codexUrl, proxy.url)
  ]);

  const portDetail = shifted
    ? '预设 ' + expected + '，内核运行在 ' + actual + '。' + (conflict ? '预设端口由 ' + ownerLabel(conflict) + ' 监听。' : '')
    : actual ? '内核报告混合端口 ' + actual + '。' : '当前未读到混合端口。';
  const checks = [
    config ? check('core', '已连接', 'ok', '本机 Mihomo 控制接口有响应。')
      : check('core', '未连接', 'warn', '请检查本软件的内核是否已启动，以及当前配置是否有效。'),
    check('port', shifted ? expected + ' → ' + actual : actual ? String(actual) : '待验证', shifted ? 'warn' : actual ? 'ok' : null, portDetail),
    externalCode === 204 ? check('web', '代理可达', 'ok', '通过本机代理收到测试站点的 HTTP 204。')
      : externalCode === null ? check('web', '待验证', null, '没有可用的 HTTP 代理或本机 curl 无法执行。')
      : check('web', '代理探测异常', 'warn', externalCode ? '测试站点返回 HTTP ' + externalCode + '。' : '通过当前代理未收到测试站点响应。')
  ];
  const routeNote = proxy.kind === 'local' ? '按 Codex .env 中的本机代理端口 ' + proxy.port + ' 探测。'
    : '按本机路由探测，可经过已启用的 TUN。';
  const codexCaveat = '仅验证站点响应，发送消息需在 Codex 中确认。';
  if (blocked) checks.push(check('codex', '代理指向异常', 'warn', 'Codex .env 指向 ' + proxy.port + '，该端口由 ' + ownerLabel(proxyOwner) + ' 监听。'));
  else if (proxy.kind === 'custom' || proxy.kind === 'unknown') checks.push(check('codex', '需应用内确认', null, '无法安全复现 Codex 的专用代理设置。'));
  else if (codexCode == null) checks.push(check('codex', '待验证', null, '本机 curl 无法执行。'));
  else if (!codexCode) checks.push(check('codex', '站点未响应', 'warn', routeNote + '未收到 ChatGPT 站点响应。'));
  else checks.push(check('codex', 'HTTP ' + codexCode, codexCode >= 400 ? 'warn' : 'ok', routeNote + codexCaveat));

  const tone = checks.some(item => item.tone === 'warn') ? 'warn' : checks.every(item => item.tone === 'ok') ? 'ok' : null;
  let title = tone === 'ok' ? '本次检测通过' : tone === 'warn' ? '有连接项需要确认' : '部分连接待验证';
  let detail = '查看各项结果。' + codexCaveat;
  let steps = [];
  if (blocked) {
    title = externalCode === 204 ? '代理可用，Codex 指向了旧端口' : 'Codex 配置指向了被占用的端口';
    detail = checks[3].detail;
    steps = [
      '确认本软件当前代理端口为 ' + httpPort + '，并确认代理探测通过。',
      '备份 Codex 的 .env 后，把本机代理指向当前可用端口。如果已验证 TUN 可用，也可移除固定代理。',
      '完全退出并重开 Codex，发送消息确认。'
    ];
  } else if (shifted) {
    title = conflict ? 'Clash 已改用其他端口' : '运行端口与预设端口不同';
    detail = portDetail;
    steps = ['在本软件的设置中核对混合端口。固定使用旧端口的应用可能需要同步更新。'];
  } else if (!config) {
    title = 'Clash 内核未连接';
    detail = checks[0].detail;
  }
  return { tone, title, detail, checks, steps, checkedAt: new Date().toISOString() };
}
