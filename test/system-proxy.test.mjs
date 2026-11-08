import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSystemProxy } from '../src/system-proxy.mjs';

test('系统代理只恢复本软件仍拥有的值，并保留原始设置', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clash-proxy-test-'));
  const original = {enable:{present:true,value:1},server:{present:true,value:'old.example:8080'}};
  let actual = structuredClone(original), writes = 0;
  const adapter = {read:async()=>structuredClone(actual),write:async value=>{writes++;actual=structuredClone(value);}};
  try {
    const proxy = createSystemProxy({directory:dir,adapter});
    assert.equal((await proxy.enable(18990)).managed,true);
    assert.equal(actual.server.value,'127.0.0.1:18990');
    await assert.rejects(() => proxy.enable(18991), /先关闭/);
    assert.deepEqual(await proxy.restoreOnExit(),{restored:true});
    assert.deepEqual(actual,original);
    await proxy.enable(18990);
    actual.server.value = 'other-app:9999';
    const count = writes;
    assert.equal((await proxy.getStatus()).externalChanged,true);
    assert.deepEqual(await proxy.disable(),{restored:false,reason:'changed-externally'});
    assert.equal(writes,count);
    assert.equal(actual.server.value,'other-app:9999');
    await assert.rejects(()=>proxy.enable(18990),/其他程序/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('没有所有权时禁用不会更改现有系统代理', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clash-proxy-test-'));
  let writes=0;
  const adapter={read:async()=>({enable:{present:true,value:1},server:{present:true,value:'other:8888'}}),write:async()=>{writes++;}};
  try { const proxy=createSystemProxy({directory:dir,adapter}); assert.deepEqual(await proxy.disable(),{restored:false,reason:'not-managed'}); assert.equal(writes,0); }
  finally { await rm(dir,{recursive:true,force:true}); }
});

test('写入失败并伴随外部改动时不覆盖其他程序的代理', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clash-proxy-test-'));
  let actual = {enable:{present:true,value:0},server:{present:false,value:null}}, writes=0;
  const adapter={read:async()=>structuredClone(actual),write:async()=>{writes++;actual={enable:{present:true,value:1},server:{present:true,value:'other:8080'}};throw new Error('write failed');}};
  try {
    const proxy=createSystemProxy({directory:dir,adapter});
    await assert.rejects(()=>proxy.enable(19000),/write failed/);
    assert.equal(writes,1);
    assert.equal(actual.server.value,'other:8080');
    assert.equal((await proxy.getStatus()).externalChanged,true);
    assert.deepEqual(await proxy.restoreOnExit(),{restored:false,reason:'changed-externally'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});
