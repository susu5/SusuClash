import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat, readdir, rm, symlink, link, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { parseNetfixEnv, patchNetfixPort, evaluateNetfix, candidatePorts, candidateIdentity } from '../src/netfix-rules.mjs';
import { summarizeNetfixLogs, probeNetfix } from '../src/netfix-evidence.mjs';
import { createNetfixTransaction } from '../src/netfix-transaction.mjs';
import { createNetfixService } from '../src/netfix-service.mjs';

// Every system dependency is injected. These tests never invoke collectors,
// real proxy requests, a Codex executable, a user auth file, or a real home.
const TIME = Date.parse('2026-11-14T08:00:00Z');
const DEAD = 43127, LIVE = 7897;
const original = Buffer.from('\uFEFF# 我的配置\r\nHTTP_PROXY="http://127.0.0.1:43127" # 保留\r\nHTTPS_PROXY="http://localhost:43127"\r\nNO_PROXY=localhost,127.0.0.1\r\nKEEP=unchanged\r\n');
const okProbe = { ok: true, code: 401, ms: 1, error: null };
const probes = () => Array.from({ length: 3 }, () => ({ ...okProbe }));
const owner = (port, pid = 42) => ({ port, pid, name: 'verge-mihomo.exe', address: '127.0.0.1' });
const hostEvidence = (port = LIVE) => ({ available: true, listeners: [owner(port)], process: { available: true, running: true, port, ambiguous: false }, systemProxy: { enabled: true, host: '127.0.0.1', port: LIVE }, vergePorts: [LIVE], actualRewrite: false });
const logsEvidence = () => ({ available: true, complete: true, cHits24h: 0, bHits15m: 0 });
const authEvidence = () => ({ available: true, present: true, expired: false, expAt: new Date(TIME + 86400000).toISOString() });
const envEvidence = (port = LIVE) => ({ ...parseNetfixEnv(Buffer.from(`HTTPS_PROXY=http://127.0.0.1:${port}\n`)), exists: true, locked: false });
const evidence = extra => ({ env: envEvidence(), host: hostEvidence(), logs: logsEvidence(), auth: authEvidence(), currentProbes: probes(), candidate: LIVE, candidateProbe: { ...okProbe }, backups: [], ...extra });

async function eventually(service) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await service.get();
    if (!value.busy) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Injected Netfix task did not settle within five seconds');
}
async function diagnose(service) { await service.diagnose(); return eventually(service); }
async function apply(service, plan) { await service.apply({ token: plan.token, confirmed: true }); return eventually(service); }

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'susu-netfix-test-'));
  const stateDirectory = path.join(directory, 'state'); await mkdir(stateDirectory);
  const file = path.join(directory, '.env');
  await writeFile(file, options.bytes || original);
  const protectedFiles = { 'config.toml': 'model="fixture-only"\n', 'auth.json': '{"fixture":"never-read-real-token"}' };
  for (const [name, text] of Object.entries(protectedFiles)) await writeFile(path.join(directory, name), text);
  const cleanup = async () => {
    assert.equal(path.dirname(directory).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase(), 'cleanup stays in allocated temporary root');
    assert(path.basename(directory).startsWith('susu-netfix-test-'));
    for (const entry of await readdir(directory).catch(() => [])) await chmod(path.join(directory, entry), 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  };
  let clock = TIME, aclRevision = 0;
  const host = hostEvidence(), logs = logsEvidence(), auth = authEvidence(), calls = [], copies = [], attributes = new Map();
  host.process.port = options.processPort ?? DEAD;
  let probeImpl = async args => args.port === LIVE ? { ...okProbe } : { ok: false, code: 0, ms: 1, error: 'Timeout' };
  const system = {
    collect: async () => structuredClone(host),
    logs: async () => structuredClone(logs),
    auth: async () => structuredClone(auth),
    probe: async args => {
      calls.push({ ...args, signal: undefined });
      return probeImpl(args);
    },
    copyPermissions: async (source, targets) => {
      assert(path.resolve(source).startsWith(path.resolve(directory) + path.sep));
      for (const target of targets) assert.equal((await readFile(target)).length, 0, 'replacement and backup receive permissions before contents');
      copies.push({ source, targets: [...targets] });
    },
    permissionFingerprint: async target => `${(await stat(target)).mode}:${aclRevision}`,
    fileAttributes: async target => {
      const value = (attributes.get(target) ?? 32) & ~129;
      return (value | ((await stat(target)).mode & 0o200 ? 0 : 1)) || 128;
    },
    setFileAttributes: async (target, value) => {
      attributes.set(target, value);
      const mode = (await stat(target)).mode;
      await chmod(target, value & 1 ? mode & ~0o222 : mode | 0o200);
    },
    setReadonly: async (target, locked, mode) => chmod(target, locked ? mode & ~0o222 : mode | 0o200),
    ...(options.system || {})
  };
  const settings = { directory, stateDirectory, system, now: () => clock, ...(options.service || {}) };
  const service = createNetfixService(settings);
  t.after(async () => { await service.close(); await cleanup(); });
  await service.get(); // Complete startup recovery before a low-level crash fixture starts another transaction.
  return { directory, stateDirectory, file, service, system, settings, host, logs, auth, calls, copies,
    advance: ms => { clock += ms; }, changeAcl: () => { aclRevision++; },
    changeAttributes: () => attributes.set(file, (attributes.get(file) ?? 32) ^ 2),
    setProbe: fn => { probeImpl = fn; },
    assertProtected: async () => { for (const [name, text] of Object.entries(protectedFiles)) assert.equal(await readFile(path.join(directory, name), 'utf8'), text, name + ' is not changed'); } };
}

