import https from 'node:https';

// Fixed endpoints prevent arbitrary URLs from being supplied through the UI.
export const targets = [
  {url:'https://www.gstatic.com/generate_204', expected:204},
  {url:'https://www.cloudflare.com/cdn-cgi/trace', expected:200}
];

function directGet({url, expected}, signal) {
  return new Promise(resolve => {
    let completed = false;
    const finish = value => { if (completed) return; completed = true; resolve(value); };
    const req = https.get(url, {signal, headers:{Connection:'close'}, agent:false}, res => {
      res.resume(); finish(res.statusCode === expected ? 'ok' : 'unknown');
    });
    req.setTimeout(2500, () => req.destroy());
    req.once('error', () => finish('unknown'));
  });
}

/** Checks current or candidate node using two fixed independent destinations.
 * A failed node is reported only if at least one destination responds directly
 * and both fail through the node; uncertain results remain unknown.
 */
export function createHealthProbe({core, direct = directGet, now = () => Date.now(), intervalMs = 4500} = {}) {
  if (!core?.call) throw new TypeError('core is required');
  let nextLight = 0, forced = false;
  async function nodeRequest(node, target, signal) {
    if (signal?.aborted) return 'unknown';
    const query = new URLSearchParams({url:target.url, timeout:'2500', expected:String(target.expected)});
    try {
      const result = await core.call('GET','/proxies/' + encodeURIComponent(node) + '/delay?' + query, null, 3500);
      return Number.isFinite(result?.delay) && result.delay > 0 ? 'ok' : 'unknown';
    } catch (error) {
      // Only a completed Mihomo HTTP response is evidence of a failed test.
      return error?.status === 502 && /HTTP (?:408|500|504)/.test(error.message) ? 'failed' : 'unknown';
    }
  }
  async function nodeResults(node, signal) { return Promise.all(targets.map(target => nodeRequest(node,target,signal))); }
  return {
    force() { forced = true; },
    async inspect(node, signal) {
      if (!node || (!forced && now() < nextLight)) return {network:'unknown',node:'unknown'};
      forced = false;
      nextLight = now() + intervalMs;
      // One target is sampled each cycle. A single failure triggers the
      // independent two-target/direct checks, never an immediate switch.
      const first = await nodeRequest(node, targets[0], signal);
      if (first === 'ok') return {network:'unknown',node:'ok'};
      if (first !== 'failed') return {network:'unknown',node:'unknown'};
      const [directResults, second] = await Promise.all([
        Promise.all(targets.map(target => direct(target,signal).catch(()=>'unknown'))),
        nodeRequest(node,targets[1],signal)
      ]);
      const network = directResults.some(result => result === 'ok') ? 'ok' : 'unknown';
      const nodeStatus = network !== 'ok' ? 'unknown' : second === 'failed' ? 'failed' : second === 'ok' ? 'ok' : 'unknown';
      return {network, node:nodeStatus};
    },
    async verify(node, signal) {
      if (!node) return 'unknown';
      const values = await nodeResults(node,signal);
      return values.some(value => value === 'ok') ? 'ok' : values.every(value => value === 'failed') ? 'failed' : 'unknown';
    }
  };
}
