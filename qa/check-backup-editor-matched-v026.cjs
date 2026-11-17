/* Public portable variant: dependency/path selection adapted; original validation logic retained. */
/* Same fixture and untouched eight-item order, paired with the v0.1.25 capture. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startPreview}=require('../scripts/preview-client.cjs');
const {largeFixture}=require('./check-backup-editor-v026.cjs');
const playwrightModule=process.env.SUSU_PLAYWRIGHT_MODULE||'playwright';
const {chromium}=require(playwrightModule);
const ROOT=path.resolve(__dirname,'..');
const OUT=path.join(ROOT,'outputs/working/backup-editor-20261117/matched-comparison');
const LOG=path.join(ROOT,'outputs/log/backup-editor-20261117-matched-comparison.json');
async function run(){
  fs.mkdirSync(OUT,{recursive:true});fs.mkdirSync(path.dirname(LOG),{recursive:true});
  const baseline=JSON.parse(fs.readFileSync(process.env.SUSU_BACKUP_BASELINE_REPORT||path.join(ROOT,'outputs/log/backup-editor-20261117-before.json'),'utf8'));
  const report={status:'log',at:new Date().toISOString(),passed:false,scope:'same 120-candidate fixture and untouched initial eight-item order; main scroll zero',version:require('../package.json').version,actualProxyWrites:0,actualConfigurationChanges:0,records:[],errors:[]};
  const preview=await startPreview();
  const browser=await chromium.launch({headless:true,...(process.env.SUSU_CHROME?{executablePath:process.env.SUSU_CHROME}:{}),args:['--no-proxy-server']});
  try{
    for(const theme of ['cat','fish','whale'])for(const size of [{width:460,height:868},{width:360,height:600}]){
      const fixture=largeFixture(theme),expected=[...fixture.state.automation.backups];preview.fixtures[theme]=fixture;
      assert.equal(expected.length,8);assert.equal(fixture.state.groups[0].members.length,120);
      const context=await browser.newContext({viewport:size,deviceScaleFactor:1,reducedMotion:'reduce'}),page=await context.newPage();
      page.on('pageerror',error=>report.errors.push({theme,size,error:error.message}));
      await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(preview.url).origin?route.continue():route.abort());
      await page.goto(preview.url+'client/'+theme+'/');await page.waitForFunction(()=>!!ui.core&&ui.groups.length>0&&!!ui.automation);
      await page.locator('.tabs [data-open=settings]').click();await page.locator('[data-page=settings] [data-open=backups]').click();
      await page.locator('#backupTabSelected').click();await page.waitForFunction(()=>ui.backupPanel==='selected'&&ui.backupDraft.length===8);
      await page.locator('.app main').evaluate(main=>{main.scrollTop=0;});await page.waitForTimeout(120);
      assert.deepEqual(await page.evaluate(()=>[...ui.backupDraft]),expected);
      assert.deepEqual(await page.locator('#backupList .backup-row').evaluateAll(rows=>rows.map(row=>row.dataset.name)),expected);
      assert.equal(fixture.savedBackups.length,0);assert(await page.locator('#saveBackups').isDisabled());
      const metrics=await page.evaluate(()=>{
        const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!e.closest('[hidden],.sr-only');};
        const main=document.querySelector('.app main'),view=document.querySelector('[data-page=backups]'),nodes=[...view.querySelectorAll('*')].filter(visible);
        const controls=['cancelBackups','backupsTitle','saveBackups'].map(id=>({id,...document.getElementById(id).getBoundingClientRect().toJSON()}));
        const overlap=[];for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){const a=controls[i],b=controls[j];if(Math.min(a.right,b.right)>Math.max(a.left,b.left)+1&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+1)overlap.push([a.id,b.id]);}
        return {mainScroll:main.scrollTop,selectedRows:document.querySelectorAll('#backupList .backup-row').length,candidateRows:ui.groups.find(g=>g.name===ui.group).members.length,small:nodes.filter(e=>e.namespaceURI!=='http://www.w3.org/2000/svg'&&parseFloat(getComputedStyle(e).fontSize)<12).map(e=>({tag:e.tagName,cls:e.className})),badCards:nodes.filter(e=>e.dataset.scSurface==='card'&&getComputedStyle(e).borderTopLeftRadius!=='18px').map(e=>e.className),horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:main.scrollWidth>main.clientWidth+1,viewOverflow:view.scrollWidth>view.clientWidth+1,controls,overlap,controlsReachable:controls.every(r=>r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight),reducedMotion:matchMedia('(prefers-reduced-motion:reduce)').matches};
      });
      assert.equal(metrics.mainScroll,0);assert.equal(metrics.selectedRows,8);assert.equal(metrics.candidateRows,120);
      assert.deepEqual(metrics.small,[]);assert.deepEqual(metrics.badCards,[]);assert.deepEqual(metrics.overlap,[]);assert(metrics.controlsReachable&&metrics.reducedMotion);
      assert(!metrics.horizontalOverflow&&!metrics.mainOverflow&&!metrics.viewOverflow);
      const before=baseline.records.find(record=>record.theme===theme&&record.size.width===size.width&&record.size.height===size.height&&record.state==='backup-editor-top');
      assert(before&&fs.existsSync(before.screenshot));assert.equal(before.selectedRows,8);assert.equal(before.candidateRows,120);assert.equal(before.mainScroll,0);
      const screenshot=path.join(OUT,`${theme}-${size.width}-initial-order-8.png`);await page.screenshot({path:screenshot,animations:'disabled'});
      report.records.push({theme,size,state:'initial-order-8',selectedNames:expected,before:before.screenshot,after:screenshot,baselineMetrics:{selectedRows:before.selectedRows,candidateRows:before.candidateRows,mainScroll:before.mainScroll},metrics,passed:true});
      await context.close();
    }
    assert.equal(report.records.length,6);assert.deepEqual(report.errors,[]);report.passed=true;
  }catch(error){report.failure={message:error.message,stack:error.stack};throw error;}
  finally{await browser.close();await preview.close();fs.writeFileSync(LOG,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify({passed:report.passed,version:report.version,screenshots:report.records.length,log:LOG}));
}
run().catch(error=>{console.error(error);process.exitCode=1;});
