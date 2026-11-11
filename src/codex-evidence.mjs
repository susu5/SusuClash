import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isConnectionFailure } from './codex-transport-errors.mjs';

const execute = promisify(execFile);
const windowMs = 30 * 60 * 1000, limit = 4000, sequenceMs = 3 * 60 * 1000;
const emptyTransport = () => ({websocketTimeouts:0,httpFallbacks:0,maxRetry:0,retryLimit:0,fiveRetriesThenHttp:false,correlation:'none'});
const unavailable = (reason = 'unavailable') => ({
  status:'unknown', detail:'未能读取最近的 Codex 运行记录，不能据此判断连接正常。', windowMinutes:30,
  scope:'local_unattributed', transport:emptyTransport(), watermark:null,
  freshness:{requested:false,complete:false,reason}
});
// Accept only transport log targets. Tool output, prompts and transcripts are
// never evidence, even if they contain words such as "timeout" or "401".
const transportTarget = /^codex_(?:core::(?:responses_retry(?:$|::)|client(?:$|::)|session::startup_prewarm(?:$|::))|api::|client::)/;
const retryTarget = /^codex_core::responses_retry(?:$|::)/;
const httpFallback = /(?:\b(?:fall(?:ing)?\s*back|fallback|switch(?:ing)?)\b.{0,100}\b(?:http|sse)\b|\b(?:http|sse)\b.{0,100}\bfallback\b)/i;

function sinceTime(since) {
  if (typeof since === 'number') return Number.isFinite(since) ? since : NaN;
  if (typeof since === 'string') return Date.parse(since);
  return null;
}
function isWatermark(value) {
  return value && typeof value === 'object' && typeof value.source === 'string' &&
    /^[a-f0-9]{32}$/.test(value.source) && Number.isSafeInteger(value.id) && value.id >= 0 &&
    typeof value.capturedAt === 'string' && Number.isFinite(Date.parse(value.capturedAt));
}

