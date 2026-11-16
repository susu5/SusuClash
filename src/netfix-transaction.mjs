import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, mkdir, open, rename, rm, chmod, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseNetfixEnv } from './netfix-rules.mjs';

const execute=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const ownerSession=randomUUID();
const namePattern=/^\.env\.netfix-bak-[0-9]{8}-[0-9]{6}-[a-f0-9-]{36}$/;
const samePath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
const psPath=()=>path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const supportedAttributes=1|2|4|32|128|8192;
const attributeMode=(attributes,locked)=>{if(attributes===null)return null;const value=(attributes&~129)|(locked?1:0);return value||128;};
export const netfixBackupName=(now=Date.now())=>'.env.netfix-bak-'+new Date(now).toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15)+'-'+randomUUID();

export async function readNetfixFileAttributes(file) {
  if(process.platform!=='win32')return null;
  const r=await execute(psPath(),['-NoProfile','-NonInteractive','-Command','$ErrorActionPreference="Stop"; [Console]::Write([int][System.IO.File]::GetAttributes($env:SUSU_NETFIX_ATTRIBUTE_FILE))'],{windowsHide:true,timeout:8000,maxBuffer:1024,env:{...process.env,SUSU_NETFIX_ATTRIBUTE_FILE:file}});
  const value=Number(r.stdout.trim());if(!Number.isInteger(value)||value<0||(value&~supportedAttributes)!==0)throw new Error('unsupported_attributes');return value;
}
export async function setNetfixFileAttributes(file,attributes) {
  if(attributes===null||process.platform!=='win32')return;
  if(!Number.isInteger(attributes)||attributes<0||(attributes&~supportedAttributes)!==0)throw new Error('unsupported_attributes');
  await execute(psPath(),['-NoProfile','-NonInteractive','-Command','$ErrorActionPreference="Stop"; [System.IO.File]::SetAttributes($env:SUSU_NETFIX_ATTRIBUTE_FILE,[System.IO.FileAttributes][int]$env:SUSU_NETFIX_ATTRIBUTE_VALUE); if([int][System.IO.File]::GetAttributes($env:SUSU_NETFIX_ATTRIBUTE_FILE) -ne [int]$env:SUSU_NETFIX_ATTRIBUTE_VALUE){throw "Attribute mismatch"}'],{windowsHide:true,timeout:8000,maxBuffer:1024,env:{...process.env,SUSU_NETFIX_ATTRIBUTE_FILE:file,SUSU_NETFIX_ATTRIBUTE_VALUE:String(attributes)}});
}

export async function copyNetfixPermissions(source,targets) {
  if(process.platform!=='win32')return;
  const command='$ErrorActionPreference="Stop"; $acl=Get-Acl -LiteralPath $env:SUSU_NETFIX_ACL_SOURCE; foreach($p in ($env:SUSU_NETFIX_ACL_TARGETS|ConvertFrom-Json)){Set-Acl -LiteralPath $p -AclObject $acl; if((Get-Acl -LiteralPath $p).Sddl -ne $acl.Sddl){throw "ACL mismatch"}}';
  await execute(psPath(),['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,maxBuffer:4096,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/Modules'),SUSU_NETFIX_ACL_SOURCE:source,SUSU_NETFIX_ACL_TARGETS:JSON.stringify(targets)}});
}

