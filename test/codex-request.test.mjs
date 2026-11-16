import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {codexRequest} from '../src/codex-request.mjs';
const launchFixture=(events,code=0,inspect=()=>{})=>(binary,args,options)=>{
 inspect(binary,args,options);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.kill=()=>{child.exitCode=-1;child.emit('exit',-1);};
 setImmediate(()=>{for(const e of events)child.stdout.write(JSON.stringify(e)+'\n');child.exitCode=code;child.emit('exit',code);});return child;
};
const reply={type:'item.completed',item:{type:'agent_message',text:'SUSUCLASH_CONNECTION_OK'}};
test('requires owned port supplied by doctor and complete response plus turn completion',async()=>{
 assert.equal((await codexRequest()).status,'needs_user');
 let inspected=false;const launch=launchFixture([reply,{type:'turn.completed'}],0,(binary,args,options)=>{assert.equal(binary,'codex.exe');assert(args.includes('--sandbox'));assert(args.includes('read-only'));assert(args.includes('--ignore-user-config'));assert.equal(options.env.HTTPS_PROXY,'http://127.0.0.1:7890');assert(!options.env.NO_PROXY.includes('openai'));inspected=true;});
 assert.equal((await codexRequest(undefined,{port:7890,launch})).status,'probe_passed');assert(inspected);
});
test('a reply without completion, completion without reply, and nonzero exit never pass',async()=>{
 for(const [events,code] of [[[reply],0],[[{type:'turn.completed'}],0],[[reply,{type:'turn.completed'}],1]])assert.notEqual((await codexRequest(undefined,{port:7890,launch:launchFixture(events,code)})).status,'probe_passed');
});
test('authentication and quota failures require user action without leaking response text',async()=>{
 const r=await codexRequest(undefined,{port:7890,launch:launchFixture([{type:'error',message:'401 unauthorized SECRET_TOKEN'}],1)});assert.equal(r.status,'needs_user');assert(!r.detail.includes('SECRET_TOKEN'));
});
test('unexpected tool activity terminates the isolated test and cannot become passed',async()=>{
 const r=await codexRequest(undefined,{port:7890,launch:launchFixture([{type:'item.started',item:{type:'command_execution'}},reply,{type:'turn.completed'}])});assert.equal(r.status,'unknown');
});
test('already aborted signal never launches a child process',async()=>{
 const c=new AbortController();c.abort();let launched=false;const r=await codexRequest(c.signal,{port:7890,launch:()=>{launched=true;}});assert.equal(r.status,'unknown');assert.equal(launched,false);
});
