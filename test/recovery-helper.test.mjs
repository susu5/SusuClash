import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

test('independent helper acknowledges, waits for owned fixture exit, relaunches and leaves a recheck receipt',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'susuclash-helper-test-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 await copyFile(new URL('../src/recovery-helper.mjs',import.meta.url),path.join(dir,'recovery-helper.mjs'));
 const marker=path.join(dir,'restarted.txt');
 await writeFile(path.join(dir,'desktop.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'restarted');`);
 const {prepareClientRestart}=await import(pathToFileURL(path.join(dir,'recovery-helper.mjs')));
 const parent=spawn(process.execPath,['-e','setTimeout(()=>{},1800)'],{windowsHide:true,stdio:'ignore'});
 const result=await prepareClientRestart(dir,{pid:parent.pid});assert(result.helperPid>0);
 assert.equal(await readFile(marker,'utf8').catch(()=>null),null,'must wait for original process exit');
 const end=Date.now()+8000;while(Date.now()<end&&!await readFile(marker,'utf8').catch(()=>null))await new Promise(r=>setTimeout(r,100));
 assert.equal(await readFile(marker,'utf8'),'restarted');
 const receipt=JSON.parse(await readFile(path.join(dir,'restart-receipt.json'),'utf8'));assert.equal(receipt.needsRecheck,true);assert.equal(receipt.source,'independent-helper');
});

test('Chinese standalone recovery script parses in Windows PowerShell 5.1 with explicit UTF-8 BOM',async()=>{
 const target=fileURLToPath(new URL('../src/recovery-assistant.ps1',import.meta.url));const bytes=await readFile(target);assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);
 if(process.platform!=='win32')return;
 const command="$taskTokens=$null;$taskErrors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('"+target.replaceAll("'","''")+"',[ref]$taskTokens,[ref]$taskErrors);if($taskErrors.Count){exit 1};Write-Output 'passed'";
 const result=await promisify(execFile)(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:10000});assert.match(result.stdout,/passed/);
});
