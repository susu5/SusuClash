import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile, copyFile, unlink, rename } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseAllDocuments, stringify } from 'yaml';
import { AppError, requestCore } from './mihomo.mjs';

const runFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ownBinary = path.join(root, 'runtime', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
export const defaultDataDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'ClashStandalone');

// Core output can contain node names, passwords or subscription URLs. Classify
// it against known patterns and return fixed messages only; never expose it.
export function coreValidationFailure(error) {
  if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') {
    return new AppError('代理内核无法启动，请检查文件和系统权限。', 503);
  }
  if (error?.code === 'ETIMEDOUT' || error?.killed === true || error?.signal === 'SIGTERM') {
    return new AppError('配置校验超时，请稍后重试。', 504);
  }
  const output = String(error?.stderr || '') + '\n' + String(error?.stdout || '');
  if (/unsupport(?:ed)?\s+proxy\s+type|unsupported\s+(?:proxy\s+)?protocol/i.test(output)) {
    return new AppError('订阅包含当前内核不支持的节点协议，请向服务商获取 Clash 格式。', 422);
  }
  if (/has unset fields|missing required fields?|missing required (?:field|parameter)/i.test(output)) {
    return new AppError('订阅中的节点缺少必要信息，请向服务商检查配置。', 422);
  }
  if (/rule\s+parse|parse\s+rule|proxy\s*group|proxy\s+.*(?:not found|not exist)/i.test(output)) {
    return new AppError('订阅中的线路、策略组或规则无法通过校验，请检查配置。', 422);
  }
  if (/yaml:\s*(?:unmarshal|line|cannot)|cannot unmarshal|invalid yaml/i.test(output)) {
    return new AppError('订阅中的配置字段与内核格式不匹配，请检查配置。', 422);
  }
  return new AppError('配置校验失败，请检查格式和内核支持的协议。', 400);
}

