import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { createSystemProxy, ProxyError } from '../src/system-proxy.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { proxy, restoreActive = async () => {}, coreStop = async () => {} }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'susu-proxy-api-'));
  let app;
  t.after(async () => {
    try { await app?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const core = {
    directory, applyConfig: async () => {}, validateConfig: async () => {},
    status: () => ({ state: 'running' }), stop: coreStop,
    call: async () => ({ 'mixed-port': 18990, mode: 'rule' })
  };
  app = await startServer({
    core, systemProxy: proxy, dailyUpdate: false,
    profileStore: { restoreActive, list: async () => ({ activeId: null, profiles: [] }) },
    monitor: { stop() {}, invalidate() {}, status: () => ({}) },
    connectionDoctor: { isRepairing: () => false, invalidate() {}, close: async () => {} }
  });
  return {
    app,
    post: (route, body) => fetch(app.url + 'api/' + route, {
      method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    get: async route => (await fetch(app.url + 'api/' + route)).json()
  };
}

for (const enabled of [true, false]) test(`system proxy ${enabled ? 'enable' : 'disable'} waits for startup recovery`, async t => {
  const entered = deferred(), gate = deferred();
  const events = [];
  let recovering = true, first = true;
  const proxy = {
    restoreOnExit: async () => {
      if (!first) return;
      first = false; events.push('recover-start'); entered.resolve();
      await gate.promise; recovering = false; events.push('recover-end');
    },
    enable: async () => { assert.equal(recovering, false); events.push('enable'); return { enabled: true, managed: true }; },
    disable: async () => { assert.equal(recovering, false); events.push('disable'); },
    getStatus: async () => ({ enabled, managed: enabled })
  };
  t.after(() => gate.resolve());
  const f = await fixture(t, { proxy, restoreActive: async () => events.push('profile-restored') });
  await entered.promise;
  const request = f.post('system-proxy', { enabled });
  // A read on the same server provides a barrier while recovery is held.
  assert.equal((await f.get('runtime')).restoring, true);
  assert.deepEqual(events, ['recover-start']);
  gate.resolve();
  const response = await request;
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.deepEqual(events, ['recover-start', 'recover-end', 'profile-restored', enabled ? 'enable' : 'disable']);
});

test('core stop waits for startup recovery and restored profile before stopping', async t => {
  const entered = deferred(), gate = deferred(), events = [];
  let first = true;
  const proxy = {
    restoreOnExit: async () => {
      if (first) { first = false; entered.resolve(); await gate.promise; events.push('recovered'); }
      else events.push('restore-before-stop');
    },
    getStatus: async () => ({ enabled: false, managed: false })
  };
  t.after(() => gate.resolve());
  const f = await fixture(t, { proxy, restoreActive: async () => events.push('profile-restored'), coreStop: async () => events.push('core-stopped') });
  await entered.promise;
  const request = f.post('core-stop', {});
  assert.equal((await f.get('runtime')).restoring, true);
  assert.deepEqual(events, []);
  gate.resolve();
  assert.equal((await request).status, 200);
  assert.deepEqual(events, ['recovered', 'profile-restored', 'restore-before-stop', 'core-stopped']);
});

test('external proxy conflict is returned by HTTP without exposing raw failures or overwriting settings', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'susu-proxy-api-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let writes = 0;
  const proxy = createSystemProxy({ directory, adapter: {
    read: async () => ({ enable: { present: true, value: 1 }, server: { present: true, value: '127.0.0.1:7897' } }),
    write: async () => { writes++; }
  } });
  const f = await fixture(t, { proxy });
  const response = await f.post('system-proxy', { enabled: true });
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.match(result.error, /其他|外部/);
  assert.equal(writes, 0);
  assert((await f.get('logs')).entries.some(entry => entry.message === '系统代理更改失败'));
});

test('confirmed proxy recovery clears only the previous proxy recovery warning', async t => {
  let first = true;
  const proxy = {
    restoreOnExit: async () => { if (first) { first = false; throw new ProxyError('read'); } },
    enable: async () => ({ enabled: true, managed: true, recoveryAvailable: true }),
    getStatus: async () => ({ enabled: true, managed: true, recoveryAvailable: true })
  };
  const f = await fixture(t, { proxy });
  assert.match((await f.get('runtime')).recoveryWarning, /系统代理恢复失败/);
  assert.equal((await f.post('system-proxy', { enabled: true })).status, 200);
  assert.equal((await f.get('runtime')).recoveryWarning, null);
});

test('successful proxy enable preserves an unrelated configuration recovery warning', async t => {
  const proxy = {
    restoreOnExit: async () => {},
    enable: async () => ({ enabled: true, managed: true }),
    getStatus: async () => ({ enabled: true, managed: true })
  };
  const f = await fixture(t, { proxy, restoreActive: async () => { throw Error('PRIVATE_CONFIG'); } });
  assert.equal((await f.post('system-proxy', { enabled: true })).status, 200);
  assert.match((await f.get('runtime')).recoveryWarning, /无法恢复上次配置/);
});

test('unexpected system proxy failures remain private', async t => {
  const proxy = {
    restoreOnExit: async () => {},
    enable: async () => { throw Error('PRIVATE_PATH_OR_SUBSCRIPTION'); },
    getStatus: async () => ({ enabled: false, managed: false })
  };
  const f = await fixture(t, { proxy });
  const response = await f.post('system-proxy', { enabled: true });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: '操作失败，请检查本地状态后重试。' });
  assert(!JSON.stringify(await f.get('logs')).includes('PRIVATE_PATH_OR_SUBSCRIPTION'));
});
