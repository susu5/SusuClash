/* Public portable variant: dependency/path selection adapted; original validation logic retained. */
/* Extracted production modules only; all OS proxy writes go to an in-memory adapter. */
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

async function checkPackagedStartup({out,readModule,startServer,ui=false}) {
  const {acquireDesktopInstance}=await readModule('desktop-instance.mjs');
  const {createProxyPreferences}=await readModule('proxy-preferences.mjs');
  const {createSystemProxy}=await readModule('system-proxy.mjs');
  const ipcDirectory=fs.mkdtempSync(path.join(out,'packaged-ipc-'));
  const leases=[];let opened=0;
  try {
    const settled=await Promise.allSettled(Array.from({length:8},()=>acquireDesktopInstance({directory:ipcDirectory,onOpen:()=>opened++})));
    const outcomes=settled.filter(item=>item.status==='fulfilled').map(item=>item.value);
    leases.push(...outcomes);assert.deepEqual(settled.filter(item=>item.status==='rejected'),[]);assert.equal(outcomes.filter(item=>item.primary).length,1);assert.equal(opened,7);
  } finally { await Promise.all(leases.map(item=>item.close())); }

  const directory=fs.mkdtempSync(path.join(out,'packaged-proxy-intent-'));
  const listener=net.createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>listener.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=listener.address().port, disabled=()=>({enable:{present:true,value:0},server:{present:true,value:'previous-disabled-value'}});
  let actual=disabled(),running=true,app,theme='cat',simulatedWrites=0,savedBackups=[];
  const longNode='美国08-0.1倍 | 电信联通移动推荐 — 长线路名称测试';
  const group={name:'Fixture',type:'Selector',now:longNode,all:[longNode,'DIRECT','REJECT']};
  const core={directory,applyConfig:async()=>{},validateConfig:async()=>{},status:()=>({state:running?'running':'stopped',version:'packaged-fixture',message:running?'内核运行中':'内核已停止'}),
    processId:()=>running?32001:null,stop:async()=>{running=false;},preferences:async()=>({expectedPort:port}),identity:async()=>({version:'packaged-fixture',transport:'本机 HTTP'}),
    call:async(method,route)=>{
      if(route==='/version')return{version:'packaged-fixture'};
      if(route==='/configs')return{'mixed-port':port,mode:'rule',tun:{enable:false}};
      if(route==='/proxies')return{proxies:{Fixture:group,[longNode]:{name:longNode,type:'Shadowsocks',history:[{delay:83}]},DIRECT:{name:'DIRECT',type:'Direct'},REJECT:{name:'REJECT',type:'Reject'}}};
      if(route==='/connections')return{connections:[],downloadTotal:0,uploadTotal:0};
      if(route==='/providers/proxies')return{providers:{}};
      throw Error('Unexpected packaged fixture core request');
    }};
  const profiles={restoreActive:async()=>{running=true;},list:async()=>({activeId:'fixture',profiles:[{id:'fixture',name:'隔离启动验证订阅',kind:'local',active:true,loaded:true,lastSuccess:'2026-11-17T00:00:00Z',lastError:null,usage:null}]})};
  function makeProxy(){return createSystemProxy({directory,adapter:{read:async()=>structuredClone(actual),write:async(value,{expected})=>{assert.deepEqual(actual,expected);actual=structuredClone(value);simulatedWrites++;}}});}
  const monitor={invalidate(){},stop:async()=>{},configure:async input=>{if(Object.hasOwn(input,'backups')){assert.equal(input.scope,'fixture');assert.equal(input.group,'Fixture');savedBackups=[...input.backups];}},status:()=>({phase:'monitoring',group:'Fixture',current:longNode,message:'隔离状态',preferences:{autoRepair:false,autoSwitch:false,backups:{[JSON.stringify(['fixture','Fixture'])]:[...savedBackups]}}})};
  async function start(){
    app=await startServer({core,profileStore:profiles,systemProxy:makeProxy(),dailyUpdate:false,monitor,
      themePreferences:{get:async()=>({theme}),set:async input=>({theme:theme=input.theme})},
      autostart:{getStatus:async()=>({enabled:false,conflict:false})},trayPreferences:{get:async()=>({closeToTray:true,available:true})},
      updateChecker:{check:async()=>({status:'up_to_date',currentVersion:'0.1.26',latestVersion:'0.1.26'})},
      connectionDoctor:{get:async()=>({base:null,history:[]}),isRepairing:()=>false,invalidate(){},close:async()=>{}}});
    const until=Date.now()+10000;while((await get('runtime')).restoring){assert(Date.now()<until,'startup fixture timed out');await sleep(10);}
  }
  async function get(route){const r=await fetch(app.url+'api/'+route);assert.equal(r.status,200,route);return r.json();}
  async function post(route,value){const r=await fetch(app.url+'api/'+route,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(value)});assert.equal(r.status,200,await r.text());}
  async function close(){if(app){const current=app;app=null;await current.close();}}
  const result={passed:false,singleInstance:{primaries:1,duplicates:7,passed:true},proxyIntent:{},actualWindowsProxyWrites:0,simulatedProxyWrites:0};
  try {
    const preferences=createProxyPreferences({directory});assert.equal((await preferences.get()).enabled,null);
    await start();assert.equal(simulatedWrites,0);assert.equal((await get('system-proxy')).enabled,false);
    await post('system-proxy',{enabled:true});assert.equal((await get('system-proxy')).managed,true);
    await close();assert.deepEqual(actual,disabled());assert.equal((await createProxyPreferences({directory}).get()).enabled,true);
    await start();assert.equal((await get('system-proxy')).managed,true);assert.equal((await get('runtime')).recoveryWarning,null);
    await post('system-proxy',{enabled:false});await close();const offWrites=simulatedWrites;
    await start();assert.equal((await get('system-proxy')).enabled,false);assert.equal(simulatedWrites,offWrites);await close();
    fs.writeFileSync(path.join(directory,'proxy-preferences.json'),JSON.stringify({version:1,enabled:true}));
    actual={enable:{present:true,value:1},server:{present:true,value:'127.0.0.1:7897'}};const external=structuredClone(actual),externalWrites=simulatedWrites;
    await start();assert.deepEqual(actual,external);assert.equal(simulatedWrites,externalWrites);assert.match((await get('runtime')).recoveryWarning,/保留现状/);await close();
    actual=disabled();fs.writeFileSync(path.join(directory,'proxy-preferences.json'),'{broken-fixture');const badWrites=simulatedWrites;
    await start();assert.equal(simulatedWrites,badWrites);assert.match((await get('runtime')).recoveryWarning,/无法读取/);await close();
    result.proxyIntent={firstLaunchDoesNotEnable:true,explicitEnableRemembered:true,normalExitRestoresOsState:true,restartRestoresRememberedIntent:true,explicitDisableClearsIntent:true,externalProxyPreserved:true,damagedPreferencesCannotEnable:true,passed:true};
    result.simulatedProxyWrites=simulatedWrites;
    if(ui){
      fs.writeFileSync(path.join(directory,'proxy-preferences.json'),JSON.stringify({version:1,enabled:false}));
      await start();result.ui=await checkUi({out,app,setTheme:value=>{theme=value;},resetBackups:()=>{savedBackups=[];},readBackups:()=>[...savedBackups]});await close();
    }else result.ui={requested:false};
    result.passed=true;return result;
  } finally {try{await close();}finally{await new Promise(resolve=>listener.close(resolve));}}
}