test('proxy parsing rejects ambiguous/external/credential/SOCKS/bypass configurations', () => {
  for (const value of [
    'HTTPS_PROXY=socks5://127.0.0.1:7897\n',
    'HTTPS_PROXY=http://secret:password@127.0.0.1:7897\n',
    'HTTPS_PROXY=http://proxy.example.test:7897\n',
    'HTTP_PROXY=http://127.0.0.1:7897\nHTTPS_PROXY=http://127.0.0.1:7890\n',
    'HTTPS_PROXY=http://127.0.0.1:7897\nNO_PROXY=*\n',
    'HTTPS_PROXY=http://127.0.0.1:7897\nNO_PROXY=*.openai.com\n'
  ]) assert.equal(parseNetfixEnv(Buffer.from(value)).supported, false, value);
  assert.equal(parseNetfixEnv(Buffer.from([0xff, 0xfe, 0xff])).supported, false, 'invalid UTF-8');
});

test('port patch preserves exact BOM, CRLF, comments and every nonproxy byte', () => {
  const expected = Buffer.from(original.toString('utf8').replaceAll(':43127', ':7897'));
  assert.deepEqual(patchNetfixPort(original, LIVE), expected);
  assert(original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  assert.equal(parseNetfixEnv(expected).port, LIVE);
});

test('candidate priority is Verge, enabled local system proxy, then known fallbacks without duplicates', () => {
  assert.deepEqual(candidatePorts({ vergePorts: [19001, LIVE, 19001], systemProxy: { enabled: true, host: '127.0.0.1', port: 19002 } }), [19001, LIVE, 19002, 7890, 10808]);
  assert(!candidatePorts({ systemProxy: { enabled: false, host: '127.0.0.1', port: 19002 } }).includes(19002));
  assert(!candidatePorts({ systemProxy: { enabled: true, host: 'proxy.example.test', port: 19002 } }).includes(19002));
  assert.equal(candidateIdentity({ listeners: [{ port: LIVE, pid: null, name: '', address: '127.0.0.1' }] }, LIVE), null);
  assert.equal(candidateIdentity({ listeners: [{ ...owner(LIVE), address: '192.0.2.1' }] }, LIVE), null);
  assert(candidateIdentity(hostEvidence(), LIVE));
});

test('decision precedence is A dead port, A2 drift, C identity, then B transport', () => {
  const c = { ...authEvidence(), expired: true }, b = { ...logsEvidence(), bHits15m: 9 };
  assert.equal(evaluateNetfix(evidence({ env: envEvidence(DEAD), auth: c, logs: b })).verdict.fixMode, 'fix-port');
  assert.match(evaluateNetfix(evidence({ host: { ...hostEvidence(), process: { available: true, running: true, port: DEAD } }, auth: c, logs: b })).verdict.tag, /A2/);
  assert.match(evaluateNetfix(evidence({ auth: c, logs: b })).verdict.tag, /C/);
  assert.match(evaluateNetfix(evidence({ logs: b })).verdict.tag, /B/);
});

test('A repair requires a candidate that passed HTTP, not an open TCP listener alone', () => {
  for (const candidateProbe of [null, { ok: false, code: 0, error: 'not an HTTP proxy' }]) {
    const result = evaluateNetfix(evidence({ env: envEvidence(DEAD), candidateProbe }));
    assert.equal(result.verdict.fixMode, 'none'); assert(!result.allowedActions.includes('fix-port'));
  }
});

test('missing or incomplete evidence is unknown and disables all writes', () => {
  for (const extra of [
    { env: { exists: false, supported: false, hasProxy: false } }, { env: { ...envEvidence(), supported: false } },
    { host: { ...hostEvidence(), available: false } },
    { host: { ...hostEvidence(), process: { available: false } } },
    { host: { ...hostEvidence(), process: { available: true, ambiguous: true } } },
    { auth: { available: false } }, { logs: { ...logsEvidence(), complete: false } }, { currentProbes: [] }
  ]) { const result = evaluateNetfix(evidence(extra)); assert.equal(result.unknown, true); assert.deepEqual(result.allowedActions, []); assert.notEqual(result.verdict.level, 'ok'); }
});

test('mere SusuClash installation is not recurrence; observed rewriting is', () => {
  assert.equal(evaluateNetfix(evidence({ host: { ...hostEvidence(), installed: true, running: true } })).verdict.fixMode, 'copy-report');
  assert.equal(evaluateNetfix(evidence({ host: { ...hostEvidence(), actualRewrite: true } })).verdict.fixMode, 'lock-only');
});

test('B fifteen-minute and C twenty-four-hour windows apply only to trusted failure targets', () => {
  const row = (age, target, body, level = 'ERROR') => ({ ts: TIME / 1000 - age, level, target, feedback_log_body: body });
  const result = summarizeNetfixLogs([
    row(60, 'codex_core::client', 'request timed out'), row(16 * 60, 'codex_core::client', 'request timed out'),
    row(23 * 3600, 'codex_api::responses', 'HTTP 401 unauthorized'), row(25 * 3600, 'codex_api::responses', 'HTTP 429 rate limit'),
    row(10, 'codex_core::tools::shell', 'fixture_secret: HTTP 401 timeout'),
    row(10, 'transcript', 'HTTP 429 quota timed out'), row(10, 'codex_core::client', 'normal info timeout', 'INFO'),
    row(-3600, 'codex_core::client', 'HTTP 401 timed out')
  ], { now: TIME });
  assert.equal(result.cHits24h, 1); assert.equal(result.bHits15m, 1);
  assert(!JSON.stringify(result).includes('fixture_secret'), 'raw tool output must not enter public summaries');
  assert.equal(summarizeNetfixLogs([], { now: TIME, truncated: true }).complete, false);
});

test('real probe handler accepts a valid 403 status before a large first body chunk without weakening TLS', async () => {
  const previous = tls.connect, connects = [], writes = [];
  let destroyed = 0;
  try {
    tls.connect = options => {
      connects.push(options); const socket = new EventEmitter();
      socket.destroy = () => { destroyed++; };
      socket.write = text => {
        writes.push(text);
        queueMicrotask(() => socket.emit('data', Buffer.from('HTTP/1.1 403 Forbidden\r\nContent-Length: 16384\r\n\r\n' + 'x'.repeat(16384))));
        return true;
      };
      queueMicrotask(() => socket.emit('secureConnect')); return socket;
    };
    const result = await probeNetfix({ port: null, target: 'https://chatgpt.com/backend-api/', timeoutMs: 1000 });
    assert.equal(result.ok, true); assert.equal(result.code, 403); assert.equal(connects.length, 1);
    assert.equal(connects[0].rejectUnauthorized, true); assert.equal(connects[0].servername, 'chatgpt.com'); assert.equal(connects[0].host, 'chatgpt.com');
    assert.deepEqual(connects[0].ALPNProtocols, ['http/1.1']);
    assert.match(writes[0], /^GET \/backend-api\/ HTTP\/1\.1\r\nHost: chatgpt\.com\r\n/);
    assert(!/authorization:|cookie:/i.test(writes[0])); assert.equal(destroyed, 1);
  } finally { tls.connect = previous; }
});

test('probe refuses destinations outside its fixed allowlist before opening any socket', async () => {
  const previous = tls.connect;
  try {
    tls.connect = () => { throw new Error('No socket may be opened for an unsupported target'); };
    for (const args of [{ target: 'https://example.test/' }, { target: 'https://api.openai.com/v1/models?token=fixture' }, { port: 70000 }, { port: 1.5 }]) {
      const result = await probeNetfix(args); assert.equal(result.ok, false); assert.equal(result.error, 'unsupported_target');
    }
  } finally { tls.connect = previous; }
});

test('actual service isolates current-route samples from failed direct and candidate controls', async t => {
  const f = await fixture(t, { bytes: patchNetfixPort(original, LIVE), processPort: LIVE });
  const result = await diagnose(f.service);
  assert.equal(result.verdict.level, 'ok', JSON.stringify(result.verdict));
  assert.equal(result.verdict.fixMode, 'copy-report');
  assert.equal(result.verification === 'app_verified', false);
  assert(f.calls.filter(call => call.port === LIVE).length >= 3);
  await f.assertProtected();
});

test('public snapshots, previews and reports omit injected credentials and raw log/process contents', async t => {
  const f = await fixture(t), secret = 'NETFIX_TEST_CREDENTIAL_SENTINEL';
  f.auth.access_token = secret; f.logs.rawBody = secret; f.host.process.environment = { PRIVATE: secret };
  f.setProbe(async args => args.port === LIVE ? { ...okProbe } : { ok: false, code: 0, ms: 1, error: 'Timeout ' + secret });
  const result = await diagnose(f.service), plan = await f.service.preview({ action: 'fix-port' });
  assert(!JSON.stringify(result).includes(secret)); assert(!JSON.stringify(plan).includes(secret)); assert(!result.report.includes(secret));
  assert(!JSON.stringify(result).includes('KEEP=unchanged'), 'unrelated dotenv contents remain private');
});

test('transient Windows audit sharing failures are bounded and retried against the unchanged file', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); let attempts = 0; const errors = [];
  f.system.renameAudit = async (source, target) => {
    if (++attempts <= 2) throw Object.assign(new Error('Injected Windows sharing failure'), { code: 'EPERM' });
    return rename(source, target);
  };
  f.system.onError = value => errors.push(value);
  const result = await diagnose(f.service);
  assert.equal(result.verdict.fixMode, 'fix-port'); assert.equal(result.audit.length, 2);
  assert.equal(attempts, 4, 'two injected failures plus successful start and complete audit writes'); assert.deepEqual(errors, []);
  assert.deepEqual(await readFile(f.file), original);
});

