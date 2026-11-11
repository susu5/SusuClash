import {spawn} from 'node:child_process';
import {mkdtemp,rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isConnectionFailure} from './codex-transport-errors.mjs';

const fallbackMessage=/(?:fall(?:ing)?\s*back|fallback)[^\n]*(?:http|sse)|switching[^\n]*\bhttp\b/i;

// This process is disposable. It never resumes or replays a user's task.
// The empty workspace and zero project-doc budget exclude project documents.
// Native Codex may still apply CODEX_HOME global instructions; this is not a
// claim that the entire native prompt is instruction-free.
export async function runTargetProbe(target,{args=[],signal,deadline=Date.now()+60000,launch=spawn,env=process.env}={}) {
  if(signal?.aborted||deadline<=Date.now())return {status:'failed',reason:'cancelled',fresh:true,transportClean:false};
  const cwd=await mkdtemp(path.join(os.tmpdir(),'susuclash-target-'));
  try{return await new Promise(resolve=>{
    let child,done=false,buffer='',bytes=0,retries=0,connectionFailures=0,otherTransportErrors=0,fallback=false,complete=false,reply=false,reason=null,stderrTail='',blockedItemType=null;
    const warnings={experimental:0,deprecated:0,other:0,background:0};
    const finish=(status,why=reason)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(child&&child.exitCode==null)child.kill();resolve({status,reason:why,retries,connectionFailures,otherTransportErrors,fallback,warnings,blockedItemType,completed:complete&&reply,fresh:true,transportClean:status==='probe_passed'&&!why&&!retries&&!fallback,detail:status==='probe_passed'?'相同 Codex 程序的新连接已完整回复，未出现连接错误、重试或连接方式回退。':({auth:'Codex 需要本人完成登录。',quota:'Codex 暂时受到额度或频率限制。',service:'服务端暂时不可用。',tls:'连接的证书或安全握手未通过，已保留证书保护。',transport:connectionFailures?'本轮测试出现连接失败，即使随后收到回复，也还不能确认连接稳定。':'新连接仍有超时、重连或连接回退。',transport_unknown:'本轮测试出现了尚未识别原因的连接错误，暂不能确认已经恢复。',tool:'诊断请求出现了工具操作，测试已停止。',timeout:'本轮连接测试未在时限内完成。',cancelled:'本轮连接测试已停止。'}[why]||'连接测试没有完整完成，未认定已经恢复。')});};
    const abort=()=>finish('failed','cancelled');
    const timer=setTimeout(()=>finish('failed','timeout'),Math.max(1,Math.min(60000,deadline-Date.now())));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    // A user-level RUST_LOG=off must not hide the very retry/fallback evidence
    // needed to judge this isolated probe. Captured logs stay bounded in memory.
    const childEnv={...env,CODEX_HOME:target.home,NO_COLOR:'1',RUST_LOG:'warn,codex_core::client=info,codex_core::responses_retry=warn,codex_core::session::startup_prewarm=warn,codex_api=warn'};
    // respect_system_proxy must actually exercise the system proxy. Explicit
    // environment proxy injection would make a broken flag appear successful.
    for(const k of Object.keys(childEnv))if(/^(https?_proxy|all_proxy|no_proxy)$/i.test(k))delete childEnv[k];
    const argv=['exec','--ignore-user-config','--strict-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--json','--color','never','-C',cwd,
      '-c','approval_policy="never"','-c','web_search="disabled"',
      '-c','project_doc_max_bytes=0','-c','skills.include_instructions=false','-c','skills.bundled.enabled=false','-c','agents.enabled=false',...args,
      '只回复 SUSUCLASH_CONNECTION_OK。不要调用任何工具，不要读取文件。'];
    function classify(text){
      let classified=true;
      if(/\b(?:401|unauthorized|authentication failed|not logged in)\b/i.test(text))reason='auth';
      else if(/\b(?:429|quota|rate.limit|usage.limit)\b/i.test(text))reason='quota';
      else if(/\b(?:502|503|504|service.unavailable)\b/i.test(text))reason='service';
      else if(/(?:certificate[^\n]*(?:failed|invalid|expired|error)|invalid[^\n]*certificate|tls handshake[^\n]*(?:failed|error|eof))/i.test(text))reason='tls';
      else if(/(?:\bmodel\b[^\n]*(?:not supported|not found|does not exist|not available)|unsupported[^\n]*\bmodel\b|model_not_found|model rerouted:)/i.test(text))reason='model';
      else if(/(?:unknown (?:field|feature|config)|error loading config|invalid[^\n]*config)/i.test(text))reason='configuration';
      else if(isConnectionFailure(text)){connectionFailures++;reason=reason||'transport';}
      else if(/(?:timed? out|timeout|stream[^\n]*(?:disconnect|closed|incomplete)|retrying|reconnecting)/i.test(text)){retries++;reason=reason||'transport';}
      else classified=false;
      if(fallbackMessage.test(text)){fallback=true;reason=reason||'transport';classified=true;}
      return classified;
    }
    function event(line){let e;try{e=JSON.parse(line);}catch{return;}
      // Codex exec maps runtime/config/deprecation warnings to non-fatal
      // ErrorItem objects. Critical errors use top-level error/turn.failed.
      if(e.type?.startsWith('item.')&&e.item?.type==='error'){
        const message=String(e.item.message||'');
        warnings[/under-development features enabled|unstable features/i.test(message)?'experimental':/deprecat/i.test(message)?'deprecated':'other']++;
        classify(message);return;
      }
      if(e.type==='turn.completed'){if(e.status&&e.status!=='completed'||e.error){reason='incomplete';return;}complete=true;}
      if(e.type==='item.completed'&&e.item?.type==='agent_message'&&e.item.text?.trim()==='SUSUCLASH_CONNECTION_OK')reply=true;
      if(e.type?.startsWith('item.')&&e.item?.type&&!['agent_message','reasoning','plan','todo_list'].includes(e.item.type)){blockedItemType=/^[a-z][a-z0-9_]{0,63}$/.test(e.item.type)?e.item.type:'unknown';finish('failed','tool');return;}
      if(e.type==='error'||e.type==='turn.failed'){classify(JSON.stringify(e));reason=reason||'incomplete';}
    }
    try{child=launch(target.binary,argv,{cwd,env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{finish('unsupported','launch');return;}
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144){finish('failed','output_limit');return;}buffer+=chunk.toString();const lines=buffer.split(/\r?\n/);buffer=lines.pop();for(const line of lines)event(line);});
    function stderrLine(line){
      line=line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
      const match=/\b(codex_[a-z0-9_:]+):\s/i.exec(line),target=match?.[1];
      if(target&&!/^codex_(?:core::(?:responses_retry(?:$|::)|client(?:$|::)|session::startup_prewarm(?:$|::))|api::|client::)/.test(target)){warnings.background++;return;}
      const level=/\b(TRACE|DEBUG|INFO|WARN|ERROR)\b/.exec(line.slice(0,match?.index??line.length))?.[1];
      if(level&&!['WARN','ERROR'].includes(level)){
        if(fallbackMessage.test(line)){fallback=true;reason=reason||'transport';}
        return;
      }
      const classified=classify(line);
      // Preserve unknown transport ERRORs instead of calling a completed reply
      // clean. Non-fatal warnings and unrelated background targets stay separate.
      if(target&&level==='ERROR'&&!classified){otherTransportErrors++;reason=reason||'transport_unknown';}
    }
    child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144){finish('failed','output_limit');return;}stderrTail+=chunk.toString();const lines=stderrTail.split(/\r?\n/);stderrTail=lines.pop();for(const line of lines)stderrLine(line);if(stderrTail.length>8192){stderrLine(stderrTail);stderrTail='';}});
    child.once('error',()=>finish('unsupported','launch'));
    // close, not exit: stdout/stderr may still be draining after exit.
    child.once('close',code=>{if(buffer)event(buffer);if(stderrTail)stderrLine(stderrTail);if(code===0&&complete&&reply&&!reason&&!retries&&!fallback)finish('probe_passed');else finish(['auth','quota'].includes(reason)?'needs_user':'failed');});
  });}finally{await rmdir(cwd).catch(()=>{});}
}
