import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { startServer } from '../src/server.mjs';

test('real Netfix HTTP service applies only its confirmed opaque plan and shares the server writer lease', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'susu-netfix-api-'));
  const directory = path.join(root, 'codex'), stateDirectory = path.join(root, 'state');
  await mkdir(directory); await mkdir(stateDirectory);
  const before = Buffer.from('\uFEFFHTTP_PROXY="http://127.0.0.1:43127"\r\nHTTPS_PROXY="http://localhost:43127"\r\nKEEP=private-fixture-value\r\n');
  await writeFile(path.join(directory, '.env'), before);
  const protectedFiles = { 'config.toml': 'model="unchanged-fixture"\n', 'auth.json': '{"fixture":"not-read-or-rewritten"}' };
  for (const [name, text] of Object.entries(protectedFiles)) await writeFile(path.join(directory, name), text);
  let release, app, binaryCalls = 0, modelRequests = 0, hasWritten = false;
  const diagnostics = [], gate = new Promise(resolve => { release = resolve; });
  const host = { available: true, listeners: [{ port: 7897, address: '127.0.0.1', pid: 42, name: 'mihomo.exe' }], process: { available: true, running: true, port: 43127 }, systemProxy: { enabled: true, host: '127.0.0.1', port: 7897 }, vergePorts: [7897] };
  const system = {
    collect: async () => structuredClone(host), logs: async () => ({ available: true, complete: true, cHits24h: 0, bHits15m: 0 }),
    auth: async () => ({ available: true, present: true, expired: false }),
    probe: async ({ port, target }) => { assert(/^https:\/\/(?:api\.openai\.com\/v1\/models|chatgpt\.com\/backend-api\/)$/u.test(target)); return { ok: port === 7897, code: port === 7897 ? 401 : null, error: port === 7897 ? null : 'Timeout', ms: 1 }; },
    copyPermissions: async () => {}, permissionFingerprint: async () => 'injected-acl', fileAttributes: async () => null, setFileAttributes: async () => {},
    hook: async ({ phase }) => { if (phase === 'afterReplace') { hasWritten = true; await gate; } },
    onError: event => { diagnostics.push({ scope: event.scope, code: event.code, operation: event.operation }); }
  };
  const core = { directory: stateDirectory, applyConfig: async () => {}, status: () => ({ state: 'running' }), identity: async () => ({}),
    preferences: async () => ({ expectedPort: 7897 }), processId: () => 42, stop: async () => {},
    call: async (_method, route) => route === '/configs' ? { 'mixed-port': 7897, mode: 'rule' } : route === '/proxies' ? { proxies: {} } : {} };
  const monitor = { invalidate() {}, status: () => ({ phase: 'stopped', preferences: {} }), stop: async () => {} };
  app = await startServer({ core, monitor, profileStore: { list: async () => ({ activeId: 'fixture', profiles: [] }), restoreActive: async () => {} },
    systemProxy: { getStatus: async () => ({ enabled: true, managed: true, port: 7897 }), restoreOnExit: async () => {} }, dailyUpdate: false,
    netfixOptions: { directory, system }, codexTargetAdapter: { recover: async () => ({ ok: true }), discover: async () => { binaryCalls++; }, probe: async () => { modelRequests++; } } });
  t.after(async () => {
    release(); await app.close();
    assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase()); assert(path.basename(root).startsWith('susu-netfix-api-'));
    await rm(root, { recursive: true, force: true });
  });
  const post = (name, body = {}) => fetch(app.url + 'api/' + name, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = async () => { const r = await fetch(app.url + 'api/netfix'); assert.equal(r.status, 200); return r.json(); };
  async function settled() { for (let i = 0; i < 300; i++) { const s = await get(); if (!s.busy) return s; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Netfix HTTP task did not finish'); }
  assert.equal((await get()).stage, 'idle'); assert.equal((await post('netfix/diagnose')).status, 200);
  let result = await settled(); assert.equal(result.verdict.fixMode, 'fix-port');
  assert(!JSON.stringify(result).includes('private-fixture-value')); assert(!JSON.stringify(result).includes('not-read-or-rewritten'));
  const previewResponse = await post('netfix/preview', { action: 'fix-port', targetPort: 65000, expectHash: 'forged' });
  assert.equal(previewResponse.status, 200); const preview = await previewResponse.json();
  assert.equal(preview.rows.length, 6); assert.match(JSON.stringify(preview.rows), /7897/); assert(!JSON.stringify(preview.rows).includes('65000'));
  assert.equal((await post('netfix/apply', { token: preview.token, confirmed: true })).status, 200);
  for (let i = 0; i < 300 && !hasWritten; i++) { const pending = await get(); assert(pending.busy, 'Task stopped before writing: ' + JSON.stringify({ diagnostics, snapshot: pending })); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert(hasWritten, 'Test fixture must reach the held write boundary');
  assert.match((await readFile(path.join(directory, '.env'))).toString('utf8'), /:7897/);
  assert.equal((await post('core-start')).status, 409); assert.equal((await post('doctor/start', { scope: 'proxy' })).status, 409);
  assert.equal((await post('doctor/auto-start', { consent: true })).status, 410);
  assert.equal((await post('codex-repair/apply', { token: 'old-token' })).status, 410);
  release(); result = await settled();
  assert.equal(result.stage, 'awaiting_restart'); assert.equal(result.waitingRestart, true);
  assert(!['probe_passed', 'app_verified'].includes(result.verification)); assert(result.backups.some(x => x.restorable));
  assert.deepEqual(await readFile(path.join(directory, '.env')), Buffer.from(before.toString('utf8').replaceAll(':43127', ':7897')));
  assert.equal((await post('netfix/apply', { token: preview.token, confirmed: true })).status, 409);
  for (const [name, text] of Object.entries(protectedFiles)) assert.equal(await readFile(path.join(directory, name), 'utf8'), text);
  assert.equal(binaryCalls, 0); assert.equal(modelRequests, 0);
});
