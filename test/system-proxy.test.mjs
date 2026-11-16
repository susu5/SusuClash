import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSystemProxy, ProxyError, windowsProxyAdapter } from '../src/system-proxy.mjs';

const disabled = () => ({enable:{present:true,value:0},server:{present:false,value:null}});
const external = () => ({enable:{present:true,value:1},server:{present:true,value:'other-app:8080'}});
const applied = port => ({enable:{present:true,value:1},server:{present:true,value:'127.0.0.1:' + port}});
const proxyError = code => error => error instanceof ProxyError && error.code === code && [400,409,503].includes(error.status);

async function fixture(t, original = disabled()) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clash-proxy-test-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  let actual = structuredClone(original);
  const writes = [];
  const adapter = {
    read:async () => structuredClone(actual),
    write:async (value, {expected} = {}) => {
      if (expected) assert.deepEqual(actual, expected, 'writes must be conditional on the sampled state');
      writes.push(structuredClone(value));
      actual = structuredClone(value);
    }
  };
  const recordPath = path.join(dir, 'owned-system-proxy.json');
  return {
    proxy:createSystemProxy({directory:dir,adapter}), adapter, writes, recordPath,
    get actual() { return structuredClone(actual); },
    set actual(value) { actual = structuredClone(value); },
    record:async () => JSON.parse(await readFile(recordPath, 'utf8')),
    noRecord:() => assert.rejects(readFile(recordPath), {code:'ENOENT'})
  };
}

test('owned enable is idempotent and disable restores the exact original disabled settings', async t => {
  const original = {enable:{present:true,value:0},server:{present:true,value:'old.example:8080'}};
  const f = await fixture(t, original);
  assert.equal((await f.proxy.enable(18990)).managed, true);
  assert.equal((await f.proxy.enable(18990)).port, 18990);
  assert.equal(f.writes.length, 1);
  await assert.rejects(f.proxy.enable(18991), proxyError('migrate'));
  assert.deepEqual(await f.proxy.restoreOnExit(), {restored:true});
  assert.deepEqual(f.actual, original);
  await f.noRecord();
});

test('an enabled foreign proxy without ownership is neither enabled over nor disabled', async t => {
  const original = external(), f = await fixture(t, original);
  await assert.rejects(f.proxy.enable(19000), proxyError('external'));
  assert.deepEqual(await f.proxy.disable(), {restored:false,reason:'not-managed'});
  assert.deepEqual(f.actual, original);
  assert.equal(f.writes.length, 0);
  await f.noRecord();
});

test('a stale record no longer blocks a new enable after the proxy has been disabled elsewhere', async t => {
  const f = await fixture(t);
  await f.proxy.enable(19000);
  const newBaseline = {enable:{present:true,value:0},server:{present:true,value:'external-disabled:7897'}};
  f.actual = newBaseline;
  assert.equal((await f.proxy.getStatus()).externalChanged, true);
  assert.equal((await f.proxy.enable(19001)).port, 19001);
  assert.deepEqual((await f.record()).before, newBaseline);
  await f.proxy.disable();
  assert.deepEqual(f.actual, newBaseline);
  await f.noRecord();
});

test('a stale record is also retired when settings have already returned to the original snapshot', async t => {
  const original = disabled(), f = await fixture(t, original);
  await f.proxy.enable(19000);
  f.actual = original;
  await f.proxy.enable(19001);
  assert.deepEqual((await f.record()).before, original);
  assert.equal(f.actual.server.value, '127.0.0.1:19001');
});

test('enabled foreign settings preserve both their values and the old ownership record', async t => {
  const f = await fixture(t);
  await f.proxy.enable(19000);
  const record = await f.record(), original = external();
  f.actual = original;
  await assert.rejects(f.proxy.enable(19001), proxyError('external'));
  assert.deepEqual(await f.proxy.disable(), {restored:false,reason:'changed-externally'});
  assert.deepEqual(f.actual, original);
  assert.deepEqual(await f.record(), record);
  assert.equal(f.writes.length, 1);
});

test('the state is sampled again after retiring a stale record and a newly enabled foreign proxy is protected', async t => {
  const f = await fixture(t);
  await f.proxy.enable(19000);
  f.actual = disabled();
  const read = f.adapter.read;
  let reads = 0;
  f.adapter.read = async () => {
    if (++reads === 2) f.actual = external();
    return read();
  };
  await assert.rejects(f.proxy.enable(19001), proxyError('external'));
  assert.deepEqual(f.actual, external());
  assert.equal(f.writes.length, 1);
  await f.noRecord();
});

