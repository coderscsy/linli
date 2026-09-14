import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createOliviaService } from '../server.js';
import { buildChatRequest, buildModelListRequest, writeModelProfile, setActiveProvider } from '../model-config.js';
import { blockedFetchPorts } from './fixtures/fetch-ports.js';

const exec = promisify(execFile);
const quote = v => v.replaceAll("'", "''");
const sample = {provider:'local',baseUrl:'https://relay.example/custom/v1/chat/completions/',model:'alias/name',authMode:'bearer',apiKey:'fixture-key'};
test('full completion URL becomes one endpoint for chat and model discovery without losing custom prefix', () => {
  assert.equal(buildChatRequest(sample).url,'https://relay.example/custom/v1/chat/completions');
  assert.equal(buildModelListRequest(sample).url,'https://relay.example/custom/v1/models');
});
test('ambiguous or credential-bearing URLs are rejected before sending a key', () => {
  for(const baseUrl of ['https://a/v1?key=x','https://a/v1#frag','https://a/v1?','https://a/v1#','https://u:p@a/v1','https://a/v1/messages','https://a/v1/responses']) {
    assert.throws(()=>buildChatRequest({...sample,baseUrl}),undefined,baseUrl);
  }
});
async function listen(server) {
  for(;;) {
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    if(!blockedFetchPorts.has(server.address().port)) return `http://127.0.0.1:${server.address().port}`;
    await new Promise(r=>server.close(r));
  }
}
async function fixture(t, handler, modelsHandler) {
  const root=await mkdtemp(join(tmpdir(),'olivia-relay-contract-'));
  const calls=[];
  const relay=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const call={url:req.url,authorization:req.headers.authorization,body:body?JSON.parse(body):{}};calls.push(call);
    res.setHeader('Content-Type','application/json; charset=utf-8');
    if(req.url.endsWith('/models')) {if(modelsHandler)modelsHandler(call,res);else res.end('{"data":[{"id":"relay-model"}]}');return;}
    if(req.url!=='/prefix/v1/chat/completions'){res.statusCode=404;res.end('{}');return;}
    handler(call,res);
  });
  const relayBase=await listen(relay);
  const service=await createOliviaService({root,dataDir:join(root,'data'),appData:join(root,'appdata'),worker:false,runMemoryRefresh:false,fetch:(url,init)=>{
    assert.equal(new URL(url).origin,relayBase);return fetch(url,init);
  }});
  t.after(async()=>{await service.close();await new Promise(r=>relay.close(r));await rm(root,{recursive:true,force:true});});
  const serviceBase=await listen(service.server);
  return {root,calls,relayBase,async post(path,body){const r=await fetch(serviceBase+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}};
}
async function runtime(root) {
  const helper=fileURLToPath(new URL('../../.cursor/skills/fit-letters/scripts/model-call.ps1',import.meta.url));
  const script=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; . '${quote(helper)}'; Import-ModelConfig -Root '${quote(root)}'; try {$value=Invoke-ModelChatOnce -System 'system' -User 'user'; @{ok=$true;value=$value}|ConvertTo-Json -Compress -Depth 8} catch {@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress}`;
  const result=await exec('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:15000,windowsHide:true});
  return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
}
const json=(res,payload)=>res.end(JSON.stringify(payload));
const ok=res=>json(res,{choices:[{message:{content:'中文 OK'},finish_reason:'stop'}]});
const cases=[
  ['standard',(_c,r)=>ok(r),true],
  ['parts',(_c,r)=>json(r,{choices:[{message:{content:[{type:'thinking',text:'never publish'},{type:'text',text:'中文 '},{type:'text',text:'OK'}]}}]}),true],
  ['reasoning only',(_c,r)=>json(r,{choices:[{message:{content:null,reasoning_content:'never publish'}}]}),false],
  ['JSON truncated',(_c,r)=>json(r,{choices:[{message:{content:'partial'},finish_reason:'length'}]}),false],
  ['JSON filtered',(_c,r)=>json(r,{choices:[{message:{content:'partial'},finish_reason:'content_filter'}]}),false],
  ['output text',(_c,r)=>json(r,{output:[{type:'reasoning',content:[{type:'text',text:'never publish'}]},{type:'message',content:[{type:'output_text',text:'中文 OK'}]}]}),true],
  ['SSE',(_c,r)=>{r.setHeader('Content-Type','text/event-stream');r.write(': ping\r\n\r\ndata: '+JSON.stringify({choices:[{delta:{reasoning_content:'never publish'}}]})+'\r\n\r\n');r.write('data: '+JSON.stringify({choices:[{delta:{content:'中文 '}}]})+'\r\n\r\n');r.end('data: '+JSON.stringify({choices:[{delta:{content:'OK'},finish_reason:'stop'}]})+'\r\n\r\ndata: [DONE]\r\n\r\n');},true],
  ['SSE interrupted',(_c,r)=>{r.setHeader('Content-Type','text/event-stream');r.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');},false],
  ['SSE error after content',(_c,r)=>{r.setHeader('Content-Type','text/event-stream');r.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"message":"private upstream detail"}}\n\ndata: [DONE]\n\n');},false],
  ['strict non-DeepSeek', (c,r)=>{if(c.body.thinking||c.body.reasoning_effort){r.statusCode=400;return json(r,{error:{message:'unsupported thinking'}});}ok(r);},true,'deepseek'],
  ['length parameter rename',(c,r)=>{if('max_tokens' in c.body){r.statusCode=400;return json(r,{error:{param:'max_tokens',code:'unsupported_parameter',message:'Use max_completion_tokens instead'}});}ok(r);},true],
];
for(const [name,handler,success,provider='local'] of cases) test(`relay parity: ${name}`,async t=>{
  const f=await fixture(t,handler);
  const profile={provider,baseUrl:f.relayBase+'/prefix/v1',model:'relay-model',authMode:'bearer',apiKey:'synthetic-key'};
  const probe=await f.post('/admin/api/model/test-save',profile);
  assert.equal(probe.status,success?200:502,JSON.stringify(probe.body));
  // Use the selected isolated profile even for rejected probes to verify the real runtime also rejects it.
  await writeModelProfile({root:f.root,provider,profile});await setActiveProvider({root:f.root,provider});
  const actual=await runtime(f.root);
  assert.equal(actual.ok,success,JSON.stringify(actual));
  if(success)assert.equal(actual.value,'中文 OK');
  assert.ok(f.calls.every(c=>c.authorization==='Bearer synthetic-key'));
  if(name==='length parameter rename') {
    assert.equal(f.calls.length,3);assert.equal(f.calls[1].body.max_completion_tokens,128);assert.equal(f.calls[1].body.max_tokens,undefined);
  }
});
test('full URL configuration works in both saved test and actual PowerShell runtime',async t=>{
  const f=await fixture(t,(_c,r)=>ok(r));
  const profile={...sample,baseUrl:f.relayBase+'/prefix/v1/chat/completions/'};
  assert.equal((await f.post('/admin/api/model/test-save',profile)).status,200);
  await setActiveProvider({root:f.root,provider:'local'});
  assert.equal((await runtime(f.root)).value,'中文 OK');
});
test('HTTP 401 and unrelated 400 must not trigger parameter negotiation or leak error body',async t=>{
  for(const status of [400,401,429]) {
    const f=await fixture(t,(_c,r)=>{r.statusCode=status;json(r,{error:{message:'upstream-secret synthetic-key'}});});
    const result=await f.post('/admin/api/model/test-save',{...sample,baseUrl:f.relayBase+'/prefix/v1'});
    assert.equal(result.status,502);assert.equal(f.calls.length,1);
    assert.doesNotMatch(JSON.stringify(result.body),/upstream-secret|synthetic-key/);
  }
});
test('DeepSeek reasoning probe allows room for a final answer while preserving runtime options',async t=>{
  const f=await fixture(t,(c,r)=>{
    if(c.body.max_tokens!==undefined&&c.body.max_tokens<1024)return json(r,{choices:[{message:{reasoning_content:'reasoning uses the tiny probe budget'},finish_reason:'length'}]});
    ok(r);
  });
  const profile={...sample,provider:'deepseek',baseUrl:f.relayBase+'/prefix/v1',model:'deepseek-v4-pro'};
  assert.equal((await f.post('/admin/api/model/test-save',profile)).status,200);
  await setActiveProvider({root:f.root,provider:'deepseek'});
  assert.equal((await runtime(f.root)).value,'中文 OK');
  assert.ok(f.calls.every(c=>c.body.thinking?.type==='enabled'&&c.body.reasoning_effort==='high'));
  assert.ok(f.calls[0].body.max_tokens<=4096,'probe remains bounded');
});

// Contract-shaped fixtures, not an integration test against a deployed One API.
// Reference: songquanpeng/one-api controller/model.go and relay/adaptor/openai/main.go.
test('One API contract: model-list metadata does not replace the public alias sent by either caller',async t=>{
  const alias='studio/evening-reply';
  const f=await fixture(t,(_c,r)=>ok(r),(_c,r)=>json(r,{object:'list',data:[{
    id:alias,object:'model',created:1626777600,owned_by:'custom',root:alias,parent:null,
    permission:[{id:'fixture-permission',object:'model_permission',allow_sampling:true}],
  }]}));
  const profile={...sample,baseUrl:f.relayBase+'/prefix/v1',model:alias};
  const discovery=await f.post('/admin/api/model/models',profile);
  assert.equal(discovery.status,200,JSON.stringify(discovery.body));
  assert.deepEqual(discovery.body.data.models,[alias]);
  assert.equal((await f.post('/admin/api/model/test-save',profile)).status,200);
  await setActiveProvider({root:f.root,provider:'local'});
  assert.equal((await runtime(f.root)).value,'中文 OK');
  assert.ok(f.calls.every(c=>c.authorization==='Bearer fixture-key'));
  const chats=f.calls.filter(c=>c.url.endsWith('/chat/completions'));
  assert.equal(chats.length,2);
  assert.ok(chats.every(c=>c.body.model===alias&&!c.body.thinking&&!c.body.reasoning_effort));
});

test('One API contract: usage-only and empty SSE events do not erase the final reply',async t=>{
  const f=await fixture(t,(_c,r)=>{
    r.setHeader('Content-Type','text/event-stream');
    for(const payload of [
      {choices:[]},
      {choices:[{index:0,delta:{role:'assistant',content:''},finish_reason:null}]},
      {choices:[{index:0,delta:{content:'中文 OK'},finish_reason:null}]},
      {choices:[{index:0,delta:{},finish_reason:'stop'}]},
      {choices:[],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}},
    ])r.write('data: '+JSON.stringify(payload)+'\n\n');
    r.end('data: [DONE]\n\n');
  });
  const profile={...sample,baseUrl:f.relayBase+'/prefix/v1'};
  assert.equal((await f.post('/admin/api/model/test-save',profile)).status,200);
  await setActiveProvider({root:f.root,provider:'local'});
  assert.equal((await runtime(f.root)).value,'中文 OK');
});

test('One API contract: HTTP 200 with an error envelope is rejected without exposing upstream details',async t=>{
  const f=await fixture(t,(_c,r)=>json(r,{error:{
    type:'upstream_error',code:'bad_response_status_code',param:'503',
    message:'private upstream fixture-key',
  }}));
  const profile={...sample,baseUrl:f.relayBase+'/prefix/v1'};
  const probe=await f.post('/admin/api/model/test-save',profile);
  assert.equal(probe.status,502);
  assert.doesNotMatch(JSON.stringify(probe.body),/private upstream|fixture-key/);
  await writeModelProfile({root:f.root,provider:'local',profile});
  await setActiveProvider({root:f.root,provider:'local'});
  const actual=await runtime(f.root);
  assert.equal(actual.ok,false);
  assert.doesNotMatch(actual.error,/private upstream|fixture-key/);
  assert.equal(f.calls.length,2,'no second provider or parameter retry for an error envelope');
});
