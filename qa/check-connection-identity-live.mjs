import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { parse } from 'yaml';

// Uses only a separately owned core, an ephemeral local HTTP target, and a
// read-only server facade. No installed client, subscription or system proxy
// is read or changed. The report contains counts and executable basenames.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const payload = path.resolve(process.env.SUSU_IDENTITY_PAYLOAD || root);
const { createManagedCore } = await import(pathToFileURL(path.join(payload, 'src/managed-core.mjs')));
const { startServer } = await import(pathToFileURL(path.join(payload, 'src/server.mjs')));
const { connectionProcessName, createConnectionIdentity } = await import(pathToFileURL(path.join(payload, 'src/connection-identity.mjs')));
const working = path.join(root, 'outputs', 'working', 'connection-identity-2026-11-11');
const reportFile = path.resolve(process.env.SUSU_IDENTITY_REPORT || path.join(root, 'outputs', 'log', 'connection-identity-live-2026-11-11.json'));
const report = {
  status: 'running',
  startedAt: new Date().toISOString(),
  isolated: true,
  packagedPayload: payload !== root,
  systemProxyChanged: false,
  externalRequests: 0,
  checks: []
};
let phase = 'setup', core, app, target, heldRequest, maskProcess = false;
const targetSockets = new Set();

function check(condition, name, evidence = {}) {
  report.checks.push({ name, status: condition ? 'passed' : 'failed', ...evidence });
  if (!condition) throw Object.assign(new Error(name), { liveCheck: true });
}
const withoutProcess = item => !item ? item : ({
  ...item,
  metadata: { ...item.metadata, process: '', processPath: '' }
});

async function get(name) {
  const response = await fetch(app.url + 'api/' + name, { signal: AbortSignal.timeout(8000) });
  check(response.ok, 'api_' + name + '_available');
  return response.json();
}

async function holdConnection(proxyPort, targetPort) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: proxyPort, method: 'GET',
      path: 'http://127.0.0.1:' + targetPort + '/hold',
      headers: { Host: '127.0.0.1:' + targetPort }, agent: false
    });
    heldRequest = request;
    request.once('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('isolated_connection_deadline')));
    request.once('response', response => {
      response.on('error', () => {});
      if (response.statusCode !== 200) return reject(Object.assign(new Error('local_target_response'), { liveCheck: true }));
      response.once('data', () => resolve(request.socket.localPort));
      response.resume();
    });
    request.end();
  });
}

