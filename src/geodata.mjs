import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, readFile, copyFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './mihomo.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function optionalRead(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicWrite(file, content) {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    await writeFile(temporary, content, {mode:0o600,flag:'wx'});
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(()=>{}); }
}

// Migrate only an identified bundled database. Unknown/custom databases stay
// untouched. Keeping the previous managed digest also supports later releases.
export async function prepareCoreGeodata({ runtimeDirectory, coreDirectory }) {
  await mkdir(coreDirectory, {recursive:true});
  try {
    const rawManifest = await optionalRead(path.join(runtimeDirectory,'geodata.json'));
    let manifest;
    if (rawManifest) {
      try {
        manifest = JSON.parse(rawManifest);
        if (manifest.version !== 1 || !validHash(manifest.geosite?.sha256) ||
            !Array.isArray(manifest.geosite.replaces) || !manifest.geosite.replaces.every(validHash)) throw Error('invalid manifest');
      } catch { throw new AppError('软件随附的地理规则数据库校验失败，请重新安装软件。', 503); }
      const bundled = await optionalRead(path.join(runtimeDirectory,'geosite.dat'));
      if (!bundled || hash(bundled) !== manifest.geosite.sha256) throw new AppError('软件随附的地理规则数据库校验失败，请重新安装软件。', 503);
      const target = path.join(coreDirectory,'geosite.dat');
      const marker = path.join(coreDirectory,'bundled-geodata.json');
      const previous = await optionalRead(target);
      const previousHash = previous === null ? null : hash(previous);
      let managedHash = null;
      const rawState = await optionalRead(marker);
      if (rawState) {
        try {
          const state = JSON.parse(rawState);
          if (state.version === 1 && validHash(state.geosite)) managedHash = state.geosite;
        } catch { /* A damaged marker never authorizes replacement of unknown data. */ }
      }
      const currentHash = manifest.geosite.sha256;
      if (previousHash === null || previousHash === currentHash ||
          manifest.geosite.replaces.includes(previousHash) || previousHash === managedHash) {
        if (previousHash !== currentHash) {
          if (previous !== null) {
            try { await copyFile(target, path.join(coreDirectory,'geosite.'+previousHash+'.bak'), constants.COPYFILE_EXCL); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
          }
          // Do not replace a file edited while the backup was being written.
          const latest = await optionalRead(target);
          if ((latest === null ? null : hash(latest)) !== previousHash) throw new AppError('地理规则数据库已被其他进程修改，请重试。', 409);
          await atomicWrite(target, bundled);
        }
        if (managedHash !== currentHash) await atomicWrite(marker, JSON.stringify({version:1,geosite:currentHash})+'\n');
      }
    }
    for (const name of ['geoip.dat','geosite.dat','Country.mmdb','ASN.mmdb']) {
      if (name === 'geosite.dat' && manifest) continue;
      try { await copyFile(path.join(runtimeDirectory,name), path.join(coreDirectory,name), constants.COPYFILE_EXCL); }
      catch (error) { if (!['ENOENT','EEXIST'].includes(error.code)) throw error; }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('无法准备本地地理规则数据库，请检查数据目录的权限和可用空间。', 503);
  }
}
