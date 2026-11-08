import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexRepair, inspectProxyLines } from '../src/codex-repair.mjs';

const setup = async (t, text) => {
 const root=path.resolve('outputs/working'); await mkdir(root,{recursive:true}); const dir=await mkdtemp(path.join(root,'codex-repair-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(path.join(dir,'.env'),text,'utf8');let owners=[{port:7891,name:'mihomo.exe',pid:'456'}], response=204;
 const core={applyConfig(){},processId(){return 456},status(){return {state:'running'}},async call(){return {'mixed-port':7891}}};
 const service=createCodexRepair({core,directory:dir,readListeners:async()=>owners,probe:async()=>response,copyPermissions:async()=>{}});
 return {dir,service,owners:value=>owners=value,response:value=>response=value};
};

test('preview and confirmed repair change only local proxy ports and keep rest, including BOM and CRLF',async t=>{
 const before='\uFEFFHTTPS_PROXY="http://127.0.0.1:7890" # active\r\nHTTP_PROXY=http://localhost:7890\r\nOTHER=very-private-value\r\n# ALL_PROXY=http://127.0.0.1:7890\r\n';
 const {dir,service}=await setup(t,before),p=await service.preview();assert.equal(p.eligible,true);assert(!JSON.stringify(p).includes('very-private-value'));
 const r=await service.apply(p.token);assert.equal(r.ok,true,r.message);const after=await readFile(path.join(dir,'.env'),'utf8');
 assert.equal(after,before.replace('127.0.0.1:7890"','127.0.0.1:7891"').replace('localhost:7890','localhost:7891'));
 const backup=(await readdir(dir)).find(x=>x.startsWith('.env.clash-backup-'));assert(backup);assert.equal(await readFile(path.join(dir,backup),'utf8'),before);assert.equal((await service.apply(p.token)).ok,false);
});
test('custom remote, credentialed, conflicting and absent proxy settings are not eligible',()=>{
 for(const value of ['HTTPS_PROXY=http://example.org:7890','HTTPS_PROXY=http://user:secret@localhost:7890','HTTPS_PROXY=http://localhost:7890\nHTTP_PROXY=http://localhost:9999','OTHER=unchanged']) assert.equal(inspectProxyLines(value),null);
});
test('changed configuration after preview prevents all changes',async t=>{
 const {dir,service}=await setup(t,'HTTPS_PROXY=http://127.0.0.1:7890\nSECRET=one\n');const p=await service.preview();assert(p.eligible);const changed='HTTPS_PROXY=http://127.0.0.1:7890\nSECRET=two\n';await writeFile(path.join(dir,'.env'),changed);const result=await service.apply(p.token);assert.equal(result.ok,false);assert.equal(await readFile(path.join(dir,'.env'),'utf8'),changed);assert.equal((await readdir(dir)).length,1);
});
test('occupied old port or failed target probe prevents updates, including changes after preview',async t=>{
 const {dir,service,owners,response}=await setup(t,'HTTPS_PROXY=http://127.0.0.1:7890\n');owners([{port:7890,name:'other.exe'},{port:7891,name:'mihomo.exe',pid:'456'}]);assert.equal((await service.preview()).eligible,false);owners([{port:7891,name:'mihomo.exe',pid:'456'}]);let p=await service.preview();assert(p.eligible);response(0);assert.equal((await service.apply(p.token)).ok,false);assert.equal(await readFile(path.join(dir,'.env'),'utf8'),'HTTPS_PROXY=http://127.0.0.1:7890\n');
});

test('ACL failure or foreign listener fails closed and preserves configuration',async t=>{
 const {dir}=await setup(t,'HTTPS_PROXY=http://127.0.0.1:7890\nSECRET=private\n');const core={applyConfig(){},processId(){return 456},status(){return {state:'running'}},async call(){return {'mixed-port':7891}}};
 let service=createCodexRepair({core,directory:dir,readListeners:async()=>[{port:7891,pid:'999'}],probe:async()=>204,copyPermissions:async()=>{}});assert.equal((await service.preview()).eligible,false);
 service=createCodexRepair({core,directory:dir,readListeners:async()=>[{port:7891,pid:'456'}],probe:async()=>204,copyPermissions:async()=>{throw new Error('cannot preserve permissions')}});let p=await service.preview();assert(p.eligible);let r=await service.apply(p.token);assert.equal(r.ok,false);assert.equal(await readFile(path.join(dir,'.env'),'utf8'),'HTTPS_PROXY=http://127.0.0.1:7890\nSECRET=private\n');assert.deepEqual(await readdir(dir),['.env']);
});

test('rejects symlinked or reparse-point configuration directory',async t=>{
 const root=path.resolve('outputs/working');await mkdir(root,{recursive:true});const base=await mkdtemp(path.join(root,'codex-link-test-'));t.after(()=>rm(base,{recursive:true,force:true}));const real=path.join(base,'real');await mkdir(real);await writeFile(path.join(real,'.env'),'HTTPS_PROXY=http://127.0.0.1:7890\n');const link=path.join(base,'link');try{await symlink(real,link,process.platform==='win32'?'junction':'dir')}catch(e){if(['EPERM','EACCES'].includes(e.code))return t.skip('creating links requires privileges');throw e};const core={applyConfig(){},processId(){return 456},status(){return {state:'running'}},async call(){return {'mixed-port':7891}}};const service=createCodexRepair({core,directory:link,readListeners:async()=>[{port:7891,pid:'456'}],probe:async()=>204,copyPermissions:async()=>{}});assert.equal((await service.preview()).eligible,false);assert.equal(await readFile(path.join(real,'.env'),'utf8'),'HTTPS_PROXY=http://127.0.0.1:7890\n');
});
