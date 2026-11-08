import { codexProxy, listeners, webProbe } from './diagnostics.mjs';

export const codexTarget = 'https://chatgpt.com/';
const fallback = {result:'unknown',detail:'尚未确认 Codex 的网络路径；站点响应不代表应用内发送成功。',checkedAt:null};

/** The result is about a fixed web target, never proof that Codex itself works.
 * Read no unrelated .env fields and never expose the proxy URL or file content.
 */
export function createCodexHealth({readProxy=codexProxy, readListeners=listeners, probe=webProbe, readSystemProxy=async()=>({enabled:false,managed:false}), now=()=>Date.now(), intervalMs=4000} = {}) {
  let nextCheck = 0;
  let last = {...fallback};
  async function inspect({corePort, portStatus, signal} = {}) {
    if (signal?.aborted || now() < nextCheck) return {result:'unknown',detail:last.detail,checkedAt:last.checkedAt};
    nextCheck = now() + intervalMs;
    const done = (result, detail) => (last={result,detail,checkedAt:new Date(now()).toISOString()});
    try {
      const setting = await readProxy();
      if (signal?.aborted) return {...fallback};
      if (!setting || setting.kind === 'unknown' || setting.kind === 'custom') return done('unknown','Codex 的代理设置无法安全确认，请在应用中验证连接。');
      let proxy = null, route = '本机直连';
      if (setting.kind === 'local') {
        if (!setting.port || !setting.url) return done('unknown','Codex 固定代理设置无法确认，请检查配置。');
        if (setting.port !== corePort) {
          const owners = await readListeners([setting.port]);
          if (!owners) return done('unknown','无法确认 Codex 固定代理端口是否可用，请检查配置。');
          if (!owners.length) return done('failed','Codex 固定代理端口没有监听，请检查代理端口设置。');
          return done('unknown','Codex 固定代理端口正由其他程序使用，请确认是否为预期代理。');
        }
        if (portStatus === 'failed') return done('failed','Codex 固定代理端口没有监听，请检查代理内核。');
        if (portStatus !== 'ok') return done('unknown','当前代理端口状态未确认，请稍后复查。');
        proxy = setting.url; route = 'Codex 固定代理';
      } else if (setting.kind === 'none') {
        const system = await readSystemProxy();
        if (signal?.aborted) return {...fallback};
        if (!system || typeof system.enabled !== 'boolean') return done('unknown','系统代理状态未确认，无法判断 Codex 的实际网络路径。');
        if (system.enabled && !system.managed) return done('unknown','系统代理由其他程序管理，请在 Codex 中确认实际连接。');
        if (system.enabled && system.managed) {
          if (!corePort || portStatus !== 'ok') return done('unknown','本软件代理端口状态未确认，请稍后复查。');
          proxy = 'http://127.0.0.1:' + corePort + '/'; route = '本软件系统代理';
        }
      } else return done('unknown','Codex 的代理设置无法安全确认。');
      const code = await probe(codexTarget, proxy, {short:true,signal});
      if (signal?.aborted || code == null) return done('unknown','暂时无法完成站点探测，请在 Codex 中确认。');
      const caveat = '；站点结果不代表 Codex 应用内发送成功。';
      if (code === 0) return done('failed',route + '下 ChatGPT 站点未响应，原因待确认' + caveat);
      if (code >= 200 && code < 400) return done('ok',route + '下 ChatGPT 站点有响应' + caveat);
      if (code === 403 || code >= 500) return done('failed',route + '下 ChatGPT 站点返回 HTTP ' + code + caveat);
      return done('unknown',route + '下 ChatGPT 站点返回 HTTP ' + code + '，无法判断应用可用性' + caveat);
    } catch { return done('unknown','暂时无法检查 Codex 连接，请在应用中确认。'); }
  }
  return {inspect};
}
