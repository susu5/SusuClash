import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../src/server.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, { delayedManualStop = false, delayedCoreStop = false, initialState = 'error' } = {}) {
  const root = path.join(process.cwd(), 'outputs', 'working');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'core-repair-race-test-'));
  await writeFile(path.join(directory, 'automation.json'), JSON.stringify({ autoRepair: true }));
  const entered = deferred(), gate = deferred(), manuallyInvalidated = deferred();
  let state = initialState, scope = 'original-profile', starts = 0, stops = 0, app;
  const core = {
    directory, applyConfig: async () => {}, validateConfig: async () => {}, preferences: async () => ({ expectedPort: null }),
    status: () => ({ state }), call: async () => { throw Error('not running'); },
    stop: async () => {
      stops++;
      if (delayedCoreStop && stops === 1) { entered.resolve(); await gate.promise; }
      state = 'stopped';
    },
    start: async () => { starts++; state = 'running'; }
  };
  const proxy = { restoreOnExit: async () => {}, getStatus: async () => ({ enabled: false, managed: false }) };
  const prefs = { get: async () => ({ enabled: false, valid: true }), change: async (_, action) => {
    if (delayedManualStop) { entered.resolve(); await gate.promise; }
    return action();
  } };
  t.after(async () => { gate.resolve(); try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  app = await startServer({ core, systemProxy: proxy, proxyPreferences: prefs, dailyUpdate: false, automationIntervalMs: 5,
    profileStore: { restoreActive: async () => {}, list: async () => ({ activeId: scope, profiles: [] }) },
    codexHealth: { inspect: async () => ({ result: 'unknown' }) },
    connectionDoctor: { isRepairing: () => false, invalidate: reason => { if (reason === undefined) manuallyInvalidated.resolve(); }, close: async () => {} }
  });
  const get = async route => (await fetch(app.url + 'api/' + route)).json();
  async function waitFor(predicate) {
    for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('race fixture did not reach the expected state');
  }
  return { entered, gate, manuallyInvalidated, get, waitFor,
    setState: value => { state = value; }, setScope: value => { scope = value; }, counts: () => ({ starts, stops }),
    stop: () => fetch(app.url + 'api/core-stop', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: '{}' })
  };
}

test('a background repair queued during manual stop cannot restart the deliberately stopped core', async t => {
  const f = await fixture(t, { initialState: 'stopped', delayedManualStop: true });
  const stopping = f.stop();
  await f.entered.promise;
  f.setState('error');
  await f.waitFor(async () => (await f.get('automation')).phase === 'repairing');
  f.gate.resolve();
  assert.equal((await stopping).status, 200);
  await f.waitFor(async () => (await f.get('automation')).phase !== 'repairing');
  assert.deepEqual(f.counts(), { starts: 0, stops: 1 });
});

test('a profile change while the old core is stopping prevents restarting for the old observation', async t => {
  const f = await fixture(t, { delayedCoreStop: true });
  await f.entered.promise;
  f.setScope('replacement-profile');
  f.gate.resolve();
  await f.waitFor(async () => (await f.get('automation')).phase !== 'repairing');
  assert.deepEqual(f.counts(), { starts: 0, stops: 1 });
});

test('a manual stop arriving during background core shutdown cancels its pending restart', async t => {
  const f = await fixture(t, { delayedCoreStop: true });
  await f.entered.promise;
  const stopping = f.stop();
  await f.manuallyInvalidated.promise;
  f.gate.resolve();
  assert.equal((await stopping).status, 200);
  assert.deepEqual(f.counts(), { starts: 0, stops: 2 });
});
