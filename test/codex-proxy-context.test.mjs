import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCodexProxyEnv,patchCodexProxyPort,safeCodexNoProxy} from '../src/codex-proxy-context.mjs';

test('single-line dotenv supports BOM, export, case, quotes, comments and loopback addresses',()=>{
  const content='\uFEFFexport https_proxy = "http://127.0.0.1:7890" # active\r\n'+
    "HTTP_PROXY='http://LOCALHOST:7890/'\r\n"+
    'all_proxy=http://[::1]:7890\t# ipv6\r\n'+
    'no_proxy="localhost,127.0.0.1,::1"# bypass\r\n'+
    'SECRET="PRIVATE_VALUE # stays private"\r\n';
  assert.deepEqual(inspectCodexProxyEnv(content),{env:{HTTPS_PROXY:'http://127.0.0.1:7890',HTTP_PROXY:'http://LOCALHOST:7890/',ALL_PROXY:'http://[::1]:7890',NO_PROXY:'localhost,127.0.0.1,::1'},port:7890,hasProxy:true,noProxy:'localhost,127.0.0.1,::1'});
  assert(!JSON.stringify(inspectCodexProxyEnv(content)).includes('PRIVATE_VALUE'));
});

test('absence and NO_PROXY-only contexts retain no inferred proxy',()=>{
  assert.deepEqual(inspectCodexProxyEnv('# HTTPS_PROXY=http://127.0.0.1:1\nOTHER=value\n'),{env:{},port:null,hasProxy:false,noProxy:undefined});
  assert.deepEqual(inspectCodexProxyEnv('NO_PROXY=\n'),{env:{NO_PROXY:''},port:null,hasProxy:false,noProxy:''});
  assert.deepEqual(inspectCodexProxyEnv('NO_PROXY=*.example.test\n'),{env:{NO_PROXY:'*.example.test'},port:null,hasProxy:false,noProxy:'*.example.test'});
});

test('ambiguous proxy settings, expansion and unsupported destinations fail without disclosing values',()=>{
  for(const content of [
    'HTTPS_PROXY=http://127.0.0.1:7890\nhttps_proxy=http://127.0.0.1:7890\n',
    'NO_PROXY=localhost\nno_proxy=localhost\n',
    'HTTPS_PROXY=\n','HTTP_PROXY=""\n',
    'HTTPS_PROXY=http://127.0.0.1:7890\nHTTP_PROXY=http://localhost:9999\n',
    ...['https://127.0.0.1:7890','socks5://127.0.0.1:7890','http://example.test:7890','http://127.0.0.2:7890','http://user:PRIVATE_SECRET@127.0.0.1:7890','http://127.0.0.1:7890/path','http://127.0.0.1:7890?PRIVATE_SECRET','http://127.0.0.1:7890#PRIVATE_SECRET','http://127.0.0.1','http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:${PRIVATE_SECRET}','http://127.0.0.1:$(PRIVATE_SECRET)','http://127.0.0.1:`PRIVATE_SECRET`'].map(value=>'HTTPS_PROXY='+value+'\n'),
    'HTTPS_PROXY="http:\\/\\/127.0.0.1:7890"\n','NO_PROXY=${PRIVATE_SECRET}\n',
    'HTTPS_PROXY="http://127.0.0.1:7890" extra\n'
  ]){
    assert.throws(()=>inspectCodexProxyEnv(content),error=>error.message==='unsupported_proxy_context'&&!error.message.includes('PRIVATE_SECRET'));
    assert.throws(()=>patchCodexProxyPort(content,7891),/unsupported_proxy_context/);
  }
});

test('multiline values and unknown syntax cannot conceal a proxy assignment',()=>{
  for(const content of [
    'NOTE="first line\nHTTPS_PROXY=http://127.0.0.1:7890\nlast line"\n',
    "NOTE='first line\nHTTPS_PROXY=http://127.0.0.1:7890\nlast line'\n",
    'NOTE="unterminated\n','NOTE="closed" garbage\n','NOTE=one\\\n',
    'unset HTTPS_PROXY\n','HTTPS_PROXY: http://127.0.0.1:7890\n',
    'NOTE="""multiple quotes"""\n','NOTE=value\rHTTP_PROXY=http://127.0.0.1:7890\n',
    'NOTE=value\n\uFEFFHTTP_PROXY=http://127.0.0.1:7890\n','NOTE=PRIVATE_SECRET\0\n'
  ])assert.throws(()=>inspectCodexProxyEnv(content),/unsupported_proxy_context/);
});

