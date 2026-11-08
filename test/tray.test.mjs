import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createTray, createTrayPreferences } from '../src/tray.mjs';
import { createDesktopSession } from '../src/desktop.mjs';

const next=()=>new Promise(resolve=>setImmediate(resolve));

test('tray preferences default to stay and persist explicit changes', async()=>{
  const root=path.join(process.cwd(),'outputs','working'); await mkdir(root,{recursive:true});
  const dir=await mkdtemp(path.join(root,'tray-test-'));
  try {
    const settings=createTrayPreferences({directory:dir});
    assert.deepEqual(await settings.get(),{closeToTray:true,available:null});
    await assert.rejects(settings.set({closeToTray:false}),/不可用/);
    settings.setAvailability(true);
    await settings.set({closeToTray:false});
    assert.deepEqual(await createTrayPreferences({directory:dir}).get(),{closeToTray:false,available:null});
    await assert.rejects(settings.set({closeToTray:'false'}),/boolean/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('closing window remains in tray, reopening works, explicit exit cleans server', async()=>{
  let callbacks, appClosed=0, trayStopped=0; const windows=[];
  const preferences={get:async()=>({closeToTray:true})};
  const session=createDesktopSession({preferences,
    startServerFn:async input=>{assert.equal(input.trayPreferences,preferences);return {url:'http://example.test/',close:async()=>{appClosed++;}};},
    trayFactory:options=>{callbacks=options;return {start:async()=>{},stop:async()=>{trayStopped++;}};},
    openWindow:()=>{const win=new EventEmitter();win.kill=()=>{};windows.push(win);return win;}
  });
  await session.start(); windows[0].emit('exit',0,null); await next();
  assert.equal(appClosed,0); callbacks.onOpen(); assert.equal(windows.length,2);
  callbacks.onExit(); await session.waitForExit();
  assert.equal(appClosed,1); assert.equal(trayStopped,1);
  await session.shutdown(); assert.equal(appClosed,1);
});

test('close-to-tray off and tray helper failure both clean up', async()=>{
  for (const failure of [false,true]) {
    let callbacks, appClosed=0, trayStopped=0, window;
    const session=createDesktopSession({preferences:{get:async()=>({closeToTray:false})},
      startServerFn:async()=>({url:'x',close:async()=>{appClosed++;}}),
      trayFactory:options=>{callbacks=options;return {start:async()=>{},stop:async()=>{trayStopped++;}};},
      openWindow:()=>{window=new EventEmitter();window.kill=()=>{};return window;}
    });
    await session.start();
    if(failure) callbacks.onFailure(new Error('tray failed')); else window.emit('exit',0,null);
    await session.waitForExit(); assert.equal(appClosed,1); assert.equal(trayStopped,1);
  }
});

test('tray unavailable at startup opens a normal window and closes cleanly', async()=>{
  let window, appClosed=0, helperStopped=0, availability=null;
  const session=createDesktopSession({preferences:{get:async()=>({closeToTray:true}),setAvailability:value=>{availability=value;}},
    startServerFn:async()=>({url:'x',close:async()=>{appClosed++;}}),
    trayFactory:()=>({start:async()=>{throw Error('unavailable');},stop:async()=>{helperStopped++;}}),
    openWindow:()=>{window=new EventEmitter();window.kill=()=>{};return window;}
  });
  await session.start(); assert(window); assert.equal(helperStopped,1); assert.equal(availability,false);
  window.emit('exit',0,null); await session.waitForExit(); assert.equal(appClosed,1);
});

test('window startup errors stop the session and do not duplicate native error dialogs', async()=>{
  for(const code of [1,11]) {
    let window, appClosed=0, errors=0;
    const session=createDesktopSession({preferences:{get:async()=>({closeToTray:true})},onError:()=>{errors++;},
      startServerFn:async()=>({url:'x',close:async()=>{appClosed++;}}),
      trayFactory:()=>({start:async()=>{},stop:async()=>{}}),
      openWindow:()=>{window=new EventEmitter();window.kill=()=>{};return window;}
    });
    await session.start();window.emit('exit',code,null);await session.waitForExit();
    assert.equal(appClosed,1);assert.equal(errors,code===11?0:1);
  }
});

test('tray helper message protocol and unexpected close', async()=>{
  let opened=0, exited=0, failed=0, fake;
  const launch=()=>{
    fake=new EventEmitter(); fake.stdout=new PassThrough(); fake.stdin=new PassThrough();
    fake.kill=()=>fake.emit('close',null);
    fake.stdin.on('data',chunk=>{if(String(chunk).includes('stop'))fake.emit('close',0);});
    setImmediate(()=>fake.stdout.write('READY\n'));
    return fake;
  };
  const tray=createTray({launch,onOpen:()=>opened++,onExit:()=>exited++,onFailure:()=>failed++});
  await tray.start(); fake.stdout.write('OPEN\nEXIT\n'); await next();
  assert.equal(opened,1); assert.equal(exited,1);
  fake.emit('close',1); await next(); assert.equal(failed,1);
  await tray.stop();
});
