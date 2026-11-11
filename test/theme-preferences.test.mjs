import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createThemePreferences } from '../src/theme-preferences.mjs';
import { startServer } from '../src/server.mjs';

test('theme choice persists across instances, validates values and contains no other settings', async () => {
  const root=path.join(process.cwd(),'outputs','working');await mkdir(root,{recursive:true});
  const directory=await mkdtemp(path.join(root,'theme-test-'));
  try {
    const first=createThemePreferences({directory});
    assert.deepEqual(await first.get(),{theme:'cat'});
    await first.set({theme:'whale'});
    assert.deepEqual(await createThemePreferences({directory}).get(),{theme:'whale'});
    await assert.rejects(first.set({theme:'other'}),/不支持/);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory,'theme.json'),'utf8')),{theme:'whale'});
    await writeFile(path.join(directory,'theme.json'),JSON.stringify({theme:'invalid',token:'never-exposed'}));
    assert.deepEqual(await createThemePreferences({directory}).get(),{theme:'cat'});
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('theme API saves only valid choices and serves the integrated page assets', async () => {
  const root=path.join(process.cwd(),'outputs','working');await mkdir(root,{recursive:true});
  const directory=await mkdtemp(path.join(root,'theme-api-test-'));
  const core={preferences:async()=>({expectedPort:7890}),call:async()=>({})};
  const app=await startServer({core,themePreferences:createThemePreferences({directory}),readSystemProxy:async()=>false});
  try {
    const get=name=>fetch(app.url+name);
    const post=(value,origin=app.origin)=>fetch(app.url+'api/theme',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
    for (const asset of ['lines-v3.js','lines-v3.css','secondary-fix.js','secondary-fix.css','window-frame.js','window-frame.css']) assert.equal((await get(asset)).status,200,asset);
    const version=JSON.parse(await readFile(path.join(process.cwd(),'package.json'),'utf8')).version;
    assert.equal((await (await get('api/runtime')).json()).appVersion,version);
    assert.deepEqual(await (await get('api/theme')).json(),{theme:'cat'});
    assert.equal((await post({theme:'whale'},'https://example.test')).status,403);
    assert.equal((await post({theme:'invalid'})).status,400);
    assert.deepEqual(await (await post({theme:'fish'})).json(),{theme:'fish'});
    assert.deepEqual(await (await get('api/theme')).json(),{theme:'fish'});
  } finally {await app.close();await rm(directory,{recursive:true,force:true});}
});

test('production entry serves every referenced style and script without exposing preview files', async () => {
  const core={preferences:async()=>({expectedPort:7890}),call:async()=>({})};
  const app=await startServer({core,readSystemProxy:async()=>false});
  try {
    const html=await (await fetch(app.url)).text();
    const files=[...html.matchAll(/(?:src|href)="([^"/]+\.(?:css|js))"/g)].map(match=>match[1]);
    for(const asset of ['design-system.css','visual-contract.css','visual-contract.js']) assert(files.includes(asset));
    for(const asset of files){
      const response=await fetch(app.url+asset);
      assert.equal(response.status,200,asset);
      assert.match(response.headers.get('content-type'),asset.endsWith('.css')?/^text\/css/:/^application\/javascript/);
      assert.equal(await response.text(),await readFile(new URL('../app/'+asset,import.meta.url),'utf8'),asset);
    }
    for(const asset of ['__preview/bridge.js','preview-bridge.js','package.json','.env']) assert.equal((await fetch(app.url+asset)).status,404,asset);
  }finally{await app.close()}
});