test('audit retry refuses a foreign edit rather than replacing its new contents', async t => {
  const f = await fixture(t); await diagnose(f.service);
  const auditFile = path.join(f.stateDirectory, 'netfix-audit.json'), external = Buffer.from('{"version":1,"items":[],"external":"KEEP_FOREIGN_AUDIT"}');
  f.system.hook = async ({ phase, action, result }) => { if (phase === 'beforeAuditReplace' && action === 'diagnose' && result === 'started') await writeFile(auditFile, external); };
  const result = await diagnose(f.service);
  assert.equal(result.verdict.tag, '未完成'); assert.deepEqual(result.allowedActions, []);
  assert.deepEqual(await readFile(auditFile), external); assert.deepEqual(await readFile(f.file), original);
  assert(result.report.includes('本轮检查或处理未完成')); assert(!result.report.includes('结论：固定代理指向'), 'failed fresh diagnosis cannot copy the previous A1 conclusion');
});

test('persistent Windows audit denial stops after six attempts with a fresh failure report', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); let attempts = 0; const errors = [];
  f.system.renameAudit = async () => { attempts++; throw Object.assign(new Error('Injected audit denial'), { code: 'EACCES' }); };
  f.system.onError = value => errors.push(value);
  const result = await diagnose(f.service);
  assert.equal(attempts, 6); assert.equal(result.errorCode, 'EACCES'); assert.equal(result.verdict.tag, '未完成');
  assert(result.report.includes('本轮检查或处理未完成')); assert.deepEqual(errors, [{ scope: 'audit', code: 'EACCES' }]);
  assert.deepEqual(await readFile(f.file), original);
});

