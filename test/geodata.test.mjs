import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareCoreGeodata } from '../src/geodata.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(),'susu-geodata-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const runtimeDirectory=path.join(root,'runtime'),coreDirectory=path.join(root,'core');
  await mkdir(runtimeDirectory); await mkdir(coreDirectory);
  return {runtimeDirectory,coreDirectory};
}
async function bundle(dirs, content, replaces=[]) {
  await writeFile(path.join(dirs.runtimeDirectory,'geosite.dat'),content);
  await writeFile(path.join(dirs.runtimeDirectory,'geodata.json'),JSON.stringify({version:1,geosite:{sha256:hash(content),replaces}}));
}

test('new installation gets the verified database and repeated preparation is stable',async t=>{
  const dirs=await fixture(t); await bundle(dirs,'new database');
  await prepareCoreGeodata(dirs); await prepareCoreGeodata(dirs);
  assert.equal(await readFile(path.join(dirs.coreDirectory,'geosite.dat'),'utf8'),'new database');
  assert.deepEqual(JSON.parse(await readFile(path.join(dirs.coreDirectory,'bundled-geodata.json'),'utf8')),{version:1,geosite:hash('new database')});
  assert.equal((await readdir(dirs.coreDirectory)).filter(n=>n.endsWith('.bak')).length,0);
});

test('known legacy data migrates once with a byte-exact backup and other data stays intact',async t=>{
  const dirs=await fixture(t);await bundle(dirs,'new database',[hash('legacy database')]);
  await writeFile(path.join(dirs.coreDirectory,'geosite.dat'),'legacy database');
  await writeFile(path.join(dirs.coreDirectory,'geoip.dat'),'keep geoip');
  await writeFile(path.join(dirs.coreDirectory,'runtime.yaml'),'keep config');
  await prepareCoreGeodata(dirs);await prepareCoreGeodata(dirs);
  assert.equal(await readFile(path.join(dirs.coreDirectory,'geosite.dat'),'utf8'),'new database');
  assert.equal(await readFile(path.join(dirs.coreDirectory,'geosite.'+hash('legacy database')+'.bak'),'utf8'),'legacy database');
  assert.equal(await readFile(path.join(dirs.coreDirectory,'geoip.dat'),'utf8'),'keep geoip');
  assert.equal(await readFile(path.join(dirs.coreDirectory,'runtime.yaml'),'utf8'),'keep config');
  assert.equal((await readdir(dirs.coreDirectory)).filter(n=>n.endsWith('.bak')).length,1);
});

test('future bundle upgrades use the previous managed digest, while custom databases are preserved',async t=>{
  const dirs=await fixture(t);await bundle(dirs,'version one');await prepareCoreGeodata(dirs);
  await bundle(dirs,'version two');await prepareCoreGeodata(dirs);
  assert.equal(await readFile(path.join(dirs.coreDirectory,'geosite.dat'),'utf8'),'version two');
  await writeFile(path.join(dirs.coreDirectory,'geosite.dat'),'custom database');
  await bundle(dirs,'version three');await prepareCoreGeodata(dirs);
  assert.equal(await readFile(path.join(dirs.coreDirectory,'geosite.dat'),'utf8'),'custom database');
  assert.equal(JSON.parse(await readFile(path.join(dirs.coreDirectory,'bundled-geodata.json'),'utf8')).geosite,hash('version two'));
});

test('an unknown database without a marker is preserved, even with a damaged marker',async t=>{
  const dirs=await fixture(t);await bundle(dirs,'new database',[hash('legacy database')]);
  await writeFile(path.join(dirs.coreDirectory,'geosite.dat'),'unknown database');
  await writeFile(path.join(dirs.coreDirectory,'bundled-geodata.json'),'{');
  await prepareCoreGeodata(dirs);
  assert.equal(await readFile(path.join(dirs.coreDirectory,'geosite.dat'),'utf8'),'unknown database');
});

test('a corrupted or missing bundled file fails before touching legacy data',async t=>{
  const dirs=await fixture(t);await bundle(dirs,'new database',[hash('legacy database')]);
  await writeFile(path.join(dirs.coreDirectory,'geosite.dat'),'legacy database');
  await writeFile(path.join(dirs.runtimeDirectory,'geosite.dat'),'corrupted');
  await assert.rejects(prepareCoreGeodata(dirs),/随附的地理规则数据库校验失败/);
  assert.equal(await readFile(path.join(dirs.coreDirectory,'geosite.dat'),'utf8'),'legacy database');
  await rm(path.join(dirs.runtimeDirectory,'geosite.dat'));
  await assert.rejects(prepareCoreGeodata(dirs),/随附的地理规则数据库校验失败/);
  assert.equal(await readFile(path.join(dirs.coreDirectory,'geosite.dat'),'utf8'),'legacy database');
});