test('port patch preserves all bytes outside the explicit proxy port digits',()=>{
  const before='\uFEFF  export https_proxy \t= "http://127.0.0.1:07890/" \t# active\r\n'+
    "HTTP_PROXY = 'http://LOCALHOST:7890'\n"+
    'ALL_PROXY=http://[::1]:7890 # ipv6\r\n'+
    'NO_PROXY="localhost,127.0.0.1"\r\n'+
    'SECRET="PRIVATE_SECRET http://127.0.0.1:7890"\r\n'+
    '# HTTPS_PROXY=http://127.0.0.1:7890\r\n';
  const expected=before.replace('127.0.0.1:07890/','127.0.0.1:12865/').replace('LOCALHOST:7890','LOCALHOST:12865').replace('[::1]:7890','[::1]:12865');
  assert.equal(patchCodexProxyPort(before,12865),expected);
  assert.equal(inspectCodexProxyEnv(expected).port,12865);
  assert.equal(patchCodexProxyPort(before,7890),before);
});

test('patch requires existing proxies and a bounded numeric port',()=>{
  for(const content of ['', 'OTHER=PRIVATE_SECRET\n','NO_PROXY=localhost\n'])assert.throws(()=>patchCodexProxyPort(content,7890),/unsupported_proxy_context/);
  for(const port of [0,-1,65536,1.5,'7890',null,NaN])assert.throws(()=>patchCodexProxyPort('HTTPS_PROXY=http://localhost:7890\n',port),/unsupported_proxy_context/);
  for(const port of [1,65535])assert.equal(inspectCodexProxyEnv(patchCodexProxyPort('HTTPS_PROXY=http://localhost:7890\n',port)).port,port);
});

test('NO_PROXY permits only bounded local literals and local domain suffixes',()=>{
  for(const value of [undefined,'',' ','localhost, .localhost,.local,::1,[::1]','127.0.0.1,127.255.255.255,10.0.0.0,10.255.255.255,172.16.0.0,172.31.255.255,192.168.0.0,192.168.255.255,169.254.0.0,169.254.255.255'])assert.equal(safeCodexNoProxy(value),true,String(value));
  for(const value of [null,1,'*','127.*','127.0.0.1/8','127.1','127.00.0.1','127.0.0.256','0.0.0.0','8.8.8.8','172.15.255.255','172.32.0.0','192.169.0.1','169.253.0.1','chatgpt.com','.openai.com','example.test','localhost:80','[::1]:80','::2','localhost,,127.0.0.1','localhost,','localhost\n','localhost\t','localhost\0',' '.repeat(8193),Array(257).fill('localhost').join(',')])assert.equal(safeCodexNoProxy(value),false,String(value));
});

test('NO_PROXY rejects any exact or suffix match against actual target hosts',()=>{
  for(const [value,hosts] of [
    ['localhost',['localhost']],['localhost',['service.localhost']],['.localhost',['localhost']],['.localhost',['service.localhost.']],
    ['.local',['model.local']],['.local',['local']],['127.0.0.1',['127.0.0.1']],['10.1.2.3',['10.1.2.3']],
    ['::1',['[::1]']],['[::1]',['::1']]
  ])assert.equal(safeCodexNoProxy(value,hosts),false,JSON.stringify([value,hosts]));
  assert.equal(safeCodexNoProxy('.local',['model.localhost']),true);
  assert.equal(safeCodexNoProxy('localhost',['mylocalhost']),true);
  assert.equal(safeCodexNoProxy('10.1.2.3',['10.1.2.4']),true);
  for(const hosts of [[],null,[''],['bad\nvalue'],[null]])assert.equal(safeCodexNoProxy('localhost',hosts),false);
});
