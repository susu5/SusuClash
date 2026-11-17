import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import {startServer} from '../src/server.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

async function fixture(t, {onGroupRead = async () => {}, onConfigure = async () => {}} = {}) {
  const root = path.join(process.cwd(), 'outputs', 'working');
  await mkdir(root, {recursive:true});
  const directory = await mkdtemp(path.join(root, 'backup-context-test-'));
  let scope = 'profile-a', groupReads = 0, app;
  const configured = [];
  let preferences = {autoRepair:false, autoSwitch:false, backups:{}};
  const monitor = {
    invalidate() {}, stop() {},
    status: () => ({phase:'monitoring', preferences:structuredClone(preferences)}),
    configure: async input => {
      configured.push(structuredClone(input));
      await onConfigure(input);
      if ('backups' in input) preferences.backups[JSON.stringify([input.scope,input.group])] = [...input.backups];
      if ('autoSwitch' in input) preferences.autoSwitch = input.autoSwitch;
    }
  };
  const core = {
    directory, applyConfig:async()=>{}, validateConfig:async()=>{},
    status:()=>({state:'running'}), stop:async()=>{},
    call:async (_method, route) => {
      assert.equal(route, '/proxies');
      groupReads++;
      await onGroupRead();
      return {proxies:{Main:{name:'共享策略组',type:'Selector',all:['当前A','备用B'],now:'当前A'}}};
    }
  };
  app = await startServer({core, monitor, dailyUpdate:false,
    profileStore:{restoreActive:async()=>null,list:async()=>({activeId:scope,profiles:[]})},
    systemProxy:{restoreOnExit:async()=>{},getStatus:async()=>({enabled:false,managed:false})},
    proxyPreferences:{get:async()=>({enabled:null,valid:true})},
    connectionDoctor:{isRepairing:()=>false,invalidate(){},close:async()=>{}}
  });
  t.after(async()=>{
    try { await app.close(); }
    finally { await rm(directory,{recursive:true,force:true}); }
  });
  return {
    configured, setScope:value=>{scope=value;}, groupReads:()=>groupReads,
    post:body=>fetch(app.url+'api/automation',{
      method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(body)
    })
  };
}

test('backup save accepts the matching edit scope and preserves its ordered choices', async t=>{
  const f = await fixture(t);
  const response = await f.post({scope:'profile-a',group:'共享策略组',backups:['备用B']});
  assert.equal(response.status,200);
  const result = await response.json();
  assert.equal(result.scope,'profile-a');
  assert.deepEqual(result.backups,['备用B']);
  assert.deepEqual(f.configured,[{scope:'profile-a',group:'共享策略组',backups:['备用B']}]);
});

test('a mismatched or invalid edit scope cannot save into an identically named group', async t=>{
  const f = await fixture(t);
  f.setScope('profile-b');
  for (const scope of ['profile-a',null,42,{},[],'']) {
    const response = await f.post({scope,group:'共享策略组',backups:['备用B']});
    assert.equal(response.status,409);
    assert.match((await response.json()).error,/配置已切换/);
  }
  assert.deepEqual(f.configured,[]);
  assert.equal(f.groupReads(),0);
});

test('a profile changed while group membership is loading blocks backup persistence', async t=>{
  const entered = deferred(), resume = deferred();
  const f = await fixture(t,{onGroupRead:async()=>{entered.resolve();await resume.promise;}});
  t.after(()=>resume.resolve());
  const saving = f.post({scope:'profile-a',group:'共享策略组',backups:['备用B']});
  await entered.promise;
  f.setScope('profile-b');
  resume.resolve();
  const response = await saving;
  assert.equal(response.status,409);
  assert.match((await response.json()).error,/配置已切换/);
  assert.deepEqual(f.configured,[]);
});

test('the legacy automation API remains usable without an edit scope', async t=>{
  const f = await fixture(t);
  const response = await f.post({group:'共享策略组',backups:['备用B']});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).backups,['备用B']);
  assert.deepEqual(f.configured,[{scope:'profile-a',group:'共享策略组',backups:['备用B']}]);
});

test('a queued backup save checks its scope when it reaches the mutation queue', async t=>{
  const entered = deferred(), resume = deferred();
  let first = true;
  const f = await fixture(t,{onConfigure:async()=>{
    if (first) { first=false;entered.resolve();await resume.promise; }
  }});
  t.after(()=>resume.resolve());
  const firstSave = f.post({scope:'profile-a',group:'共享策略组',backups:['备用B']});
  await entered.promise;
  const queuedSave = f.post({scope:'profile-a',group:'共享策略组',backups:['备用B']});
  f.setScope('profile-b');
  resume.resolve();
  assert.equal((await firstSave).status,200);
  const response = await queuedSave;
  assert.equal(response.status,409);
  assert.equal(f.configured.length,1);
  assert.equal(f.groupReads(),1);
});
