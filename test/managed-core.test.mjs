import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { createManagedCore, safeRuntimeConfig, coreValidationFailure } from '../src/managed-core.mjs';

async function lifecycleFixture(t, {beforeReady, failsAtLaunch = false, lateFatal = false, noMixed = false, afterLaunch} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(),'clash-lifecycle-'));
  const runtimeDirectory = path.join(directory,'bundled');
  await mkdir(runtimeDirectory);
  await writeFile(path.join(directory,'active.yaml'),'mode: rule\nproxies: []\nrules: [MATCH,DIRECT]\n');
  const children = [];
  const cores = [];
  const launch = (_binary,args,options) => {
    assert.deepEqual(options.stdio,['ignore','pipe','pipe']);
    const child = new EventEmitter();
    child.pid = 12345 + children.length;
    child.exitCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let server, mixed;
    let finished = false;
    child.finish = (code = 0, signal = null, lateOutput = null) => {
      if (finished) return;
      finished = true;
      child.exitCode = code;
      const exited = () => {
        child.emit('exit',code,signal);
        const drained = () => {if(lateOutput)child.stderr.write(lateOutput);child.stdout.end();child.stderr.end();child.emit('close',code,signal);};
        if (lateOutput) setTimeout(drained,30); else drained();
      };
      const servers = [server,mixed].filter(Boolean);
      if (servers.length) void Promise.all(servers.map(item=>new Promise(resolve=>{item.closeAllConnections?.();item.close(resolve);}))).then(exited);
      else queueMicrotask(exited);
    };
    child.kill = () => { child.finish(); return true; };
    children.push(child);
    queueMicrotask(async () => {
      if (failsAtLaunch) {
        const fatal = 'level=error msg="Start Mixed(http+socks) server error: listen tcp: bind: address already in use private-token-node https://secret.example/sub"\n';
        if (!lateFatal) child.stderr.write(fatal);
        child.finish(93,null,lateFatal?fatal:null);
        return;
      }
      await beforeReady?.(directory);
      const port = Number(args[args.indexOf('-ext-ctl')+1].split(':').at(-1));
      const config = parse(await readFile(path.join(directory,'core','runtime.yaml'),'utf8'));
      const mixedPort = config['mixed-port'];
      if (!noMixed) { mixed=net.createServer(socket=>socket.destroy()); mixed.listen(mixedPort,'127.0.0.1'); }
      server = http.createServer((req,res) => { res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/configs'?{'mixed-port':mixedPort}:{version:'fixture-1'})); });
      server.listen(port,'127.0.0.1');
      await afterLaunch?.({directory,child,children,config});
    });
    return child;
  };
  const create = () => {const core = createManagedCore({directory,runtimeDirectory,binary:process.execPath,launch,testFile:async()=>{}});cores.push(core);return core;};
  t.after(async () => {
    for (const core of cores) await core.stop();
    for (const child of children) child.finish();
    await rm(directory,{recursive:true,force:true});
  });
  return {directory,children,create};
}

test('the first automatic proxy port is saved only after readiness and reused by a new core', async t => {
  const fixture = await lifecycleFixture(t);
  const first = fixture.create();
  await first.start();
  const saved = JSON.parse(await readFile(path.join(fixture.directory,'port.json'),'utf8'));
  assert(saved.port > 0);
  assert.equal((await first.preferences()).expectedPort,saved.port);
  await first.stop();
  const reopened = fixture.create();
  await reopened.start();
  assert.equal((await reopened.preferences()).expectedPort,saved.port);
  const runtime = parse(await readFile(path.join(fixture.directory,'core','runtime.yaml'),'utf8'));
  assert.equal(runtime['mixed-port'],saved.port);
});

test('failure to save the automatic port stops the newly ready core and preserves failure evidence', async t => {
  const fixture = await lifecycleFixture(t,{beforeReady:directory=>mkdir(path.join(directory,'port.json'))});
  const core = fixture.create();
  await assert.rejects(core.start(),/无法保存代理端口/);
  assert.equal(core.status().state,'error');
  assert.equal(core.processId(),null);
  assert.equal(fixture.children[0].exitCode,0);
  const log = JSON.parse(await readFile(path.join(fixture.directory,'core','lifecycle.json'),'utf8'));
  assert.equal(log.entries.at(-1).phase,'startup_failed');
  assert.match(log.entries.at(-1).reason,/无法保存代理端口/);
});

test('automatic port persistence preserves a port setting created by another writer during startup', async t => {
  const external = JSON.stringify({port:12345,external:true});
  const fixture = await lifecycleFixture(t,{beforeReady:directory=>writeFile(path.join(directory,'port.json'),external)});
  const core = fixture.create();
  await assert.rejects(core.start(),/无法保存代理端口/);
  assert.equal(core.status().state,'error');
  assert.equal(core.processId(),null);
  assert.equal(fixture.children[0].exitCode,0);
  assert.equal(await readFile(path.join(fixture.directory,'port.json'),'utf8'),external);
});

test('startup and later core exits retain fixed reasons and exit codes without raw output', async t => {
  const failed = await lifecycleFixture(t,{failsAtLaunch:true,lateFatal:true});
  const failedCore = failed.create();
  await assert.rejects(failedCore.start(),/监听端口被占用/);
  assert.equal(failedCore.status().lastFailure.exitCode,93);
  let content = await readFile(path.join(failed.directory,'core','lifecycle.json'),'utf8');
  assert.doesNotMatch(content,/private-token-node|secret\.example/);
  assert.match(content,/startup_failed/);

  const running = await lifecycleFixture(t);
  const core = running.create();
  await core.start();
  running.children[0].finish(17,null,'level=fatal msg="load GeoSite data error, failed to decode geodata file: geosite.dat private-token-node https://secret.example/sub"\n');
  await new Promise(resolve=>running.children[0].once('exit',resolve));
  assert.equal(core.status().state,'error');
  await new Promise(resolve=>running.children[0].once('close',resolve));
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(core.status().message,/地理规则数据库/);
  assert.equal(core.status().lastFailure.exitCode,17);
  await core.stop(); // Also flushes pending diagnostic writes.
  content = await readFile(path.join(running.directory,'core','lifecycle.json'),'utf8');
  assert.doesNotMatch(content,/private-token-node|secret\.example/);
  assert.equal(JSON.parse(content).entries.at(-1).phase,'unexpected_exit');
  const previousFailure = await readFile(path.join(running.directory,'core','last-failure.json'),'utf8');
  const reopened = running.create();
  await reopened.start();
  assert.equal(await readFile(path.join(running.directory,'core','last-failure.json'),'utf8'),previousFailure);
});

test('normal provider names and connection errors do not override verified core readiness or invent an exit cause', async t => {
  const fixture = await lifecycleFixture(t,{afterLaunch:({child})=>{
    for (const level of ['info','warning','warn','error']) {
      const message = 'Start initial compatible provider unsupported protocol private-token-node level=fatal msg="load GeoSite data error"';
      const line = 'time="2026-11-17T00:00:00Z" level='+level+' msg='+JSON.stringify(message)+'\n';
      child.stdout.write(line.slice(0,51));child.stdout.write(line.slice(51));
    }
    child.stderr.write('untrusted provider text unsupported protocol bind failed private-token-node\n');
  }});
  const core = fixture.create();
  assert.equal((await core.start()).state,'running');
  assert.equal(core.status().lastFailure,null);
  fixture.children[0].finish(33);
  await new Promise(resolve=>fixture.children[0].once('close',resolve));
  await core.stop();
  assert.equal(core.status().lastFailure.reason,'内核意外退出');
  const content=await readFile(path.join(fixture.directory,'core','last-failure.json'),'utf8');
  assert.doesNotMatch(content,/private-token-node|unsupported protocol|GeoSite/);
});

test('the fixed mixed-listener bind failure rejects even a responding controller and occupied TCP entry', async t => {
  const fixture=await lifecycleFixture(t,{afterLaunch:({child})=>{
    child.stderr.write('time="2026-11-17T00:00:00Z" level=error msg="Start Mixed(http+socks) server error: listen tcp 127.0.0.1:12345: bind: Only one usage of each socket address private-token-node"\n');
  }});
  const core=fixture.create();
  await assert.rejects(core.start(),/监听端口被占用/);
  assert.equal(core.processId(),null);assert.equal(fixture.children[0].exitCode,0);
  await assert.rejects(readFile(path.join(fixture.directory,'port.json')),error=>error.code==='ENOENT');
});

test('a real top-level fatal record prevents readiness without exposing unknown raw text', async t => {
  const fixture=await lifecycleFixture(t,{afterLaunch:({child})=>{
    child.stderr.write('time="2026-11-17T00:00:00Z" level=fatal msg="unknown private-token-node https://secret.example/sub"\n');
  }});
  const core=fixture.create();
  await assert.rejects(core.start(),/内核发生致命错误/);
  assert.equal(core.processId(),null);
  assert.doesNotMatch(JSON.stringify(core.status()),/private-token-node|secret\.example/);
});

test('diagnostic persistence failure does not turn a healthy core into startup failure', async t => {
  const fixture = await lifecycleFixture(t,{beforeReady:directory=>mkdir(path.join(directory,'core','lifecycle.json'))});
  const core = fixture.create();
  assert.equal((await core.start()).state,'running');
  await core.stop();
  assert.equal(core.status().state,'stopped');
});

test('a responding controller without its mixed listener is never accepted or persisted', async t => {
  const fixture = await lifecycleFixture(t,{noMixed:true,afterLaunch:({child})=>{setTimeout(()=>child.finish(28),350);}});
  const core = fixture.create();
  await assert.rejects(core.start(),/启动期间退出/);
  assert.equal(core.processId(),null);
  await assert.rejects(readFile(path.join(fixture.directory,'port.json')),error=>error.code==='ENOENT');
});

test('failure to save active configuration stops the new core before restarting the previous one', async t => {
  const fixture = await lifecycleFixture(t,{afterLaunch:async({directory,children})=>{
    const active = path.join(directory,'active.yaml');
    const held = path.join(directory,'active-held.yaml');
    if (children.length === 2) { await rename(active,held);await mkdir(active); }
    if (children.length === 3) {
      assert.equal(children[1].exitCode,0,'rollback must wait for the candidate to exit');
      await rm(active,{recursive:true});await rename(held,active);
    }
  }});
  const core = fixture.create();
  await core.start();
  const candidate = path.join(fixture.directory,'candidate.yaml');
  await writeFile(candidate,'mode: direct\nproxies: []\nrules: [MATCH,DIRECT]\n');
  await assert.rejects(core.applyConfig(candidate));
  assert.equal(fixture.children.length,3);
  assert.equal(fixture.children[0].exitCode,0);
  assert.equal(fixture.children[1].exitCode,0);
  assert.equal(core.status().state,'running');
  assert.equal(parse(await readFile(path.join(fixture.directory,'core','runtime.yaml'),'utf8')).mode,'rule');
  assert.equal(parse(await readFile(path.join(fixture.directory,'active.yaml'),'utf8')).mode,'rule');
});

test('a saved proxy port occupied by another listener is never silently replaced', async t => {
  const fixture = await lifecycleFixture(t);
  const blocker = net.createServer();
  await new Promise((resolve,reject)=>blocker.once('error',reject).listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>blocker.close(resolve)));
  const port = blocker.address().port;
  await writeFile(path.join(fixture.directory,'port.json'),JSON.stringify({port}));
  const core = fixture.create();
  await assert.rejects(core.start(),error=>error.status===409);
  assert.equal(fixture.children.length,0);
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.directory,'port.json'),'utf8')),{port});
});

