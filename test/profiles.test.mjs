import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createProfileStore } from '../src/profiles.mjs';
import { coreValidationFailure } from '../src/managed-core.mjs';

test('validated import, explicit activation and atomic failed update', async () => {
  await mkdir(path.join(process.cwd(), 'outputs', 'working'), { recursive: true });
  const directory = await mkdtemp(path.join(process.cwd(), 'outputs', 'working', 'clash-profile-test-'));
  let response = 'valid: one\n';
  let running = null;
  let rejectApply = false;
  const validateConfig = async p => { if (!(await readFile(p, 'utf8')).startsWith('valid:')) throw Error('invalid'); };
  const applyConfig = async p => { if (rejectApply) throw Error('must not leak private link'); running = await readFile(p, 'utf8'); };
  const fetchImpl = async () => new Response(response, { status: 200 });
  try {
    const store = createProfileStore({directory, validateConfig, applyConfig, fetchImpl});
    const first = await store.addUrl({name:'订阅 A', url:'https://example.com/sub?token=private-token'});
    assert.equal(first.active, false);
    assert.equal(running, null);
    const list = await store.list();
    assert.equal(JSON.stringify(list).includes('private-token'), false);
    assert.equal(JSON.stringify(list).includes('https://'), false);
    await store.activate(first.id);
    assert.equal(running, 'valid: one\n');
    response = 'not a valid config';
    await assert.rejects(store.edit(first.id, {name:'修改后',url:'https://example.org/new?token=replacement'}), /内核校验/);
    assert.equal((await store.list()).profiles[0].name, '订阅 A');
    await assert.rejects(store.update(first.id), /内核校验/);
    assert.equal(running, 'valid: one\n');
    assert.equal((await store.list()).activeId, first.id);
    assert.match((await store.list()).profiles[0].lastError, /内核校验/);
    assert.equal((await readdir(path.join(directory,'files'))).length, 1);
    response = 'valid: two\n';
    rejectApply = true;
    await assert.rejects(store.update(first.id), /旧配置文件已保留/);
    assert.equal(running, 'valid: one\n');
    rejectApply = false;
    await store.update(first.id);
    assert.equal(running, 'valid: two\n');
    assert.equal((await readdir(path.join(directory,'files'))).length, 1);
    await assert.rejects(store.remove(first.id), /先切换/);
    const second = await store.addLocal({name:'本地配置', content:'valid: local\n'});
    assert.equal(running, 'valid: two\n');
    await store.activate(second.id);
    await store.remove(first.id);
    assert.equal((await store.list()).activeId, second.id);
    assert.equal(running, 'valid: local\n');
    const reopened = createProfileStore({directory, validateConfig, applyConfig, fetchImpl});
    assert.equal((await reopened.list()).activeId, second.id);
    await reopened.edit(second.id, {name:'新名字', url:''});
    running = null;
    await reopened.restoreActive();
    assert.equal(running, 'valid: local\n');
    assert.equal((await reopened.list()).profiles[0].name, '新名字');
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('rejects unsafe input, invalid candidate and oversized downloads', async () => {
  await mkdir(path.join(process.cwd(), 'outputs', 'working'), { recursive: true });
  const directory = await mkdtemp(path.join(process.cwd(), 'outputs', 'working', 'clash-profile-test-'));
  const make = fetchImpl => createProfileStore({directory, validateConfig:async()=>{}, applyConfig:async()=>{}, fetchImpl});
  try {
    const store = make(async()=>new Response('<html>not a profile</html>', {status:200}));
    await assert.rejects(store.addUrl({name:'x', url:'file:///etc/passwd'}), /HTTP/);
    await assert.rejects(store.addUrl({name:'x', url:'https://user:pass@example.com/'}), /用户名/);
    await assert.rejects(store.addUrl({name:'x', url:'https://example.com/'}), /网页/);
    await assert.rejects(store.addLocal({name:'x', content:'x'.repeat(5 * 1024 * 1024 + 1)}), /超过/);
    const oversize = make(async()=>new Response('a', {status:200, headers:{'content-length':String(5 * 1024 * 1024 + 1)}}));
    await assert.rejects(oversize.addUrl({name:'x', url:'https://example.com/'}), /超过/);
    let observedRedirect;
    const redirected = make(async(_url, options)=> { observedRedirect = options.redirect; return new Response(null, {status:302, headers:{location:'http://127.0.0.1/private?token=hidden'}}); });
    await assert.rejects(redirected.addUrl({name:'x',url:'https://example.com/'}), error=>/最终订阅地址/.test(error.message) && !error.message.includes('127.0.0.1'));
    assert.equal(observedRedirect,'manual');
    // Inject a shorter timeout without actually issuing a network request.
    const fast = createProfileStore({directory, validateConfig:async()=>{}, applyConfig:async()=>{}, timeoutMs:10, fetchImpl:(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('secret'))))});
    await assert.rejects(fast.addUrl({name:'x',url:'https://example.com/?token=private'}), error => /超时/.test(error.message) && !error.message.includes('private'));
    const unsupported = createProfileStore({directory, validateConfig:async()=>{throw Object.assign(new Error('暂不支持包含远程代理集或规则集的配置。'),{status:400});}, applyConfig:async()=>{}});
    await assert.rejects(unsupported.addLocal({name:'x',content:'proxy-providers: {}'}), /暂不支持包含远程代理集或规则集/);
    assert.equal((await store.list()).profiles.length, 0);
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('requests Clash-compatible subscription format without exposing validator details', async () => {
  await mkdir(path.join(process.cwd(), 'outputs', 'working'), { recursive: true });
  const directory = await mkdtemp(path.join(process.cwd(), 'outputs', 'working', 'clash-profile-test-'));
  let receivedHeaders;
  const validateConfig = async () => { throw Object.assign(new Error('配置 YAML 格式无效或包含暂不支持的标签。'), {status:400}); };
  const fetchImpl = async (_url, options) => { receivedHeaders = options.headers; return new Response('bad: content\n', {status:200}); };
  try {
    const store = createProfileStore({directory, validateConfig, applyConfig:async()=>{}, fetchImpl});
    await assert.rejects(store.addUrl({name:'测试',url:'https://example.com/sub?token=secret'}), error=>
      /YAML 格式无效/.test(error.message) && !error.message.includes('secret'));
    assert.match(receivedHeaders['User-Agent'], /Clash\.Meta/i);
    assert.equal((await store.list()).profiles.length,0);
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('recognizes unsupported share-link feeds without exposing subscription contents', async () => {
  await mkdir(path.join(process.cwd(), 'outputs', 'working'), { recursive: true });
  const directory = await mkdtemp(path.join(process.cwd(), 'outputs', 'working', 'clash-profile-test-'));
  const validateConfig = async () => { throw Error('private validator output'); };
  let body = 'trojan://password-secret@example.test:443#example';
  const fetchImpl = async () => new Response(body,{status:200});
  try {
    const store = createProfileStore({directory,validateConfig,applyConfig:async()=>{},fetchImpl});
    for (const text of [body,Buffer.from(body).toString('base64')]) {
      body=text;
      await assert.rejects(store.addUrl({name:'测试',url:'https://example.com/sub?token=secret'}), error=>
        /节点链接列表/.test(error.message) && !/secret|example/.test(error.message));
    }
    assert.equal((await store.list()).profiles.length,0);
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('validator safe categories retain timeout status and mask all unknown messages', async () => {
  await mkdir(path.join(process.cwd(), 'outputs', 'working'), { recursive: true });
  const directory = await mkdtemp(path.join(process.cwd(), 'outputs', 'working', 'clash-profile-test-'));
  let msg = '配置校验超时，请稍后重试。';
  const validateConfig = async () => { throw Object.assign(new Error(msg), {status:504}); };
  const store = createProfileStore({directory,validateConfig,applyConfig:async()=>{}});
  try {
    await assert.rejects(store.addLocal({name:'测试',content:'proxies: []'}), error => error.status === 504 && error.message === msg);
    msg = '原始内核错误 https://example.invalid/?token=secret';
    await assert.rejects(store.addLocal({name:'测试',content:'proxies: []'}), error => error.status === 422 && !/secret|example/.test(error.message));
    msg = '订阅中的线路、策略组或规则无法通过校验，请检查配置。';
    await assert.rejects(store.addLocal({name:'测试',content:'proxies: []'}), error => error.status === 504 && error.message === msg);
    assert.equal((await store.list()).profiles.length,0);
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test('actual core failure categories survive profile import without disclosing core output', async t => {
  const directory = await mkdtemp(path.join(process.cwd(), 'outputs', 'working', 'clash-profile-test-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const secret = 'credential-secret-never-display';
  let output;
  const store = createProfileStore({directory, applyConfig:async()=>{}, validateConfig:async()=>{
    throw coreValidationFailure({code:1,stdout:output});
  }});
  for (const [text, expected] of [
    ['load GeoSite data error, base error: list ' + secret + ' not found in geosite.dat', /地理规则分类在本机数据库中不存在/],
    ['load GeoSite data error: geosite.dat unexpected EOF ' + secret, /无法加载.*地理规则数据库/],
    ['proxy 0: cipher: ' + secret + ' initialize error: unknown method', /加密方式或密钥参数/],
    ['unrecognized internal failure ' + secret, /配置校验失败/]
  ]) {
    output = text;
    await assert.rejects(store.addLocal({name:'测试',content:'mode: rule\nrules: []'}), error =>
      error.status === 422 && expected.test(error.message) && !error.message.includes(secret));
  }
  assert.equal((await store.list()).profiles.length, 0);
  assert.equal((await readdir(path.join(directory,'files'))).length, 0);
});
