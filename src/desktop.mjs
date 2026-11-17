import {prepareClientRestart} from './recovery-helper.mjs';
import { spawn } from 'node:child_process';
import { access, mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { defaultDataDir } from './managed-core.mjs';
import { createTray, createTrayPreferences } from './tray.mjs';
import { runDesktopInstance } from './desktop-instance.mjs';
import { AppError } from './mihomo.mjs';

const windowHost = fileURLToPath(new URL('../runtime/webview2/SusuClashWindow.exe', import.meta.url));

// Failure of the optional restart helper must not orphan an already running
// server or prevent the normal desktop from opening.
export async function recordDesktopRecoverySession(app, {directory=defaultDataDir,onError=()=>{}}={}) {
  try {
    await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,'recovery-session.json'),JSON.stringify({pid:process.pid,node:process.execPath,url:app.url,startedAt:new Date(Date.now()-process.uptime()*1000).toISOString()}),{mode:0o600});
    return true;
  } catch {
    onError(new Error('恢复助手会话记录未能保存，客户端继续运行，暂不能自动重开客户端。'));
    return false;
  }
}

// Dependency injection keeps lifecycle tests isolated from the Windows desktop.
export function createDesktopSession({startServerFn, openWindow, trayFactory, preferences, onError = () => {}}) {
  let app, tray, window, shuttingDown = false, finished, trayAvailable = false;
  const completed = new Promise(resolve => { finished = resolve; });
  let closePromise;
  let startupFinished = Promise.resolve();
  function shutdown() {
    if (closePromise) return closePromise;
    shuttingDown = true;
    preferences.setAvailability?.(false);
    closePromise = (async () => {
      await startupFinished;
      const closingWindow=window;window=null;
      try { closingWindow?.kill(); } catch { /* The window may already be closed. */ }
      try { await tray?.stop(); } catch (error) { onError(error); }
      try { await app?.close(); }
      catch {
        tray=null;trayAvailable=false;shuttingDown=false;closePromise=null;
        onError(new Error('客户端退出尚未完成，仍保留运行实例。请重试正常退出。'));
        return false;
      }
      finished();
      return true;
    })();
    return closePromise;
  }
  function showWindow() {
    if (shuttingDown || window || !app) return;
    let handle;
    try { handle = openWindow(app.url); }
    catch (error) { onError(error); void shutdown(); return; }
    window = handle;
    handle.once('error', error => { if (window !== handle) return; window = null; onError(error); void shutdown(); });
    handle.once('exit', (code, signal) => {
      if (window !== handle) return;
      window = null;
      if (shuttingDown) return;
      // Exit 11 means the native host already displayed a descriptive error.
      if (code !== 0 || signal) { if (code !== 11) onError(new Error('应用窗口异常关闭。')); void shutdown(); return; }
      if (!trayAvailable) { void shutdown(); return; }
      void preferences.get().then(settings => { if (!settings.closeToTray) return shutdown(); }).catch(error => { onError(error); return shutdown(); });
    });
  }
  async function start() {
    if (shuttingDown) return;
    let finishStartup, failure;
    startupFinished = new Promise(resolve=>{finishStartup=resolve;});
    try {
      app = await startServerFn({trayPreferences:preferences});
      if (!shuttingDown) {
        tray = trayFactory({onOpen:showWindow,onExit:()=>void shutdown(),onFailure:error=>{preferences.setAvailability?.(false);onError(error);void shutdown();}});
        try { await tray.start(); trayAvailable = true; preferences.setAvailability?.(true); }
        catch (error) {
          preferences.setAvailability?.(false);
          onError(error);
          try { await tray.stop(); } catch { /* Continue with a normal window. */ }
          tray = null;
        }
        showWindow();
      }
    } catch (error) { failure=error; }
    finally { finishStartup(); }
    if (failure) { await shutdown(); throw failure; }
    if (shuttingDown) await shutdown();
  }
  return {start,shutdown,showWindow,waitForExit:()=>completed};
}

async function main() {
  let session, recoverySessionReady=false;
  return runDesktopInstance({directory:defaultDataDir,onOpen:()=>session?.showWindow(),run:async()=>{
  if (process.argv.includes('--server-only')) {
    const app = await startServer();
    console.log(app.url);
    let close;
    try {
      await new Promise(resolve=>{
        let closing;
        close=()=>{closing ??= app.close().then(resolve,()=>{closing=null;console.error('客户端退出尚未完成，仍保留运行实例。');});};
        for (const signal of ['SIGINT','SIGTERM']) process.on(signal,close);
      });
    } finally { for (const signal of ['SIGINT','SIGTERM']) process.removeListener(signal,close); }
    return;
  }
  try { await access(windowHost); }
  catch {
    showLaunchError();
    throw new Error('窗口组件缺失，请重新安装 SusuClash。');
  }
  const temp = await realpath(os.tmpdir());
  const profilePrefix = 'susuclash-webview-';
  const profile = await mkdtemp(path.join(temp, profilePrefix));
  const preferences = createTrayPreferences({directory:defaultDataDir});
  const shutdown=()=>{void session?.shutdown();};
  try {
    session = createDesktopSession({
      startServerFn:async options=>{
        const app=await startServer({...options,restartClient:async()=>{
          if(!recoverySessionReady)throw new AppError('恢复助手会话记录未就绪，暂不能自动重开客户端。',503);
          const ready=await prepareClientRestart(defaultDataDir);setTimeout(()=>void session.shutdown(),500);return ready;
        }});
        recoverySessionReady=await recordDesktopRecoverySession(app,{onError:error=>console.error(error.message)});
        return app;
      }, preferences, trayFactory:createTray,
      // The executable is a GUI binary, so no console is created. Do not set
      // windowsHide here: that can hide its actual top-level window.
      openWindow:url => spawn(windowHost, [url, profile, String(process.pid)], {stdio:'ignore'}),
      onError:error => { console.error(error.message); if (error.message === '应用窗口异常关闭。' || error.code === 'ENOENT') showLaunchError(); }
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal,shutdown);
    await session.start();
    await session.waitForExit();
  } finally {
    if (await session?.shutdown() === false) await session.waitForExit();
    for (const signal of ['SIGINT','SIGTERM']) process.removeListener(signal,shutdown);
    const target = await realpath(profile).catch(() => null);
    if (target && path.dirname(target) === temp && path.basename(target).startsWith(profilePrefix)) {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 }).catch(() => {});
    }
  }
  }});
}

function showLaunchError() {
  if (process.platform !== 'win32') return;
  // Fixed literal only; never include URLs or private configuration in shell text.
  const command = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('SusuClash 窗口无法启动。请确认已安装 Microsoft Edge WebView2 Runtime，并重新安装或启动应用。','SusuClash','OK','Error') | Out-Null";
  const executable=path.win32.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawn(executable,['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:'ignore'});
  child.on('error',()=>{});
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