async function permissionFingerprint(file) {
  if(process.platform!=='win32'){const s=await lstat(file);return [s.mode&0o555,s.uid,s.gid].join(':');}
  const r=await execute(psPath(),['-NoProfile','-NonInteractive','-Command','$ErrorActionPreference="Stop"; [Console]::Write((Get-Acl -LiteralPath $env:SUSU_NETFIX_ACL_SOURCE).Sddl)'],{windowsHide:true,timeout:8000,maxBuffer:16384,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/Modules'),SUSU_NETFIX_ACL_SOURCE:file}});
  return hash(Buffer.from(r.stdout,'utf8'));
}
export { permissionFingerprint as readNetfixPermissionFingerprint };

async function plainDirectory(directory,{create=false}={}) {
  if(!directory||process.platform==='win32'&&/^\\\\/.test(directory))throw new Error('unsafe_directory');
  if(create)await mkdir(directory,{recursive:true,mode:0o700});
  const s=await lstat(directory);
  if(!s.isDirectory()||s.isSymbolicLink()||!samePath(await realpath(directory),directory))throw new Error('unsafe_directory');
}
async function safeFile(file,max=1048576) {
  const s=await lstat(file,{bigint:true});
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size>BigInt(max)||!samePath(await realpath(file),file))throw new Error('unsafe_file');
  // NTFS file IDs can exceed JavaScript's exact integer range. Keep their
  // decimal form in fingerprints/journals instead of rounding their identity.
  return {dev:s.dev.toString(),ino:s.ino.toString(),mode:Number(s.mode),size:Number(s.size),mtimeMs:Number(s.mtimeMs),mtimeNs:s.mtimeNs.toString()};
}
async function durable(file,bytes,mode=0o600) {
  const handle=await open(file,'wx',mode);
  try{const born=await handle.stat({bigint:true});await handle.writeFile(bytes);await handle.sync();return {dev:born.dev.toString(),ino:born.ino.toString()};}finally{await handle.close();}
}
async function metadataSnapshot(file) {
  try {
    const before=await safeFile(file,262144),bytes=await readFile(file),after=await safeFile(file,262144);
    if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeNs!==after.mtimeNs||before.mode!==after.mode||before.size!==after.size)throw new Error('metadata_changed');
    const sha256=hash(bytes);
    return {bytes,sha256,fingerprint:JSON.stringify({dev:after.dev,ino:after.ino,mtimeNs:after.mtimeNs,mode:after.mode,size:after.size,sha256})};
  }catch(error){if(error.code==='ENOENT')return {bytes:null,sha256:null,fingerprint:null};throw error;}
}
async function atomicJson(file,value,{system={},kind='journal',expected,expectedId}={}) {
  await plainDirectory(path.dirname(file));
  const prior=expected||await metadataSnapshot(file);
  if(expectedId&&(!prior.bytes||JSON.parse(prior.bytes.toString('utf8')).id!==expectedId))throw new Error('journal_changed');
  const tmp=file+'.tmp-'+randomUUID();
  let owned=null;
  try {
    const bytes=Buffer.from(JSON.stringify(value));await durable(tmp,bytes,0o600);
    owned=await metadataSnapshot(tmp);if(owned.sha256!==hash(bytes))throw new Error('metadata_temp_changed');
    for(let attempt=0;;attempt++) {
      await system.hook?.({phase:'beforeMetadataReplace',kind,attempt});
      await plainDirectory(path.dirname(file));
      const current=await metadataSnapshot(file),temp=await metadataSnapshot(tmp);
      if(current.fingerprint!==prior.fingerprint||temp.fingerprint!==owned.fingerprint)throw new Error('metadata_changed');
      if(expectedId&&(!current.bytes||JSON.parse(current.bytes.toString('utf8')).id!==expectedId))throw new Error('journal_changed');
      try{await (system.renameMetadata||rename)(tmp,file);const saved=await metadataSnapshot(file);if(saved.fingerprint!==owned.fingerprint)throw new Error('metadata_changed');return saved;}
      catch(error){
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=5)throw error;
        await new Promise(resolve=>setTimeout(resolve,16*2**attempt));
      }
    }
  }finally{try{if(owned&&(await metadataSnapshot(tmp)).fingerprint===owned.fingerprint)await rm(tmp,{force:true});}catch{/* Preserve a foreign metadata temporary file. */}}
}

