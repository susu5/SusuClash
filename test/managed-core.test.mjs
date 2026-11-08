import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createManagedCore, safeRuntimeConfig, coreValidationFailure } from '../src/managed-core.mjs';

test('validation failures are classified without exposing raw output or credentials', () => {
  const secret = 'fixture-secret-do-not-display';
  const cases = [
    [{ code:1, stderr:'proxy 0: unsupport proxy type: ' + secret }, /不支持的节点协议/],
    [{ code:1, stdout:'proxy 0: ' + secret + ' has unset fields: password' }, /缺少必要信息/],
    [{ code:1, stderr:'rule parse failed: ' + secret }, /策略组或规则/],
    [{ code:1, stderr:'yaml: unmarshal errors: ' + secret }, /字段与内核格式不匹配/],
    [{ code:'ENOENT', stderr:secret }, /代理内核无法启动/],
    [{ code:'ETIMEDOUT', stderr:secret }, /校验超时/],
    [{ code:1, stderr:secret }, /配置校验失败/]
  ];
  for (const [error, expected] of cases) {
    const failure = coreValidationFailure(error);
    assert.match(failure.message, expected);
    assert(!failure.message.includes(secret));
  }
});

test('real validation path classifies inner core failure without returning its output', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clash-validation-error-'));
  t.after(async () => { await rm(dir, {recursive:true,force:true}); });
  const fakeSecret = 'secret-containing-user-data';
  const core = createManagedCore({directory:dir, binary:process.execPath, testFile: async () => {
    throw Object.assign(new Error('fixture internal error'), {code:1, stdout:'proxy 0: unsupport proxy type: ' + fakeSecret});
  }});
  const source = path.join(dir, 'config.yaml');
  await writeFile(source, 'mode: rule\nproxies: []\nrules: [MATCH,DIRECT]\n');
  await assert.rejects(core.validateConfig(source), error => {
    assert.match(error.message, /不支持的节点协议/);
    assert(!error.message.includes(fakeSecret));
    return true;
  });
});

test('configuration blocks externally controlled listeners and TUN', () => {
  const text = safeRuntimeConfig('mode: rule\nallow-lan: true\nexternal-controller: 0.0.0.0:9090\ntun:\n  enable: true\nlisteners:\n - name: exposed\nproxies: []\nrules:\n - MATCH,DIRECT\n', 12345);
  assert.match(text, /allow-lan: false/); assert.doesNotMatch(text, /0\.0\.0\.0|enable: true|name: exposed/);
  assert.match(text, /mixed-port: 12345/); assert.match(text, /enable: false/);
  assert.doesNotMatch(safeRuntimeConfig('"allow-lan": true\nrules: []', 1), /allow-lan: true/);
  assert.throws(() => safeRuntimeConfig('mode: rule\n---\nallow-lan: true', 1), /YAML/);
  assert.throws(() => safeRuntimeConfig('proxy-providers:\n  remote:\n    url: http://127.0.0.1/private\n    path: ../profiles.json\n', 1), /暂不支持/);
  const merged = safeRuntimeConfig('defaults: &defaults\n  allow-lan: true\n  tun: { enable: true }\n<<: *defaults\ndns: {enable: true, listen: "0.0.0.0:53", nameserver: ["1.1.1.1"]}\nproxy-groups: [{name: Test, type: url-test, url: "http://127.0.0.1/private", interval: 1, proxies: [DIRECT]}]\nrules: []\n',12345);
  assert.match(merged, /allow-lan: false/); assert.doesNotMatch(merged,/0\.0\.0\.0:53|127\.0\.0\.1\/private/);
  assert.match(merged,/nameserver:/); assert.match(merged,/interval: 300/);
});

test('owns a local core process and fails closed on bad configuration', async t => {
  if (process.platform !== 'win32') return t.skip('bundled test executable is Windows');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clash-owned-test-'));
  const core = createManagedCore({directory: dir});
  t.after(async () => { await core.stop(); await rm(dir, {recursive:true,force:true}); });
  const config = path.join(dir,'fixture.yaml');
  await writeFile(config, 'mode: rule\ndns:\n  enable: true\n  listen: 0.0.0.0:53\n  nameserver: [system]\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n');
  await core.validateConfig(config);
  await core.applyConfig(config);
  assert.equal(core.status().state,'running');
  const state = await core.call('GET','/configs');
  assert.equal(state.tun.enable,false); assert.equal(state['allow-lan'],false);
  assert(state['mixed-port'] > 0);
  const invalid = path.join(dir,'bad.yaml');
  await writeFile(invalid, 'mode: bad-mode\nrules: []\n');
  await assert.rejects(core.applyConfig(invalid));
  assert.equal(core.status().state, 'running');
});
