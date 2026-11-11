import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {summarizeCodexLogs,readCodexLogs,codexEvidence} from '../src/codex-evidence.mjs';
const now=Date.now(),ts=Math.floor(now/1000);
const row=(body,extra={})=>({ts,level:'WARN',target:'codex_core::responses_retry',feedback_log_body:body,...extra});
const connectFailure='responses_websocket.connect{transport="responses_websocket" api.path="/responses"}: failed to connect to Responses WebSocket stage=Unknown';

test('native WebSocket connection failure is detected without timeout or retries and cannot become a pass',()=>{
 const r=summarizeCodexLogs([
  row(connectFailure,{level:'ERROR',target:'codex_api::endpoint::responses_websocket'}),
  row('response completed',{level:'INFO',target:'codex_api::endpoint::responses_websocket'})
 ],{now});
 assert.equal(r.status,'needs_action');assert.equal(r.counts.connection,1);assert.equal(r.counts.reconnect,0);assert.equal(r.counts.timeout,0);assert.equal(r.counts.stream,0);assert.equal(r.counts.other,0);
 assert.equal(r.lastErrorAt,new Date(ts*1000).toISOString());assert.equal(r.scope,'local_unattributed');
 assert.equal(r.transport.fiveRetriesThenHttp,false);assert.match(r.detail,/1 条连接失败/);assert.match(r.detail,/可能来自其他本机会话/);
 assert(!JSON.stringify(r).includes('/responses'));assert(!JSON.stringify(r).includes('stage=Unknown'));
});

test('explicit connection failures and unclassified transport errors remain different evidence categories',()=>{
 for(const text of ['WebSocket connection failed','unable to connect to service','could not connect to server','connection refused','connect error','ECONNREFUSED','ENETUNREACH']){
  const r=summarizeCodexLogs([row(text,{level:'ERROR',target:'codex_client::transport'})],{now});
  assert.equal(r.counts.connection,1,text);assert.equal(r.counts.other,0,text);
 }
 const r=summarizeCodexLogs([row('unexpected protocol event secret-private',{level:'ERROR',target:'codex_api::endpoint::responses_websocket'})],{now});
 assert.equal(r.status,'needs_action');assert.equal(r.counts.connection,0);assert.equal(r.counts.other,1);
 assert.equal(r.lastErrorAt,new Date(ts*1000).toISOString());assert.match(r.detail,/其他请求错误（原因待确认）/);assert.equal(r.scope,'local_unattributed');
 assert(!JSON.stringify(r).includes('secret-private'));
});

test('successful events, ordinary warnings and connection errors in unrelated outputs stay excluded',()=>{
 const r=summarizeCodexLogs([
  row(connectFailure,{level:'INFO',target:'codex_api::endpoint::responses_websocket'}),
  row('using experimental transport settings',{target:'codex_api::endpoint::responses_websocket'}),
  row('unexpected event',{level:'ERROR',target:'codex_core::tools'}),
  row(connectFailure,{level:'ERROR',target:'codex_core::session::session'}),
  row(connectFailure,{level:'ERROR',target:'codex_core::tools'}),
  row(connectFailure,{level:'ERROR',target:'codex_core::models_manager::manager'}),
  row(connectFailure,{level:'ERROR',target:'codex_api::endpoint::responses_websocket',ts:ts-1801})
 ],{now});
 assert.equal(r.status,'unknown');assert.equal(r.lastErrorAt,null);assert(Object.values(r.counts).every(n=>n===0));
 assert.match(r.detail,/不能仅凭没有报错判断已经恢复/);
});