test('candidate discovery skips an unowned listener or failing protocol and tries the next source', async t => {
  const f = await fixture(t);
  f.host.vergePorts = [19001, 19002]; f.host.listeners = [{ port: 19001, pid: null, name: '', address: '127.0.0.1' }, owner(19002), owner(LIVE)];
  const result = await diagnose(f.service);
  assert.equal(result.verdict.fixMode, 'fix-port'); assert.match(result.verdict.fixLabel, /7897/);
  assert(!f.calls.some(call => call.port === 19001), 'unowned candidate never receives a proxy probe');
  assert(f.calls.some(call => call.port === 19002), 'owned higher-priority candidate is tested first');
});

test('service executes disclosed port change, keeps source bytes/permissions, and stops awaiting activation', async t => {
  const f = await fixture(t); const diagnosed = await diagnose(f.service);
  assert.equal(diagnosed.verdict.fixMode, 'fix-port');
  const plan = await f.service.preview({ action: 'fix-port' });
  assert.equal(plan.rows.length, 6); assert.equal(typeof plan.token, 'string'); assert(plan.token.length >= 24);
  for (const label of ['目标文件', '变更内容', '备份', '并发改动', '回滚方式', '生效条件']) assert(JSON.stringify(plan.rows).includes(label));
  assert(!JSON.stringify(plan).includes('KEEP=unchanged'), 'plan exposes a diff, not arbitrary dotenv contents');
  const result = await apply(f.service, plan);
  assert.deepEqual(await readFile(f.file), patchNetfixPort(original, LIVE));
  assert.equal(result.stage, 'awaiting_restart'); assert.equal(result.waitingRestart, true);
  assert.notEqual(result.verification, 'app_verified'); assert(f.copies.length > 0);
  assert(result.backups.length > 0); await f.assertProtected();
});

test('write-time ownership change invalidates a candidate instead of repointing to a new process', async t => {
  const f = await fixture(t); await diagnose(f.service); const plan = await f.service.preview({ action: 'fix-port' });
  f.host.listeners = [owner(LIVE, 999)];
  const result = await apply(f.service, plan);
  assert.equal(result.verification, 'not_verified'); assert.deepEqual(result.allowedActions, []);
  assert.match(result.verdict.tag, /失效/);
  assert.deepEqual(await readFile(f.file), original);
});

test('opaque preview rejects absent confirmation, expired, changed content, attributes, and replays', async t => {
  for (const variant of ['unconfirmed', 'expired', 'content', 'readonly', 'acl', 'attributes']) await t.test(variant, async t => {
    const f = await fixture(t); await diagnose(f.service); const plan = await f.service.preview({ action: 'fix-port' });
    let expected = original;
    if (variant === 'expired') f.advance(60001);
    if (variant === 'content') { expected = Buffer.concat([original, Buffer.from('EXTERNAL=keep\r\n')]); await writeFile(f.file, expected); }
    if (variant === 'readonly') await chmod(f.file, 0o400);
    if (variant === 'acl') f.changeAcl();
    if (variant === 'attributes') f.changeAttributes();
    if (['unconfirmed', 'expired'].includes(variant)) await assert.rejects(f.service.apply({ token: plan.token, confirmed: variant !== 'unconfirmed' }));
    else {
      const result = await apply(f.service, plan);
      assert.equal(result.verification, 'not_verified'); assert.deepEqual(result.allowedActions, []); assert.match(result.verdict.tag, /失效/);
      await assert.rejects(f.service.apply({ token: plan.token, confirmed: true }), 'failed precondition still consumes the opaque plan');
    }
    assert.deepEqual(await readFile(f.file), expected);
  });
  const f = await fixture(t); await diagnose(f.service); const plan = await f.service.preview({ action: 'fix-port' });
  await apply(f.service, plan);
  await assert.rejects(f.service.apply({ token: plan.token, confirmed: true }));
  assert.deepEqual(await readFile(f.file), patchNetfixPort(original, LIVE));
});

