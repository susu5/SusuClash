/* Public portable variant: dependency/path selection adapted; original validation logic retained. */
/* Run with the extracted MSI's Node. Real packaged services and temporary files;
 * host evidence/probes/permissions are injected. No live collector or model runs. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const ROOT = path.resolve(__dirname, '..'), VERSION = '0.1.26';
const LOG = path.join(ROOT, 'outputs/log/release-v0.1.26-runtime.json');
const args = process.argv.slice(2), option = key => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {status:'log',version:VERSION,passed:false,installed:false,published:false,actualModelRequests:0,actualProxyProbes:0,actualHostCollectors:0,actualWindowsProxyWrites:0,userConfigurationChanges:0,scenarios:[]};
const REQUIRED = ['netfix-service.mjs','netfix-evidence.mjs','netfix-rules.mjs','netfix-transaction.mjs','netfix-legacy-recovery.mjs','atomic-metadata.mjs','desktop-instance.mjs','proxy-preferences.mjs'];
function inside(root, value) { const relative = path.relative(root, path.resolve(value)); assert(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), 'QA output must stay inside outputs/working'); }
async function run() {
  const manifestFile = process.env.SUSU_PACKAGE_MANIFEST || path.join(ROOT, 'outputs/log/release-v0.1.26-payload.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, '')) : null;
  const requested = option('--payload') || process.env.SUSU_PACKAGE_PAYLOAD || manifest?.payload;
  assert(requested, 'Pass --payload or SUSU_PACKAGE_PAYLOAD; optional verified MSI report via SUSU_PACKAGE_MANIFEST');
  const payload = fs.realpathSync(path.resolve(requested));
  report.payload=payload;
  if(manifest){
    assert.equal(manifest.passed,true,'Payload must have passed independent MSI verification');
    assert.equal(manifest.version,VERSION,'Payload verification version mismatch');
    assert.equal(payload.toLowerCase(),fs.realpathSync(manifest.payload).toLowerCase(),'Runtime evidence must bind the latest verified MSI payload');
    const artifact=fs.realpathSync(manifest.artifact),sha256=createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    assert.equal(sha256,manifest.sha256,'Verified MSI must remain unchanged');
    Object.assign(report,{artifact,artifactSha256:sha256});
  }
  assert.equal(fs.realpathSync(process.execPath).toLowerCase(), fs.realpathSync(path.join(payload, 'runtime/node/node.exe')).toLowerCase(), 'Use the extracted MSI runtime/node/node.exe');
  if(manifest)assert.equal(createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),manifest.records.find(item=>item.path==='runtime/node/node.exe')?.sha256,'Node must be the verified packaged binary');
  assert.equal(JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8')).version, VERSION);
  for (const name of REQUIRED) assert(fs.statSync(path.join(payload, 'src', name)).isFile(), name);
  for (const name of ['netfix.js','netfix.css','backups.css']) assert(fs.statSync(path.join(payload, 'app', name)).isFile(), name);
  for (const folder of ['qa','test','outputs']) assert(!fs.existsSync(path.join(payload, folder)), 'Preview/test outputs must be absent');
  const out = path.resolve(option('--out') || path.join(ROOT, 'outputs/working/release-v0.1.26-runtime-qa'));
  inside(path.join(ROOT, 'outputs/working'), out); fs.mkdirSync(out, {recursive:true});
  const readModule = name => import(pathToFileURL(path.join(payload, 'src', name)).href);
  const {createNetfixService} = await readModule('netfix-service.mjs');
  const {startServer} = await readModule('server.mjs');
  const before = Buffer.from('\uFEFF# packaged fixture\r\nHTTP_PROXY="http://127.0.0.1:43127" # preserve comment\r\nHTTPS_PROXY="http://localhost:43127"\r\nNO_PROXY=localhost,127.0.0.1\r\nKEEP=PACKAGED_PRIVATE_SENTINEL\r\n');
  const after = Buffer.from(before.toString('utf8').replaceAll(':43127', ':7897'));
  const foreign = Buffer.from('HTTPS_PROXY=http://127.0.0.1:10808\r\nKEEP=FOREIGN_EDIT_MUST_SURVIVE\r\n');
  let injectedProbeCalls = 0, injectedHostCalls = 0, forbiddenMutations = 0, assetCount = 0;

  async function checkScenario(scenario) {
    const dir = fs.mkdtempSync(path.join(out, scenario + '-'));
    const home = path.join(dir, 'codex'), stateDirectory = path.join(dir, 'state');
    fs.mkdirSync(home); fs.mkdirSync(stateDirectory);
    const envFile = path.join(home, '.env'); fs.writeFileSync(envFile, before);
    const protectedFiles = {'config.toml':'model="packaged-isolation-fixture"\n','auth.json':'{"fixture":"PACKAGED_AUTH_SENTINEL"}'};
    for (const [name, text] of Object.entries(protectedFiles)) fs.writeFileSync(path.join(home, name), text);
    let wrote = false, app;
    const host = {available:true,listeners:[{port:7897,address:'127.0.0.1',pid:42,name:'verge-mihomo.exe'}],process:{available:true,running:true,port:43127,ambiguous:false},systemProxy:{enabled:true,host:'127.0.0.1',port:7897},vergePorts:[7897]};
    const system = {
      collect:async () => { injectedHostCalls++; return structuredClone(host); },
      logs:async () => ({available:true,complete:true,cHits24h:0,bHits15m:0}),
      auth:async () => ({available:true,present:true,expired:false}),
      probe:async ({port,target}) => {
        injectedProbeCalls++;
        assert(/^https:\/\/(?:api\.openai\.com\/v1\/models|chatgpt\.com\/backend-api\/)$/u.test(target), 'Fixed probe allowlist');
        const ok = port === 7897 && !(wrote && scenario !== 'saved');
        return {ok,code:ok?401:null,error:ok?null:'Timeout',ms:1};
      },
      copyPermissions:async (source, targets) => { assert(source.startsWith(home + path.sep)); for (const target of targets) { assert(target.startsWith(home + path.sep)); assert.equal(fs.statSync(target).size, 0); } },
      permissionFingerprint:async () => 'packaged-injected-acl',
      fileAttributes:async () => null, setFileAttributes:async () => {},
      setReadonly:async (file, locked, mode) => { assert(file.startsWith(home + path.sep)); fs.chmodSync(file, locked ? mode & ~0o222 : mode | 0o200); },
      hook:async ({phase}) => { if (phase === 'afterReplace') { wrote = true; if (scenario === 'conflict') fs.writeFileSync(envFile, foreign); } }
    };
    const netfix = createNetfixService({directory:home,stateDirectory,system,legacyRecover:async () => ({ok:true})});
    const denyMutation = async () => { forbiddenMutations++; assert.fail('No Windows proxy or legacy request mutation may run'); };
    const core = {status:() => ({state:'running',version:'injected-packaged-core'}),preferences:async () => ({expectedPort:7897}),identity:async () => ({}),processId:() => 42,stop:async () => {},call:async (_method, route) => route === '/configs' ? {'mixed-port':7897,mode:'rule',tun:{enable:false}} : route === '/proxies' ? {proxies:{}} : {}};
    try {
      app = await startServer({core,netfixService:netfix,dailyUpdate:false,monitor:{invalidate(){},stop:async () => {},status:() => ({phase:'stopped',preferences:{}})},
        profileStore:{list:async () => ({activeId:null,profiles:[]})},systemProxy:{getStatus:async () => ({enabled:true,managed:true,port:7897}),restoreOnExit:async () => {},enable:denyMutation,disable:denyMutation},
        themePreferences:{get:async () => ({theme:'cat'}),set:async input => ({theme:input.theme})},autostart:{get:async () => ({enabled:false})},trayPreferences:{get:async () => ({closeToTray:true})},
        updateChecker:{check:async () => ({status:'up_to_date',currentVersion:VERSION,latestVersion:VERSION})},
        connectionDoctor:{isRepairing:() => false,invalidate(){},close:async () => {},get:() => ({base:null,history:[]})},
        codexTargetAdapter:{recover:async () => ({ok:true}),discover:denyMutation,probe:denyMutation}});
      assert.equal(new URL(app.url).hostname, '127.0.0.1'); assert(new URL(app.url).pathname.length > 25, 'Random application URL');
      const get = async name => { const response = await fetch(app.url + 'api/' + name); assert.equal(response.status, 200, name); return response.json(); };
      const post = (name, input = {}, origin = app.origin) => fetch(app.url + 'api/' + name, {method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
      async function settle() { const until = Date.now() + 15000; while (Date.now() < until) { const next = await get('netfix'); if (!next.busy) return next; await sleep(10); } throw Error('Packaged Netfix task did not finish: ' + scenario); }
      assert.equal((await get('runtime')).appVersion, VERSION);
      if (scenario === 'saved') {
        const entry = await fetch(app.url); assert.equal(entry.status, 200); const html = await entry.text();
        assert(!/preview-bridge|__preview|netfixPrototype/.test(html)); assert(/src="netfix\.js"/.test(html)); assert(/href="netfix\.css"/.test(html)); assert(/href="backups\.css"/.test(html)); assert(!/src="codex-repair\.js"/.test(html));
        const assets = [...new Set([...html.matchAll(/(?:src|href)="([^"/]+\.(?:css|js))"/g)].map(match => match[1]))];
        assert(assets.includes('netfix.js') && assets.includes('netfix.css') && assets.includes('backups.css') && assets.length >= 20);
        for (const name of assets) { const response = await fetch(app.url + name); assert.equal(response.status, 200, name); const content = await response.text(); assert.equal(content, fs.readFileSync(path.join(payload, 'app', name), 'utf8')); assert(!/preview-bridge|\/__preview|netfix-scenario|netfixPrototype|NETFIX_VIEWS|setNetfixScenario|holdNetfixExecution/.test(content), name + ' must be production code'); }
        for (const name of ['cat-motion.gif','cat-poster.png','fish-motion.gif','fish-poster.png','whale-motion.gif','whale-poster.png']) { const response = await fetch(app.url + name); assert.equal(response.status, 200, name); assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(payload, 'app', name))); }
        assetCount = assets.length;
        for (const route of ['__preview/bridge.js','preview-bridge.js','qa/preview-bridge.js','package.json','.env','auth.json','src/netfix-service.mjs']) assert.equal((await fetch(app.url + route)).status, 404, route);
        assert.equal((await fetch(app.origin + '/api/netfix')).status, 404, 'Missing random path denied');
        assert.equal((await fetch(app.origin + '/wrong-token/api/netfix')).status, 404);
        assert.equal((await post('netfix/diagnose', {}, 'https://foreign.invalid')).status, 403, 'Foreign Origin denied');
        for (const [name, input] of [['doctor/auto-start',{consent:true}],['doctor/start',{scope:'codex'}],['doctor/request',{}],['doctor/confirm',{}],['doctor/preview',{kind:'codex-port'}],['codex-repair/preview',{}],['codex-repair/apply',{token:'old'}]]) assert.equal((await post(name,input)).status, 410, name + ' retired');
      }
      assert.equal((await get('netfix')).stage, 'idle');
      assert.equal((await post('netfix/diagnose')).status, 200);
      let result = await settle(); assert.equal(result.verdict.fixMode, 'fix-port', JSON.stringify(result.verdict));
      assert.equal(result.allowedActions.includes('fix-port'), true);
      assert(!JSON.stringify(result).includes('PACKAGED_PRIVATE_SENTINEL')); assert(!JSON.stringify(result).includes('PACKAGED_AUTH_SENTINEL'));
      const response = await post('netfix/preview', {action:'fix-port',targetPort:65000,expectHash:'forged'}); assert.equal(response.status, 200);
      const plan = await response.json(); assert.equal(plan.rows.length, 6); assert(plan.token); assert.match(JSON.stringify(plan.rows), /7897/); assert(!JSON.stringify(plan.rows).includes('65000'));
      assert(!JSON.stringify(await get('netfix')).includes(plan.token), 'GET must not leak plan tokens');
      assert.equal((await post('netfix/apply', {token:plan.token,confirmed:true})).status, 200);
      result = await settle(); assert(wrote, 'The real file transaction must reach its replacement boundary');
      if (scenario === 'saved') {
        assert.equal(result.stage, 'awaiting_restart'); assert.equal(result.waitingRestart, true); assert.equal(result.verification, 'http_route_only'); assert.deepEqual(fs.readFileSync(envFile), after); assert(result.backups.some(item => item.restorable));
      } else if (scenario === 'rollback') { assert.equal(result.stage, 'rolled_back'); assert.deepEqual(fs.readFileSync(envFile), before); }
      else { assert.equal(result.stage, 'rollback_conflict'); assert.deepEqual(fs.readFileSync(envFile), foreign); assert.deepEqual(result.allowedActions, []); }
      assert(!['probe_passed','app_verified'].includes(result.verification));
      assert.equal((await post('netfix/apply', {token:plan.token,confirmed:true})).status, 409, 'Opaque plans are one-use');
      for (const [name,text] of Object.entries(protectedFiles)) assert.equal(fs.readFileSync(path.join(home,name),'utf8'), text, name + ' unchanged');
      report.scenarios.push({name:scenario,passed:true,stage:result.stage,verification:result.verification,backups:result.backups.length,fixtureDirectory:dir});
    } finally { if (app) await app.close(); else await netfix.close(); }
  }

  for (const scenario of ['saved','rollback','conflict']) await checkScenario(scenario);
  report.optionalCore = {requested:args.includes('--real-core'),executed:false};
  if (args.includes('--real-core')) {
    const {createManagedCore} = await readModule('managed-core.mjs');
    const binary=fs.realpathSync(path.join(payload,'runtime/mihomo.exe')),binarySha256=createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    if(manifest)assert.equal(binarySha256,manifest.records.find(item=>item.path==='runtime/mihomo.exe')?.sha256,'Actual core must be the verified packaged binary');
    const directory = fs.mkdtempSync(path.join(out, 'real-core-')); let core = createManagedCore({directory,binary,runtimeDirectory:path.join(payload,'runtime')});
    const source = path.join(directory, 'fixture.yaml');
    fs.writeFileSync(source, 'mode: rule\ndns:\n  enable: false\nproxies: []\nproxy-groups:\n  - name: Fixture\n    type: select\n    proxies: [DIRECT, REJECT]\nrules:\n  - MATCH,DIRECT\n');
    try { await core.applyConfig(source); const config = await core.call('GET','/configs'); assert(Number.isInteger(config['mixed-port']) && config['mixed-port'] > 0); const saved=JSON.parse(fs.readFileSync(path.join(directory,'port.json'),'utf8')); assert.equal(saved.port,config['mixed-port']); await core.stop(); core=createManagedCore({directory,binary,runtimeDirectory:path.join(payload,'runtime')}); await core.start(); assert.equal((await core.call('GET','/configs'))['mixed-port'],saved.port); report.optionalCore = {requested:true,executed:true,passed:true,version:core.status().version,port:config['mixed-port'],binary,binarySha256,systemProxyWrites:0,freshInstanceReusesPort:true}; }
    finally { await core.stop(); }
  }
  const {checkPackagedStartup}=require('./check-packaged-startup-v026.cjs');
  report.startup=await checkPackagedStartup({out,readModule,startServer,ui:args.includes('--ui')});
  if(report.artifact)assert.equal(createHash('sha256').update(fs.readFileSync(report.artifact)).digest('hex'),report.artifactSha256,'MSI changed while runtime QA was in progress');
  assert.equal(forbiddenMutations, 0);
  Object.assign(report,{passed:true,payload,shippedNode:process.execPath,source:'extracted MSI src/app only',productionAssets:assetCount,backupsStylesheetServed:true,allNetfixModulesPresent:true,previewExcluded:true,opaquePlanVerified:true,retiredRoutes410:true,randomPathAndOriginGuards:true,protectedFilesPreserved:true,injectedProbeCalls,injectedHostCalls,fixtureRoot:out});
}
run().catch(error => { report.failure={message:error.message,stack:error.stack}; process.exitCode=1; }).finally(() => { fs.mkdirSync(path.dirname(LOG),{recursive:true}); fs.writeFileSync(LOG,JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify({passed:report.passed,version:report.version,scenarios:report.scenarios.map(x=>({name:x.name,passed:x.passed,stage:x.stage})),core:report.optionalCore,startup:report.startup?{passed:report.startup.passed,proxyIntent:report.startup.proxyIntent,singleInstance:report.startup.singleInstance,ui:report.startup.ui?{requested:report.startup.ui.requested,passed:report.startup.ui.passed,checks:report.startup.ui.checks,screenshots:report.startup.ui.screenshots,backupSmoke:report.startup.ui.backupSmoke?{passed:report.startup.ui.backupSmoke.passed,cases:report.startup.ui.backupSmoke.cases,screenshots:report.startup.ui.backupSmoke.screenshots}:null}:null}:null,failure:report.failure,log:LOG})); });
