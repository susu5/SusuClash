import http from 'node:http';
import {createConnectionDoctor} from './connection-doctor.mjs';
import {codexRequest} from './codex-request.mjs';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, createMihomo, modes, portNumber, probeUrl, routingGroups, selectableMember } from './mihomo.mjs';
import { diagnose, systemProxyEnabled } from './diagnostics.mjs';
import { createManagedCore } from './managed-core.mjs';
import { createProfileStore, ProfileError } from './profiles.mjs';
import { createSystemProxy } from './system-proxy.mjs';
import { createAutomation } from './automation.mjs';
import { createHealthProbe, targets as healthTargets } from './health-probe.mjs';
import { createAutostart } from './autostart.mjs';
import { createTrayPreferences } from './tray.mjs';
import { createCodexHealth, codexTarget } from './codex-health.mjs';
import { createCodexRepair } from './codex-repair.mjs';
import { createThemePreferences } from './theme-preferences.mjs';
import { createUpdateChecker } from './update-check.mjs';
import { createDailyUpdate } from './daily-update.mjs';
import { createConnectionIdentity } from './connection-identity.mjs';

const appVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

const assets = {
  'design-system.css': ['design-system.css', 'text/css; charset=utf-8'],
  'visual-contract.css': ['visual-contract.css', 'text/css; charset=utf-8'],
  'visual-contract.js': ['visual-contract.js', 'application/javascript; charset=utf-8'],
  'doctor.js':['doctor.js','application/javascript; charset=utf-8'],
  'doctor.css':['doctor.css','text/css; charset=utf-8'],
  'visual-polish.css':['visual-polish.css','text/css; charset=utf-8'],
  '': ['index.html', 'text/html; charset=utf-8'],
  'app.css': ['app.css', 'text/css; charset=utf-8'],
  'app.js': ['app.js', 'application/javascript; charset=utf-8'],
  'theme-v2.css': ['theme-v2.css', 'text/css; charset=utf-8'],
  'theme-v2.js': ['theme-v2.js', 'application/javascript; charset=utf-8'],
  'lines-v3.css': ['lines-v3.css', 'text/css; charset=utf-8'],
  'lines-v3.js': ['lines-v3.js', 'application/javascript; charset=utf-8'],
  'settings-v2.css': ['settings-v2.css', 'text/css; charset=utf-8'],
  'settings-v2.js': ['settings-v2.js', 'application/javascript; charset=utf-8'],
  'secondary-fix.css': ['secondary-fix.css', 'text/css; charset=utf-8'],
  'secondary-fix.js': ['secondary-fix.js', 'application/javascript; charset=utf-8'],
  'window-frame.css': ['window-frame.css', 'text/css; charset=utf-8'],
  'window-frame.js': ['window-frame.js', 'application/javascript; charset=utf-8'],
  'update-check.css': ['update-check.css', 'text/css; charset=utf-8'],
  'update-check.js': ['update-check.js', 'application/javascript; charset=utf-8'],
  'codex-repair.js': ['codex-repair.js', 'application/javascript; charset=utf-8'],
  'cat-motion.gif': ['cat-motion.gif', 'image/gif'],
  'fish-motion.gif': ['fish-motion.gif', 'image/gif'],
  'whale-motion.gif': ['whale-motion.gif', 'image/gif'],
  'cat-poster.png': ['cat-poster.png', 'image/png'],
  'fish-poster.png': ['fish-poster.png', 'image/png'],
  'whale-poster.png': ['whale-poster.png', 'image/png'],
  'icon.svg': ['icon.svg', 'image/svg+xml'],
  'icon.ico': ['icon.ico', 'image/x-icon']
};
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

function respond(res, status, contentType, body) {
  res.writeHead(status, { ...headers, 'Content-Type': contentType });
  res.end(body);
}

