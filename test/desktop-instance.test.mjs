import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { acquireDesktopInstance,runDesktopInstance } from '../src/desktop-instance.mjs';
import { createDesktopSession,recordDesktopRecoverySession } from '../src/desktop.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'susu-desktop-instance-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return directory;
}

test('concurrent launches elect one primary and notify it through actual IPC',async t=>{
  const directory=await fixture(t);let opens=0;
  const outcomes=await Promise.allSettled(Array.from({length:12},()=>acquireDesktopInstance({directory,onOpen:()=>opens++})));
  const leases=outcomes.filter(item=>item.status==='fulfilled').map(item=>item.value);
  t.after(()=>Promise.all(leases.map(lease=>lease.close())));
  assert.deepEqual(outcomes.filter(item=>item.status==='rejected').map(item=>String(item.reason)+' '+item.reason.cause),[]);
  assert.equal(leases.filter(lease=>lease.primary).length,1);
  assert.equal(opens,11);
});

test('a duplicate launch only opens the existing session and does not start another server',async t=>{
  const directory=await fixture(t),started=gate(),exit=gate();let starts=0,opens=0;
  const primary=runDesktopInstance({directory,onOpen:()=>opens++,run:async()=>{starts++;started.resolve();await exit.promise;}});
  t.after(()=>{exit.resolve();return primary;});
  await started.promise;
  const duplicate=await runDesktopInstance({directory,run:async()=>assert.fail('duplicate must not reach startServer')});
  assert.equal(duplicate.primary,false);assert.equal(starts,1);assert.equal(opens,1);
  exit.resolve();await primary;
  await runDesktopInstance({directory,run:async()=>{starts++;}});
  assert.equal(starts,2);
});

test('startup failure closes the lease and permits a fresh primary',async t=>{
  const directory=await fixture(t);let starts=0;
  await assert.rejects(runDesktopInstance({directory,run:async()=>{
    const session=createDesktopSession({startServerFn:async()=>{starts++;throw Error('fixture startup failed');},preferences:{},trayFactory:()=>assert.fail('no tray before server'),openWindow:()=>assert.fail('no window before server')});
    await session.start();
  }}),/fixture startup failed/);
  await runDesktopInstance({directory,run:async()=>{starts++;}});
  assert.equal(starts,2);
});

test('an unacknowledged existing instance never authorizes a second application',async t=>{
  const directory=await fixture(t);
  const primary=await acquireDesktopInstance({directory,onOpen:()=>{throw Error('fixture notification failed');}});
  t.after(()=>primary.close());
  assert.equal(primary.primary,true);
  await assert.rejects(runDesktopInstance({directory,run:async()=>assert.fail('uncertain ownership cannot startServer')}),/尚未确认退出/);
});

test('the primary retains its lease until application shutdown finishes',async t=>{
  const directory=await fixture(t),started=gate(),closing=gate(),closed=gate();let session;
  const primary=runDesktopInstance({directory,run:async()=>{
    session=createDesktopSession({
      startServerFn:async()=>({url:'http://127.0.0.1/fixture',close:async()=>{closing.resolve();await closed.promise;}}),
      preferences:{get:async()=>({closeToTray:true})},trayFactory:()=>({start:async()=>{},stop:async()=>{}}),
      openWindow:()=>{const window=new EventEmitter();window.kill=()=>{};return window;}
    });
    await session.start();started.resolve();await session.waitForExit();await session.shutdown();
  }});
  t.after(()=>{closed.resolve();return primary;});
  await started.promise;const shutdown=session.shutdown();await closing.promise;
  assert.equal((await runDesktopInstance({directory,run:async()=>assert.fail('shutdown still owns the lease')})).primary,false);
  closed.resolve();await shutdown;await primary;
  await runDesktopInstance({directory,run:async()=>{}});
});

