import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { createManagedCore } from '../src/managed-core.mjs';

const fixture = 'mode: rule\nmixed-port: 0\nproxies: []\ndns:\n  enable: true\n  nameserver: [1.1.1.1]\n  fallback: [8.8.8.8]\n  fallback-filter:\n    geoip: false\n    geosite: [gfw]\nrules:\n  - GEOSITE,apple-cn,DIRECT\n  - GEOSITE,google-cn,DIRECT\n  - GEOSITE,cn,DIRECT\n  - MATCH,DIRECT\n';

test('bundled geosite supports DNS fallback gfw and Meta categories',async t=>{
  if(process.platform!=='win32') return t.skip('requires the Windows Mihomo runtime');
  const directory=await mkdtemp(path.join(os.tmpdir(),'susu-geosite-compat-'));
  const core=createManagedCore({directory});
  t.after(async()=>{await core.stop();await rm(directory,{recursive:true,force:true});});
  const file=path.join(directory,'fixture.yaml');await writeFile(file,fixture);
  await core.validateConfig(file);
  // Validation and startup use the same prepared database and preserve DNS semantics.
  await core.applyConfig(file);
  assert.equal(core.status().state,'running');
  const runtime=await readFile(path.join(directory,'core','runtime.yaml'),'utf8');
  assert.match(runtime,/geosite:\s*\n\s*- gfw/);
});

test('a legacy release database fails first, then migrates and validates the same DNS config',async t=>{
  const legacy=process.env.SUSU_TEST_LEGACY_GEOSITE;
  if(process.platform!=='win32'||!legacy) return t.skip('set SUSU_TEST_LEGACY_GEOSITE to the reviewed 0.1.9 database');
  const directory=await mkdtemp(path.join(os.tmpdir(),'susu-geosite-upgrade-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const coreDirectory=path.join(directory,'core');await mkdir(coreDirectory);
  const legacyBytes=await readFile(legacy);
  const legacyHash=createHash('sha256').update(legacyBytes).digest('hex');
  assert.equal(legacyHash,'dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2');
  await copyFile(legacy,path.join(coreDirectory,'geosite.dat'));
  for(const name of ['geoip.dat','Country.mmdb','ASN.mmdb']) await copyFile(path.resolve('runtime',name),path.join(coreDirectory,name));
  const file=path.join(directory,'fixture.yaml');
  const dnsFixture=fixture.replace('  - GEOSITE,apple-cn,DIRECT\n','').replace('  - GEOSITE,google-cn,DIRECT\n','');
  await writeFile(file,dnsFixture);
  const binary=path.resolve('runtime','mihomo.exe');
  const env={...process.env};
  for(const name of Object.keys(env)) if(name.toUpperCase()==='SAFE_PATHS'||name.toUpperCase().startsWith('CLASH_'))delete env[name];
  await assert.rejects(promisify(execFile)(binary,['-d',coreDirectory,'-f',file,'-t'],{windowsHide:true,timeout:15000,env}),error=>{
    assert.equal(error.code,1);
    assert.match(String(error.stdout||'')+String(error.stderr||''),/list gfw not found in geosite.dat/);
    return true;
  });
  const core=createManagedCore({directory});
  await core.validateConfig(file);
  assert.deepEqual(await readFile(path.join(coreDirectory,'geosite.'+legacyHash+'.bak')),legacyBytes);
  assert.deepEqual(await readFile(path.join(coreDirectory,'geosite.dat')),await readFile(path.resolve('runtime','geosite.dat')));
});
