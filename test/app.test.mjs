import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMihomo } from '../src/mihomo.mjs';
import { diagnose } from '../src/diagnostics.mjs';
import { startServer } from '../src/server.mjs';

test('loopback app validates writes and forwards only approved Mihomo actions', async t => {
  const auth = 'fixture-secret';
  const groupName = '线路组 / 示例';
  let mode = 'global';
  let current = '节点 A';
  let writes = 0;
  const fixture = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + auth) return res.writeHead(401).end();
    const url = new URL(req.url, 'http://localhost');
    const route = decodeURIComponent(url.pathname);
    const json = value => res.end(JSON.stringify(value));
    const data = () => ({ name: groupName, type: 'Selector', all: ['节点 A', '节点 B'], now: current });
    if (req.method === 'GET') {
      if (route === '/version') return json({ version: 'fixture' });
      if (route === '/configs') return json({ mode, 'mixed-port': 7900, tun: { enable: true }, secret: auth });
      if (route === '/proxies') return json({ proxies: { [groupName]: data(), '节点 A': { history: [{ delay: 38 }] } } });
      if (route === '/proxies/' + groupName) return json(data());
      if (route === '/proxies/节点 B/delay') return json({ delay: 61 });
      if (route === '/connections') return json({ downloadTotal: 105, uploadTotal: 25, connections: [
        { download: 10, upload: 5, metadata: { processPath: 'C:\\Private\\chrome.exe', host: 'private.example' } }
      ] });
      if (route === '/providers/proxies') return json({ providers: { demo: { vehicleType: 'HTTP' }, internal: { vehicleType: 'Compatible' } } });
    }
    const buffers = [];
    for await (const item of req) buffers.push(item);
    const body = Buffer.concat(buffers).toString('utf8');
    if (req.method === 'PATCH' && route === '/configs') {
      mode = JSON.parse(body).mode;
    } else if (req.method === 'PUT' && route === '/proxies/' + groupName) {
      current = JSON.parse(body).name;
    } else if (req.method !== 'PUT' || route !== '/providers/proxies/demo') {
      return res.writeHead(404).end();
    }
    writes++;
    res.writeHead(204).end();
  });
  await new Promise((resolve, reject) => fixture.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clash-glass-test-'));
  const yaml = path.join(dir, 'clash-verge.yaml');
  t.after(async () => { await unlink(yaml); await rmdir(dir); });
  await writeFile(yaml, 'external-controller: 127.0.0.1:' + fixture.address().port + '\nsecret: ' + auth + '\n');
  const app = await startServer({ core: createMihomo(dir), readSystemProxy: async () => true });
  t.after(app.close);
  const get = route => fetch(app.url + 'api/' + route);
  const post = (route, value, origin = app.origin) => fetch(app.url + 'api/' + route, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  const page = await fetch(app.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(app.origin + '/api/state')).status, 404);
  const status = await (await get('state')).json();
  assert.equal(status.port, 7900);
  assert.equal(status.connections.apps[0].name, 'chrome.exe');
  assert.doesNotMatch(JSON.stringify(status), /private\.example|Private|fixture-secret/);
  assert.equal((await post('mode', { mode: 'direct' }, 'https://example.com')).status, 403);
  assert.equal((await post('mode', { mode: 'wrong' })).status, 400);
  assert.equal((await post('select', { group: groupName, member: '失效线路' })).status, 409);
  assert.equal(writes, 0);
  assert.equal((await (await post('mode', { mode: 'direct' })).json()).mode, 'direct');
  assert.equal((await (await post('mode', { mode: 'resume' })).json()).mode, 'global');
  assert.equal((await (await post('select', { group: groupName, member: '节点 B' })).json()).current, '节点 B');
  assert.equal((await (await post('delay', { group: groupName, member: '节点 B' })).json()).delay, 61);
  assert.deepEqual((await (await get('settings')).json()).providers, ['demo']);
  assert.equal((await post('provider', { name: 'internal' })).status, 409);
  assert.equal((await post('provider', { name: 'demo' })).status, 200);
  assert.equal(writes, 4);
});

test('diagnostics separates the active proxy, occupied port and Codex probe', async () => {
  const core = {
    call: async () => ({ 'mixed-port': 7900, tun: { enable: true } }),
    preferences: async () => ({ expectedPort: 7897 })
  };
  const probed = [];
  const system = {
    codexProxy: async () => ({ kind: 'local', port: 7897, url: 'http://127.0.0.1:7897' }),
    listeners: async () => [{ port: 7897, name: 'GameViewerServer.exe', pid: '1' }],
    webProbe: async (url, proxy) => { probed.push([url, proxy]); return 204; }
  };
  const stale = await diagnose(core, system);
  assert.deepEqual(stale.checks.map(item => item.tone), ['ok', 'warn', 'ok', 'warn']);
  assert.match(stale.checks[3].detail, /GameViewerServer/);
  assert.equal(probed.length, 1);
  assert.match(probed[0][1], /7900$/);
  const recovered = await diagnose(core, { ...system, codexProxy: async () => ({ kind: 'none' }) });
  assert.deepEqual(recovered.checks.map(item => item.tone), ['ok', 'warn', 'ok', 'ok']);
  assert.match(recovered.checks[3].detail, /发送消息需在 Codex 中确认/);
});

test('connections distinguishes an empty Mihomo snapshot from invalid data or an unavailable core', async t => {
  let value = { downloadTotal: 0, uploadTotal: 0, connections: null };
  const core = {
    call: async (method, route) => {
      if (route === '/connections') {
        if (value instanceof Error) throw value;
        return value;
      }
      if (route === '/configs') return {mode:'rule','mixed-port':7890};
      throw new Error('unexpected fixture request');
    },
    identity: async () => ({version:'fixture'}), preferences: async () => ({})
  };
  const app = await startServer({core});
  t.after(app.close);
  const get = name => fetch(app.url + 'api/' + name);
  let response = await get('connections');
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).connections,[]);
  assert.equal((await (await get('state')).json()).connections.active,0);
  value = { downloadTotal: 0, uploadTotal: 0 };
  assert.equal((await get('connections')).status,503);
  assert.equal((await (await get('state')).json()).connections,null);
  value = new Error('fixture unavailable');
  assert.notEqual((await get('connections')).status,200);
});