// Resolve YAML aliases/merges before overriding privileged and listening fields.
// Provider URLs require a separately controlled downloader and are rejected.
export function safeRuntimeConfig(source, port) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 4 * 1024 * 1024 || source.includes('\0')) throw new AppError('配置文件无效或过大。', 400);
  let data;
  try {
    const docs = parseAllDocuments(source, { merge:true, uniqueKeys:true });
    if (docs.length !== 1 || docs[0].errors.length || docs[0].warnings.length) throw new Error('invalid yaml');
    data = docs[0].toJS({ maxAliasCount:50 });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a mapping');
  } catch { throw new AppError('配置 YAML 格式无效或包含暂不支持的标签。', 400); }
  const forbidden = /^(?:allow-lan|bind-address|authentication|skip-auth-prefixes|lan-allowed-ips|lan-disallowed-ips|secret|tun|listeners|tunnels|ntp|port|socks-port|mixed-port|redir-port|tproxy-port|geox-url|geo-auto-update|external-controller(?:-.*)?|external-ui(?:-.*)?)$/i;
  for (const key of Object.keys(data)) {
    if (/^(dns|proxy-groups)$/i.test(key) && key !== key.toLowerCase()) throw new AppError('配置中的保留字段名称格式无效。', 400);
    if (/^(proxy-providers|rule-providers)$/i.test(key)) {
      if (data[key] && typeof data[key] === 'object' && Object.keys(data[key]).length) throw new AppError('暂不支持包含远程代理集或规则集的配置。', 400);
      delete data[key];
    } else if (forbidden.test(key)) delete data[key];
  }
  if (data.dns != null) {
    if (typeof data.dns !== 'object' || Array.isArray(data.dns)) throw new AppError('配置中的 DNS 设置格式无效。', 400);
    for (const key of Object.keys(data.dns)) if (key.toLowerCase() === 'listen') delete data.dns[key];
    data.dns.listen = '';
  }
  if (Array.isArray(data['proxy-groups'])) {
    for (const group of data['proxy-groups']) {
      if (group && typeof group === 'object' && ['url-test','fallback','load-balance'].includes(group.type)) {
        const interval = Number(group.interval);
        for (const key of Object.keys(group)) if (['url','interval'].includes(key.toLowerCase())) delete group[key];
        group.url = 'https://www.gstatic.com/generate_204';
        group.interval = Math.max(Number.isFinite(interval) ? interval : 300, 300);
      }
    }
  }
  data['allow-lan'] = false;
  data['bind-address'] = '127.0.0.1';
  data['mixed-port'] = port;
  data.tun = {enable:false};
  data.listeners = [];
  try { return stringify(data); }
  catch { throw new AppError('配置包含暂不支持的循环引用。', 400); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function checkPort(port) {
  const server = net.createServer();
  try { await new Promise((resolve,reject) => server.once('error',reject).listen(port,'127.0.0.1',resolve)); }
  catch { throw new AppError('这个端口不可用或已被占用，请选择其他端口。', 409); }
  await new Promise(resolve => server.close(resolve));
}

export function createManagedCore({ directory = defaultDataDir, binary = process.env.CLASH_APP_MIHOMO || ownBinary, launch = spawn, testFile = runFile } = {}) {
  let child = null, endpoint = null, currentStatus = 'stopped', message = '尚未启动内核', version = null, lastConfig = null, stopping = false;
  let pendingStart = null;
  let assignedProxyPort = null;
  let loadedPort = false;
  const coreDirectory = path.join(directory, 'core');
  const runtime = path.join(coreDirectory, 'runtime.yaml');
  function cleanEnvironment(secret) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.toUpperCase() === 'SAFE_PATHS' || name.toUpperCase().startsWith('CLASH_')) delete env[name];
    env.CLASH_OVERRIDE_EXTERNAL_CONTROLLER_UNIX = '';
    env.CLASH_OVERRIDE_EXTERNAL_CONTROLLER_PIPE = '';
    env.CLASH_OVERRIDE_SECRET = secret;
    return env;
  }
  async function available() { try { await access(binary); return true; } catch { return false; } }
  async function loadPort() {
    if (loadedPort) return;
    try {
      const value = JSON.parse(await readFile(path.join(directory, 'port.json'), 'utf8'))?.port;
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('invalid port');
      assignedProxyPort = value;
    } catch (error) { if (error.code !== 'ENOENT') throw new AppError('无法读取保存的代理端口，请检查应用配置。', 503); }
    loadedPort = true;
  }
  async function persistPort(port) {
    await mkdir(directory, {recursive:true});
    const file = path.join(directory,'port.json');
    const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try { await writeFile(temp,JSON.stringify({port}),{mode:0o600,flag:'wx'}); await rename(temp,file); }
    finally { await unlink(temp).catch(()=>{}); }
  }
  async function prepareDirectory() {
    await mkdir(coreDirectory, { recursive: true });
    for (const name of ['geoip.dat', 'geosite.dat', 'Country.mmdb', 'ASN.mmdb']) {
      try { await copyFile(path.join(root, 'runtime', name), path.join(coreDirectory, name), constants.COPYFILE_EXCL); }
      catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
    }
  }
  function status() { return { state: currentStatus, message, version }; }
  async function writeSafe(sourcePath, target, port) {
    const input = await readFile(sourcePath, 'utf8');
    await writeFile(target, safeRuntimeConfig(input, port), { mode: 0o600 });
  }
  async function validateConfig(sourcePath) {
    if (!await available()) throw new AppError('未找到本软件的 Mihomo 内核，请先安装内核。', 503);
    await prepareDirectory();
    const tmp = path.join(coreDirectory, 'validate-' + randomBytes(8).toString('hex') + '.yaml');
    try {
      await writeSafe(sourcePath, tmp, 0);
      const secret = randomBytes(24).toString('hex');
      await testFile(binary, ['-d', coreDirectory, '-f', tmp, '-t', '-ext-ctl', '127.0.0.1:0', '-secret', secret], { timeout: 15000, maxBuffer: 512 * 1024, windowsHide: true, env:cleanEnvironment(secret) });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw coreValidationFailure(error);
    } finally { await unlink(tmp).catch(() => {}); }
  }
  async function stop() {
    if (!child) { currentStatus = 'stopped'; message = '内核已停止'; endpoint = null; return; }
    stopping = true;
    const old = child;
    child = null; endpoint = null;
    await new Promise(resolve => {
      const timer = setTimeout(() => { old.kill('SIGKILL'); resolve(); }, 2500);
      old.once('exit', () => { clearTimeout(timer); resolve(); });
      old.kill();
    });
    stopping = false; currentStatus = 'stopped'; message = '内核已停止';
  }
  async function startInternal(sourcePath) {
    if (!await available()) { currentStatus = 'missing'; message = '未找到本软件的 Mihomo 内核'; throw new AppError(message, 503); }
    await prepareDirectory();
    await loadPort();
    const proxyPort = assignedProxyPort ??= await freePort();
    await checkPort(proxyPort);
    const controlPort = await freePort();
    const secret = randomBytes(32).toString('hex');
    await writeSafe(sourcePath, runtime, proxyPort);
    currentStatus = 'starting'; message = '内核正在启动';
    const processHandle = launch(binary, ['-d', coreDirectory, '-f', runtime, '-ext-ctl', '127.0.0.1:' + controlPort, '-secret', secret], { windowsHide: true, stdio: 'ignore', env:cleanEnvironment(secret) });
    child = processHandle;
    const target = { address: { hostname: '127.0.0.1', port: controlPort }, secret };
    processHandle.once('error', () => { if (child === processHandle) { child = null; endpoint = null; currentStatus = 'error'; message = '内核启动失败'; } });
    processHandle.once('exit', () => { if (child === processHandle) { child = null; endpoint = null; currentStatus = stopping ? 'stopped' : 'error'; message = stopping ? '内核已停止' : '内核意外退出'; } });
    const until = Date.now() + 8000;
    while (Date.now() < until && child === processHandle) {
      try {
        const value = await requestCore(target, 'GET', '/version', null, 500);
        if (typeof value?.version === 'string') {
          endpoint = target; version = value.version; currentStatus = 'running'; message = '内核运行中';
          return status();
        }
      } catch { /* process may still be starting */ }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    await stop(); currentStatus = 'error'; message = '内核启动失败，请检查配置与运行日志';
    throw new AppError(message, 503);
  }
  async function applyConfig(sourcePath) {
    await validateConfig(sourcePath);
    await mkdir(directory, { recursive: true });
    const newFile = path.join(directory, 'active-next.yaml');
    const oldFile = path.join(directory, 'active-rollback.yaml');
    const active = path.join(directory, 'active.yaml');
    await copyFile(sourcePath, newFile);
    const hadOld = await access(active).then(() => true, () => false);
    if (hadOld) await copyFile(active, oldFile);
    await stop();
    try {
      await startInternal(newFile);
      await copyFile(newFile, active);
      lastConfig = active;
    } catch (error) {
      if (hadOld) {
        try { await startInternal(oldFile); lastConfig = active; }
        catch { throw new AppError('新配置加载失败，恢复旧内核也失败，请检查配置。', 503); }
      }
      throw error;
    } finally { await unlink(newFile).catch(() => {}); await unlink(oldFile).catch(() => {}); }
    return status();
  }
  async function start() {
    if (currentStatus === 'running') return status();
    const active = lastConfig || path.join(directory, 'active.yaml');
    if (!await access(active).then(() => true, () => false)) throw new AppError('请先添加并启用配置。', 409);
    pendingStart ??= startInternal(active).finally(() => { pendingStart = null; });
    return pendingStart;
  }
  async function setPort(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('请输入 1 到 65535 的端口。', 400);
    await loadPort();
    if (assignedProxyPort === port) return {port};
    await checkPort(port);
    const previous = assignedProxyPort;
    const running = currentStatus === 'running';
    const active = lastConfig || path.join(directory, 'active.yaml');
    if (running) await stop();
    assignedProxyPort = port;
    try {
      if (running) await startInternal(active);
      await persistPort(port);
      return {port};
    } catch {
      if (running && child) await stop();
      assignedProxyPort = previous;
      if (running) {
        try { await startInternal(active); }
        catch { throw new AppError('端口更改失败，恢复旧内核也失败，请检查运行状态。', 503); }
      }
      throw new AppError('端口更改失败，已保留之前的端口设置。', 409);
    }
  }
  async function call(method, route, body, timeout = 3500) {
    if (!endpoint || currentStatus !== 'running') throw new AppError('内核未运行，请先启用配置。', 503);
    try { return await requestCore(endpoint, method, route, body, timeout); }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError('与本软件内核的连接中断。', 503); }
  }
  return { call, status, start, stop, setPort, validateConfig, applyConfig, directory,
    processId() { return currentStatus === 'running' && Number.isInteger(child?.pid) ? child.pid : null; },
    async identity() { return { version, transport: '本机 HTTP' }; },
    async preferences() { await loadPort(); return { expectedPort: assignedProxyPort, autoLaunch: null }; }
  };
}