test('validation failures are classified without exposing raw output or credentials', () => {
  const secret = 'fixture-secret-do-not-display';
  const cases = [
    [{ code:1, stderr:'proxy 0: unsupport proxy type: ' + secret }, /不支持的节点协议/],
    [{ code:1, stdout:'proxy 0: ' + secret + ' has unset fields: password' }, /缺少必要信息/],
    [{ code:1, stderr:'rule parse failed: ' + secret }, /策略组或规则/],
    [{ code:1, stderr:'yaml: unmarshal errors: ' + secret }, /字段与内核格式不匹配/],
    [{ code:1, stdout:'rules[0] [GEOSITE,' + secret + ',DIRECT] error: load GeoSite data error, failed to decode geodata file: geosite.dat, base error: list ' + secret + ' not found in geosite.dat' }, /地理规则分类在本机数据库中不存在/],
    [{ code:1, stderr:'load GeoIP data error, failed to decode geodata file: geoip.dat, base error: list ' + secret + ' not found in geoip.dat' }, /地理规则分类在本机数据库中不存在/],
    [{ code:1, stderr:'load GeoSite data error, failed to decode geodata file: geosite.dat, base error: unexpected EOF ' + secret }, /无法加载.*地理规则数据库/],
    [{ code:1, stdout:'proxy 0: ss ' + secret + ' cipher: invalid initialize error: unknown method: invalid' }, /加密方式或密钥参数/],
    [{ code:1, stderr:'rules[12] [DOMAIN,' + secret + ',missing] error: target does not exist' }, /策略组或规则/],
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

test('runtime preprocessing accepts the download byte limit and rejects invalid content explicitly', () => {
  // A large comment exercises the byte boundary without creating a huge YAML object.
  const limit = 5 * 1024 * 1024;
  const prefix = 'mode: rule\nrules: []\n#';
  const content = prefix + 'a'.repeat(limit - Buffer.byteLength(prefix));
  assert.match(safeRuntimeConfig(content, 0), /mixed-port: 0/);
  assert.throws(() => safeRuntimeConfig(content + 'a', 0), error => error.status === 413 && /超过 5 MiB/.test(error.message));
  assert.throws(() => safeRuntimeConfig('mode: rule\0', 0), /内容无效/);
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

test('runtime always collects connection ownership regardless of imported process mode', () => {
  for (const value of ['off', 'strict', 'always', 'false', 'unexpected']) {
    const config = parse(safeRuntimeConfig(`mode: rule\nfind-process-mode: ${value}\nFIND-PROCESS-MODE: off\nFind-Process-Mode: strict\nproxies: []\nrules: [MATCH,DIRECT]\n`, 12345));
    assert.equal(config['find-process-mode'], 'always');
    assert.deepEqual(Object.keys(config).filter(key => /^find-process-mode$/i.test(key)), ['find-process-mode']);
    assert.equal(config.mode, 'rule');
    assert.equal(config['mixed-port'], 12345);
    assert.deepEqual(config.proxies, []);
    assert.deepEqual(config.rules, ['MATCH', 'DIRECT']);
  }
  const merged = parse(safeRuntimeConfig('defaults: &defaults\n  find-process-mode: off\n  FIND-PROCESS-MODE: strict\n  mode: global\n<<: *defaults\nproxies: []\nrules: [MATCH,DIRECT]\n', 23456));
  assert.equal(merged['find-process-mode'], 'always');
  assert.deepEqual(Object.keys(merged).filter(key => /^find-process-mode$/i.test(key)), ['find-process-mode']);
  assert.equal(merged.mode, 'global');
  assert.deepEqual(merged.rules, ['MATCH', 'DIRECT']);
  assert.equal(parse(safeRuntimeConfig('mode: direct\nrules: []\n', 34567))['find-process-mode'], 'always');
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