test('a write that fails before changing anything leaves no unused recovery record or raw error details', async t => {
  const f = await fixture(t);
  f.adapter.write = async () => { throw new Error('PRIVATE_REGISTRY_PATH'); };
  await assert.rejects(f.proxy.enable(19000), error => proxyError('write')(error) && !error.message.includes('PRIVATE'));
  assert.deepEqual(f.actual, disabled());
  await f.noRecord();
});

test('a notification failure after applying the desired settings rolls back and verifies the original state', async t => {
  const f = await fixture(t), write = f.adapter.write;
  f.adapter.write = async (...args) => {
    await write(...args);
    if (f.writes.length === 1) throw new ProxyError('refresh');
  };
  await assert.rejects(f.proxy.enable(19000), proxyError('refresh'));
  assert.deepEqual(f.writes, [applied(19000), disabled()]);
  assert.deepEqual(f.actual, disabled());
  await f.noRecord();
});

test('a transient readback failure after writing also rolls back before reporting failure', async t => {
  const f = await fixture(t), read = f.adapter.read;
  let reads = 0;
  f.adapter.read = async () => {
    if (++reads === 2) throw new Error('PRIVATE_READ_ERROR');
    return read();
  };
  await assert.rejects(f.proxy.enable(19000), proxyError('read'));
  assert.deepEqual(f.actual, disabled());
  assert.deepEqual(f.writes, [applied(19000), disabled()]);
  await f.noRecord();
});

test('an external change during a failed write is retained without a rollback write', async t => {
  const f = await fixture(t);
  f.adapter.write = async () => { f.actual = external(); throw new Error('PRIVATE_WRITE_ERROR'); };
  await assert.rejects(f.proxy.enable(19000), proxyError('write'));
  assert.deepEqual(f.actual, external());
  assert.equal(f.writes.length, 0);
  assert.equal((await f.proxy.getStatus()).externalChanged, true);
  assert.deepEqual(await f.proxy.restoreOnExit(), {restored:false,reason:'changed-externally'});
  assert.deepEqual((await f.record()).applied, applied(19000));
});

test('a readback that shows foreign values does not trigger a rollback over those values', async t => {
  const f = await fixture(t), read = f.adapter.read;
  let reads = 0;
  f.adapter.read = async () => {
    if (++reads === 2) f.actual = external();
    return read();
  };
  await assert.rejects(f.proxy.enable(19000), proxyError('verify'));
  assert.deepEqual(f.actual, external());
  assert.equal(f.writes.length, 1);
  assert.equal((await f.proxy.getStatus()).recoveryAvailable, true);
});

test('a failed rollback retains the durable record until a later verified recovery', async t => {
  const f = await fixture(t), write = f.adapter.write;
  let calls = 0;
  f.adapter.write = async (...args) => {
    calls++;
    if (calls === 2) throw new Error('rollback failed');
    await write(...args);
    if (calls === 1) throw new ProxyError('refresh');
  };
  await assert.rejects(f.proxy.enable(19000), proxyError('rollback'));
  assert.deepEqual(f.actual, applied(19000));
  assert.deepEqual((await f.record()).before, disabled());
  f.adapter.write = write;
  assert.deepEqual(await f.proxy.restoreOnExit(), {restored:true});
  assert.deepEqual(f.actual, disabled());
  await f.noRecord();
});

test('failed rollback notification retains a record even after registry values returned to their baseline', async t => {
  const f = await fixture(t), write = f.adapter.write;
  f.adapter.write = async (...args) => { await write(...args); throw new ProxyError('refresh'); };
  await assert.rejects(f.proxy.enable(19000), proxyError('rollback'));
  assert.deepEqual(f.actual, disabled());
  assert.deepEqual((await f.record()).before, disabled());
  f.adapter.write = write;
  assert.deepEqual(await f.proxy.restoreOnExit(), {restored:false,reason:'not-applied'});
  await f.noRecord();
});

test('corrupt recovery records block writes with a safe fixed error', async t => {
  const f = await fixture(t);
  await writeFile(f.recordPath, 'PRIVATE_BAD_JSON');
  await assert.rejects(f.proxy.enable(19000), proxyError('record'));
  assert.equal(f.writes.length, 0);
  assert.equal(await readFile(f.recordPath, 'utf8'), 'PRIVATE_BAD_JSON');
});