// Even thread correlation does not identify a desktop process or prove a proxy
// cause. These candidates are never application/session verification results.
function retryPattern(events) {
  let best = 'none';
  const groups = new Map();
  for (const event of events) {
    const key = event.thread || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  for (const [thread, group] of groups) {
    let begin = null, retry = 0, lastRetryAt = null;
    for (const event of group) {
      if (begin !== null && event.at - begin > sequenceMs) { begin = null; retry = 0; }
      if (event.wsTimeout && !event.fallback && (begin === null || event.retry === null)) { begin = event.at; retry = 0; lastRetryAt = null; }
      if (begin !== null && event.retry !== null) {
        // Duplicates, skipped attempts and interleaved retry sequences cannot
        // establish this specific pattern.
        if (event.retryLimit !== 5 || event.retry !== retry + 1 ||
            (lastRetryAt !== null && event.at - lastRetryAt > 60_000)) {
          begin = null; retry = 0;
        } else {
          retry = event.retry; lastRetryAt = event.at;
        }
      }
      if (event.fallback && begin !== null && retry === 5) {
        best = thread ? 'thread' : best === 'thread' ? best : 'time_only';
        begin = null; retry = 0;
      }
    }
  }
  return best;
}

export function summarizeCodexLogs(rows, {now=Date.now(),truncated=false,since,source,watermark=null} = {}) {
  const counts = {connection:0,timeout:0,reconnect:0,stream:0,auth:0,quota:0,tls:0,service:0,other:0};
  const transport = emptyTransport();
  const requested = since !== undefined && since !== null;
  const time = sinceTime(since);
  const cursor = isWatermark(since) ? since : null;
  if (requested && !cursor && !Number.isFinite(time)) return {...unavailable('invalid_watermark'),freshness:{requested:true,complete:false,reason:'invalid_watermark'}};
  if ((Number.isFinite(time) && time > now+5000) || (cursor && Date.parse(cursor.capturedAt) > now+5000)) return {...unavailable('invalid_watermark'),freshness:{requested:true,complete:false,reason:'invalid_watermark'}};
  if (cursor && cursor.source !== source) return {...unavailable('source_changed'),freshness:{requested:true,complete:false,reason:'source_changed'},watermark};
  let latestAt = null;
  const events = [];
  const ordered = [...rows].sort((a,b) => a.ts-b.ts || (a.id || 0)-(b.id || 0));
  for (const row of ordered) {
    const at = row.ts * 1000;
    if (!Number.isFinite(row.ts) || at < now-windowMs || at > now+5000 ||
        !['WARN','ERROR','INFO'].includes(row.level) || !transportTarget.test(row.target)) continue;
    if (cursor && (!Number.isSafeInteger(row.id) || row.id <= cursor.id)) continue;
    // Timestamp cutoffs are exclusive. Use the returned database watermark for
    // same-second precision instead of comparing rounded log timestamps.
    if (Number.isFinite(time) && at <= time) continue;
    const body = String(row.feedback_log_body || '').slice(0,4096);
    const fallback = httpFallback.test(body);
    const failure = row.level === 'WARN' || row.level === 'ERROR';
    const hit = {
      connection:failure && isConnectionFailure(body),
      timeout:failure && /\b(?:request timed out|timed out|timeout)\b/i.test(body),
      reconnect:failure && /\b(?:retrying|reconnecting|stream.*retry|retry.*stream)\b/i.test(body),
      stream:failure && /\bstream\b.*\b(?:disconnect|disconnected|closed|incomplete|error|failed)\b/i.test(body),
      auth:failure && /\b(?:401|unauthorized|authentication failed|token expired)\b/i.test(body),
      quota:failure && /\b(?:429|quota exceeded|rate limit|usage limit)\b/i.test(body),
      tls:failure && /\b(?:certificate|tls handshake)\b.*\b(?:error|failed|invalid|expired)\b/i.test(body),
      service:failure && /\b(?:502|503|504|service unavailable)\b/i.test(body)
    };
    // An unrecognised ERROR from the bounded transport target allowlist is
    // evidence to investigate, not proof of a particular cause or session.
    // Ordinary WARN/INFO messages and non-transport output remain excluded.
    hit.other = row.level === 'ERROR' && !fallback && !Object.values(hit).some(Boolean);
    const wsTimeout = hit.timeout && /\b(?:websocket|websockets|ws|wss)\b/i.test(body);
    const attempt = failure && retryTarget.test(row.target) && hit.reconnect ? body.match(/\b(?:retrying|reconnecting|retry)\s*[:=]?\s*\(?(\d{1,2})\s*\/\s*(\d{1,2})\b/i) : null;
    const retry = attempt ? Number(attempt[1]) : null, retryLimit = attempt ? Number(attempt[2]) : null;
    if (wsTimeout) transport.websocketTimeouts++;
    if (fallback) transport.httpFallbacks++;
    if (attempt && retry >= 1 && retry <= retryLimit) {
      transport.maxRetry = Math.max(transport.maxRetry,retry);
      transport.retryLimit = Math.max(transport.retryLimit,retryLimit);
    }
    if (wsTimeout || fallback || attempt) events.push({at,wsTimeout,fallback,retry,retryLimit,thread:typeof row.thread_id === 'string' ? row.thread_id : ''});
    if (!Object.values(hit).some(Boolean) && !fallback) continue;
    for (const [key,value] of Object.entries(hit)) if (value) counts[key]++;
    latestAt = Math.max(latestAt ?? at, at);
  }
  transport.correlation = retryPattern(events);
  transport.fiveRetriesThenHttp = transport.correlation !== 'none';
  const found = latestAt !== null;
  const rangeLimited = (Number.isFinite(time) && time < now-windowMs) || (cursor && Date.parse(cursor.capturedAt) < now-windowMs);
  const label = requested ? '本次复测开始后的' : '最近30分钟的';
  const descriptions = Object.entries({connection:'连接失败',timeout:'超时',reconnect:'重连',stream:'回复中断',other:'其他请求错误（原因待确认）'})
    .filter(([key])=>counts[key]).map(([key,name])=>`${counts[key]} 条${name}`).join('、');
  return {
    status:found?'needs_action':'unknown', counts, lastErrorAt:found?new Date(latestAt).toISOString():null,
    windowMinutes:30, truncated, checkedAt:new Date(now).toISOString(), scope:'local_unattributed', transport, watermark,
    freshness:{requested,complete:!truncated&&!rangeLimited,reason:truncated?'truncated':rangeLimited?'range_limited':null},
    detail:(found ? `${label}本机 Codex 运行记录中发现${descriptions?` ${descriptions}`:transport.httpFallbacks?'连接方式切换':'请求错误'}记录。同一故障可能产生多条记录；可能来自其他本机会话，最终有回复也不代表连接稳定。` : '本次读取范围内未发现连接失败、超时或重连等错误记录。记录可能不完整，不能仅凭没有报错判断已经恢复。')+
      (transport.fiveRetriesThenHttp?'发现先连接超时、连续重试5次、再换连接方式的记录；这是一条待验证线索，尚不能确定属于当前聊天。':'')+
      (truncated?'本次仅检查了最新4000条匹配记录。':'')
  };
}

export async function readCodexLogs({directory=process.env.CODEX_HOME||(process.env.USERPROFILE?path.join(process.env.USERPROFILE,'.codex'):null),now=Date.now(),since} = {}) {
  if (!directory) return unavailable();
  let db;
  try {
    const files = (await readdir(directory)).filter(n=>/^logs_\d+\.sqlite$/.test(n)).sort((a,b)=>Number(b.match(/\d+/)[0])-Number(a.match(/\d+/)[0]));
    if (!files.length) return unavailable();
    const file = path.join(directory,files[0]);
    const metadata = await stat(file);
    const source = createHash('sha256').update(`${path.resolve(file)}\0${metadata.birthtimeMs}\0${metadata.ino}`).digest('hex').slice(0,32);
    const {DatabaseSync} = await import('node:sqlite');
    db = new DatabaseSync(file,{readOnly:true,timeout:300});
    const columns = new Set(db.prepare('PRAGMA table_info(logs)').all().map(c=>c.name));
    if (!['id','ts','level','target','feedback_log_body'].every(name=>columns.has(name))) return unavailable('unsupported_schema');
    // Cursor and bounded tail share a read transaction, including the live WAL.
    // Otherwise a concurrent insertion could be skipped by the next read.
    db.exec('BEGIN');
    const id = db.prepare('SELECT coalesce(max(id),0) AS id FROM logs').get().id;
    if (!Number.isSafeInteger(id) || id < 0) return unavailable('unsupported_schema');
    const watermark = {source,id,capturedAt:new Date(now).toISOString()};
    if (isWatermark(since) && (since.source !== source || since.id > id)) {
      return {...unavailable('source_changed'),watermark,freshness:{requested:true,complete:false,reason:'source_changed'}};
    }
    const time = sinceTime(since);
    const afterId = isWatermark(since) ? since.id : -1;
    const from = Math.max(now-windowMs,Number.isFinite(time)?time:0);
    const threadColumn = columns.has('thread_id') ? ', substr(thread_id,1,128) AS thread_id' : '';
    // INFO is included only for HTTP fallback, which some versions log at INFO.
    const rows = db.prepare(`SELECT id,ts,level,target,substr(feedback_log_body,1,4096) AS feedback_log_body${threadColumn} FROM logs
      WHERE ts >= ? AND id > ? AND (level IN ('WARN','ERROR') OR (level = 'INFO' AND (lower(feedback_log_body) LIKE '%http%' OR lower(feedback_log_body) LIKE '%sse%') AND (lower(feedback_log_body) LIKE '%fall%back%' OR lower(feedback_log_body) LIKE '%switch%')))
      AND (target LIKE 'codex_core::responses_retry%' OR target LIKE 'codex_core::client%' OR target LIKE 'codex_core::session::startup_prewarm%' OR target LIKE 'codex_api::%' OR target LIKE 'codex_client::%') ORDER BY id DESC LIMIT ?`).all(Math.floor(from/1000),afterId,limit+1);
    return summarizeCodexLogs(rows.slice(0,limit),{now,since,source,watermark,truncated:rows.length>limit});
  } catch { return unavailable(); }
  finally { db?.close(); }
}

// Only fixed summaries cross the process boundary; no shell is involved.
export async function codexEvidence(signal, {directory,since,now} = {}) {
  try {
    const options = JSON.stringify({directory,since,now});
    const result = await execute(process.execPath,[fileURLToPath(import.meta.url),'--read-codex-evidence',options],{windowsHide:true,timeout:4000,signal,maxBuffer:16384});
    return JSON.parse(result.stdout);
  } catch { return unavailable(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--read-codex-evidence') {
  let options = {};
  try { options = JSON.parse(process.argv[3] || '{}'); } catch { /* Unknown input stays read-only. */ }
  process.stdout.write(JSON.stringify(await readCodexLogs(options)));
}
