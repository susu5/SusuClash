/**
 * Health monitoring and user-approved recovery. No probe, process, network,
 * privilege or OS-setting action is performed by this module itself.
 *
 * Adapters:
 * probe({signal}) -> {scope,group,current,network,port,core,node,codex};
 * each result is 'ok', 'failed' or 'unknown'. node:'failed' must mean a
 * confirmed node-specific failure, not just a single destination failure.
 * repair({problem,observation,signal,isCurrent}) -> {ok,message};
 * verify({scope,group,node,phase,signal}) -> 'ok'|'failed'|'unknown'.
 * select({scope,group,node,signal,isCurrent}) must serialize with manual
 * selections and check both signal and isCurrent immediately before commit.
 * load()/persist(preferences) handle durable storage and must not store
 * subscription URLs. The server must call invalidate before a manual operation.
 */
const results = new Set(['ok', 'failed', 'unknown']);
const components = ['core', 'port', 'network', 'node', 'codex'];
const key = (scope, group) => JSON.stringify([scope, group]);
const cleanText = (value, max = 200) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : '';

export function createAutomation({probe, repair, select, verify, load = async () => null, persist = async () => {}, intervalMs = 5000, cooldownMs = 60000, timeoutMs = 4000, now = () => Date.now()} = {}) {
  if (![probe, repair, select, verify, load, persist].every(fn => typeof fn === 'function')) throw new TypeError('automation adapters are required');
  let preferences = { autoRepair: false, autoSwitch: false, backups: {} };
  let state = { phase:'stopped', checks:{}, problem:null, message:'监测未启动', lastChecked:null, current:null, scope:null, group:null, attempts:[] };
  let active = false, timer = null, inFlight = false, epoch = 0, controller = null;
  let counters = Object.fromEntries(components.map(c => [c,0]));
  let counterLast = Object.fromEntries(components.map(c => [c,0]));
  let counterContext = '', lastActionAt = -Infinity;
  let ready = Promise.resolve().then(load).then(saved => {
    if (!saved || typeof saved !== 'object') return;
    const backups = {};
    if (saved.backups && typeof saved.backups === 'object' && !Array.isArray(saved.backups)) {
      for (const [groupKey, values] of Object.entries(saved.backups)) {
        try {
          const pair = JSON.parse(groupKey);
          if (Array.isArray(pair) && pair.length === 2 && pair.every(x => cleanText(x)) && Array.isArray(values)) backups[groupKey] = [...new Set(values.map(x => cleanText(x)).filter(Boolean))].slice(0, 64);
        } catch { /* Ignore invalid saved group records. */ }
      }
    }
    preferences = {autoRepair:saved.autoRepair === true, autoSwitch:saved.autoSwitch === true, backups};
  });

  function snapshot() { return structuredClone({ ...state, preferences }); }
  function changed(mine) { return mine !== epoch || !controller || controller.signal.aborted; }
  function bounded(action, task, mine) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        task.signal.removeEventListener('abort', aborted);
        fn(value);
      };
      const aborted = () => finish(reject, new Error('cancelled'));
      const timeout = setTimeout(() => {
        if (mine === epoch) state = {...state,phase:'unknown',message:'检查或处理超时，请稍后重试'};
        task.abort();
      }, timeoutMs);
      task.signal.addEventListener('abort', aborted, {once:true});
      if (task.signal.aborted) return aborted();
      Promise.resolve().then(action).then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  function resetCounts() { counters = Object.fromEntries(components.map(c => [c,0])); counterLast = Object.fromEntries(components.map(c => [c,0])); }
  function invalidate() {
    epoch++;
    controller?.abort();
    controller = null;
    resetCounts();
    if (active) state = {...state, phase:'monitoring', problem:null, message:'检测状态已更新，等待下一次检查', attempts:[]};
  }
  async function configure(input = {}) {
    await ready;
    const next = structuredClone(preferences);
    if ('autoRepair' in input) {
      if (typeof input.autoRepair !== 'boolean') throw new TypeError('autoRepair must be boolean');
      next.autoRepair = input.autoRepair;
    }
    const scope = cleanText(input.scope), group = cleanText(input.group);
    if ('backups' in input) {
      if (!scope || !group || !Array.isArray(input.backups) || input.backups.length > 64 || input.backups.some(item => !cleanText(item))) throw new TypeError('scope, group and valid backups are required');
      next.backups[key(scope,group)] = [...new Set(input.backups)];
    }
    if ('autoSwitch' in input) {
      if (typeof input.autoSwitch !== 'boolean') throw new TypeError('autoSwitch must be boolean');
      if (input.autoSwitch && !preferences.autoSwitch) {
        if (!scope || !group || !(next.backups[key(scope,group)] || []).some(node => node !== state.current)) throw new Error('请先选择不同于当前线路的备用节点。');
      }
      next.autoSwitch = input.autoSwitch;
    }
    if ('backups' in input && input.backups.length === 0 && (preferences.backups[key(scope,group)] || []).length) next.autoSwitch = false;
    invalidate();
    await persist(structuredClone(next));
    preferences = next;
    return snapshot();
  }
  function normalise(raw) {
    const output = {scope:cleanText(raw?.scope), group:cleanText(raw?.group), current:cleanText(raw?.current)};
    for (const component of components) output[component] = results.has(raw?.[component]) ? raw[component] : 'unknown';
    return output;
  }
  function resultMessage(problem) {
    return ({core:'内核异常',port:'端口异常',network:'本机网络异常',node:'当前线路异常',codex:'Codex 目标连接异常，原因待确认'})[problem] || '状态待确认';
  }
  async function tick() {
    await ready;
    if (inFlight) return snapshot();
    inFlight = true;
    const mine = ++epoch;
    const task = new AbortController(); controller = task;
    state = {...state, phase:'checking', message:'正在检查运行状态', attempts:[]};
    try {
      let observed = normalise(await bounded(() => probe({signal:task.signal}), task, mine));
      if (changed(mine)) return snapshot();
      const context = key(observed.scope, observed.group) + '\0' + observed.current;
      if (context !== counterContext) { resetCounts(); counterContext = context; }
      for (const component of components) {
        if (observed[component] === 'failed') { counters[component]++; counterLast[component] = now(); }
        else if (observed[component] === 'ok' || (counters[component] && now() - counterLast[component] > 90000)) counters[component] = 0;
      }
      const failed = components.find(component => observed[component] === 'failed' && counters[component] >= 2);
      const confirming = components.some(component => counters[component] === 1);
      state = {...state, checks:observed, current:observed.current || null, scope:observed.scope || null, group:observed.group || null,
        lastChecked:new Date(now()).toISOString(), problem:failed || null,
        phase:failed ? 'issue' : confirming ? 'confirming' : 'monitoring',
        message:failed ? resultMessage(failed) : confirming ? '发现异常，正在等待下一次检查确认' : '检查完成；未知项目尚未确认'};
      if (!failed || !observed.scope || !observed.group) return snapshot();
      if ((!preferences.autoRepair && !preferences.autoSwitch) || now() - lastActionAt < cooldownMs) return snapshot();
      // A Codex-only failure is target-specific and does not justify a repair or node change.
      if (failed === 'codex') return snapshot();
      if (failed === 'node' && (observed.core !== 'ok' || observed.port !== 'ok' || observed.network !== 'ok')) {
        state = {...state,message:'当前线路异常，但基础环境尚未确认，不自动处理'};
        return snapshot();
      }
      if (!preferences.autoRepair && (failed !== 'node' || !preferences.autoSwitch)) return snapshot();
      lastActionAt = now();
      if (preferences.autoRepair) {
        state = {...state, phase:'repairing', message:'正在尝试修复：' + resultMessage(failed)};
        let fixed;
        try { fixed = await bounded(() => repair({problem:failed,observation:observed,signal:task.signal,isCurrent:()=>!changed(mine)}), task, mine); }
        catch { fixed = {ok:false}; }
        if (changed(mine)) return snapshot();
        const after = normalise(await bounded(() => probe({signal:task.signal}), task, mine));
        if (changed(mine)) return snapshot();
        if (fixed?.ok === true && after[failed] === 'ok') {
          resetCounts(); state = {...state, phase:'recovered',problem:null,checks:after,message:'自动修复后复查通过'};
          return snapshot();
        }
        if (after.scope !== observed.scope || after.group !== observed.group || after.current !== observed.current) return snapshot();
        observed = after;
        if (failed === 'node' && (observed.node !== 'failed' || observed.core !== 'ok' || observed.port !== 'ok' || observed.network !== 'ok')) {
          state = {...state,phase:'issue',checks:after,message:'修复后线路或基础环境尚未确认，不自动切换'};
          return snapshot();
        }
        state = {...state,phase:'issue',message:'自动修复后尚未确认恢复'};
      }
      // Prerequisites must be independently known good before blaming a node.
      if (failed !== 'node' || !preferences.autoSwitch || observed.core !== 'ok' || observed.port !== 'ok' || observed.network !== 'ok') return snapshot();
      const candidates = (preferences.backups[key(observed.scope,observed.group)] || []).filter(node => node !== observed.current);
      if (!candidates.length) { state = {...state,message:'没有其他备用节点，请手动选择线路'}; return snapshot(); }
      let actual = observed.current;
      for (const node of candidates) {
        if (changed(mine)) return snapshot();
        state = {...state,phase:'switching',message:'正在检查备用节点 ' + node};
        let before = 'unknown';
        try { before = await bounded(() => verify({scope:observed.scope,group:observed.group,node,phase:'candidate',signal:task.signal}), task, mine); } catch { /* Treat unavailable evidence as unknown. */ }
        if (changed(mine)) return snapshot();
        if (before !== 'ok') { state.attempts.push({node,result:before === 'failed' ? '不可用' : '未确认'}); continue; }
        try {
          await bounded(() => select({scope:observed.scope,group:observed.group,node,signal:task.signal,isCurrent:()=>!changed(mine)}), task, mine);
        } catch {
          if (changed(mine)) return snapshot();
          state.attempts.push({node,result:'切换失败'}); continue;
        }
        if (changed(mine)) return snapshot();
        actual = node;
        state = {...state,current:node,message:'已切换至 ' + node + '，正在复查'};
        let after = 'unknown';
        try { after = await bounded(() => verify({scope:observed.scope,group:observed.group,node,phase:'selected',signal:task.signal}), task, mine); } catch { /* No evidence of success. */ }
        if (changed(mine)) return snapshot();
        if (after === 'ok') {
          state.attempts.push({node,result:'复查通过'}); resetCounts();
          state = {...state,phase:'recovered',problem:null,message:'已切换备用节点并复查通过'};
          return snapshot();
        }
        state.attempts.push({node,result:after === 'failed' ? '复查失败' : '复查未确认'});
        if (after !== 'failed') { state = {...state,phase:'issue',current:actual,message:'已切换线路，但复查结果未知，请手动确认'}; return snapshot(); }
      }
      state = {...state,phase:'issue',current:actual,message:'备用节点均未恢复连接，请手动处理'};
      return snapshot();
    } catch {
      if (!changed(mine)) state = {...state,phase:'unknown',problem:null,message:'暂时无法完成检测，请稍后重试'};
      return snapshot();
    } finally {
      if (mine === epoch) controller = null;
      inFlight = false;
    }
  }
  async function start() {
    await ready;
    if (active) return snapshot();
    active = true;
    state = {...state,phase:'monitoring',message:'监测已开启'};
    timer = setInterval(() => { void tick(); }, intervalMs);
    void tick();
    return snapshot();
  }
  function stop() {
    active = false;
    if (timer) clearInterval(timer);
    timer = null;
    invalidate();
    state = {...state,phase:'stopped',message:'监测已停止'};
    return snapshot();
  }
  return { ready, status:snapshot, configure, start, stop, invalidate, runNow:tick };
}