test('live WAL recheck catches new same-second connection errors and never reuses previous evidence',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'codex-evidence-connection-'));const db=new DatabaseSync(path.join(dir,'logs_2.sqlite'));
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 db.exec('PRAGMA journal_mode=WAL; CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, level TEXT, target TEXT, feedback_log_body TEXT)');
 const insert=db.prepare('INSERT INTO logs VALUES (?,?,?,?,?)');
 const initial=await readCodexLogs({directory:dir,now});assert.equal(initial.status,'unknown');assert.equal(initial.watermark.id,0);
 insert.run(1,ts,'ERROR','codex_api::endpoint::responses_websocket',connectFailure);
 const fresh=await readCodexLogs({directory:dir,now,since:initial.watermark});
 assert.equal(fresh.status,'needs_action');assert.equal(fresh.counts.connection,1);assert.equal(fresh.freshness.complete,true);assert.equal(fresh.watermark.id,1);
 const worker=await codexEvidence(undefined,{directory:dir,now,since:initial.watermark});
 assert.equal(worker.status,'needs_action');assert.equal(worker.counts.connection,1);assert.equal(worker.watermark.id,1);
 insert.run(2,ts,'ERROR','codex_api::endpoint::responses_websocket','unrecognised protocol event secret-private');
 const next=await readCodexLogs({directory:dir,now,since:fresh.watermark});
 assert.equal(next.counts.connection,0);assert.equal(next.counts.other,1);assert.equal(next.watermark.id,2);assert(!JSON.stringify(next).includes('secret-private'));
 const after=await readCodexLogs({directory:dir,now,since:next.watermark});
 assert.equal(after.status,'unknown');assert.equal(after.lastErrorAt,null);assert(Object.values(after.counts).every(n=>n===0));
 const all=await readCodexLogs({directory:dir,now});assert.equal(all.counts.connection,1);assert.equal(all.counts.other,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM logs').get().n,2);
});
test('five reconnects with timeouts remain a problem even when a later response succeeds',()=>{
 const r=summarizeCodexLogs([...Array.from({length:5},()=>row('stream disconnected before completion: request timed out; retrying 5/5')),row('response completed',{level:'INFO'})],{now});
 assert.equal(r.status,'needs_action');assert.equal(r.counts.reconnect,5);assert.equal(r.counts.timeout,5);assert.equal(r.counts.stream,5);assert.match(r.detail,/同一故障/);
});
test('expired records, tool output, prompts and ordinary timeout configuration are not failures',()=>{
 const r=summarizeCodexLogs([row('request timed out',{ts:ts-1801}),row('request timed out',{ts:ts+60}),row('request timed out',{target:'codex_core::session::session'}),row('timeout=90',{level:'INFO'}),row('tool error: 401 timeout',{target:'codex_core::tools'})],{now});
 assert.equal(r.status,'unknown');assert.equal(r.lastErrorAt,null);assert(Object.values(r.counts).every(n=>n===0));
});
test('error categories are fixed summaries and never export secrets or original error text',()=>{
 const r=summarizeCodexLogs([row('401 unauthorized token=secret-private'),row('429 quota exceeded'),row('certificate validation failed'),row('503 service unavailable')],{now});
 assert.equal(r.counts.auth,1);assert.equal(r.counts.quota,1);assert.equal(r.counts.tls,1);assert.equal(r.counts.service,1);assert(!JSON.stringify(r).includes('secret-private'));
});
test('read-only live SQLite reader sees committed WAL data and rereads new entries',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'codex-evidence-'));const db=new DatabaseSync(path.join(dir,'logs_2.sqlite'));
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 db.exec('PRAGMA journal_mode=WAL; CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, level TEXT, target TEXT, feedback_log_body TEXT)');
 let r=await readCodexLogs({directory:dir,now});assert.equal(r.status,'unknown');
 db.prepare('INSERT INTO logs VALUES (?,?,?,?,?)').run(1,ts,'WARN','codex_core::responses_retry','request timed out, retrying 1/5');
 r=await readCodexLogs({directory:dir,now});assert.equal(r.counts.reconnect,1);assert.equal(r.status,'needs_action');
 assert.equal(db.prepare('SELECT count(*) AS n FROM logs').get().n,1);
});
test('unavailable or unsupported logs stay unknown',async()=>{
 const r=await readCodexLogs({directory:path.join(os.tmpdir(),'codex-evidence-missing-directory')});assert.equal(r.status,'unknown');assert.match(r.detail,/不能据此判断/);
});

