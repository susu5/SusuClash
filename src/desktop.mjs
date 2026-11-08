import { spawn } from 'node:child_process';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { defaultDataDir } from './managed-core.mjs';
import { createTray, createTrayPreferences } from './tray.mjs';

const windowHost = fileURLToPath(new URL('../runtime/webview2/SusuClashWindow.exe', import.meta.url));

// Dependency injection keeps lifecycle tests isolated from the Windows desktop.
export function createDesktopSession({startServerFn, openWindow, trayFactory, preferences, onError = () => {}}) {
  let app, tray, window, shuttingDown = false, finished, trayAvailable = false;
  const completed = new Promise(resolve => { finished = resolve; });
  let closePromise;
  function shutdown() {
    if (closePromise) return closePromise;
    shuttingDown = true;
    preferences.setAvailability?.(false);
    closePromise = (async () => {
      try { window?.kill(); } catch { /* The window may already be closed. */ }
      try { await tray?.stop(); } catch (error) { onError(error); }
      try { await app?.close(); } catch (error) { onError(error); }
      finished();
    })();
    return closePromise;
  }
  function showWindow() {
    if (shuttingDown || window) return;
    let handle;
    try { handle = openWindow(app.url); }
    catch (error) { onError(error); void shutdown(); return; }
    window = handle;
    handle.once('error', error => { if (window === handle) window = null; onError(error); void shutdown(); });
    handle.once('exit', (code, signal) => {
      if (window === handle) window = null;
      if (shuttingDown) return;
      // Exit 11 means the native host already displayed a descriptive error.
      if (code !== 0 || signal) { if (code !== 11) onError(new Error('应用窗口异常关闭。')); void shutdown(); return; }
      if (!trayAvailable) { void shutdown(); return; }
      void preferences.get().then(settings => { if (!settings.closeToTray) return shutdown(); }).catch(error => { onError(error); return shutdown(); });
    });
  }
  async function start() {
    try {
      app = await startServerFn({trayPreferences:preferences});
      tray = trayFactory({onOpen:showWindow,onExit:()=>void shutdown(),onFailure:error=>{preferences.setAvailability?.(false);onError(error);void shutdown();}});
      try { await tray.start(); trayAvailable = true; preferences.setAvailability?.(true); }
      catch (error) {
        preferences.setAvailability?.(false);
        onError(error);
        try { await tray.stop(); } catch { /* Continue with a normal window. */ }
        tray = null;
      }
      showWindow();
    } catch (error) { await shutdown(); throw error; }
  }
  return {start,shutdown,waitForExit:()=>completed};
}

async function main() {
  if (process.argv.includes('--server-only')) {
    const app = await startServer();
    console.log(app.url);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close());
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
  let session;
  try {
    session = createDesktopSession({
      startServerFn:startServer, preferences, trayFactory:createTray,
      // The executable is a GUI binary, so no console is created. Do not set
      // windowsHide here: that can hide its actual top-level window.
      openWindow:url => spawn(windowHost, [url, profile, String(process.pid)], {stdio:'ignore'}),
      onError:error => { console.error(error.message); if (error.message === '应用窗口异常关闭。' || error.code === 'ENOENT') showLaunchError(); }
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void session?.shutdown(); });
    await session.start();
    await session.waitForExit();
  } finally {
    await session?.shutdown();
    const target = await realpath(profile).catch(() => null);
    if (target && path.dirname(target) === temp && path.basename(target).startsWith(profilePrefix)) {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 }).catch(() => {});
    }
  }
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