async function checkUi({out,app,setTheme,resetBackups,readBackups}) {
  const {chromium}=require(process.env.SUSU_PLAYWRIGHT_MODULE||'playwright');
  const screenshots=path.join(out,'ui');fs.mkdirSync(screenshots,{recursive:true});
  const browser=await chromium.launch({headless:true,...(process.env.SUSU_CHROME?{executablePath:process.env.SUSU_CHROME}:{}),args:['--no-proxy-server']});
  const records=[],errors=[],failures=[],externalRequests=[],backupSmoke=[];
  try {
    for(const theme of ['cat','fish','whale'])for(const viewport of [{width:460,height:868},{width:360,height:600}]){
      setTheme(theme);resetBackups();const context=await browser.newContext({viewport,reducedMotion:'reduce'}),page=await context.newPage();
      await context.addInitScript(()=>{window.chrome??={};window.chrome.webview={postMessage(){},addEventListener(){}};});
      page.on('pageerror',error=>errors.push({theme,viewport,message:error.message}));
      page.on('response',response=>{if(response.status()>=400)failures.push({theme,viewport,status:response.status(),path:new URL(response.url()).pathname.split('/').slice(2).join('/')});});
      page.on('request',request=>{if(!request.url().startsWith(app.url)&&!request.url().startsWith('data:'))externalRequests.push({theme,viewport,url:request.url()});});
      await page.goto(app.url);await page.waitForFunction(()=>typeof ui!=='undefined'&&ui.runtime?.appVersion==='0.1.26'&&ui.profiles.length>0&&ui.core&&ui.groups.some(group=>group.name==='Fixture')&&ui.automation?.scope==='fixture'&&ui.automation?.group==='Fixture');
      await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
      for(const name of ['home','lines','settings','about','runtime']){
        await page.evaluate(name=>openPage(name,true),name);await page.locator(`[data-page="${name}"]`).waitFor({state:'visible'});await page.waitForTimeout(80);
        const metrics=await inspect(page);validate(metrics,`${theme} ${viewport.width} ${name}`);
        const scrolling=await page.evaluate(()=>{const body=document.querySelector('.app main');if(!body||body.scrollHeight<=body.clientHeight+1)return{needed:false};body.scrollTop=body.scrollHeight;const reachedBottom=body.scrollTop+body.clientHeight>=body.scrollHeight-2;body.scrollTop=0;return{needed:true,reachedBottom};});
        if(scrolling.needed)assert.equal(scrolling.reachedBottom,true,'long content reaches the bottom');metrics.scrolling=scrolling;
        if(name==='about')assert.equal(await page.locator('#aboutAppVersion').textContent(),'0.1.26');
        const image=path.join(screenshots,`${theme}-${viewport.width}-${name}.png`);await page.screenshot({path:image});records.push({theme,viewport,page:name,...metrics,screenshot:image});
      }
      await page.evaluate(()=>openPage('settings',true));await page.locator('.settings-theme-entry').click();await page.locator('.theme-dialog-v2').waitFor({state:'visible'});
      await page.keyboard.press('Tab');const metrics=await inspect(page);validate(metrics,`${theme} ${viewport.width} dialog`,true);assert(metrics.focusOutline,'keyboard focus is visible');
      const image=path.join(screenshots,`${theme}-${viewport.width}-theme-dialog.png`);await page.screenshot({path:image});records.push({theme,viewport,page:'theme-dialog',...metrics,screenshot:image});
      await page.keyboard.press('Escape');await page.locator('.theme-dialog-v2').waitFor({state:'hidden'});
      backupSmoke.push(await checkBackupSmoke({page,theme,viewport,screenshots,readBackups}));await context.close();
    }
    assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);assert.deepEqual(externalRequests,[]);return{requested:true,passed:true,themes:3,sizes:2,checks:records.length,screenshots:records.length,totalScreenshots:records.length+backupSmoke.reduce((sum,item)=>sum+item.records.length,0),records,backupSmoke:{passed:backupSmoke.every(item=>item.passed),cases:backupSmoke.length,screenshots:backupSmoke.reduce((sum,item)=>sum+item.records.length,0),records:backupSmoke},pageErrors:errors,failedResponses:failures,externalRequests,previewBridge:false,nativeBridge:'inert WebView2 environment stub; no actual host/window commands'};
  }finally{await browser.close();}
}

