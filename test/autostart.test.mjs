import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutostart, defaultAutostartCommand } from '../src/autostart.mjs';

function mock(initial = null) {
  let value = initial, writes = 0, deletes = 0;
  return {
    read:async()=>value,
    set:async expected=>{ if (value !== null && value !== expected) throw Error('conflict'); value = expected; writes++; },
    remove:async expected=>{ if (value !== null && value !== expected) throw Error('conflict'); if (value === expected) {value = null; deletes++;} },
    change:next=>{value=next;}, counts:()=>({writes,deletes,value})
  };
}

test('explicit enable and disable only modify our own startup value', async () => {
  const adapter=mock(), command='"C:\\app\\powershell.exe" -File "C:\\app\\launch.ps1"';
  const start=createAutostart({adapter,command});
  assert.deepEqual(await start.getStatus(),{enabled:false,conflict:false});
  assert.deepEqual(await start.enable(),{enabled:true,conflict:false});
  await start.enable(); assert.equal(adapter.counts().writes,1);
  assert.deepEqual(await start.disable(),{enabled:false,conflict:false});
  await start.disable(); assert.equal(adapter.counts().deletes,1);
  assert.match(defaultAutostartCommand(), /autostart-launch\.ps1/);
});

test('never overwrites or deletes a same-name value owned by someone else', async () => {
  const adapter=mock('other launcher'), start=createAutostart({adapter,command:'our launcher'});
  assert.deepEqual(await start.getStatus(),{enabled:false,conflict:true});
  await assert.rejects(start.enable(),/不属于本软件/);
  await assert.rejects(start.disable(),/已被修改/);
  assert.deepEqual(adapter.counts(),{writes:0,deletes:0,value:'other launcher'});
});

test('rechecks ownership in the adapter if another writer changes the value', async () => {
  let value='ours';
  const adapter={read:async()=>value,set:async()=>{},remove:async expected=>{value='other launcher';if(value!==expected)throw Error('conflict'); value=null;}};
  const start=createAutostart({adapter,command:'ours'});
  await assert.rejects(start.disable(),/conflict/);
  assert.equal(value,'other launcher');
});