test('the Windows adapter preserves UTF-8 values, sends an expected snapshot and maps process errors safely', async t => {
  if (process.platform !== 'win32') return t.skip('Windows adapter');
  const value = {enable:{present:true,value:0},server:{present:true,value:'本机旧设置:7897'}};
  let captured;
  const adapter = windowsProxyAdapter({executeFile:async (_exe,args,options) => {
    assert.equal(options.encoding, 'utf8');
    if (args.at(-1) === 'read') return {stdout:'\uFEFF' + JSON.stringify(value)};
    captured = JSON.parse(Buffer.from(args.at(-1), 'base64').toString('utf8'));
    return {stdout:''};
  }});
  assert.deepEqual(await adapter.read(), value);
  await adapter.write(applied(19000), {expected:value});
  assert.deepEqual(captured, {state:applied(19000),expected:value});
  for (const [stderr,code] of [['PRIVATE_ERROR','write'],['SC_PROXY_CHANGED','changed'],['SC_PROXY_REFRESH_FAILED','refresh']]) {
    const broken = windowsProxyAdapter({executeFile:async () => { throw Object.assign(new Error('PRIVATE_COMMAND'), {stderr}); }});
    await assert.rejects(broken.write(applied(19000)), error => proxyError(code)(error) && !error.message.includes('PRIVATE'));
  }
});

test('the PowerShell write path checks expected values and both notifications against an isolated fake registry', async t => {
  if (process.platform !== 'win32') return t.skip('PowerShell 5.1');
  const source = await readFile(new URL('../src/system-proxy.ps1', import.meta.url), 'utf8');
  const open = "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, ($Action -eq 'write'))";
  assert(source.includes(open));
  const run = promisify(execFile);
  for (const scenario of [
    {expected:disabled(),notify:true,code:null,writes:2,calls:2},
    {expected:external(),notify:true,code:'SC_PROXY_CHANGED',writes:0,calls:0},
    {expected:disabled(),notify:false,code:'SC_PROXY_REFRESH_FAILED',writes:2,calls:2}
  ]) {
    const mockHelper = `    Add-Type -TypeDefinition 'using System; public static class ProxyRefresh { public static int Calls; public static bool InternetSetOption(IntPtr h, int o, IntPtr b, int l) { Calls++; return ${scenario.notify}; } }'`;
    const isolated = source.replace(open, '$key = $global:proxyTestKey')
      .replace(/^\s*Add-Type -TypeDefinition[^\r\n]+/m, mockHelper);
    // Refuse to execute unless both native effects have been removed entirely.
    assert(!isolated.includes('[Microsoft.Win32.Registry]::CurrentUser'));
    assert(!isolated.includes('DllImport'));
    assert(!isolated.includes('wininet.dll'));
    const payload = Buffer.from(JSON.stringify({state:applied(19000),expected:scenario.expected}), 'utf8').toString('base64');
    const wrapper = `
class ProxyTestKey {
  [hashtable]$Values = @{ProxyEnable=0}
  [int]$Writes = 0
  [string[]]GetValueNames() { return [string[]]$this.Values.Keys }
  [object]GetValue([string]$name) { return $this.Values[$name] }
  [void]SetValue([string]$name,[object]$value,[Microsoft.Win32.RegistryValueKind]$kind) { $this.Writes++; $this.Values[$name]=$value }
  [void]DeleteValue([string]$name,[bool]$throwOnMissing) { $this.Writes++; $this.Values.Remove($name) }
  [void]Flush() {}
  [void]Close() {}
}
$global:proxyTestKey = [ProxyTestKey]::new()
$failure = $null
try { & { ${isolated} } -Action write -Payload '${payload}' } catch { $failure = $_.Exception.Message }
@{error=$failure;writes=$global:proxyTestKey.Writes;calls=[ProxyRefresh]::Calls;values=$global:proxyTestKey.Values} | ConvertTo-Json -Compress -Depth 4
`;
    const encoded = Buffer.from(wrapper, 'utf16le').toString('base64');
    const {stdout} = await run(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'), ['-NoProfile','-NonInteractive','-EncodedCommand',encoded], {windowsHide:true,timeout:10000,encoding:'utf8'});
    const result = JSON.parse(stdout.trim());
    assert.equal(result.error, scenario.code);
    assert.equal(result.writes, scenario.writes);
    assert.equal(result.calls, scenario.calls);
    assert.equal(result.values.ProxyEnable, scenario.writes ? 1 : 0);
    assert.equal(result.values.ProxyServer, scenario.writes ? '127.0.0.1:19000' : undefined);
  }
});