async function checkBackupSmoke({page,theme,viewport,screenshots,readBackups}) {
  await page.locator('[data-page=settings] [data-open=backups]').click();await page.locator('[data-page=backups]').waitFor({state:'visible'});
  assert.equal(await page.locator('#backupTabChoices').getAttribute('aria-selected'),'true');assert.equal(await page.locator('#backupTabSelected').getAttribute('aria-selected'),'false');
  assert(await page.locator('#saveBackups').isDisabled());assert.deepEqual(readBackups(),[]);
  await page.locator('#backupSearch').fill('DIRECT');assert.equal(await page.locator('#availableNodes [data-backup-node]').count(),1);
  await page.locator('#availableNodes [data-backup-node="DIRECT"]').check();assert.deepEqual(await page.evaluate(()=>ui.backupDraft),['DIRECT']);assert.deepEqual(readBackups(),[]);
  await page.locator('#backupSearch').fill('REJECT');await page.locator('#availableNodes [data-backup-node="REJECT"]').check();
  assert.deepEqual(await page.evaluate(()=>ui.backupDraft),['DIRECT','REJECT']);
  const records=[];
  for(const state of ['choices','selected']){
    if(state==='selected'){await page.locator('#backupTabSelected').click();assert(await page.locator('#backupOrderPanel').isVisible());await page.locator('#backupList [data-move="down"][data-name="DIRECT"]').click();assert.deepEqual(await page.evaluate(()=>ui.backupDraft),['REJECT','DIRECT']);}
    const metrics=await inspect(page);validate(metrics,`${theme} ${viewport.width} backups ${state}`);const screenshot=path.join(screenshots,`${theme}-${viewport.width}-backups-${state}.png`);await page.screenshot({path:screenshot});records.push({theme,viewport,state,...metrics,screenshot});
  }
  assert.deepEqual(readBackups(),[],'order changes are draft only');
  await page.locator('#backupTabChoices').click();assert.equal(await page.locator('#backupSearch').inputValue(),'REJECT');assert(await page.locator('#availableNodes [data-backup-node="REJECT"]').isChecked());
  await page.locator('#saveBackups').click();await page.locator('[data-page=settings]').waitFor({state:'visible'});assert.deepEqual(readBackups(),['REJECT','DIRECT']);
  return{passed:true,theme,viewport,checks:['new settings entry','two tabs','filtered search','selection stays in draft','selected ordering','search survives tab change','scoped save through packaged API'],records};
}
async function inspect(page){return page.evaluate(()=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!e.closest('[hidden],.sr-only,.doctor-legacy-state,.check-legacy-source')&&e.namespaceURI!=='http://www.w3.org/2000/svg';};
  const nodes=[...document.body.querySelectorAll('*')].filter(visible),rect=e=>{const r=e?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,height:r.height}:null;},dialog=document.querySelector('dialog[open]');
  const active=document.activeElement,focus=active&&getComputedStyle(active);
  return{small:nodes.filter(e=>parseFloat(getComputedStyle(e).fontSize)<12).map(e=>({class:e.className,size:getComputedStyle(e).fontSize})),badCards:nodes.filter(e=>e.dataset.scSurface==='card'&&getComputedStyle(e).borderTopLeftRadius!=='18px').map(e=>e.className),horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,title:rect(document.querySelector('.desktop-titlebar')),navigation:rect(document.querySelector('.tabs')),height:innerHeight,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,nonzeroMotion:nodes.filter(e=>{const s=getComputedStyle(e);return s.animationName!=='none'&&parseFloat(s.animationDuration)>0.01||parseFloat(s.transitionDuration)>0.01;}).map(e=>e.className),focusOutline:!!focus&&focus.outlineStyle!=='none'&&parseFloat(focus.outlineWidth)>0,dialog:dialog?{rect:rect(dialog),radius:getComputedStyle(dialog).borderRadius}:null};
});}
function validate(result,label,dialog=false){
  assert.deepEqual(result.small,[],label+' small text');assert.deepEqual(result.badCards,[],label+' card radius');assert.equal(result.horizontalOverflow,false,label+' overflow');assert.equal(result.reducedMotion,true);assert.deepEqual(result.nonzeroMotion,[],label+' reduced motion');
  assert(result.title&&result.title.top>=0&&result.title.bottom<=result.height+1,label+' title reachable');
  assert(result.navigation&&result.navigation.top>=0&&result.navigation.bottom<=result.height+1,label+' navigation reachable');
  if(dialog){assert(result.dialog&&result.dialog.rect.bottom<=result.height+1);assert.equal(result.dialog.radius,'24px 24px 0px 0px');}
}
module.exports={checkPackagedStartup};
