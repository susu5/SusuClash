import net from 'node:net';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const instanceMessage = 'open\n';
const acceptedMessage = 'accepted\n';
const unavailable = error => new Error('另一个 SusuClash 实例尚未确认退出，本次未重复启动。',{cause:error?.code});

async function endpointFor(directory) {
  let canonical = await realpath(path.resolve(directory)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return path.resolve(directory);
  });
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0,32);
  return process.platform === 'win32' ? '\\\\.\\pipe\\susuclash-instance-' + digest : path.join(os.tmpdir(),'susuclash-instance-' + digest + '.sock');
}

function notifyOnce(endpoint, timeoutMs) {
  return new Promise((resolve,reject) => {
    const socket = net.createConnection(endpoint);
    let reply = '', settled = false;
    const timer = setTimeout(()=>finish(unavailable()),timeoutMs);
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.once('connect',()=>socket.write(instanceMessage));
    socket.on('data',chunk=>{
      reply += chunk.toString('utf8');
      if (reply === acceptedMessage) finish();
      else if (reply.length >= acceptedMessage.length || !acceptedMessage.startsWith(reply)) finish(unavailable());
    });
    socket.once('error',error=>finish(unavailable(error)));
    socket.once('end',()=>finish(unavailable()));
  });
}

async function notifyExisting(endpoint, timeoutMs) {
  const until=Date.now()+timeoutMs;
  do {
    try { await notifyOnce(endpoint,Math.max(1,until-Date.now())); return; }
    catch (error) {
      // A just-created Windows pipe may not have its next instance ready yet.
      // Retry only the fixed notification, never ownership or application start.
      if (!['ENOENT','ECONNREFUSED','EBUSY'].includes(error.cause)) throw error;
      if (Date.now() >= until) throw error;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  } while(Date.now()<until);
  throw unavailable();
}

// The OS owns the listening pipe. Never infer ownership from a PID file, kill
// another process, or start a second server when the occupied pipe is uncertain.
// Only the fixed open request and acknowledgement cross IPC, never app URLs.
export async function acquireDesktopInstance({directory,onOpen = ()=>{},timeoutMs = 1500} = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('directory is required');
  const endpoint = await endpointFor(directory);
  const sockets = new Set();
  let closing = false, closePromise;
  const server = net.createServer(socket=>{
    sockets.add(socket);
    socket.once('close',()=>sockets.delete(socket));
    socket.on('error',()=>{});
    socket.setTimeout(timeoutMs,()=>socket.destroy());
    let request = '';
    socket.on('data',chunk=>{
      request += chunk.toString('utf8');
      if (request === instanceMessage) {
        socket.pause();
        if (closing) { socket.destroy(); return; }
        try { onOpen(); socket.end(acceptedMessage); }
        catch { socket.destroy(); }
      } else if (request.length >= instanceMessage.length || !instanceMessage.startsWith(request)) socket.destroy();
    });
  });
  try {
    await new Promise((resolve,reject)=>{
      const failed=error=>{server.removeListener('listening',ready);reject(error);};
      const ready=()=>{server.removeListener('error',failed);resolve();};
      server.once('error',failed);server.once('listening',ready);server.listen(endpoint);
    });
  } catch (error) {
    // Windows can report EACCES while another first pipe instance is being
    // created. Only an acknowledged request may classify this as a duplicate.
    if (error.code !== 'EADDRINUSE' && !(process.platform === 'win32' && error.code === 'EACCES')) throw unavailable(error);
    await notifyExisting(endpoint,timeoutMs);
    return {primary:false,close:async()=>{}};
  }
  // A later listener error must not escape as an unhandled event. It cannot
  // authorize a replacement instance; this process retains its application.
  server.on('error',()=>{});
  return {primary:true,close() {
    if (closePromise) return closePromise;
    closing=true;
    closePromise=new Promise((resolve,reject)=>{
      for(const socket of sockets)socket.destroy();
      server.close(error=>error?reject(error):resolve());
    });
    return closePromise;
  }};
}

export async function runDesktopInstance({directory,onOpen,run}) {
  const lease=await acquireDesktopInstance({directory,onOpen});
  if (!lease.primary) return {primary:false};
  try { await run(); return {primary:true}; }
  finally { await lease.close(); }
}
