/* Public portable variant: dependency/path selection adapted; original validation logic retained. */
/* Isolated backup editor visual and interaction QA. No real proxy/configuration. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startPreview}=require('../scripts/preview-client.cjs');
const {createFixture}=require('./preview-fixture.cjs');
const ROOT=path.resolve(__dirname,'..');
const PHASE=process.argv.includes('--before')?'before':'after';
const OUT=path.join(ROOT,'outputs/working/backup-editor-20261117',process.argv.includes('--final')?'after-final':PHASE);
const LOG=path.join(ROOT,'outputs/log','backup-editor-20261117-'+PHASE+'.json');
const playwrightPath=process.env.SUSU_PLAYWRIGHT_MODULE||'playwright';
const {chromium}=require(playwrightPath);
const themes=['cat','fish','whale'],sizes=[{width:460,height:868},{width:360,height:600}];
const clone=value=>JSON.parse(JSON.stringify(value));
function largeFixture(theme,{selected=8,invalid=false,currentSelected=false,count=120}={}){
  const fixture=createFixture(theme),group=fixture.state.groups[0];
  const regions=['香港','日本','新加坡','美国'];
  group.members=Array.from({length:count},(_,i)=>({name:`${regions[i%4]} ${String(i+1).padStart(3,'0')} · ${i===119?'超长线路名称用于验证移动窗口完整阅读和相似节点区分 电信联通移动多地区线路':'稳定线路'}`,delay:i%11===0?null:35+i,type:'Shadowsocks'}));
  group.current=group.members[0]?.name||'';
  fixture.state.automation.group=group.name;fixture.state.automation.scope='daily';
  fixture.state.automation.backups=group.members.slice(1,selected+1).map(m=>m.name);
  if(currentSelected)fixture.state.automation.backups.unshift(group.current);
  if(invalid)fixture.state.automation.backups.push('已下线节点 · 原顺序保留');
  fixture.savedBackups=[];fixture.failSave=false;
  const original=fixture.request;
  fixture.request=(endpoint,method,payload)=>{
    if(endpoint==='automation'&&method!=='GET'&&payload&&Array.isArray(payload.backups)){
      if(fixture.failSave)return{error:'隔离测试：保存未完成，请重试',httpStatus:503};
      fixture.savedBackups.push({scope:payload.scope,group:payload.group,backups:[...payload.backups]});
    }
    return original(endpoint,method,payload);
  };
  return fixture;
}
async function metrics(page){
  return page.evaluate(()=>{
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!e.closest('[hidden],.sr-only');};
    const nodes=[...document.querySelectorAll('[data-page]:not([hidden]) *,dialog[open] *')].filter(visible);
    const rect=e=>{const r=e?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,width:r.width,height:r.height}:null;};
    const main=document.querySelector('.app main'),view=document.querySelector('[data-page]:not([hidden])');
    let headingControls=null;
    if(view.dataset.page==='backups'){
      const items=[document.querySelector('#cancelBackups'),document.querySelector('#backupsTitle'),document.querySelector('#saveBackups')].map(e=>({id:e.id,...e.getBoundingClientRect().toJSON()}));
      const overlap=[];for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){const a=items[i],b=items[j];if(Math.min(a.right,b.right)>Math.max(a.left,b.left)+1&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+1)overlap.push([a.id,b.id]);}
      headingControls={items,overlap,accessible:items.every(r=>r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight)};
    }
    const clippedControls=[...document.querySelectorAll('[data-page="backups"] button,[data-page="backups"] input')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+1||r.left<0;}).map(e=>({id:e.id,label:e.getAttribute('aria-label'),right:e.getBoundingClientRect().right}));
    return {horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:main.scrollWidth>main.clientWidth+1,viewOverflow:view.scrollWidth>view.clientWidth+1,clippedControls,headingControls,small:nodes.filter(e=>e.namespaceURI!=='http://www.w3.org/2000/svg'&&parseFloat(getComputedStyle(e).fontSize)<12).map(e=>({tag:e.tagName,cls:e.className,size:getComputedStyle(e).fontSize})),badCards:nodes.filter(e=>e.dataset.scSurface==='card'&&getComputedStyle(e).borderTopLeftRadius!=='18px').map(e=>({cls:e.className,radius:getComputedStyle(e).borderTopLeftRadius})),viewport:{width:innerWidth,height:innerHeight},navigation:rect(document.querySelector('.tabs')),titlebar:rect(document.querySelector('.window-frame')),reducedMotion:matchMedia('(prefers-reduced-motion:reduce)').matches,mainScroll:main.scrollTop,active:document.activeElement?.id||document.activeElement?.getAttribute('aria-label'),selectedRows:document.querySelectorAll('#backupList .backup-row').length,candidateRows:document.querySelectorAll('#availableNodes [data-add],#availableNodes [data-backup-choice]').length};
  });
}
async function byData(page,selector,key,value){
  const nodes=page.locator(selector),index=await nodes.evaluateAll((items,{key,value})=>items.findIndex(item=>item.dataset[key]===value),{key,value});
  assert(index>=0,selector+' missing '+key+'='+value);return nodes.nth(index);
}
async function draft(page){return page.evaluate(()=>[...ui.backupDraft]);}
async function capture(page,report,theme,size,state){
  await page.waitForTimeout(100);const result=await metrics(page);
  assert(!result.horizontalOverflow&&!result.mainOverflow&&!result.viewOverflow,theme+' '+size.width+' '+state+' internal overflow');
  assert.deepEqual(result.clippedControls,[],theme+' '+state+' clipped controls');assert.deepEqual(result.small,[],theme+' '+state+' small text');assert.deepEqual(result.badCards,[],theme+' '+state+' card radius');
  if(result.headingControls){assert(result.headingControls.accessible,'backup heading controls not reachable');assert.deepEqual(result.headingControls.overlap,[],'backup heading controls overlap');}
  assert(result.reducedMotion);assert(result.navigation&&result.navigation.bottom<=size.height+1);
  const screenshot=path.join(OUT,`${theme}-${size.width}-${state}.png`);await page.screenshot({path:screenshot,animations:'disabled'});
  report.records.push({theme,size,state,...result,screenshot});
}
async function afterFlow(page,fixture,report,theme,size){
  const group=fixture.state.groups[0],saved=clone(fixture.state.automation.backups),initial=await draft(page);
  for(const id of ['backupTabChoices','backupTabSelected','backupSearch','backupSelectResults','backupClearSelection','backupSelectionPanel','backupOrderPanel'])assert.equal(await page.locator('#'+id).count(),1,id);
  assert.deepEqual(initial,saved);assert(await page.locator('#saveBackups').isDisabled());
  const current=await byData(page,'#availableNodes input[data-backup-node]','backupNode',group.current);assert(await current.isDisabled());assert(!await current.isChecked());
  await capture(page,report,theme,size,'choices');
  await page.locator('#backupSearch').fill('日本 稳定');
  const labels=await page.locator('#availableNodes [data-backup-choice]').evaluateAll(items=>items.map(item=>item.dataset.backupChoice));
  assert.equal(labels.length,30);assert(labels.every(name=>name.includes('日本')&&name.includes('稳定')));
  assert.deepEqual(fixture.state.automation.backups,saved,'search must not change saved order');
  const next=group.members.find(m=>m.name.includes('日本')&&!initial.includes(m.name)).name;
  const input=await byData(page,'#availableNodes input[data-backup-node]','backupNode',next);
  await input.scrollIntoViewIfNeeded();const scroll=await page.locator('.app main').evaluate(el=>el.scrollTop);
  await input.click();assert(await input.isChecked());
  assert(Math.abs((await page.locator('.app main').evaluate(el=>el.scrollTop))-scroll)<=8,'selection moved scroll position');
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.backupNode),next,'selection lost checkbox focus');
  const beforeRefresh=await draft(page);await page.evaluate(()=>refresh());assert.deepEqual(await draft(page),beforeRefresh,'polling must preserve draft');
  assert.equal(await page.locator('#backupSearch').inputValue(),'日本 稳定');
  assert.deepEqual(fixture.state.automation.backups,saved,'editing must not write saved order');
  await capture(page,report,theme,size,'search-selection');
  await page.locator('#backupTabSelected').click();assert(await page.locator('#backupOrderPanel').isVisible());
  let ordered=await draft(page),first=ordered[0],second=ordered[1];
  assert(await (await byData(page,'#backupList [data-move="up"]','name',first)).isDisabled());
  await (await byData(page,'#backupList [data-move="down"]','name',first)).click();
  assert.deepEqual((await draft(page)).slice(0,2),[second,first]);
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.name),first,'ordering lost row focus');
  const handle=await byData(page,'#backupList .drag-handle','name',first);await handle.focus();await page.keyboard.press('ArrowUp');
  assert.deepEqual((await draft(page)).slice(0,2),[first,second]);
  await capture(page,report,theme,size,'selected-order');
  const currentDraft=await draft(page),query=await page.locator('#backupSearch').inputValue();
  await page.locator('#cancelBackups').click();await page.locator('#discardDialog').waitFor({state:'visible'});
  await page.keyboard.press('Tab');assert(await page.locator('#discardDialog').evaluate(dialog=>dialog.contains(document.activeElement)));
  await capture(page,report,theme,size,'discard-dialog');
  await page.locator('#keepEditing').click();assert.deepEqual(await draft(page),currentDraft);assert.equal(await page.locator('#backupSearch').inputValue(),query);
  await page.locator('#saveBackups').click();await page.locator('[data-page="settings"]').waitFor({state:'visible'});
  assert.deepEqual(fixture.state.automation.backups,currentDraft);assert.equal(fixture.savedBackups.at(-1).scope,'daily');assert.equal(fixture.savedBackups.at(-1).group,group.name);
  report.interactions.push({theme,size,checks:['keyword AND search','checkbox multi-selection','focus and scroll retention','draft survives polling','explicit order buttons','keyboard order','unsaved guard and continue','scope-bound save'],passed:true});
  for(const name of ['home','lines','settings','about']){
    await page.evaluate(name=>openPage(name,true),name);await page.locator(`[data-page="${name}"]`).waitFor({state:'visible'});await capture(page,report,theme,size,name);
  }
}
async function edgeCases(page,preview,report,theme,size){
  async function reset(options){const f=largeFixture(theme,options);preview.fixtures[theme]=f;await page.goto(preview.url+'client/'+theme+'/');await page.waitForFunction(()=>!!ui.core&&ui.groups.length>0&&!!ui.automation);await page.locator('.tabs [data-open=settings]').click();await page.locator('[data-page=settings] [data-open=backups]').click();return f;}
  let fixture=await reset({selected:0});await page.locator('#backupSearch').fill('确实不存在的节点');assert.equal(await page.locator('#availableNodes input').count(),0);assert(await page.locator('#backupSelectResults').isDisabled());
  await page.locator('#backupSearch').fill('日本');await page.locator('#backupSelectResults').click();assert.equal((await draft(page)).length,30);assert.equal(fixture.savedBackups.length,0);await page.locator('#backupClearSelection').click();assert.deepEqual(await draft(page),[]);
  await page.locator('#backupSearch').fill('');assert(await page.locator('#backupSelectResults').isDisabled());
  await capture(page,report,theme,size,'empty-selection');
  fixture=await reset({selected:64});assert.equal((await draft(page)).length,64);const remaining=fixture.state.groups[0].members[65].name;assert(await (await byData(page,'#availableNodes input','backupNode',remaining)).isDisabled());await page.locator('#backupSearch').fill('日本');assert(await page.locator('#backupSelectResults').isDisabled());
  report.interactions.push({theme,size,checks:['no search result','explicit filtered batch selection','empty search cannot bulk-select','clear is draft only','64 item limit and no silent truncation'],passed:true});
  fixture=await reset({selected:2,invalid:true,currentSelected:true});await page.locator('#backupTabSelected').click();assert(await page.locator('#saveBackups').isDisabled());assert((await page.locator('#backupContextWarning').innerText()).includes('失效'));
  await page.locator('#backupRemoveStale').click();assert(!(await draft(page)).includes('已下线节点 · 原顺序保留'));assert((await draft(page)).includes(fixture.state.groups[0].current));
  await page.locator('#backupTabChoices').click();const currentInput=await byData(page,'#availableNodes input','backupNode',fixture.state.groups[0].current);assert(await currentInput.isChecked());
  fixture.failSave=true;const unsaved=await draft(page);await page.locator('#saveBackups').click();await page.waitForFunction(()=>!ui.busy);assert.deepEqual(await draft(page),unsaved);assert(await page.locator('[data-page=backups]').isVisible());assert.equal(fixture.savedBackups.length,0);assert((await page.locator('#backupContextWarning').innerText()).includes('保存'));
  await capture(page,report,theme,size,'save-failure');
  fixture.failSave=false;await page.locator('#saveBackups').click();await page.locator('[data-page=settings]').waitFor({state:'visible'});
  report.interactions.push({theme,size,checks:['invalid entries explicitly removed','current selection retained and indicated','save failure preserves draft','save failure can retry'],passed:true});
  fixture=await reset({selected:2});await page.locator('#backupSearch').fill('日本');const add=fixture.state.groups[0].members.find(m=>m.name.includes('日本')&&!fixture.state.automation.backups.includes(m.name)).name;await (await byData(page,'#availableNodes input','backupNode',add)).click();
  for(const profile of fixture.state.profiles)profile.active=profile.id==='backup';fixture.state.automation.scope='backup';
  await page.evaluate(async()=>{await refreshProfiles();await refresh();});assert(await page.locator('#saveBackups').isDisabled());assert((await page.locator('#backupContextWarning').innerText()).trim().length>0);assert.equal(fixture.savedBackups.length,0);
  await capture(page,report,theme,size,'context-changed');
  report.interactions.push({theme,size,checks:['profile change invalidates draft destination','changed context performs no save'],passed:true});
  fixture=await reset({selected:2});await page.locator('#backupSearch').fill('日本');const groupAdd=fixture.state.groups[0].members.find(m=>m.name.includes('日本')&&!fixture.state.automation.backups.includes(m.name)).name;await (await byData(page,'#availableNodes input','backupNode',groupAdd)).click();
  await page.evaluate(async()=>{ui.group='流媒体';await refresh();});assert(await page.locator('#saveBackups').isDisabled());assert((await page.locator('#backupContextWarning').innerText()).trim().length>0);assert.equal(fixture.savedBackups.length,0);
  fixture=await reset({selected:0,count:0});assert.equal(await page.locator('#availableNodes input').count(),0);assert(await page.locator('#saveBackups').isDisabled());assert(await page.locator('#backupSelectResults').isDisabled());
  await capture(page,report,theme,size,'no-candidates');
  report.interactions.push({theme,size,checks:['group change invalidates draft destination','empty candidate list remains usable'],passed:true});
}
async function run(){
  fs.mkdirSync(OUT,{recursive:true});fs.mkdirSync(path.dirname(LOG),{recursive:true});
  const report={status:'log',phase:PHASE,at:new Date().toISOString(),passed:false,isolated:true,actualProxyWrites:0,actualConfigurationChanges:0,playwrightModule:playwrightPath,records:[],interactions:[],errors:[],externalRequests:[]};
  const preview=await startPreview();
  const browser=await chromium.launch({headless:true,...(process.env.SUSU_CHROME?{executablePath:process.env.SUSU_CHROME}:{}),args:['--no-proxy-server']});
  try{
    for(const theme of themes)for(const size of sizes){
      preview.fixtures[theme]=largeFixture(theme);
      const context=await browser.newContext({viewport:size,deviceScaleFactor:1,reducedMotion:'reduce'}),page=await context.newPage();
      page.on('pageerror',e=>report.errors.push({theme,size,error:e.message}));
      await page.route('**/*',route=>{if(new URL(route.request().url()).origin===new URL(preview.url).origin)return route.continue();report.externalRequests.push({theme,size,url:route.request().url()});return route.abort();});
      await page.goto(preview.url+'client/'+theme+'/');
      await page.waitForFunction(()=>!!ui.core&&ui.groups.length>0&&!!ui.automation);
      await page.locator('.tabs [data-open="settings"]').click();
      await page.locator('[data-page=settings] [data-open=backups]').click();
      await page.locator('[data-page=backups]').waitFor({state:'visible'});
      await page.waitForTimeout(100);
      const before=await metrics(page);if(PHASE!=='before'){assert(!before.horizontalOverflow);assert.equal(before.small.length,0,JSON.stringify(before.small));}
      const screenshot=path.join(OUT,`${theme}-${size.width}-backups.png`);await page.screenshot({path:screenshot});
      report.records.push({theme,size,state:'backup-editor-top',...before,screenshot});
      if(PHASE==='before'){
        await page.locator('#availableNodes').scrollIntoViewIfNeeded();
        const availableScreenshot=path.join(OUT,`${theme}-${size.width}-available.png`);await page.screenshot({path:availableScreenshot});
        report.records.push({theme,size,state:'candidate-list',...(await metrics(page)),screenshot:availableScreenshot});
      }else{await afterFlow(page,preview.fixtures[theme],report,theme,size);if(theme==='cat'&&size.width===460)await edgeCases(page,preview,report,theme,size);}
      await context.close();
    }
    assert.equal(report.errors.length,0,JSON.stringify(report.errors));assert.equal(report.externalRequests.length,0,JSON.stringify(report.externalRequests));report.passed=true;
  }catch(error){report.failure={message:error.message,stack:error.stack};throw error;}
  finally{await browser.close();await preview.close();fs.writeFileSync(LOG,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify({passed:report.passed,phase:PHASE,screenshots:report.records.length,log:LOG,playwrightModule:playwrightPath}));
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={largeFixture};