const sequence = (extra={}) => [
 row('WebSocket connection failed: request timed out',{id:1,ts:ts-100,target:'codex_core::session::startup_prewarm',...extra}),
 ...Array.from({length:5},(_,i)=>row(`stream disconnected before completion: request timed out; retrying ${i+1}/5`,{id:i+2,ts:ts-85+i*15,...extra})),
 row('WebSocket retries exhausted; falling back to HTTP',{id:7,ts:ts-5,level:'INFO',target:'codex_core::client',...extra})
];
test('ordered WS timeout, retries 1..5 and INFO HTTP fallback is an unattributed candidate',()=>{
 const r=summarizeCodexLogs(sequence().reverse(),{now});
 assert.equal(r.transport.fiveRetriesThenHttp,true);assert.equal(r.transport.correlation,'time_only');
 assert.equal(r.transport.websocketTimeouts,1);assert.equal(r.transport.httpFallbacks,1);
 assert.equal(r.transport.maxRetry,5);assert.equal(r.transport.retryLimit,5);assert.equal(r.scope,'local_unattributed');
 assert.equal(r.status,'needs_action');assert.match(r.detail,/尚不能确定属于当前聊天/);
});
test('retries explicitly mentioning WebSocket remain one sequence',()=>{
 const rows=sequence();for(const r of rows.slice(1,6))r.feedback_log_body='WebSocket '+r.feedback_log_body;
 assert.equal(summarizeCodexLogs(rows,{now}).transport.fiveRetriesThenHttp,true);
});
test('parenthesized retry counters used by Codex are recognized',()=>{
 const rows=sequence();rows.slice(1,6).forEach((r,i)=>{r.feedback_log_body=`stream error - retrying (${i+1}/5 in 200ms): request timed out`;});
 assert.equal(summarizeCodexLogs(rows,{now}).transport.fiveRetriesThenHttp,true);
});
test('separate threads, partial retries, out-of-order retries and distant fallback cannot establish pattern',()=>{
 const mixed=sequence({thread_id:'private-thread-a'});mixed.at(-1).thread_id='private-thread-b';
 assert.equal(summarizeCodexLogs(mixed,{now}).transport.fiveRetriesThenHttp,false);
 const missing=sequence();missing.splice(3,1);assert.equal(summarizeCodexLogs(missing,{now}).transport.fiveRetriesThenHttp,false);
 const duplicate=sequence();duplicate.splice(3,0,{...duplicate[2],id:2.5});assert.equal(summarizeCodexLogs(duplicate,{now}).transport.fiveRetriesThenHttp,false);
 const stale=sequence();for(const r of stale.slice(0,6))r.ts-=300;
 assert.equal(summarizeCodexLogs(stale,{now}).transport.fiveRetriesThenHttp,false);
 const unrelated=sequence();unrelated.at(-1).target='codex_core::tools';
 assert.equal(summarizeCodexLogs(unrelated,{now}).transport.fiveRetriesThenHttp,false);
});
test('same-thread correlation never exposes thread identity or promotes session verification',()=>{
 const r=summarizeCodexLogs(sequence({thread_id:'private-thread-uuid'}),{now});
 assert.equal(r.transport.correlation,'thread');assert.equal(r.status,'needs_action');assert.equal(r.scope,'local_unattributed');
 assert(!JSON.stringify(r).includes('private-thread-uuid'));
});
test('fresh time cutoff excludes old failures and refuses malformed or incomplete ranges',()=>{
 const r=summarizeCodexLogs(sequence(),{now,since:new Date((ts-3)*1000).toISOString()});
 assert.equal(r.status,'unknown');assert.equal(r.transport.fiveRetriesThenHttp,false);
 assert.equal(r.freshness.complete,true);assert.equal(r.freshness.requested,true);
 const invalid=summarizeCodexLogs(sequence(),{now,since:{id:1}});assert.equal(invalid.freshness.complete,false);
 const future=summarizeCodexLogs(sequence(),{now,since:now+60_000});assert.equal(future.freshness.reason,'invalid_watermark');
 const old=summarizeCodexLogs(sequence(),{now,since:now-31*60*1000});assert.equal(old.freshness.reason,'range_limited');
 const truncated=summarizeCodexLogs([],{now,truncated:true});assert.equal(truncated.freshness.complete,false);
});
test('watermark catches same-second new errors, excludes old errors, and supports isolated worker',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'codex-evidence-cursor-'));const db=new DatabaseSync(path.join(dir,'logs_3.sqlite'));
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 db.exec('PRAGMA journal_mode=WAL; CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, level TEXT, target TEXT, feedback_log_body TEXT, thread_id TEXT)');
 const insert=db.prepare('INSERT INTO logs VALUES (?,?,?,?,?,?)');
 insert.run(1,ts,'WARN','codex_core::responses_retry','401 unauthorized',null);
 const initial=await readCodexLogs({directory:dir,now});assert.equal(initial.counts.auth,1);
 let r=await readCodexLogs({directory:dir,now,since:initial.watermark});assert.equal(r.status,'unknown');assert.equal(r.counts.auth,0);
 insert.run(2,ts,'WARN','codex_core::responses_retry','request timed out, retrying 1/5','private-thread');
 r=await readCodexLogs({directory:dir,now,since:initial.watermark});assert.equal(r.counts.timeout,1);assert.equal(r.counts.auth,0);
 assert.equal(r.watermark.id,2);assert.equal(r.freshness.complete,true);
 const worker=await codexEvidence(undefined,{directory:dir,now,since:initial.watermark});
 assert.deepEqual(worker,r);assert(!JSON.stringify(worker).includes(dir));
});
test('reader includes INFO fallback, rejects incompatible schema, and detects log database rotation',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'codex-evidence-schema-'));const db=new DatabaseSync(path.join(dir,'logs_1.sqlite'));
 let newer;t.after(async()=>{db.close();newer?.close();await rm(dir,{recursive:true,force:true});});
 db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, level TEXT, target TEXT, feedback_log_body TEXT)');
 const insert=db.prepare('INSERT INTO logs VALUES (?,?,?,?,?)');for(const r of sequence())insert.run(r.id,r.ts,r.level,r.target,r.feedback_log_body);
 const initial=await readCodexLogs({directory:dir,now});assert.equal(initial.transport.fiveRetriesThenHttp,true);
 newer=new DatabaseSync(path.join(dir,'logs_2.sqlite'));newer.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, level TEXT, target TEXT, feedback_log_body TEXT)');
 const changed=await readCodexLogs({directory:dir,now,since:initial.watermark});
 assert.equal(changed.status,'unknown');assert.equal(changed.freshness.reason,'source_changed');assert.equal(changed.freshness.complete,false);
 newer.exec('DROP TABLE logs; CREATE TABLE logs (id INTEGER PRIMARY KEY, body TEXT)');
 const unsupported=await readCodexLogs({directory:dir,now});assert.equal(unsupported.status,'unknown');assert.equal(unsupported.freshness.reason,'unsupported_schema');
});