test('unknown service result rejects all write previews including manual lock and restore', async t => {
  const f = await fixture(t); f.logs.complete = false; const result = await diagnose(f.service);
  assert.match(result.verdict.tag, /证据不足/);
  for (const action of ['fix-port', 'lock', 'unlock', 'restore']) await assert.rejects(f.service.preview({ action }));
  assert.deepEqual(await readFile(f.file), original);
});

test('observed absent dotenv may inspect a known system route but never creates a repair target', async t => {
  const f = await fixture(t, { processPort: LIVE }); await rm(f.file);
  const result = await diagnose(f.service);
  assert.equal(result.env.exists, false); assert.equal(result.verdict.level, 'ok', JSON.stringify(result.verdict));
  assert.deepEqual(result.allowedActions, []);
  for (const action of ['fix-port', 'lock', 'unlock', 'restore']) await assert.rejects(f.service.preview({ action }));
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
});

test('independent lock/unlock preserve contents and backup restore preserves current lock', async t => {
  const f = await fixture(t); await diagnose(f.service);
  const locked = await apply(f.service, await f.service.preview({ action: 'lock' }));
  assert.equal(locked.stage, 'result', JSON.stringify(locked));
  assert.equal(Boolean((await stat(f.file)).mode & 0o200), false); assert.deepEqual(await readFile(f.file), original);
  const rediagnosed = await diagnose(f.service); assert.equal(rediagnosed.verdict.fixMode, 'fix-port', JSON.stringify(rediagnosed));
  const fixed = await apply(f.service, await f.service.preview({ action: 'fix-port' }));
  assert.equal(Boolean((await stat(f.file)).mode & 0o200), false, 'port write preserves read-only lock');
  const backup = fixed.backups.find(b => b.restorable && b.port === DEAD); assert(backup, 'original port backup is selectable');
  await diagnose(f.service); const restored = await apply(f.service, await f.service.preview({ action: 'restore', backupName: backup.name }));
  assert.deepEqual(await readFile(f.file), original); assert.equal(Boolean((await stat(f.file)).mode & 0o200), false);
  assert(restored.backups.length > fixed.backups.length, 'restore first backs up current state');
  await diagnose(f.service); await apply(f.service, await f.service.preview({ action: 'unlock' }));
  assert.equal(Boolean((await stat(f.file)).mode & 0o200), true); await f.assertProtected();
});

test('verification failure automatically restores exact original bytes and never reports success', async t => {
  const f = await fixture(t); await diagnose(f.service); const plan = await f.service.preview({ action: 'fix-port' });
  let replaced = false;
  f.system.hook = async ({ phase }) => { if (phase === 'afterReplace') replaced = true; };
  f.setProbe(async () => replaced ? { ok: false, code: 0, error: 'Timeout' } : { ...okProbe });
  const result = await apply(f.service, plan);
  assert.equal(result.stage, 'rolled_back'); assert.deepEqual(await readFile(f.file), original);
  assert.notEqual(result.verification, 'app_verified'); assert(result.audit.some(a => JSON.stringify(a).includes('回滚')));
});

test('external edits after a write cause rollback conflict and remain untouched', async t => {
  const f = await fixture(t); await diagnose(f.service); const plan = await f.service.preview({ action: 'fix-port' });
  const external = Buffer.from('HTTPS_PROXY=http://127.0.0.1:19009\r\nUSER_EDIT=keep\r\n'); let replaced = false;
  f.system.hook = async ({ phase }) => { if (phase === 'afterReplace') { replaced = true; await writeFile(f.file, external); } };
  f.setProbe(async () => replaced ? { ok: false, code: 0, error: 'Timeout' } : { ...okProbe });
  const result = await apply(f.service, plan);
  assert.equal(result.stage, 'rollback_conflict'); assert.deepEqual(await readFile(f.file), external);
  assert.notEqual(result.verification, 'app_verified');
});

test('cancel after replacement waits for safe rollback and concurrent apply cannot replay', async t => {
  const f = await fixture(t); await diagnose(f.service); const plan = await f.service.preview({ action: 'fix-port' });
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { entered = resolve; });
  f.system.hook = async ({ phase }) => { if (phase === 'afterReplace') { entered(); await gate; } };
  await f.service.apply({ token: plan.token, confirmed: true }); await arrived;
  await assert.rejects(f.service.apply({ token: plan.token, confirmed: true }));
  const stopped = f.service.cancel(); release(); await stopped;
  const result = await eventually(f.service);
  assert.equal(result.stage, 'cancelled'); assert.deepEqual(await readFile(f.file), original);
});

test('unfinished transaction recovers exact bytes after a simulated crash without probes', async t => {
  const f = await fixture(t); const tx = createNetfixTransaction(f.settings), before = await tx.inspect();
  await tx.change({ before, bytes: patchNetfixPort(before.bytes, LIVE), action: 'fix-port', locked: before.locked });
  assert.deepEqual(await readFile(f.file), patchNetfixPort(original, LIVE));
  const fresh = createNetfixTransaction(f.settings); const result = await fresh.recover();
  assert.equal(result.ok, true); assert.deepEqual(await readFile(f.file), original); assert.equal(f.calls.length, 0);
});

