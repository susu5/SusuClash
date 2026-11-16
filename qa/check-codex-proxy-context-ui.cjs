const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
const {startPreview}=require('../scripts/preview-client.cjs');
const ROOT=path.resolve(__dirname,'..'),OUT=path.resolve(process.env.SUSU_PROXY_UI_OUT||path.join(ROOT,'outputs/working/codex-proxy-context-ui'));
const LOG=path.resolve(process.env.SUSU_PROXY_UI_LOG||path.join(ROOT,'outputs/log/codex-proxy-context-ui.json'));
const VERSION=require('../package.json').version;
const sizes=[{width:460,height:868},{width:360,height:600}];
async function layout(page,doctor=false){
 return page.evaluate(doctor=>{
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!e.closest('[hidden],.sr-only,.doctor-legacy-state,.check-legacy-source')&&e.namespaceURI!=='http://www.w3.org/2000/svg';};
  const scope=doctor?document.querySelector('.doctor-shell'):document.body;
  const nodes=[...scope.querySelectorAll('*')].filter(visible),body=scope.querySelector('.app-body'),footer=scope.querySelector('.action-area');
  const nav=document.querySelector('.tabs'),title=document.querySelector('.desktop-titlebar');
  const rect=e=>{const r=e?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,height:r.height}:null;};
  const cards=nodes.filter(e=>e.dataset.scSurface==='card');
  const active=document.activeElement,s=active?getComputedStyle(active):null;
  return {overflow:document.documentElement.scrollWidth>innerWidth+1||!!body&&body.scrollWidth>body.clientWidth+1,
   scroll:!!body&&body.scrollHeight>body.clientHeight+1,scrollTop:body?.scrollTop||0,
   title:rect(title),navigation:rect(nav),footer:rect(footer),viewportHeight:innerHeight,
   small:nodes.filter(e=>parseFloat(getComputedStyle(e).fontSize)<12).map(e=>e.className),
   cardRadii:cards.map(e=>getComputedStyle(e).borderRadius),
   reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
   active:{tag:active?.tagName,outline:s?.outlineStyle,outlineWidth:s?.outlineWidth},
   nonzeroMotion:nodes.filter(e=>{const s=getComputedStyle(e);return s.animationName!=='none'&&parseFloat(s.animationDuration)>0.01||parseFloat(s.transitionDuration)>0.01;}).map(e=>e.className)};
 },doctor);
}
function validate(result,label){
 assert.equal(result.overflow,false,label+' horizontal overflow');assert.deepEqual(result.small,[],label+' small text');
 assert(result.cardRadii.every(x=>x==='18px'),label+' card radius');assert.equal(result.reducedMotion,true);
 assert(result.navigation&&result.navigation.top>=0&&result.navigation.bottom<=result.viewportHeight+1,label+' navigation reachable');
 assert(result.title&&result.title.height>0&&result.title.top>=0&&result.title.bottom<=result.viewportHeight+1,label+' titlebar reachable');
 assert.deepEqual(result.nonzeroMotion,[],label+' reduced motion');
}
async function captureNative(preview){
 const binary=process.env.SUSU_PROXY_UI_NATIVE_BINARY;
 if(!binary)return {requested:false,captures:[]};
 // Native capture intentionally uses a long line name. Keep the fixture's
 // periodic API refresh in that same state while the host changes themes.
 const longName='美国08-0.1倍 | 电信联通移动推荐 — 长线路名称测试';
 const fixture=preview.fixtures.cat.state,oldName=fixture.groups[0].current;
 for(const group of fixture.groups){if(group.current===oldName)group.current=longName;for(const member of group.members)if(member.name===oldName)member.name=longName;}
 const profile=path.join(OUT,'native-profile-'+Date.now());await fs.mkdir(profile,{recursive:true});
 const native=spawn(path.resolve(binary),[preview.url+'client/cat/',profile,String(process.pid),'--test'],{windowsHide:true,stdio:'ignore',env:{...process.env,SUSU_TEST_RENDER:'1'}});
 const result=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{native.kill();reject(Error('Isolated native capture timed out'));},45000);
  native.once('error',e=>{clearTimeout(timer);reject(e);});native.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
 });
 assert.deepEqual(result,{code:0,signal:null});
 const files=await fs.readdir(profile);assert(!files.includes('test-error.txt'),'native test succeeded');
 const captures=[];
 for(const file of files.filter(x=>/^native-.*\.png$/.test(x))){
  const metrics=JSON.parse(await fs.readFile(path.join(profile,file.replace(/\.png$/,'.json')),'utf8'));
  assert(metrics.width>=360&&metrics.height>=600&&metrics.dpr>=1,'native viewport metrics');
  captures.push({file:path.join(profile,file),metrics});
 }
 assert.equal(captures.length,6);return {requested:true,testMode:true,binary:path.resolve(binary),profile,captures};
}
async function main(){
 await fs.mkdir(OUT,{recursive:true});
 const target=await fs.readFile(path.join(ROOT,'src/codex-target.mjs'),'utf8');
 const autoRepair=await fs.readFile(path.join(ROOT,'src/codex-auto-repair.mjs'),'utf8');
 const proxyLoadDetail='本机代理端口已备份并保存，两次代理文件投影请求通过；尚未确认原 Codex 启动入口加载该文件。已保留正在进行的任务。';
 assert(autoRepair.includes(proxyLoadDetail),'proxy file activation detail kept in sync');
 const details={
  old:'正在识别 Codex 使用的连接设置',
  occupied:'应用代理的旧端口仍被程序使用或无法核对归属，已保留该程序和原设置。',
  external:'应用代理包含自定义地址、冲突语法或无法安全读取的文件，已保留原设置。'
 };
 for(const text of [details.occupied,details.external])assert(target.includes(text),'backend detail kept in sync');
 const preview=await startPreview();let browser;const results=[],errors=[],externalRequests=[];
 try{
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--no-proxy-server']});
 for(const theme of ['cat','fish','whale']){
  const context=await browser.newContext({viewport:sizes[0],deviceScaleFactor:1,reducedMotion:'reduce'}),page=await context.newPage();
  page.on('pageerror',e=>errors.push({theme,error:e.message}));
  page.on('request',r=>{if(!r.url().startsWith(preview.url)&&!r.url().startsWith('data:'))externalRequests.push({theme,url:r.url()});});
  await page.goto(preview.url+'client/'+theme+'/');await page.locator('.doctor-home:not([hidden])').waitFor();
  await page.waitForFunction(()=>!!ui.core&&ui.groups.length>0);
  for(const size of sizes){
   await page.setViewportSize(size);
   for(const name of ['home','lines','settings','about']){
    await page.evaluate(name=>openPage(name,true),name);await page.locator('[data-page="'+name+'"]').waitFor({state:'visible'});await page.waitForTimeout(65);
    const info=await layout(page);validate(info,theme+' '+name);assert(info.navigation.bottom<=size.height+1);assert(info.navigation.top>=0);
    await page.screenshot({path:path.join(OUT,theme+'-'+name+'-'+size.width+'.png')});results.push({theme,scene:name,size,...info});
   }
   await page.evaluate(()=>{openPage('settings');document.querySelector('.settings-theme-entry').click();});await page.locator('.theme-dialog-v2').waitFor({state:'visible'});
   let info=await layout(page);validate(info,theme+' theme dialog');
   await page.screenshot({path:path.join(OUT,theme+'-theme-dialog-'+size.width+'.png')});await page.keyboard.press('Escape');await page.locator('.theme-dialog-v2').waitFor({state:'hidden'});
   results.push({theme,scene:'theme-dialog',size,...info});
  }
  const identify={id:'identify',title:'已识别本机 Codex 入口并重新读取运行记录',status:'passed'};
  const states=[
   {name:'system-proxy',stage:'probe_passed',detail:'两次新连接均正常，本轮未复现原来的重连问题，因此没有更改设置。当前桌面窗口和原聊天仍未验证。',changed:false,actions:[identify]},
   {name:'equivalent-env',stage:'probe_passed',detail:'两次新连接均正常，本轮未复现原来的重连问题，因此没有更改设置。当前桌面窗口和原聊天仍未验证。',changed:false,actions:[identify]},
   {name:'old-port-checking',stage:'checking',detail:details.old,verification:'route_ok',actions:[identify]},
   {name:'old-port-repairing',stage:'repairing',detail:'已找到有效设置，正在备份并保存最小改动',verification:'route_ok',actions:[identify,{id:'candidate',title:'候选连接设置的诊断请求已通过',status:'passed'}]},
   {name:'awaiting-activation',stage:'awaiting_activation',detail:proxyLoadDetail,activation:'awaiting_proxy_load',actions:[identify,{id:'repair',title:'已备份并保存连接设置',status:'passed'},{id:'verify',title:'两个全新连接均收到完整回复，未发生重试',status:'passed'}]},
   {name:'external-proxy',stage:'unsupported',detail:details.external,verification:'none',actions:[]},
   {name:'occupied-port',stage:'unsupported',detail:details.occupied,verification:'route_ok',actions:[identify]},
   {name:'rollback-conflict',stage:'rollback_conflict',detail:'自动恢复没有全部完成，已保留恢复记录并停止继续修改。',verification:'route_ok',actions:[identify]}
  ];
  for(const state of states){
   const a={requests:['checking','unsupported'].includes(state.stage)?0:2,requestLimit:5,verification:'probe_passed',...state};
   const fixture=preview.fixtures[theme];fixture.state.readyAt=0;fixture.state.nextResult=null;
   fixture.state.doctor.codex={status:a.stage,client:'desktop',symptom:'reconnect',sessionConfirmed:false,checkedAt:'2026-11-11T04:00:00Z',checks:[{id:'automatic',name:'本轮自动处理',status:a.stage,detail:a.detail},{id:'session',name:'原任务验证',status:'unknown',detail:'本轮未向原聊天重复发送任务，原任务完成情况单独记录。'}],autoRepair:a};
   fixture.state.doctor.task={id:'proxy-ui-'+state.name,scope:'codex',phase:['checking','repairing'].includes(a.stage)?'repairing':'completed',step:a.detail};
   await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.waitForTimeout(75);
   for(const size of sizes){
    await page.setViewportSize(size);await page.evaluate(v=>connectionDoctor.open(v),['checking','repairing'].includes(a.stage)?'progress':'codex-result');await page.waitForTimeout(90);
    const shell=page.locator('.doctor-shell');await shell.waitFor({state:'visible'});
    const text=await shell.innerText();assert(!text.includes('当前 Codex 已通过验证'));assert.equal(await shell.locator('.outcome-symbol.ok').count(),0);assert.equal(await shell.locator('[data-doctor=confirm]').count(),0);
    if(a.stage==='awaiting_activation')assert(text.includes('当前窗口尚未确认'));
    if(a.stage==='unsupported')assert(text.includes(a.detail));
    let info=await layout(page,true);validate(info,theme+' '+state.name);assert(info.navigation.bottom<=size.height+1);assert(info.footer.bottom<=size.height+1);assert(info.navigation.top>=0);
    await shell.locator('.page-header button').focus();await page.keyboard.press('Tab');
    const focus=await page.evaluate(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,reachable:r.top>=0&&r.bottom<=innerHeight,outline:s.outlineStyle,width:s.outlineWidth};});
    assert(['BUTTON','SELECT','INPUT','SUMMARY'].includes(focus.tag));assert.equal(focus.reachable,true);assert.notEqual(focus.outline,'none');
    if(!['checking','repairing'].includes(a.stage)){
     await shell.locator('details.fold summary').click();await page.waitForTimeout(35);const expanded=await layout(page,true);validate(expanded,theme+' '+state.name+' details');
     if(a.activation==='awaiting_proxy_load')assert((await shell.locator('details.fold').innerText()).includes(proxyLoadDetail),'expanded evidence explains unverified proxy file loading');
     await shell.locator('.app-body').evaluate(e=>e.scrollTop=e.scrollHeight);const scrolled=await layout(page,true);if(scrolled.scroll)assert(scrolled.scrollTop>0);
     assert(scrolled.navigation.bottom<=size.height+1);await shell.locator('.app-body').evaluate(e=>e.scrollTop=0);await shell.locator('details.fold summary').click();
    }
    await shell.locator('.app-body').evaluate(e=>e.scrollTop=0);
    await page.screenshot({path:path.join(OUT,theme+'-'+state.name+'-'+size.width+'.png')});results.push({theme,scene:state.name,size,...info,keyboard:focus});
   }
  }
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
 const native=await captureNative(preview);
 const report={status:'log',passed:true,version:VERSION,scope:'隔离预览，未修改生产配置、未发送模型请求，不能据此确认真实网络或当前Codex已恢复。',themes:3,sizes,scenes:results.length,screenshots:results.length,totalScreenshots:results.length+native.captures.length,native,errors,externalRequests,results};
 await fs.mkdir(path.dirname(LOG),{recursive:true});await fs.writeFile(LOG,JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:true,version:VERSION,themes:3,scenes:results.length,screenshots:results.length,nativeCaptures:native.captures.length,log:LOG}));
 }finally{await browser?.close();await preview.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
