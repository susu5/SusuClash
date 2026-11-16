import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionProcessName, parseWindowsConnectionOwners, createConnectionIdentity } from '../src/connection-identity.mjs';

const proxyPorts = [7890];
const connection = (metadata = {}, extra = {}) => ({
  id: 'connection-one', start: '2026-11-11T04:00:00.000Z',
  metadata: { network: 'tcp', sourceIP: '127.0.0.1', sourcePort: '51000', ...metadata },
  ...extra
});
const owner = (extra = {}) => ({ address: '127.0.0.1', port: 51000, remoteAddress: '127.0.0.1', remotePort: 7890, name: 'chrome.exe', ...extra });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('connection process names use valid metadata and disclose only a basename', () => {
  assert.equal(connectionProcessName({ process: 'C:\\Private\\chrome.exe', processPath: 'C:\\Other\\fallback.exe' }), 'chrome.exe');
  for (const process of [true, 44, {}, [], '', '  ', 'bad\nname', '.', '..']) {
    assert.equal(connectionProcessName({ process, processPath: 'C:\\Private\\备用程序.exe' }), '备用程序.exe');
  }
  assert.equal(connectionProcessName({ processPath: '/private/path/codex.exe' }), 'codex.exe');
  assert.equal(connectionProcessName(null), null);
  assert.equal(connectionProcessName({ processPath: 'C:\\bad\u0000\\name.exe' }), null);
  assert.equal(connectionProcessName({ process: 'x'.repeat(200) }).length, 120);
});