test('crash recovery never overwrites a third-party edit', async t => {
  const f = await fixture(t), tx = createNetfixTransaction(f.settings), before = await tx.inspect();
  await tx.change({ before, bytes: patchNetfixPort(before.bytes, LIVE), action: 'fix-port', locked: before.locked });
  const external = Buffer.from('HTTPS_PROXY=http://127.0.0.1:19009\nUSER=external\n'); await writeFile(f.file, external);
  const result = await createNetfixTransaction(f.settings).recover();
  assert.equal(result.ok, false); assert.deepEqual(await readFile(f.file), external); assert.equal(f.calls.length, 0);
});

test('committed transaction survives restart and its backup restores only by explicit new action', async t => {
  const f = await fixture(t), tx = createNetfixTransaction(f.settings), before = await tx.inspect();
  const record = await tx.change({ before, bytes: patchNetfixPort(before.bytes, LIVE), action: 'fix-port', locked: before.locked });
  await tx.commit(record); assert.equal((await createNetfixTransaction(f.settings).recover()).ok, true);
  assert.deepEqual(await readFile(f.file), patchNetfixPort(original, LIVE)); assert.equal(f.calls.length, 0);
});

test('same-second operations keep distinct verifiable backups', async t => {
  const f = await fixture(t), tx = createNetfixTransaction(f.settings);
  for (const port of [LIVE, 7890]) {
    const before = await tx.inspect();
    const record = await tx.change({ before, bytes: patchNetfixPort(before.bytes, port), action: 'fix-port', locked: before.locked });
    await tx.commit(record);
  }
  const backups = await tx.listBackups();
  assert.equal(backups.length, 2); assert.equal(new Set(backups.map(x => x.name)).size, 2);
  assert(backups.every(x => x.restorable)); assert.deepEqual(new Set(backups.map(x => x.port)), new Set([DEAD, LIVE]));
});

test('Windows configuration replacement retries only the unchanged owned files and preserves readonly state', {skip:process.platform!=='win32'},async t=>{
  for(const locked of [false,true])await t.test(locked?'readonly':'writable',async t=>{
    const f=await fixture(t);if(locked)await chmod(f.file,0o444);
    let attempts=0,afterReplace=0,validations=0;const diagnostics=[];
    f.system.renameEnv=async(from,to)=>{if(++attempts<=2)throw Object.assign(new Error('fixture private text'),{code:'EPERM',syscall:'rename'});await rename(from,to);};
    f.system.onError=info=>diagnostics.push(info);
    f.system.hook=async({phase})=>{if(phase==='afterReplace')afterReplace++;};
    const tx=createNetfixTransaction(f.settings),before=await tx.inspect();
    const record=await tx.change({before,bytes:patchNetfixPort(before.bytes,LIVE),action:'fix-port',validate:async()=>{validations++;},isAuthorized:()=>true});
    await tx.commit(record);
    assert.equal(attempts,3);assert.equal(afterReplace,1);assert(validations>=3);
    assert.deepEqual(await readFile(f.file),patchNetfixPort(original,LIVE));assert.equal((await tx.inspect()).locked,locked);
    assert.equal(f.calls.length,0,'the disk retry must not replay probes or business work');
    assert(diagnostics.some(x=>x.code==='EPERM'&&x.operation==='rename'&&x.syscall==='rename'));
    assert(!JSON.stringify(diagnostics).includes('private text'));await f.assertProtected();
  });
});

test('persistent configuration denial stops at six attempts and safely restores a temporary readonly unlock', {skip:process.platform!=='win32'},async t=>{
  for(const locked of [false,true])await t.test(locked?'readonly':'writable',async t=>{
    const f=await fixture(t);if(locked)await chmod(f.file,0o444);
    let attempts=0;f.system.renameEnv=async()=>{attempts++;throw Object.assign(new Error('fixture denial'),{code:'EACCES',syscall:'rename'});};
    f.system.onError=()=>{throw new Error('observer must not break recovery');};
    const tx=createNetfixTransaction(f.settings),before=await tx.inspect();
    await assert.rejects(tx.change({before,bytes:patchNetfixPort(before.bytes,LIVE),action:'fix-port',isAuthorized:()=>true}),e=>e.code==='EACCES'&&e.rollback?.ok===true);
    assert.equal(attempts,6);assert.deepEqual(await readFile(f.file),original);assert.equal((await tx.inspect()).locked,locked);
    assert.equal((await tx.recover()).pending,false);await f.assertProtected();
  });
});

test('configuration retry stops for foreign target, temporary data or recovery journal changes', {skip:process.platform!=='win32'},async t=>{
  for(const kind of ['target','temp','journal'])await t.test(kind,async t=>{
    const f=await fixture(t),tx=createNetfixTransaction(f.settings),before=await tx.inspect();
    const foreign=Buffer.from('KEEP_FOREIGN_'+kind+'\n');let attempts=0,changedPath;
    f.system.renameEnv=async(from,to)=>{
      attempts++;changedPath=kind==='target'?to:kind==='temp'?from:tx.journalPath;
      await writeFile(changedPath,foreign);throw Object.assign(new Error('fixture sharing'),{code:'EPERM',syscall:'rename'});
    };
    await assert.rejects(tx.change({before,bytes:patchNetfixPort(before.bytes,LIVE),action:'fix-port',isAuthorized:()=>true}),e=>e.rollback?.ok===(kind==='temp'));
    assert.equal(attempts,1);assert.deepEqual(await readFile(changedPath),foreign,'foreign data must not be overwritten or deleted');
    assert.deepEqual(await readFile(f.file),kind==='target'?foreign:original);await f.assertProtected();
  });
});