export function createNetfixTransaction({directory,stateDirectory,system={},now=()=>Date.now()}={}) {
  if(!directory||!stateDirectory)throw new Error('netfix_directory_required');
  directory=path.resolve(directory);stateDirectory=path.resolve(stateDirectory);
  const envPath=path.join(directory,'.env'),id=hash(Buffer.from(directory)).slice(0,24);
  const journalPath=path.join(stateDirectory,'netfix-pending-'+id+'.json'),indexPath=path.join(stateDirectory,'netfix-backups-'+id+'.json');
  const copy=system.copyPermissions||copyNetfixPermissions,permission=system.permissionFingerprint||permissionFingerprint;
  const attributes=system.fileAttributes||readNetfixFileAttributes,setAttributes=system.setFileAttributes||setNetfixFileAttributes;
  let active=null,preparing=false;
  const ownedJournals=new Map();
  async function reportError(scope,error,operation) {
    const code=['EPERM','EACCES','EBUSY','ENOENT','EIO','ENOSPC','EROFS','ETIMEDOUT'].includes(error?.code)?error.code:'transaction_failed';
    const syscall=['rename','read','write','open','stat','lstat','unlink','chmod'].includes(error?.syscall)?error.syscall:null;
    try{await system.onError?.({scope,code,operation,syscall});}catch{/* Diagnostic observers cannot change recovery. */}
  }
  async function setLocked(file,locked,mode) {
    if(system.setReadonly)return system.setReadonly(file,locked,mode);
    await chmod(file,locked?mode&~0o222:process.platform==='win32'?0o666:mode|0o200);
  }
  async function inspectAt(file) {
    await plainDirectory(directory);
    try {
      const stat=await safeFile(file),fileAttributes=await attributes(file),bytes=await readFile(file),parsed=parseNetfixEnv(bytes),permissions=await permission(file);
      const last=await safeFile(file);
      if(last.dev!==stat.dev||last.ino!==stat.ino||last.size!==stat.size||last.mtimeNs!==stat.mtimeNs||last.mode!==stat.mode||await attributes(file)!==fileAttributes||await permission(file)!==permissions)throw new Error('file_changed');
      const sha256=hash(bytes),locked=!(stat.mode&0o200),fingerprint=hash(Buffer.from(JSON.stringify({sha256,dev:stat.dev,ino:stat.ino,size:stat.size,mtimeNs:stat.mtimeNs,mode:stat.mode,permissions,fileAttributes})));
      return {exists:true,path:file,bytes,...parsed,sha256,locked,mode:stat.mode&0o777,dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,permissions,attributes:fileAttributes,fingerprint};
    }catch(error){if(error.code==='ENOENT')return {exists:false,path:file,supported:true,hasProxy:false,port:null,locked:false,fingerprint:'missing'};throw error;}
  }
  const inspect=()=>inspectAt(envPath);
  async function assertJournal(record) {
    const expected=ownedJournals.get(record.id),current=await metadataSnapshot(journalPath);
    if(!current.bytes||JSON.parse(current.bytes.toString('utf8')).id!==record.id||expected&&expected.fingerprint!==current.fingerprint)throw new Error('journal_changed');
    return current;
  }
  async function replaceOwnedEnv({tmp,source,destination,record,signal,validate,isAuthorized,kind}) {
    for(let attempt=0;;attempt++) {
      await system.hook?.({phase:'beforeEnvReplace',kind,attempt,record:{...record}});
      if(signal?.aborted)throw new Error('cancelled');
      await validate?.();
      if(signal?.aborted)throw new Error('cancelled');
      await plainDirectory(directory);await plainDirectory(stateDirectory);await assertJournal(record);
      if((await inspect()).fingerprint!==destination.fingerprint)throw new Error('file_changed');
      const currentSource=await inspectAt(tmp);
      if(!currentSource.exists||currentSource.fingerprint!==source.fingerprint)throw new Error('temp_changed');
      if(signal?.aborted)throw new Error('cancelled');
      if(isAuthorized&&isAuthorized()!==true)throw new Error('plan_expired');
      try{await (system.renameEnv||rename)(tmp,envPath);return;}
      catch(error){
        await reportError(kind==='rollback'?'rollback':'transaction',error,'rename');
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=5)throw error;
        await new Promise(resolve=>setTimeout(resolve,16*2**attempt));
      }
    }
  }
  async function readIndex() {
    return decodeIndex(await metadataSnapshot(indexPath));
  }
  function decodeIndex(snapshot) {
    if(!snapshot.bytes)return [];
    try{const data=JSON.parse(snapshot.bytes.toString('utf8'));if(data.version!==1||!Array.isArray(data.items))throw new Error();return data.items.filter(x=>namePattern.test(x.name)&&/^[a-f0-9]{64}$/.test(x.sha256));}catch{throw new Error('backup_index_invalid');}
  }
  async function remember(record) {
    const expected=await metadataSnapshot(indexPath),items=decodeIndex(expected);
    const entry={name:record.backup,sha256:record.beforeHash,port:record.beforePort,at:record.createdAt};
    await atomicJson(indexPath,{version:1,items:[entry,...items.filter(x=>x.name!==entry.name)].slice(0,100)},{system,kind:'index',expected});
  }
  async function listBackups() {
    await plainDirectory(directory);
    const index=await readIndex(),items=[];
    const names=(await readdir(directory)).filter(n=>/^\.env\.(?:netfix-bak-|before-|.*backup)[A-Za-z0-9._-]*$/.test(n)).slice(-100);
    for(const name of names) {
      try {
        const file=path.join(directory,name),s=await safeFile(file),bytes=await readFile(file),parsed=parseNetfixEnv(bytes),sha256=hash(bytes),known=index.find(x=>x.name===name);
        items.push({name,port:parsed.supported?parsed.port:null,at:new Date(s.mtimeMs).toISOString(),sha256,restorable:!!known&&known.sha256===sha256&&parsed.supported,reason:known?'backup_changed':'untracked_backup'});
      }catch{/* Unreadable/link/oversized backups are never candidates. */}
    }
    return items.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,40);
  }
  async function assertCurrent(before) {
    const current=await inspect();if(current.fingerprint!==before.fingerprint)throw new Error('file_changed');return current;
  }
  async function loadJournal(snapshot) {
    try{if(snapshot&&!snapshot.bytes)return null;let bytes=snapshot?.bytes;if(!bytes){await safeFile(journalPath,262144);bytes=await readFile(journalPath);}const r=JSON.parse(bytes.toString('utf8'));if(r.version!==1||r.home!==directory||!['fix-port','restore','lock','unlock'].includes(r.action)||!/^[a-f0-9]{64}$/.test(r.beforeHash)||!/^[a-f0-9]{64}$/.test(r.afterHash)||r.backup&&!namePattern.test(r.backup)||!/^\.env\.netfix-tmp-[a-f0-9-]{36}$/.test(r.tmp||''))throw new Error();return r;}catch(e){if(e.code==='ENOENT')return null;throw new Error('journal_invalid');}
  }
  async function clean(record) {
    await assertJournal(record);
    if(record.tmp&&record.tempFingerprint){const file=path.join(directory,record.tmp);try{if((await inspectAt(file)).fingerprint===record.tempFingerprint)await rm(file,{force:true});}catch{/* Preserve an unowned temporary file. */}}
    await assertJournal(record);
    await rm(journalPath,{force:true});active=null;
    ownedJournals.delete(record.id);
  }
  async function rollback(record) {
    try {
      await plainDirectory(directory);await plainDirectory(stateDirectory);
      if(!ownedJournals.has(record.id)){const snapshot=await metadataSnapshot(journalPath),pending=await loadJournal(snapshot);if(!pending||hash(Buffer.from(JSON.stringify(pending)))!==hash(Buffer.from(JSON.stringify(record))))throw new Error('journal_changed');ownedJournals.set(record.id,snapshot);}
      await assertJournal(record);
      await system.hook?.({phase:'beforeRollback',record:{...record}});
      const current=await inspect();
      if(![record.afterAttributes??null,record.beforeAttributes??null,record.tempAttributes??null,attributeMode(record.beforeAttributes??null,false)].includes(current.attributes))throw new Error('attribute_conflict');
      // Permission changes by another actor are also an ownership conflict.
      if(![record.afterPermissions,record.permissions,record.tempPermissions,record.unlockedPermissions].includes(current.permissions))throw new Error('conflict');
      const beforeIdentity=current.dev===record.beforeIdentity.dev&&current.ino===record.beforeIdentity.ino;
      const unchanged=current.sha256===record.beforeHash&&current.locked===record.beforeLocked&&beforeIdentity&&(!record.beforeFingerprint||current.fingerprint===record.beforeFingerprint);
      const fileAction=record.action==='fix-port'||record.action==='restore';
      const ours=current.sha256===record.afterHash&&(record.afterIdentity?current.dev===record.afterIdentity.dev&&current.ino===record.afterIdentity.ino:true)&&(record.afterFingerprint?current.fingerprint===record.afterFingerprint:fileAction);
      const unlockedOnly=current.sha256===record.beforeHash&&record.beforeLocked&&!current.locked&&beforeIdentity&&typeof record.unlockedFingerprint==='string'&&current.fingerprint===record.unlockedFingerprint;
      if(!unchanged&&!ours&&!unlockedOnly)throw new Error('conflict');
      if(unchanged){await clean(record);return {ok:true};}
      if(unlockedOnly||record.action==='lock'||record.action==='unlock') {
        if(current.sha256!==record.beforeHash)throw new Error('conflict');
        await assertJournal(record);if((await inspect()).fingerprint!==current.fingerprint)throw new Error('conflict');
        await chmod(envPath,record.beforeMode);await setAttributes(envPath,record.beforeAttributes??null);
      }else {
        const backup=path.join(directory,record.backup),savedBackup=await inspectAt(backup);
        const bytes=savedBackup.bytes;if(!savedBackup.exists||hash(bytes)!==record.beforeHash||record.backupFingerprint&&savedBackup.fingerprint!==record.backupFingerprint)throw new Error('backup_changed');
        const tmp=path.join(directory,'.env.netfix-tmp-'+randomUUID());
        let ownedRestore=null;
        try {
          const born=await durable(tmp,Buffer.alloc(0),record.beforeMode|0o200);await copy(backup,[tmp]);
          const h=await open(tmp,'r+');try{const opened=await h.stat({bigint:true});if(opened.dev.toString()!==born.dev||opened.ino.toString()!==born.ino)throw new Error('temp_changed');await h.writeFile(bytes);await h.sync();}finally{await h.close();}
          ownedRestore=await inspectAt(tmp);if(ownedRestore.dev!==born.dev||ownedRestore.ino!==born.ino||ownedRestore.sha256!==record.beforeHash)throw new Error('temp_changed');
          const compare=await inspect();if(compare.fingerprint!==current.fingerprint)throw new Error('conflict');
          await assertJournal(record);
          if(compare.locked)await setLocked(envPath,false,compare.mode);
          await rename(tmp,envPath);await chmod(envPath,record.beforeMode);await setAttributes(envPath,record.beforeAttributes??null);
        }finally{try{if(ownedRestore&&(await inspectAt(tmp)).fingerprint===ownedRestore.fingerprint)await rm(tmp,{force:true});}catch{/* Preserve an unowned restore temporary file. */}}
      }
      const restored=await inspect();if(restored.sha256!==record.beforeHash||restored.locked!==record.beforeLocked||restored.permissions!==record.permissions||restored.attributes!==(record.beforeAttributes??null))throw new Error('rollback_verification');
      await clean(record);return {ok:true};
    }catch(error){await reportError('rollback',error,'restore');return {ok:false,reason:'rollback_conflict'};}
  }
  async function recover() {
    try {
      // A normal get does not inspect or create the user's Codex directory.
      try{await plainDirectory(stateDirectory);}catch(e){if(e.code==='ENOENT')return {ok:true,pending:false};throw e;}
      const snapshot=await metadataSnapshot(journalPath),record=await loadJournal(snapshot);if(!record)return {ok:true,pending:false};
      if(Number.isInteger(record.ownerPid)&&record.ownerPid!==process.pid){try{process.kill(record.ownerPid,0);return {ok:false,pending:true,reason:'writer_running'};}catch(e){if(e.code!=='ESRCH')return {ok:false,pending:true,reason:'writer_unknown'};}}
      active=record;ownedJournals.set(record.id,snapshot);const result=await rollback(record);return {...result,pending:true};
    }catch{return {ok:false,pending:true,reason:'recovery_conflict'};}
  }
  async function changeInternal({before,bytes,action,locked,onStep=()=>{},signal,validate,isAuthorized,backupName}={}) {
    if(!['fix-port','restore','lock','unlock'].includes(action)||active)throw new Error('transaction_busy');
    await plainDirectory(directory);await plainDirectory(stateDirectory,{create:true});
    if(await loadJournal())throw new Error('recovery_pending');
    const current=await assertCurrent(before);
    if(!current.exists||!current.supported)throw new Error('unsupported_env');
    const fileAction=action==='fix-port'||action==='restore';
    if(backupName!==undefined&&!namePattern.test(backupName))throw new Error('backup_invalid');
    if(fileAction&&(!Buffer.isBuffer(bytes)||!parseNetfixEnv(bytes).supported))throw new Error('unsupported_env');
    if(signal?.aborted)throw new Error('cancelled');
    const record={version:1,id:randomUUID(),ownerPid:process.pid,ownerSession,home:directory,action,createdAt:new Date(now()).toISOString(),beforeHash:current.sha256,beforeFingerprint:current.fingerprint,afterHash:fileAction?hash(bytes):current.sha256,beforePort:current.port,beforeMode:current.mode,beforeLocked:current.locked,afterLocked:fileAction?current.locked:!!locked,beforeAttributes:current.attributes,afterAttributes:fileAction?current.attributes:attributeMode(current.attributes,!!locked),permissions:current.permissions,beforeIdentity:{dev:current.dev,ino:current.ino},backup:fileAction?backupName||netfixBackupName(now()):null,tmp:'.env.netfix-tmp-'+randomUUID(),phase:'prepared'};
    const backup=record.backup&&path.join(directory,record.backup),tmp=path.join(directory,record.tmp);
    let journalSaved=false,journalExpected=null,operation='prepare',ownedTemp=null,backupBorn=null,tempBorn=null;
    try {
      if(fileAction) {
        operation='write';
        backupBorn=await durable(backup,Buffer.alloc(0),current.mode|0o200);tempBorn=await durable(tmp,Buffer.alloc(0),current.mode|0o200);
        operation='permissions';
        await copy(envPath,[backup,tmp]);await assertCurrent(before);
        operation='write';
        for(const [file,data,born]of [[backup,current.bytes,backupBorn],[tmp,bytes,tempBorn]]){const h=await open(file,'r+');try{const opened=await h.stat({bigint:true});if(opened.dev.toString()!==born.dev||opened.ino.toString()!==born.ino)throw new Error('temp_changed');await h.writeFile(data);await h.sync();}finally{await h.close();}}
        if(hash(await readFile(backup))!==record.beforeHash||hash(await readFile(tmp))!==record.afterHash)throw new Error('backup_verification');
        operation='attributes';await chmod(backup,current.mode);await setAttributes(backup,current.attributes);
        await chmod(tmp,current.mode|0o200);await setAttributes(tmp,attributeMode(current.attributes,false));
        const backupSaved=await inspectAt(backup);ownedTemp=await inspectAt(tmp);
        if(backupSaved.dev!==backupBorn.dev||backupSaved.ino!==backupBorn.ino||backupSaved.sha256!==record.beforeHash||ownedTemp.dev!==tempBorn.dev||ownedTemp.ino!==tempBorn.ino||ownedTemp.sha256!==record.afterHash)throw new Error('temp_changed');
        record.backupFingerprint=backupSaved.fingerprint;record.tempFingerprint=ownedTemp.fingerprint;record.tempPermissions=ownedTemp.permissions;record.tempAttributes=ownedTemp.attributes;
        await onStep('备份当前 .env','done',record.backup);
      }
      const predicted=fileAction?ownedTemp:current;
      record.afterIdentity={dev:predicted.dev,ino:predicted.ino};
      await assertCurrent(before);await onStep('并发改动检测','done','配置、属性与权限指纹一致');
      // The first durable journal is also the cross-process writer lease.
      // Never overwrite another instance's pending transaction.
      const initialJournal=Buffer.from(JSON.stringify(record));
      operation='journal';
      await durable(journalPath,initialJournal,0o600);journalSaved=true;active=record;
      journalExpected=await metadataSnapshot(journalPath);if(journalExpected.sha256!==hash(initialJournal))throw new Error('journal_changed');
      ownedJournals.set(record.id,journalExpected);
      if(fileAction)await remember(record);
      await system.hook?.({phase:'beforeReplace',record:{...record}});
      await validate?.();
      await assertCurrent(before);if(signal?.aborted)throw new Error('cancelled');
      if(fileAction) {
        let destination=current;
        if(isAuthorized&&isAuthorized()!==true)throw new Error('plan_expired');
        operation='attributes';if(current.locked){
          await setLocked(envPath,false,current.mode);destination=await inspect();
          if(destination.sha256!==current.sha256||destination.dev!==current.dev||destination.ino!==current.ino||destination.locked||destination.permissions!==ownedTemp.permissions||destination.attributes!==attributeMode(current.attributes,false))throw new Error('unlock_conflict');
          record.unlockedFingerprint=destination.fingerprint;record.unlockedPermissions=destination.permissions;record.phase='unlocked';
          operation='journal';journalExpected=await atomicJson(journalPath,record,{system,kind:'journal',expected:journalExpected,expectedId:record.id});ownedJournals.set(record.id,journalExpected);
        }
        operation='rename';await replaceOwnedEnv({tmp,source:ownedTemp,destination,record,signal,validate,isAuthorized,kind:'apply'});
        operation='attributes';await chmod(envPath,current.mode);await setAttributes(envPath,record.afterAttributes);
      }else {if(signal?.aborted)throw new Error('cancelled');if(isAuthorized&&isAuthorized()!==true)throw new Error('plan_expired');operation='attributes';await setLocked(envPath,!!locked,current.mode);await setAttributes(envPath,record.afterAttributes);}
      operation='readback';
      const after=await inspect();
      if(after.dev!==record.afterIdentity.dev||after.ino!==record.afterIdentity.ino)throw new Error('replacement_identity');
      record.afterPermissions=after.permissions;record.afterFingerprint=after.fingerprint;record.phase='written';
      if(fileAction&&after.permissions!==record.permissions)throw new Error('permission_changed');
      operation='journal';journalExpected=await atomicJson(journalPath,record,{system,kind:'journal',expected:journalExpected,expectedId:record.id});ownedJournals.set(record.id,journalExpected);
      await system.hook?.({phase:'afterReplace',record:{...record}});
      const readback=await inspect();
      if(readback.sha256!==record.afterHash||readback.locked!==record.afterLocked||readback.attributes!==record.afterAttributes||readback.permissions!==record.afterPermissions||readback.dev!==after.dev||readback.ino!==after.ino)throw new Error('readback_mismatch');
      await onStep(fileAction?'原子替换':'设置只读位','done',fileAction?'原只读属性与权限已保留':record.afterLocked?'readonly':'writable');
      await onStep(fileAction?'回读校验':'属性校验','done','内容和属性与预期一致');
      return record;
    }catch(error) {
      await reportError('transaction',error,operation);
      if(journalSaved) {error.record=record;error.rollback=await rollback(record);}
      throw error;
    }finally {
      if(!journalSaved){for(const [file,expected]of [[tmp,record.tempFingerprint],[backup,record.backupFingerprint]])if(file&&expected)try{if((await inspectAt(file)).fingerprint===expected)await rm(file,{force:true});}catch{/* Preserve files whose ownership changed. */}}
    }
  }
  async function commit(record) {
    await assertJournal(record);
    const current=await inspect();
    if(current.sha256!==record.afterHash||record.afterFingerprint&&current.fingerprint!==record.afterFingerprint||current.locked!==record.afterLocked||current.attributes!==(record.afterAttributes??null)||current.permissions!==(record.afterPermissions||record.permissions)||record.afterIdentity&&(current.dev!==record.afterIdentity.dev||current.ino!==record.afterIdentity.ino))throw new Error('commit_conflict');
    await clean(record);return {ok:true};
  }
  async function readBackup(name,expectedHash) {
    if(!namePattern.test(name||''))throw new Error('backup_invalid');
    const item=(await listBackups()).find(x=>x.name===name&&x.restorable&&x.sha256===expectedHash);
    if(!item)throw new Error('backup_changed');
    const file=path.join(directory,name);await safeFile(file);const bytes=await readFile(file);
    if(hash(bytes)!==expectedHash)throw new Error('backup_changed');return bytes;
  }
  async function change(options) {
    if(preparing)throw new Error('transaction_busy');
    preparing=true;try{return await changeInternal(options);}finally{preparing=false;}
  }
  return {inspect,listBackups,change,commit,rollback,recover,readBackup,journalPath};
}
