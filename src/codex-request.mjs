import { spawn } from 'node:child_process';
import { mkdtemp, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Opt-in, short-lived, default OpenAI CLI probe. Never reads or exports auth tokens. */
export async function codexRequest(signal,{launch=spawn,port}={}) {
  if(!Number.isInteger(port)||port<1||port>65535)return {status:'needs_user',detail:'本次受控代理入口尚未确认，请先检查内核和端口。'};
  const cwd=await mkdtemp(path.join(os.tmpdir(),'susuclash-request-'));
  try {
    return await new Promise(resolve=>{
      let child,finished=false,buffer='',complete=false,reply=false,reason='unknown';
      const finish=(status,detail)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(child && child.exitCode==null)child.kill();resolve({status,detail});};
      const abort=()=>finish('unknown','本次测试已停止；原会话状态未验证。');
      const timer=setTimeout(()=>finish('unknown','90 秒内未收到完整完成事件，请在原客户端核对登录、额度、服务状态和持续接收情况。'),90000);
      if(signal?.aborted){abort();return;}
      signal?.addEventListener('abort',abort,{once:true});
      // The isolated default configuration prevents user MCP/plugins/hooks from being
      // invoked by a connectivity test. Enterprise/OS policies are not relaxed.
      const args=['exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--json','--color','never','-C',cwd,'-c','approval_policy="never"','-c','features.shell_tool=false','-c','web_search="disabled"','只回复 SUSUCLASH_CONNECTION_OK。不要调用工具，不要读取文件。'];
      const env={...process.env};
      for(const key of Object.keys(env))if(/^(https?_proxy|all_proxy|no_proxy)$/i.test(key))delete env[key];
      Object.assign(env,{HTTP_PROXY:'http://127.0.0.1:'+port,HTTPS_PROXY:'http://127.0.0.1:'+port,ALL_PROXY:'http://127.0.0.1:'+port,NO_PROXY:'127.0.0.1,localhost,::1'});
      try {child=launch('codex.exe',args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});}
      catch {finish('needs_user','未找到受支持的 Codex CLI，请安装或更新 CLI 后重试。');return;}
      function classify(text){if(/401|unauthorized|login|not logged|sign.in|authentication/i.test(text))reason='auth';else if(/429|quota|rate.limit|usage.limit/i.test(text))reason='quota';else if(/503|502|service.unavailable/i.test(text))reason='service';}
      child.stdout.on('data',chunk=>{
        buffer+=chunk.toString();if(buffer.length>262144){finish('unknown','CLI 输出超过测试上限，测试已停止。');return;}
        const lines=buffer.split(/\r?\n/);buffer=lines.pop();
        for(const line of lines){let e;try{e=JSON.parse(line);}catch{continue;}
          if(e.type==='turn.completed')complete=true;
          if(e.type==='item.completed'&&e.item?.type==='agent_message'&&e.item.text?.includes('SUSUCLASH_CONNECTION_OK'))reply=true;
          if(e.type==='item.started'&&['command_execution','mcp_tool_call','web_search','file_change'].includes(e.item?.type)){finish('unknown','测试出现了工具操作，已停止；本次不执行工具诊断。');return;}
          if(e.type==='error'||e.type==='turn.failed')classify(JSON.stringify(e));
        }
      });
      child.stderr.on('data',chunk=>classify(chunk.toString()));
      child.once('error',()=>finish('needs_user','未找到受支持的 codex.exe，或系统策略阻止启动。请在原客户端完成验证。'));
      child.once('exit',code=>{
        if(code===0&&complete&&reply)finish('probe_passed','独立 CLI 使用本次受控代理入口与默认 OpenAI 配置，已收到完整回复和完成事件。桌面、IDE、自定义服务、长回复及原会话仍需分别确认。');
        else finish(['auth','quota'].includes(reason)?'needs_user':'unknown',({auth:'CLI 明确提示登录或授权问题，请在原客户端重新登录。',quota:'CLI 提示额度或频率限制，请核对账户；换线不能解决额度。',service:'服务端暂时异常，请稍后复查。'})[reason]||'CLI 测试未完整完成。可能是版本、策略、路径或网络问题，请在原客户端核对；不会直接认定线路失效。');
      });
    });
  } finally {await rmdir(cwd).catch(()=>{});}
}