test('a metadata retry preserves a temporary file whose contents were replaced externally', {skip:process.platform!=='win32'},async t=>{
  const foreign=Buffer.from('KEEP_FOREIGN_METADATA_TEMP\n');let changedPath,attempts=0;
  const f=await fixture(t,{system:{renameMetadata:async(from,to)=>{
    if(path.basename(to).startsWith('netfix-backups-')){attempts++;changedPath=from;await writeFile(from,foreign);throw Object.assign(new Error('fixture sharing'),{code:'EPERM'});}
    await rename(from,to);
  }}});
  const tx=createNetfixTransaction(f.settings),before=await tx.inspect();
  await assert.rejects(tx.change({before,bytes:patchNetfixPort(before.bytes,LIVE),action:'fix-port'}),e=>e.rollback?.ok===true);
  assert.equal(attempts,1);assert.deepEqual(await readFile(changedPath),foreign);assert.deepEqual(await readFile(f.file),original);
});

test('a prepared transaction never mistakes an external readonly change for its own write',async t=>{
  for(const action of ['fix-port','lock','unlock'])await t.test(action,async t=>{
    const f=await fixture(t,{system:{permissionFingerprint:async()=> 'unchanged-windows-acl'}});
    const wasLocked=action!=='lock';if(wasLocked)await chmod(f.file,0o444);
    const tx=createNetfixTransaction(f.settings),before=await tx.inspect();
    f.system.hook=async({phase})=>{if(phase==='beforeReplace')await chmod(f.file,wasLocked?0o666:0o444);};
    await assert.rejects(tx.change({before,bytes:action==='fix-port'?patchNetfixPort(before.bytes,LIVE):undefined,action,locked:action==='lock',isAuthorized:()=>true}),e=>e.rollback?.ok===false);
    assert.deepEqual(await readFile(f.file),original);assert.equal((await tx.inspect()).locked,!wasLocked,'foreign readonly state must remain untouched');
    assert.equal((await tx.recover()).ok,false,'a prepared record must not claim an unproved attribute write');
  });
});

test('a synchronous final authorization gate protects file and attribute writes after asynchronous checks',async t=>{
  for(const action of ['fix-port','lock','unlock'])await t.test(action,async t=>{
    const f=await fixture(t);if(action==='unlock')await chmod(f.file,0o444);
    const tx=createNetfixTransaction(f.settings),before=await tx.inspect();let writes=0,gates=0;
    f.system.renameEnv=async(from,to)=>{writes++;await rename(from,to);};
    const isAuthorized=()=>++gates<(action==='fix-port'?2:1);
    await assert.rejects(tx.change({before,bytes:action==='fix-port'?patchNetfixPort(before.bytes,LIVE):undefined,action,locked:action==='lock',isAuthorized}),e=>e.message==='plan_expired'&&e.rollback?.ok===true);
    assert.equal(writes,0);assert.deepEqual(await readFile(f.file),original);assert.equal((await tx.inspect()).locked,before.locked);
  });
});

test('cancellation during a configuration sharing backoff stops before another rename and restores readonly', {skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);await chmod(f.file,0o444);
  const tx=createNetfixTransaction(f.settings),before=await tx.inspect(),controller=new AbortController();let attempts=0;
  f.system.renameEnv=async()=>{attempts++;controller.abort();throw Object.assign(new Error('fixture busy'),{code:'EBUSY',syscall:'rename'});};
  await assert.rejects(tx.change({before,bytes:patchNetfixPort(before.bytes,LIVE),action:'fix-port',signal:controller.signal,isAuthorized:()=>true}),e=>e.message==='cancelled'&&e.rollback?.ok===true);
  assert.equal(attempts,1);assert.deepEqual(await readFile(f.file),original);assert.equal((await tx.inspect()).locked,true);
});

test('Windows journal and backup-index metadata retry transient sharing denials safely', { skip: process.platform !== 'win32' }, async t => {
  for (const kind of ['journal', 'index']) await t.test(kind, async t => {
    let attempts = 0, denied = 0; const hooks = [];
    const matches = file => path.basename(file).startsWith(kind === 'journal' ? 'netfix-pending-' : 'netfix-backups-');
    const f = await fixture(t, { system: {
      renameMetadata: async (source, target) => {
        if (matches(target) && ++attempts <= 2) { denied++; throw Object.assign(new Error('Injected metadata sharing failure'), { code: 'EPERM' }); }
        return rename(source, target);
      },
      hook: async value => { if (value.phase === 'beforeMetadataReplace' && value.kind === kind) hooks.push(value.attempt); }
    } });
    const tx = createNetfixTransaction(f.settings), before = await tx.inspect();
    const record = await tx.change({ before, action: kind === 'journal' ? 'lock' : 'fix-port', bytes: kind === 'index' ? patchNetfixPort(before.bytes, LIVE) : undefined, locked: kind === 'journal' ? true : before.locked });
    await tx.commit(record);
    assert.equal(denied, 2); assert(attempts >= 3 && attempts <= 6); assert.deepEqual(hooks.slice(0, 3), [0, 1, 2]);
    assert.deepEqual(await readFile(f.file), kind === 'journal' ? original : patchNetfixPort(original, LIVE));
    assert.equal(Boolean((await stat(f.file)).mode & 0o200), kind !== 'journal');
    if (kind === 'index') assert((await tx.listBackups()).some(x => x.restorable && x.port === DEAD));
  });
});