test('Windows socket parsing supports IPv4, IPv6 and mapped IPv4 while ignoring unowned or inactive sockets', () => {
  const sockets = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:51000       127.0.0.1:7890         ESTABLISHED     123
  TCP    [0:0:0:0:0:0:0:1]:51001 [::1]:7890           ESTABLISHED     456
  TCP    [::ffff:127.0.0.1]:51002 [::ffff:7f00:1]:7890 ESTABLISHED     789
  TCP    127.0.0.1:7890        0.0.0.0:0              LISTENING       123
  TCP    127.0.0.1:51003       127.0.0.1:7890         TIME_WAIT       0
  TCP    127.0.0.1:51004       127.0.0.1:7890         ESTABLISHED     999
  TCP    bad-address:51005    127.0.0.1:7890         ESTABLISHED     123
  TCP    127.0.0.1:65536       127.0.0.1:7890         ESTABLISHED     123
  UDP    0.0.0.0:51000         *:*                                    123
  `;
  const processes = `"chrome.exe","123","Console","1","10,000 K"\r\n"程序,助手.exe","456","Console","1","20,000 K"\r\n"quoted""name.exe","789","Console","1","1 K"\r\n"System Idle Process","0","Services","0","8 K"`;
  assert.deepEqual(parseWindowsConnectionOwners(sockets, processes), [
    owner(),
    owner({ address: '::1', port: 51001, remoteAddress: '::1', name: '程序,助手.exe' }),
    owner({ port: 51002, name: 'quoted"name.exe' })
  ]);
  assert.deepEqual(parseWindowsConnectionOwners('', null), []);
});

test('known core metadata avoids OS sampling and takes precedence over remembered Windows identities', async () => {
  let reads = 0;
  const identity = createConnectionIdentity({ lookup: async () => { reads++; return [owner()]; } });
  const input = connection({ processPath: 'C:\\Private\\codex.exe' });
  const before = structuredClone(input);
  const [result] = await identity.identify([input], { proxyPorts });
  assert.equal(result.app, 'codex.exe');
  assert.equal(result.processSource, 'core');
  assert.equal(reads, 0);
  assert.deepEqual(input, before);
  await identity.identify([connection()], { proxyPorts });
  assert.equal(identity.known([input])[0].app, 'codex.exe');
  assert.equal(identity.known([input])[0].processSource, 'core');
});

test('a batch of local TCP connections shares one OS snapshot and matches exact endpoints', async () => {
  let reads = 0;
  const identity = createConnectionIdentity({ lookup: async () => {
    reads++;
    return [owner(), owner({ address: '::1', port: 51001, remoteAddress: '::1', remotePort: 7891, name: 'codex.exe' })];
  } });
  const items = [connection(), connection({ sourceIP: '0:0:0:0:0:0:0:1', sourcePort: 51001 }, { id: 'v6' }), connection({ sourceIP: '::ffff:127.0.0.1' }, { id: 'mapped' })];
  const result = await identity.identify(items, { proxyPorts: [7890, '7891'] });
  assert.deepEqual(result.map(item => [item.app, item.processSource]), [['chrome.exe', 'windows'], ['codex.exe', 'windows'], ['chrome.exe', 'windows']]);
  assert.equal(reads, 1);
});

test('local port alone, unrelated proxy ports and remote clients cannot acquire a local app identity', async () => {
  const cases = [
    [connection(), owner({ address: '127.0.0.2' })],
    [connection(), owner({ port: 51001 })],
    [connection(), owner({ remoteAddress: '192.0.2.3' })],
    [connection(), owner({ remotePort: 9090 })],
    [connection({ sourceIP: '192.168.1.12' }), owner({ address: '192.168.1.12' })],
    [connection({ sourceIP: '203.0.113.9' }), owner({ address: '203.0.113.9' })]
  ];
  for (const [item, socket] of cases) {
    const identity = createConnectionIdentity({ lookup: async () => [socket] });
    const [result] = await identity.identify([item], { proxyPorts });
    assert.equal(result.processSource, 'unknown', JSON.stringify([item.metadata, socket]));
  }
});

test('UDP and missing endpoints stay unknown rather than guessing from a PID', async () => {
  let reads = 0;
  const identity = createConnectionIdentity({ lookup: async () => { reads++; return [owner()]; } });
  const items = [connection({ network: 'udp' }), connection({ sourceIP: null, processID: 123 }), connection({ sourcePort: undefined, processID: 123 }), connection({ network: undefined, processID: 123 })];
  const results = await identity.identify(items, { proxyPorts });
  assert(results.every(item => item.app === '未知应用' && item.processSource === 'unknown'));
  assert.equal(reads, 0);
});

test('ambiguous socket owners remain unknown even when their image names are equal', async () => {
  for (const sockets of [[owner(), owner()], [owner(), owner({ name: 'codex.exe' })]]) {
    const identity = createConnectionIdentity({ lookup: async () => sockets });
    assert.equal((await identity.identify([connection()], { proxyPorts }))[0].processSource, 'unknown');
  }
});

test('failed or malformed OS results leave the connection usable and can recover on the next read', async () => {
  for (const fail of [() => { throw new Error('OS query timeout'); }, () => Promise.reject(new Error('permission denied')), () => null, () => ({})]) {
    let reads = 0;
    const identity = createConnectionIdentity({ lookup: async () => ++reads === 1 ? fail() : [owner()] });
    const first = await identity.identify([connection()], { proxyPorts });
    assert.equal(first[0].processSource, 'unknown');
    const next = await identity.identify([connection()], { proxyPorts });
    assert.equal(next[0].app, 'chrome.exe');
    assert.equal(reads, 2);
  }
});

test('invalid source addresses and port values fail closed without throwing', async () => {
  let reads = 0;
  const identity = createConnectionIdentity({ lookup: async () => { reads++; return [owner()]; } });
  const inputs = [
    ...[null, 'unknown', 'localhost', '::1%12', 'fe80::1%12', '127.0.0.1:51000'].map(sourceIP => connection({ sourceIP })),
    ...[0, -1, 65536, 51000.5, '51000x', '5e4', '', null, true].map(sourcePort => connection({ sourcePort }))
  ];
  assert((await identity.identify(inputs, { proxyPorts })).every(item => item.processSource === 'unknown'));
  assert.equal(reads, 0);
  assert.deepEqual(parseWindowsConnectionOwners('TCP [fe80::1%12]:51000 [::1]:7890 ESTABLISHED 1', '"app.exe","1"'), []);
});

test('unknown connections retry on the next sample instead of retaining a negative cache', async () => {
  let reads = 0;
  const identity = createConnectionIdentity({ lookup: async () => ++reads === 1 ? [] : [owner()] });
  assert.equal((await identity.identify([connection()], { proxyPorts }))[0].processSource, 'unknown');
  assert.equal((await identity.identify([connection()], { proxyPorts }))[0].processSource, 'windows');
  assert.equal(reads, 2);
});

test('positive cache belongs to one connection lifetime and is cleared after disappearance', async () => {
  let reads = 0;
  const identity = createConnectionIdentity({ lookup: async () => ++reads === 1 ? [owner()] : [] });
  assert.equal((await identity.identify([connection()], { proxyPorts }))[0].app, 'chrome.exe');
  assert.equal((await identity.identify([connection()], { proxyPorts }))[0].processSource, 'windows');
  assert.equal(reads, 1);
  await identity.identify([], { proxyPorts });
  assert.equal(identity.known([connection()])[0].processSource, 'unknown');
  assert.equal((await identity.identify([connection()], { proxyPorts }))[0].processSource, 'unknown');
  assert.equal(reads, 2);
});

test('cache cannot transfer an app across ID, start time, source tuple or transport changes', async () => {
  for (const changed of [
    connection({}, { id: 'new-connection' }),
    connection({}, { start: '2026-11-11T04:00:01.000Z' }),
    connection({ sourceIP: '127.0.0.2' }), connection({ sourcePort: 51001 }), connection({ network: 'udp' })
  ]) {
    let reads = 0;
    const identity = createConnectionIdentity({ lookup: async () => ++reads === 1 ? [owner()] : [] });
    await identity.identify([connection()], { proxyPorts });
    assert.equal(identity.known([changed])[0].processSource, 'unknown');
    assert.equal((await identity.identify([changed], { proxyPorts }))[0].processSource, 'unknown');
  }
});

test('proxy port changes invalidate cached Windows owners', async () => {
  let reads = 0;
  const identity = createConnectionIdentity({ lookup: async () => ++reads === 1 ? [owner()] : [] });
  await identity.identify([connection()], { proxyPorts });
  assert.equal((await identity.identify([connection()], { proxyPorts: [7891] }))[0].processSource, 'unknown');
  assert.equal(reads, 2);
});

test('connections without a lifetime are never positively cached', async () => {
  let reads = 0;
  const identity = createConnectionIdentity({ lookup: async () => ++reads === 1 ? [owner()] : [] });
  const item = connection({}, { start: undefined });
  assert.equal((await identity.identify([item], { proxyPorts }))[0].processSource, 'windows');
  assert.equal(identity.known([item])[0].processSource, 'unknown');
  assert.equal((await identity.identify([item], { proxyPorts }))[0].processSource, 'unknown');
});

test('fresh snapshot recheck confirms the same lifetime and returns fresh connection values', async () => {
  let rechecks = 0;
  const identity = createConnectionIdentity({ lookup: async () => [owner()] });
  const [result] = await identity.identify([connection({}, { download: 1 })], { proxyPorts, recheck: async () => { rechecks++; return [connection({}, { download: 20 })]; } });
  assert.equal(result.app, 'chrome.exe');
  assert.equal(result.download, 20);
  assert.equal(rechecks, 1);
});

test('fresh snapshot cannot assign a sampled owner to an ended, replaced or unconfirmed lifetime', async () => {
  for (const current of [[], [connection({}, { id: 'reused-port-new-connection' })], [connection({}, { start: '2026-11-11T04:01:00Z' })], [connection({}, { start: undefined })]]) {
    const identity = createConnectionIdentity({ lookup: async () => [owner()] });
    const result = await identity.identify([connection()], { proxyPorts, recheck: async () => current });
    assert(result.every(item => item.processSource === 'unknown'));
    assert.equal(identity.known([connection()])[0].processSource, 'unknown');
  }
  for (const recheck of [async () => null, async () => { throw new Error('core unavailable'); }]) {
    const identity = createConnectionIdentity({ lookup: async () => [owner()] });
    assert.equal((await identity.identify([connection()], { proxyPorts, recheck }))[0].processSource, 'unknown');
  }
});

test('fresh core process metadata wins over a simultaneous Windows sample', async () => {
  const identity = createConnectionIdentity({ lookup: async () => [owner()] });
  const result = await identity.identify([connection()], { proxyPorts, recheck: async () => [connection({ process: 'codex.exe' })] });
  assert.equal(result[0].app, 'codex.exe');
  assert.equal(result[0].processSource, 'core');
});

test('concurrent reads share one OS query without sharing identities across proxy changes', async () => {
  const gate = defer();
  let reads = 0;
  const identity = createConnectionIdentity({ lookup: async () => { reads++; return gate.promise; } });
  const oldRead = identity.identify([connection()], { proxyPorts });
  const newRead = identity.identify([connection()], { proxyPorts: [7891] });
  gate.resolve([owner()]);
  const [, current] = await Promise.all([oldRead, newRead]);
  assert.equal(reads, 1);
  assert.equal(current[0].processSource, 'unknown');
  assert.equal(identity.known([connection()])[0].processSource, 'unknown');
});