function json(res, status, body) {
  respond(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

async function readJson(req, limit = 4096) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new AppError('请求必须使用 JSON。', 415);
  }
  if (Number(req.headers['content-length']) > limit) throw new AppError('请求体太长。', 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new AppError('请求体太长。', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Respond with a single validation error. */ }
  throw new AppError('无法读取请求。', 400);
}

function publicConfig(config) {
  return {
    mode: modes.has(config?.mode) ? config.mode : null,
    port: portNumber(config?.['mixed-port']),
    tun: typeof config?.tun?.enable === 'boolean' ? config.tun.enable : null
  };
}

const count = value => Number.isFinite(value) && value >= 0 ? value : null;

// Mihomo represents a valid snapshot without active connections as null.
// Missing or malformed fields are still treated as unavailable rather than empty.
function connectionItems(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Object.hasOwn(snapshot, 'connections')) return null;
  if (snapshot.connections === null) return [];
  return Array.isArray(snapshot.connections) ? snapshot.connections : null;
}

function connectionSummary(snapshot, connections = connectionItems(snapshot)) {
  if (!connections) return null;
  const byApp = new Map();
  for (const item of connections) {
    const name = item.app || '未知应用';
    const app = byApp.get(name) ?? { name, active: 0, downloaded: 0, uploaded: 0 };
    app.active++;
    app.downloaded += count(item?.download) ?? 0;
    app.uploaded += count(item?.upload) ?? 0;
    byApp.set(name, app);
  }
  return {
    active: connections.length,
    downloaded: count(snapshot.downloadTotal),
    uploaded: count(snapshot.uploadTotal),
    apps: [...byApp.values()].sort((a, b) => b.active - a.active).slice(0, 80)
  };
}

async function httpProviders(core) {
  const response = await core.call('GET', '/providers/proxies');
  return Object.entries(response?.providers ?? {}).filter(([, data]) => data?.vehicleType === 'HTTP').map(([name]) => name);
}