test('persistent Windows metadata denial is bounded and restores contents and original readonly state', { skip: process.platform !== 'win32' }, async t => {
  for (const kind of ['journal', 'index']) await t.test(kind, async t => {
    let attempts = 0;
    const matches = file => path.basename(file).startsWith(kind === 'journal' ? 'netfix-pending-' : 'netfix-backups-');
    const f = await fixture(t, { system: { renameMetadata: async (source, target) => {
      if (matches(target)) { attempts++; throw Object.assign(new Error('Injected persistent metadata denial'), { code: 'EACCES' }); }
      return rename(source, target);
    } } });
    const tx = createNetfixTransaction(f.settings), before = await tx.inspect(); let failure;
    await assert.rejects(tx.change({ before, action: kind === 'journal' ? 'lock' : 'fix-port', bytes: kind === 'index' ? patchNetfixPort(before.bytes, LIVE) : undefined, locked: kind === 'journal' ? true : before.locked }), error => { failure = error; return true; });
    assert.equal(attempts, 6); assert.equal(failure.code, 'EACCES'); assert.equal(failure.rollback?.ok, true, 'failed metadata persistence must retain successful compensation evidence');
    assert.deepEqual(await readFile(f.file), original); assert.equal(Boolean((await stat(f.file)).mode & 0o200), true);
    assert.equal((await tx.recover()).ok, true); assert.equal(f.calls.length, 0);
  });
});

test('metadata retries preserve an external journal replacement or backup index created during the wait', { skip: process.platform !== 'win32' }, async t => {
  for (const kind of ['journal', 'index']) await t.test(kind, async t => {
    let attempts = 0, foreignBytes, foreignPath;
    const matches = file => path.basename(file).startsWith(kind === 'journal' ? 'netfix-pending-' : 'netfix-backups-');
    const f = await fixture(t, { system: { renameMetadata: async (source, target) => {
      if (matches(target)) {
        attempts++;
        if (attempts === 1) {
          foreignPath = target;
          if (kind === 'journal') {
            const prior = JSON.parse(await readFile(target, 'utf8'));
            foreignBytes = Buffer.from(JSON.stringify({ ...prior, id: '00000000-0000-4000-8000-000000000001', foreign: 'KEEP_EXTERNAL_JOURNAL' }));
            await rm(target); await writeFile(target, foreignBytes, { flag: 'wx' });
          } else {
            foreignBytes = Buffer.from('{"version":1,"items":[],"foreign":"KEEP_EXTERNAL_INDEX"}');
            await writeFile(target, foreignBytes, { flag: 'wx' });
          }
          throw Object.assign(new Error('External writer appeared while metadata was locked'), { code: 'EPERM' });
        }
      }
      return rename(source, target);
    } } });
    const tx = createNetfixTransaction(f.settings), before = await tx.inspect(); let failure;
    await assert.rejects(tx.change({ before, action: kind === 'journal' ? 'lock' : 'fix-port', bytes: kind === 'index' ? patchNetfixPort(before.bytes, LIVE) : undefined, locked: kind === 'journal' ? true : before.locked }), error => { failure = error; return true; });
    assert.equal(attempts, 1, 'the second CAS check must abort before another replacement attempt');
    assert.deepEqual(await readFile(foreignPath), foreignBytes, 'foreign metadata must stay byte-identical');
    assert.deepEqual(await readFile(f.file), original, 'metadata conflicts never replace dotenv contents');
    assert.equal(failure.rollback?.ok, kind === 'index', 'a foreign journal blocks rollback rather than claiming ownership');
    if (kind === 'index') assert.equal(Boolean((await stat(f.file)).mode & 0o200), true);
    assert.equal(f.calls.length, 0);
  });
});

test('linked configuration files never become writable repair targets', async t => {
  const f = await fixture(t), target = path.join(f.directory, 'linked-target.env');
  await writeFile(target, original); await rm(f.file);
  await link(target, f.file);
  await assert.rejects(createNetfixTransaction(f.settings).inspect(), /unsafe/);
  const diagnosis = await diagnose(f.service); assert.match(diagnosis.verdict.tag, /证据不足/);
  await assert.rejects(f.service.preview({ action: 'fix-port' })); assert.deepEqual(await readFile(target), original);
});

test('symbolic configuration links are rejected when the OS permits creating the fixture', async t => {
  const f = await fixture(t), target = path.join(f.directory, 'symlink-target.env');
  await writeFile(target, original); await rm(f.file);
  try { await symlink(target, f.file, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows denied symbolic-link creation privilege for this temporary fixture'); return; }
    throw error;
  }
  await assert.rejects(createNetfixTransaction(f.settings).inspect(), /unsafe/);
  assert.deepEqual(await readFile(target), original);
});