test('open requests reuse an existing window and reopen a tray-only session',async()=>{
  let openCount=0;const windows=[];
  const session=createDesktopSession({startServerFn:async()=>({url:'http://127.0.0.1/fixture',close:async()=>{}}),
    preferences:{get:async()=>({closeToTray:true})},trayFactory:()=>({start:async()=>{},stop:async()=>{}}),
    openWindow:()=>{openCount++;const window=new EventEmitter();window.kill=()=>{};windows.push(window);return window;}
  });
  await session.start();session.showWindow();assert.equal(openCount,1);
  windows[0].emit('exit',0,null);await Promise.resolve();session.showWindow();assert.equal(openCount,2);
  await session.shutdown();
});

test('failed application shutdown retains instance ownership until a confirmed retry',async t=>{
  const directory=await fixture(t),started=gate(),windows=[];let session,failClose=true;const errors=[];
  const primary=runDesktopInstance({directory,onOpen:()=>session?.showWindow(),run:async()=>{
    session=createDesktopSession({startServerFn:async()=>({url:'http://127.0.0.1/fixture',close:async()=>{if(failClose)throw Error('fixture close failed');}}),
      preferences:{get:async()=>({closeToTray:true})},trayFactory:()=>({start:async()=>{},stop:async()=>{}}),
      openWindow:()=>{const window=new EventEmitter();window.kill=()=>{window.emit('exit',0,null);};windows.push(window);return window;},onError:error=>errors.push(error.message)
    });
    await session.start();started.resolve();await session.waitForExit();
  }});
  t.after(async()=>{failClose=false;await session?.shutdown();await primary;});
  await started.promise;assert.equal(windows.length,1);assert.equal(await session.shutdown(),false);assert.match(errors[0],/退出尚未完成/);
  assert.equal((await runDesktopInstance({directory,run:async()=>assert.fail('unconfirmed close still owns the lease')})).primary,false);
  assert.equal(windows.length,2,'the retained instance reopens its existing service after failed shutdown');
  failClose=false;assert.equal(await session.shutdown(),true);await primary;
  await runDesktopInstance({directory,run:async()=>{}});
});

test('shutdown during server initialization waits for and closes the resulting application',async()=>{
  const entered=gate(),ready=gate();let appClosed=0;
  const session=createDesktopSession({startServerFn:async()=>{entered.resolve();await ready.promise;return {close:async()=>{appClosed++;}};},preferences:{},
    trayFactory:()=>assert.fail('shutdown must not start a tray'),openWindow:()=>assert.fail('shutdown must not open a window')
  });
  const startup=session.start();await entered.promise;const shutdown=session.shutdown();
  let completed=false;void session.waitForExit().then(()=>{completed=true;});await Promise.resolve();assert.equal(completed,false);
  ready.resolve();await startup;assert.equal(await shutdown,true);assert.equal(appClosed,1);
});

test('restart-helper record failure keeps the running server available and owned by the desktop session',async t=>{
  const directory=await fixture(t),errors=[];let closes=0,windows=0,helperReady;
  await mkdir(path.join(directory,'recovery-session.json'));
  const app={url:'http://127.0.0.1/fixture',close:async()=>{closes++;}};
  const session=createDesktopSession({
    startServerFn:async()=>{helperReady=await recordDesktopRecoverySession(app,{directory,onError:error=>errors.push(error.message)});return app;},
    preferences:{get:async()=>({closeToTray:true})},trayFactory:()=>({start:async()=>{},stop:async()=>{}}),
    openWindow:()=>{windows++;const window=new EventEmitter();window.kill=()=>{};return window;}
  });
  t.after(()=>session.shutdown());
  await session.start();
  assert.equal(helperReady,false);assert.equal(windows,1);assert.equal(closes,0);
  assert.deepEqual(errors,['恢复助手会话记录未能保存，客户端继续运行，暂不能自动重开客户端。']);
  assert.equal(await session.shutdown(),true);assert.equal(closes,1);
});