async function findHeld(sourcePort, targetPort) {
  const deadline = Date.now() + 4000;
  do {
    const snapshot = await core.call('GET', '/connections');
    const items = Array.isArray(snapshot?.connections) ? snapshot.connections : [];
    const item = items.find(connection => Number(connection?.metadata?.sourcePort) === sourcePort && Number(connection?.metadata?.destinationPort) === targetPort);
    if (item) return { snapshot, items, item };
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw Object.assign(new Error('held_connection_observed'), { liveCheck: true });
}

try {
  check(process.platform === 'win32', 'windows_platform');
  await mkdir(working, { recursive: true });
  await mkdir(path.dirname(reportFile), { recursive: true });
  const directory = await mkdtemp(path.join(working, 'run-'));
  const source = path.join(directory, 'fixture.yaml');
  await writeFile(source, 'mode: rule\nfind-process-mode: off\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n');

  phase = 'isolated_core_start';
  core = createManagedCore({ directory });
  await core.applyConfig(source);
  const config = await core.call('GET', '/configs');
  const runtime = parse(await readFile(path.join(directory, 'core', 'runtime.yaml'), 'utf8'));
  report.coreVersion = (await core.identity()).version;
  check(runtime['find-process-mode'] === 'always', 'runtime_forces_process_lookup', { mode: runtime['find-process-mode'] });

  phase = 'local_target_and_request';
  target = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    response.write('isolated-local-target-ready\n');
    // Keep the response open so native endpoint sampling can inspect it.
  });
  target.on('connection', socket => {
    targetSockets.add(socket);
    socket.once('close', () => targetSockets.delete(socket));
  });
  await new Promise((resolve, reject) => target.once('error', reject).listen(0, '127.0.0.1', resolve));
  const targetPort = target.address().port;
  const proxyPort = config['mixed-port'];
  const sourcePort = await holdConnection(proxyPort, targetPort);
  const observed = await findHeld(sourcePort, targetPort);
  const expectedName = path.win32.basename(process.execPath);
  check(connectionProcessName(observed.item.metadata)?.toLowerCase() === expectedName.toLowerCase(), 'real_core_process_identity', {
    active: observed.items.length,
    identified: observed.items.filter(item => connectionProcessName(item?.metadata)).length,
    processName: connectionProcessName(observed.item.metadata)
  });

  phase = 'api_core_identity';
  const facade = {
    call: async (method, route, body, timeout) => {
      const result = await core.call(method, route, body, timeout);
      if (maskProcess && route === '/connections' && Array.isArray(result?.connections)) {
        return { ...result, connections: result.connections.map(withoutProcess) };
      }
      return result;
    },
    identity: core.identity,
    preferences: core.preferences,
    status: core.status
  };
  app = await startServer({ core: facade, dailyUpdate: false, readSystemProxy: async () => false, connectionIdentity: createConnectionIdentity() });
  let list = await get('connections');
  let item = list.connections.find(connection => connection.id === observed.item.id);
  check(item?.app?.toLowerCase() === expectedName.toLowerCase() && item.processSource === 'core', 'api_preserves_real_core_identity', {
    active: list.connections.length, processName: item?.app ?? null, source: item?.processSource ?? null
  });
  let state = await get('state');
  check(state.connections?.apps.some(group => group.name === item.app && group.active > 0), 'state_matches_core_connection_list', {
    active: state.connections?.active ?? null,
    names: state.connections?.apps.map(group => group.name) ?? []
  });

  phase = 'native_windows_fallback';
  const resolver = createConnectionIdentity();
  const resolved = await resolver.identify(observed.items.map(withoutProcess), {
    proxyPorts: [proxyPort],
    recheck: async () => {
      const fresh = await core.call('GET', '/connections');
      return fresh.connections.map(withoutProcess);
    }
  });
  const fallback = resolved.find(connection => connection.id === observed.item.id);
  check(fallback?.app?.toLowerCase() === expectedName.toLowerCase() && fallback.processSource === 'windows', 'real_windows_endpoint_fallback', {
    processMetadataRemoved: true,
    active: resolved.length,
    processName: fallback?.app ?? null,
    source: fallback?.processSource ?? null
  });

  phase = 'api_windows_fallback';
  maskProcess = true;
  list = await get('connections');
  item = list.connections.find(connection => connection.id === observed.item.id);
  check(item?.app?.toLowerCase() === expectedName.toLowerCase() && item.processSource === 'windows', 'api_recovers_missing_process_metadata', {
    processMetadataRemoved: true,
    active: list.connections.length, processName: item?.app ?? null, source: item?.processSource ?? null
  });
  state = await get('state');
  check(state.connections?.apps.some(group => group.name === item.app && group.active > 0), 'state_matches_fallback_connection_list', {
    active: state.connections?.active ?? null,
    names: state.connections?.apps.map(group => group.name) ?? []
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = {
    phase,
    reason: error.liveCheck ? error.message : 'native_or_runtime_operation_failed',
    code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : null
  };
  process.exitCode = 1;
} finally {
  heldRequest?.destroy();
  for (const socket of targetSockets) socket.destroy();
  const cleanup = await Promise.allSettled([
    app?.close(),
    core?.stop(),
    target && new Promise(resolve => target.close(resolve))
  ]);
  report.cleanupPassed = cleanup.every(result => result.status === 'fulfilled');
  if (!report.cleanupPassed) { report.status = 'failed'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