export async function startServer({ core = createManagedCore(), diagnostic = diagnose, readSystemProxy = systemProxyEnabled, profileStore, systemProxy, monitor, healthProbe, codexHealth, codexRepairService, autostart, trayPreferences, themePreferences, updateChecker, updateRequest, dailyUpdate, automationIntervalMs = 5000, connectionDoctor, doctorSystem, restartClient, codexTargetAdapter, autoRepairOptions, connectionIdentity = createConnectionIdentity() } = {}) {
  const managed = typeof core.applyConfig === 'function';
  const codexRepair = codexRepairService || createCodexRepair({core});
  const profiles = profileStore || (managed ? createProfileStore({ directory: path.join(core.directory, 'profiles'), validateConfig: core.validateConfig, applyConfig: core.applyConfig }) : null);
  const proxy = systemProxy || (managed ? createSystemProxy({ directory: core.directory }) : null);
  const startup = autostart || (managed ? createAutostart() : null);
  const tray = trayPreferences || (managed ? createTrayPreferences({directory:core.directory}) : null);
  const theme = themePreferences || (managed ? createThemePreferences({directory:core.directory}) : null);
  const updates = updateChecker || createUpdateChecker({currentVersion:appVersion, request:updateRequest, getManagedProxy:async()=>{
    if (!managed || !proxy || core.status()?.state !== 'running') return null;
    const status=await proxy.getStatus();
    if (!status?.enabled || !status?.managed) return null;
    const config=await core.call('GET','/configs');
    return portNumber(config?.['mixed-port']);
  }});
  const token = randomBytes(24).toString('base64url');
  const prefix = '/' + token + '/';
  const contents = Object.fromEntries(await Promise.all(Object.entries(assets).map(async ([route, [filename, type]]) =>
    [route, { type, data: await readFile(new URL('../app/' + filename, import.meta.url)) }]
  )));
  let origin;
  let pendingCheck;
  let writing = false;
  let doctor;
  let writeTail = Promise.resolve();
  let closing = false;
  let closePromise = null;
  let resumeMode = 'rule';
  const logEntries = [];
  function logEvent(level, message) {
    logEntries.unshift({time:new Date().toISOString(), level, message});
    if (logEntries.length > 300) logEntries.length = 300;
  }
  async function tracked(action, success, failure) {
    try { const result = await action(); logEvent('info', success); return result; }
    catch (error) { logEvent('error', failure); throw error; }
  }
  logEvent('info', '客户端已启动');
  let restoring = null;
  let recoveryWarning = null;
  if (profiles && managed) {
    restoring = (async () => {
      try { if (proxy) await proxy.restoreOnExit(); }
      catch { recoveryWarning = '上次异常退出后，系统代理恢复失败。请先检查 Windows 代理设置。'; return; }
      try { await profiles.restoreActive(); }
      catch { recoveryWarning = '无法恢复上次配置，请检查内核和配置。'; }
    })().finally(() => { restoring = null; });
  }

  const daily = dailyUpdate === false ? null : dailyUpdate || (managed ? createDailyUpdate({
    directory:core.directory, checker:updates, currentVersion:appVersion,
    waitUntilReady:async()=>{if(restoring) await restoring;}
  }) : null);

  let automation = monitor || null;
  let monitorGroup = '';
  let monitorScope = '';
  let codexStatus = {result:'unknown',detail:'尚未检测 Codex 站点。',checkedAt:null};
  let savedGroups = {};
  const contextFile = managed ? path.join(core.directory, 'automation-context.json') : null;
  const contextReady = contextFile ? readFile(contextFile, 'utf8').then(data => {
    try { const saved = JSON.parse(data); if (saved && typeof saved === 'object' && !Array.isArray(saved)) savedGroups = saved; } catch { /* Ignore damaged context. */ }
  }, () => {}) : Promise.resolve();
  async function syncScope(scope) {
    await contextReady;
    if ((scope || '') !== monitorScope) {
      monitorScope = scope || '';
      monitorGroup = typeof savedGroups[monitorScope] === 'string' ? savedGroups[monitorScope] : '';
      codexStatus = {result:'unknown',detail:'配置已切换，尚未重新检测 Codex 站点。',checkedAt:null};
    }
  }
  async function rememberGroup(scope, group) {
    await syncScope(scope);
    if (monitorGroup === group && savedGroups[scope] === group) return;
    const next = {...savedGroups, [scope]:group};
    const tmp = contextFile + '.' + randomBytes(8).toString('hex') + '.tmp';
    await mkdir(core.directory, { recursive:true });
    try { await writeFile(tmp, JSON.stringify(next), {mode:0o600, flag:'wx'}); await rename(tmp,contextFile); }
    finally { await rm(tmp,{force:true}).catch(()=>{}); }
    savedGroups = next; monitorGroup = group;
  }
  function mutation(action, manual = true) {
    if (closing) throw new AppError('客户端正在退出，暂时不能更改设置。', 503);
    if (manual) { if(doctor?.isRepairing())throw new AppError('修复步骤正在完成，请等待复查后再更改连接设置。',409); automation?.invalidate(); doctor?.invalidate(); }
    const task = writeTail.then(async () => {
      writing = true;
      try { return await action(); }
      finally { writing = false; }
    });
    writeTail = task.catch(() => {});
    return task;
  }

  async function currentGroup() {
    const response = await core.call('GET', '/proxies');
    const groups = routingGroups(response, 'rule');
    return groups.find(group => group.name === monitorGroup) || null;
  }
  function localPortOpen(port) {
    if (!portNumber(port)) return Promise.resolve('unknown');
    return new Promise(resolve => {
      const socket = net.createConnection({host:'127.0.0.1', port:Number(port)});
      let complete = false;
      const finish = result => { if (complete) return; complete = true; socket.destroy(); resolve(result); };
      socket.setTimeout(800, () => finish('unknown'));
      socket.once('connect', () => finish('ok'));
      socket.once('error', error => finish(error.code === 'ECONNREFUSED' ? 'failed' : 'unknown'));
    });
  }
  if (!automation && managed && profiles) {
    const file = path.join(core.directory, 'automation.json');
    const health = healthProbe || createHealthProbe({core});
    const codex = codexHealth || createCodexHealth({readSystemProxy: () => proxy ? proxy.getStatus() : Promise.resolve(null)});
    automation = createAutomation({
      timeoutMs: 8000,
      intervalMs: automationIntervalMs,
      load: async () => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } },
      persist: async prefs => {
        await mkdir(core.directory, { recursive:true });
        const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
        try { await writeFile(temp, JSON.stringify(prefs), { mode:0o600, flag:'wx' }); await rename(temp, file); }
        finally { await rm(temp, {force:true}).catch(() => {}); }
      },
      probe: async ({signal}) => {
        const scope = (await profiles.list()).activeId || '';
        await syncScope(scope);
        const runtimeState = core.status().state;
        if (!scope) return {scope, group:monitorGroup, current:'', core:'unknown', port:'unknown',network:'unknown',node:'unknown',codex:'unknown'};
        if (runtimeState !== 'running') {
          const prefs = await core.preferences().catch(() => ({}));
          const port = await localPortOpen(prefs.expectedPort);
          const checked = await codex.inspect({corePort:prefs.expectedPort,portStatus:port === 'failed' ? 'failed' : 'unknown',signal});
          if (!signal.aborted && checked.checkedAt) codexStatus = checked;
          return {scope, group:monitorGroup, current:'', core:runtimeState === 'error' ? 'failed' : 'unknown', port:'unknown',network:'unknown',node:'unknown',codex:checked.result};
        }
        try {
          const [config, group] = await Promise.all([core.call('GET','/configs'), currentGroup()]);
          const portPromise = localPortOpen(config['mixed-port']);
          const [port, deep, checked] = await Promise.all([
            portPromise, health.inspect(group?.current, signal),
            portPromise.then(portStatus => codex.inspect({corePort:config['mixed-port'],portStatus,signal}))
          ]);
          if (!signal.aborted && checked.checkedAt) codexStatus = checked;
          return {scope, group:group?.name || '', current:group?.current || '', core:'ok', port, network:deep.network, node:deep.node, codex:checked.result};
        } catch { return {scope,group:monitorGroup,current:'',core:'unknown',port:'unknown',network:'unknown',node:'unknown',codex:'unknown'}; }
      },
      repair: async ({problem, observation, signal, isCurrent}) => {
        if (problem === 'node') return mutation(async () => {
          health.force();
          if (signal.aborted || !isCurrent() || (await profiles.list()).activeId !== observation.scope || monitorGroup !== observation.group) return {ok:false};
          try {
            const encoded = await selectableMember(core, observation.group, observation.current);
            const group = await core.call('GET', '/proxies/' + encoded);
            if (signal.aborted || !isCurrent() || group?.now !== observation.current) return {ok:false};
            if(doctor?.isRepairing())return {ok:false};
            doctor?.invalidate('后台已重新应用线路，请重新检查连接。');
            await core.call('PUT', '/proxies/' + encoded, {name:observation.current});
            if (signal.aborted || !isCurrent()) return {ok:false};
            logEvent('info', '已尝试重新应用当前线路');
            return {ok:true};
          } catch { logEvent('error', '重新应用当前线路失败'); return {ok:false}; }
        }, false);
        if (problem !== 'core') return {ok:false};
        return mutation(async () => {
          if (signal.aborted || !isCurrent()) return {ok:false};
          try { if(doctor?.isRepairing())return {ok:false};doctor?.invalidate('后台正在恢复内核，请重新检查连接。');await core.stop();await core.start(); logEvent('info', '已尝试自动重启内核'); return {ok:true}; }
          catch { logEvent('error', '自动重启内核失败'); return {ok:false}; }
        }, false);
      },
      verify: async ({node, signal}) => health.verify(node,signal),
      select: async ({scope, group, node, signal, isCurrent}) => mutation(async () => {
        if (signal.aborted || !isCurrent() || (await profiles.list()).activeId !== scope || group !== monitorGroup) throw new AppError('自动处理已取消。', 409);
        const encoded = await selectableMember(core, group, node);
        if (signal.aborted || !isCurrent()) throw new AppError('自动处理已取消。', 409);
        if(doctor?.isRepairing())throw new AppError('连接修复正在完成，暂停后台换线。',409);
        doctor?.invalidate('后台已切换备用线路，请重新检查连接。');
        await core.call('PUT', '/proxies/' + encoded, {name:node});
        logEvent('info', '已尝试自动切换备用节点');
      }, false)
    });
    void automation.start();
  }

  async function automationStatus(groupName = null) {
    if (!automation) return { phase:'stopped', checks:{}, message:'自动处理不可用', autoRepair:false, autoSwitch:false, backups:[], scope:null, group:null };
    const data = automation.status();
    const scope = profiles ? (await profiles.list()).activeId : data.scope;
    await syncScope(scope);
    const group = groupName || monitorGroup || data.group || null;
    const backups = scope && group ? data.preferences?.backups?.[JSON.stringify([scope, group])] || [] : [];
    return {...data, scope:scope || null, group, autoRepair:data.preferences?.autoRepair === true, autoSwitch:data.preferences?.autoSwitch === true, backups, targets:healthTargets.map(x=>x.url), codexTarget, codexDetail:codexStatus.detail, codexCheckedAt:codexStatus.checkedAt};
  }

  async function state() {
    if (managed && core.status().state !== 'running') {
      return { mode: null, port: null, tun: null, version: null, transport: null, resumeMode, sampledAt: Date.now(), connections: null, runtime: core.status() };
    }
    const [config, identity, snapshot] = await Promise.all([
      core.call('GET', '/configs'),
      core.identity(),
      core.call('GET', '/connections').catch(() => null)
    ]);
    const current = publicConfig(config);
    if (!writing && current.mode && current.mode !== 'direct') resumeMode = current.mode;
    const items = connectionItems(snapshot);
    return { ...current, ...identity, resumeMode, sampledAt: Date.now(), connections: connectionSummary(snapshot, items && connectionIdentity.known(items)) };
  }

  doctor = connectionDoctor || createConnectionDoctor({core,proxy,profiles,codexRepair,health:healthProbe || (core.call?createHealthProbe({core}):{verify:async()=>'unknown'}),directory:managed?core.directory:null,system:doctorSystem,requestProbe:codexRequest,restartClient,codexTargetAdapter,autoRepairOptions,
    configuration:async()=>({runtime:core.status?.().state,config:await core.call('GET','/configs').then(publicConfig,()=>null),proxy:await proxy?.getStatus(),profile:(await profiles?.list())?.activeId,groups:await core.call('GET','/proxies').then(r=>routingGroups(r,'rule').map(g=>({name:g.name,current:g.current})),()=>[]),automation:await automationStatus().then(a=>({scope:a.scope,group:a.group,backups:a.backups}))}),
    serialize:fn=>{automation?.invalidate();return mutation(fn,false);}
  });
  if(managed)void readFile(path.join(core.directory,'restart-receipt.json'),'utf8').then(async raw=>{const receipt=JSON.parse(raw);if(receipt.source==='independent-helper'&&receipt.needsRecheck&&Date.now()-Date.parse(receipt.at)<120000){if(restoring)await restoring;await doctor.start();await rm(path.join(core.directory,'restart-receipt.json'),{force:true});}}).catch(()=>{});
  const reads = {
    doctor:()=>doctor.get(),
    'update-check': async () => daily ? daily.checkNow() : updates.check(),
    'update-settings': async () => daily ? daily.get() : {enabled:false,lastCheckedAt:null,nextCheckAt:null,lastResult:null,checking:false,error:'自动检查不可用。'},
    theme: async () => theme ? theme.get() : {theme:'cat'},
    state,
    logs: async () => ({entries:logEntries}),
    automation: async () => automationStatus(),
    autostart: async () => startup ? startup.getStatus() : { enabled:false, conflict:false },
    tray: async () => tray ? tray.get() : {closeToTray:false},
    runtime: async () => managed ? { ...core.status(), restoring: !!restoring, recoveryWarning, appVersion } : { state: 'running', message: '', version: null, appVersion },
    profiles: async () => profiles ? profiles.list() : { activeId: null, profiles: [] },
    'system-proxy': async () => proxy ? proxy.getStatus() : { enabled: await readSystemProxy(), managed: false },
    async connections() {
      const [snapshot, config] = await Promise.all([
        core.call('GET', '/connections'), core.call('GET', '/configs').catch(() => null)
      ]);
      const connections = connectionItems(snapshot);
      if (!connections) throw new AppError('连接数据暂不可用。', 503);
      const identified = await connectionIdentity.identify(connections, {
        proxyPorts: [config?.['mixed-port'], config?.port, config?.['socks-port']],
        recheck: async () => connectionItems(await core.call('GET', '/connections'))
      });
      return { downloaded: count(snapshot.downloadTotal), uploaded: count(snapshot.uploadTotal), connections: identified.map(item => {
        const meta = item?.metadata ?? {};
        const host = meta.host || meta.destinationIP || '未知地址';
        const port = meta.destinationPort ? ':' + meta.destinationPort : '';
        return { id: typeof item.id === 'string' ? item.id : '', app: item.app, processSource: item.processSource,
          address: String(host).slice(0,256) + port, route: Array.isArray(item.chains) ? item.chains.filter(x => typeof x === 'string').join(' → ').slice(0,400) : '未知',
          startedAt: typeof item.start === 'string' ? item.start : null, upload: count(item.upload), download: count(item.download) };
      }).filter(item => item.id) };
    },
    async groups() {
      const [response, config] = await Promise.all([core.call('GET', '/proxies'), core.call('GET', '/configs')]);
      return { groups: routingGroups(response, config?.mode) };
    },
    async settings() {
      const [prefs, windowsProxy, providers] = await Promise.all([
        core.preferences(), readSystemProxy(), httpProviders(core).catch(() => null)
      ]);
      return { ...prefs, windowsProxy, providers };
    }
  };
  const writes = {
    'doctor/start':input=>doctor.start(input),
    'doctor/auto-start':input=>doctor.autoStart(input),
    'doctor/cancel':()=>doctor.cancel(),
    'doctor/invalidate':async()=>{doctor.invalidate('网络环境已变化，请重新检查。');return doctor.get();},
    'doctor/preview':input=>doctor.preview(input),
    'doctor/apply':input=>doctor.apply(input),
    'doctor/request':()=>doctor.request(),
    'doctor/confirm':()=>doctor.confirm(),
    'update-settings': input => mutation(async()=>{
      if(!daily || typeof input.enabled!=='boolean') throw new AppError('自动检查设置不可用。',400);
      return daily.set({enabled:input.enabled});
    },false),
    theme: input => mutation(async () => {
      if (!theme || !['cat','fish','whale'].includes(input?.theme)) throw new AppError('主题设置不可用。', 400);
      return theme.set({theme:input.theme});
    }, false),
    'codex-repair/preview': () => mutation(() => codexRepair.preview()),
    'codex-repair/apply': input => mutation(() => codexRepair.apply(input.token)),
    tray: input => mutation(async () => {
      if (!tray || typeof input.closeToTray !== 'boolean') throw new AppError('托盘设置不可用。', 400);
      if ((await tray.get()).available !== true) throw new AppError('系统托盘尚不可用，关闭窗口将退出。', 409);
      return tray.set({closeToTray:input.closeToTray});
    }),
    port: input => mutation(async () => {
      if (!managed || typeof core.setPort !== 'function') throw new AppError('修改端口暂不可用。', 503);
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new AppError('请输入 1 到 65535 的端口。', 400);
      if (restoring) await restoring;
      const proxyStatus = proxy ? await proxy.getStatus() : null;
      if (!proxyStatus) throw new AppError('无法确认系统代理状态，请稍后重试。', 503);
      if (proxyStatus.enabled) throw new AppError('请先关闭系统代理，再修改端口。', 409);
      return tracked(() => core.setPort(input.port), '混合端口已更改', '混合端口更改失败');
    }),
    autostart: input => mutation(async () => {
      if (!startup || typeof input.enabled !== 'boolean') throw new AppError('开机启动设置不可用。', 400);
      try { return input.enabled ? await startup.enable() : await startup.disable(); }
      catch { throw new AppError('无法更改开机启动，请检查同名启动项或 Windows 权限。', 409); }
    }),
    automation: input => mutation(async () => {
      if (!automation || !profiles) throw new AppError('自动处理不可用。', 503);
      const scope = (await profiles.list()).activeId;
      if (!scope) throw new AppError('请先启用配置。', 409);
      if (typeof input.group !== 'string' || !input.group || input.group.length > 200) throw new AppError('请选择策略组。', 400);
      const response = await core.call('GET', '/proxies');
      const group = routingGroups(response, 'rule').find(item => item.name === input.group);
      if (!group) throw new AppError('策略组不存在或不能手动选择。', 409);
      const accepted = { scope, group:group.name };
      if ('backups' in input) {
        if (!Array.isArray(input.backups) || input.backups.length > 64 || input.backups.some(name => typeof name !== 'string' || !group.members.some(item => item.name === name))) throw new AppError('备用节点必须属于当前策略组。', 400);
        accepted.backups = input.backups;
      }
      if ('autoRepair' in input) {
        if (typeof input.autoRepair !== 'boolean') throw new AppError('自动修复开关无效。', 400);
        accepted.autoRepair = input.autoRepair;
      }
      if ('autoSwitch' in input) {
        if (typeof input.autoSwitch !== 'boolean') throw new AppError('自动切换开关无效。', 400);
        const chosen = accepted.backups || (await automationStatus(group.name)).backups;
        if (input.autoSwitch && !chosen.some(name => name !== group.current)) throw new AppError('请先选择不同于当前线路的备用节点。', 409);
        accepted.autoSwitch = input.autoSwitch;
      }
      await rememberGroup(scope, group.name);
      try { await automation.configure(accepted); }
      catch (error) { throw new AppError(error.message || '无法保存自动处理设置。', 400); }
      return automationStatus(monitorGroup);
    }),
    'profiles/url': input => mutation(() => { if (!profiles) throw new AppError('配置管理不可用。', 503); return tracked(() => profiles.addUrl(input), '订阅已导入', '订阅导入失败'); }),
    'profiles/local': input => mutation(() => { if (!profiles) throw new AppError('配置管理不可用。', 503); return tracked(() => profiles.addLocal(input), '本地配置已导入', '本地配置导入失败'); }),
    'profiles/update': input => mutation(() => { if (!profiles) throw new AppError('配置管理不可用。', 503); return tracked(() => profiles.update(input.id), '订阅更新完成', '订阅更新失败，旧配置文件已保留'); }),
    'profiles/edit': input => mutation(() => { if (!profiles) throw new AppError('配置管理不可用。', 503); return profiles.edit(input.id, input); }),
    'profiles/activate': input => mutation(() => { if (!profiles) throw new AppError('配置管理不可用。', 503); return tracked(() => profiles.activate(input.id), '配置已启用', '配置启用失败'); }),
    'profiles/delete': input => mutation(() => { if (!profiles) throw new AppError('配置管理不可用。', 503); return profiles.remove(input.id); }),
    'core-start': () => mutation(async () => { if (!managed) throw new AppError('内核控制不可用。', 503); if (restoring) await restoring; return tracked(() => core.start(), '内核已启动', '内核启动失败'); }),
    'core-stop': () => mutation(async () => {
      if (!managed) throw new AppError('内核控制不可用。', 503);
      if (proxy) await proxy.restoreOnExit();
      await core.stop();
      logEvent('info', '内核已停止');
      return core.status();
    }),
    'system-proxy': input => mutation(async () => {
      if (!proxy || typeof input.enabled !== 'boolean') throw new AppError('系统代理设置不可用。', 400);
      if (!input.enabled) { await proxy.disable(); return proxy.getStatus(); }
      const config = publicConfig(await core.call('GET', '/configs'));
      if (!config.port) throw new AppError('代理端口尚未就绪。', 409);
      return proxy.enable(config.port);
    }),
    disconnect: input => mutation(async () => {
      if (typeof input.id !== 'string' || !input.id || input.id.length > 200) throw new AppError('请选择有效连接。', 400);
      const snapshot = await core.call('GET', '/connections');
      if (!Array.isArray(snapshot?.connections) || !snapshot.connections.some(item => item?.id === input.id)) throw new AppError('该连接已结束。', 409);
      await core.call('DELETE', '/connections/' + encodeURIComponent(input.id));
      return { ok: true };
    }),
    mode: input => mutation(async () => {
      const previous = publicConfig(await core.call('GET', '/configs')).mode;
      const requested = input.mode === 'resume' ? (previous && previous !== 'direct' ? previous : resumeMode) : input.mode;
      if (!modes.has(requested)) throw new AppError('请选择规则、全局或直连模式。', 400);
      if (previous && previous !== 'direct') resumeMode = previous;
      if (requested !== previous) await core.call('PATCH', '/configs', { mode: requested });
      const current = publicConfig(await core.call('GET', '/configs')).mode;
      if (current !== requested) throw new AppError('内核返回的模式与选择不同，请刷新后核对。', 409);
      if (current !== 'direct') resumeMode = current;
      return { mode: current };
    }),
    select: input => mutation(async () => {
      const group = await selectableMember(core, input.group, input.member);
      if (managed && profiles) { const scope = (await profiles.list()).activeId; if (scope) await rememberGroup(scope, input.group); }
      await core.call('PUT', '/proxies/' + group, { name: input.member });
      const updated = await core.call('GET', '/proxies/' + group);
      if (updated?.now !== input.member) throw new AppError('内核未确认线路切换，请刷新后核对。', 409);
      logEvent('info', '已手动切换线路');
      return { current: updated.now };
    }),
    async delay(input) {
      await selectableMember(core, input.group, input.member);
      const query = new URLSearchParams({ url: probeUrl, timeout: '4500', expected: '204' });
      const result = await core.call('GET', '/proxies/' + encodeURIComponent(input.member) + '/delay?' + query, null, 6500);
      const delay = count(result?.delay);
      if (!delay) throw new AppError('这条线路没有返回有效的测速结果。', 502);
      return { delay };
    },
    provider: input => mutation(async () => {
      if (typeof input.name !== 'string' || !(await httpProviders(core)).includes(input.name)) {
        throw new AppError('没有找到可由内核更新的 HTTP 代理集。', 409);
      }
      await core.call('PUT', '/providers/proxies/' + encodeURIComponent(input.name), null, 15000);
      return { updated: true };
    }),
    async diagnose() {
      pendingCheck ??= diagnostic(core).finally(() => { pendingCheck = null; });
      return pendingCheck;
    }
  };

  const server = http.createServer({ headersTimeout: 5000, requestTimeout: 15000, keepAliveTimeout: 2500 }, async (req, res) => {
    try {
      const host = origin.slice('http://'.length);
      if (req.headers.host !== host || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new AppError('此界面仅限本机窗口访问。', 403);
      }
      const route = new URL(req.url, origin);
      if (route.origin !== origin || !route.pathname.startsWith(prefix)) throw new AppError('页面不存在。', 404);
      const name = route.pathname.slice(prefix.length);
      if (req.method === 'GET' && Object.hasOwn(contents, name)) {
        respond(res, 200, contents[name].type, contents[name].data);
      } else if (req.method === 'GET' && name.startsWith('api/') && Object.hasOwn(reads, name.slice(4))) {
        json(res, 200, await reads[name.slice(4)]());
      } else if (req.method === 'POST' && name.startsWith('api/') && Object.hasOwn(writes, name.slice(4))) {
        if (req.headers.origin !== origin) throw new AppError('请从 SusuClash 窗口发起操作。', 403);
        json(res, 200, await writes[name.slice(4)](await readJson(req, name === 'api/profiles/local' ? 11 * 1024 * 1024 : 4096)));
      } else {
        throw new AppError('页面不存在。', 404);
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        json(res, error instanceof AppError || error instanceof ProfileError ? error.status : 500, {
          error: error instanceof AppError || error instanceof ProfileError ? error.message : '操作失败，请检查本地状态后重试。'
        });
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      origin = 'http://127.0.0.1:' + server.address().port;
      server.removeListener('error', reject);
      resolve();
    });
  });
  daily?.start();
  return {
    url: origin + prefix,
    origin,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      daily?.stop();
      closePromise = (async () => {
        if (automation?.stop) await automation.stop();
        await doctor?.close();
        await writeTail;
        if (restoring) await restoring;
        if (proxy) await proxy.restoreOnExit();
        if (managed) await core.stop();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      })().catch(error => { closing = false; closePromise = null; throw error; });
      return closePromise;
    }
  };
}
