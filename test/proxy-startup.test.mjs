import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { createSystemProxy, ProxyError } from '../src/system-proxy.mjs';
import { createProxyPreferences } from '../src/proxy-preferences.mjs';

const disabled = () => ({ enable: { present: true, value: 0 }, server: { present: true, value: 'previous-disabled-value' } });

async function fixture(t, options = {}) {
  const root = path.join(process.cwd(), 'outputs', 'working');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'proxy-startup-test-'));
  const file = path.join(directory, 'proxy-preferences.json');
  if (options.intent !== undefined) await writeFile(file, JSON.stringify({ version: 1, enabled: options.intent }));
  if (options.corrupt) await writeFile(file, '{broken-private-data');
  const listener = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  let actual = options.external ? { enable: { present: true, value: 1 }, server: { present: true, value: '127.0.0.1:7897' } } : disabled();
  const events = [];
  let running = true, pid = 10001, currentPort = port, app;
  const core = {
    directory, applyConfig: async () => {}, validateConfig: async () => {},
    status: () => ({ state: running ? 'running' : 'error' }),
    processId: () => running ? pid : null,
    stop: async () => { events.push('core-stop'); running = false; },
    call: async (_, route) => {
      events.push(route);
      if (route === '/version') return { version: options.invalidVersion ? '' : 'fixture-version' };
      return { 'mixed-port': currentPort, mode: 'rule' };
    }
  };
  let proxy;
  function makeProxy() {
    proxy = createSystemProxy({ directory, adapter: {
      read: async () => structuredClone(actual),
      write: async (value, { expected }) => {
        assert.deepEqual(actual, expected);
        if (options.denyEnable && value.enable.value === 1) throw new ProxyError('write');
        actual = structuredClone(value);
        events.push(value.enable.value === 1 ? 'proxy-enable' : 'proxy-restore');
        if (value.enable.value === 1 && options.exitDuringEnable) running = false;
        if (value.enable.value === 1 && options.replaceDuringEnable) pid++;
        if (value.enable.value === 1 && options.portDuringEnable) currentPort++;
      }
    } });
    return proxy;
  }
  async function start(extra = {}) {
    app = await startServer({ core, systemProxy: makeProxy(), dailyUpdate: false,
      profileStore: { restoreActive: async () => { running = true; events.push('profile-restored'); }, list: async () => ({ activeId: 'fixture', profiles: [] }) },
      monitor: { stop() {}, invalidate() {}, status: () => ({}) },
      connectionDoctor: { isRepairing: () => false, invalidate() {}, close: async () => {} },
      ...extra
    });
    for (let i = 0; i < 200; i++) {
      if (!(await get('runtime')).restoring) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('startup recovery did not settle');
  }
  const get = async route => (await fetch(app.url + 'api/' + route)).json();
  const post = (route, body) => fetch(app.url + 'api/' + route, {
    method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  async function close() { const old = app; app = null; await old?.close(); }
  t.after(async () => { try { await close(); } finally { await new Promise(resolve => listener.close(resolve)); await rm(directory, { recursive: true, force: true }); } });
  return { directory, file, events, core, start, close, get, post, status: () => proxy.getStatus(), actual: () => structuredClone(actual) };
}

test('first launch has no implicit system-proxy intent even when auto repair is enabled', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'automation.json'), JSON.stringify({ autoRepair: true, autoSwitch: true }));
  await f.start();
  assert.deepEqual(f.events, ['profile-restored']);
  assert.equal((await f.status()).enabled, false);
  await assert.rejects(readFile(f.file), error => error.code === 'ENOENT');
});

test('explicit enable survives normal exit and restores only after the same verified core is ready', async t => {
  const f = await fixture(t);
  await f.start();
  assert.equal((await f.post('system-proxy', { enabled: true })).status, 200);
  assert.equal((await f.status()).managed, true);
  await f.close();
  assert.deepEqual(f.actual(), disabled());
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).enabled, true);
  f.events.length = 0;
  await f.start();
  assert.equal((await f.status()).managed, true);
  assert.equal((await f.get('runtime')).recoveryWarning, null);
  assert(f.events.indexOf('profile-restored') < f.events.indexOf('/version'));
  assert(f.events.indexOf('/configs') < f.events.indexOf('proxy-enable'));
  assert((await f.get('logs')).entries.some(x => x.message === '已按上次明确选择恢复系统代理并回读确认'));
});

for (const route of ['system-proxy', 'core-stop']) test(`explicit ${route} off clears the next startup intent`, async t => {
  const f = await fixture(t, { intent: true });
  await f.start();
  assert.equal((await f.status()).managed, true);
  assert.equal((await f.post(route, route === 'system-proxy' ? { enabled: false } : {})).status, 200);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).enabled, false);
  await f.close(); f.events.length = 0;
  await f.start();
  assert(!f.events.includes('proxy-enable'));
  assert.equal((await f.status()).enabled, false);
});

test('remembered intent preserves an already enabled external system proxy', async t => {
  const f = await fixture(t, { intent: true, external: true });
  const original = f.actual();
  await f.start();
  assert.deepEqual(f.actual(), original);
  assert(!f.events.includes('proxy-enable'));
  assert.match((await f.get('runtime')).recoveryWarning, /保留现状/);
});

for (const kind of ['corrupt', 'invalidVersion']) test(`${kind} cannot authorize an automatic system-proxy write`, async t => {
  const f = await fixture(t, { intent: true, [kind]: true });
  await f.start();
  assert(!f.events.includes('proxy-enable'));
  assert.equal((await f.status()).enabled, false);
  const warning = (await f.get('runtime')).recoveryWarning;
  assert.match(warning, kind === 'corrupt' ? /无法读取系统代理启动偏好/ : /未能确认/);
  assert(!warning.includes('private-data'));
});

for (const kind of ['exitDuringEnable', 'replaceDuringEnable', 'portDuringEnable']) test(`${kind} withdraws only the startup-owned proxy`, async t => {
  const f = await fixture(t, { intent: true, [kind]: true });
  await f.start();
  assert(f.events.includes('proxy-enable'));
  assert(f.events.includes('proxy-restore'));
  assert.deepEqual(f.actual(), disabled());
  assert.match((await f.get('runtime')).recoveryWarning, /未能确认/);
  assert(!(await f.get('logs')).entries.some(x => x.message === '已按上次明确选择恢复系统代理并回读确认'));
});

test('preference save denial blocks manual proxy writes and core stop before changing Windows', async t => {
  const f = await fixture(t);
  const prefs = createProxyPreferences({ directory: f.directory, writeMetadata: async () => { throw Error('PRIVATE_FILE'); } });
  await f.start({ proxyPreferences: prefs });
  for (const [route, input] of [['system-proxy', { enabled: true }], ['core-stop', {}]]) {
    const response = await f.post(route, input);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /尚未执行/);
    assert(!body.error.includes('PRIVATE_FILE'));
  }
  assert(!f.events.includes('proxy-enable'));
  assert(!f.events.includes('core-stop'));
  assert.deepEqual(f.actual(), disabled());
});

test('a rejected OS enable restores the previous false intent without leaking details', async t => {
  const f = await fixture(t, { intent: false, denyEnable: true });
  await f.start();
  assert.equal((await f.post('system-proxy', { enabled: true })).status, 503);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).enabled, false);
  assert.deepEqual(f.actual(), disabled());
});
