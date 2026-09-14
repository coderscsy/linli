import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModelText, parseModelResponse, executeChatRequest } from '../model-transport.js';

test('only final textual parts enter a reply, never reasoning or tool arguments',()=>{
  assert.equal(extractModelText({choices:[{message:{reasoning_content:'private reasoning',content:[{type:'thinking',text:'private'},{type:'text',text:'正文'},{type:'output_text',text:'。'},{type:'tool_call',text:'private'}]}}]}),'正文。');
  assert.throws(()=>extractModelText({choices:[{message:{content:[],tool_calls:[{function:{arguments:'not text'}}],reasoning_content:'private'}}]}),/有效文字/);
  assert.equal(extractModelText({choices:[{text:'legacy text'}]}),'legacy text');
});
test('malformed or interrupted streams never become a successful partial reply',()=>{
  for(const body of [
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n\n',
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: invalid-private-body\n\n',
  ]) assert.throws(()=>parseModelResponse(body,'text/event-stream'),error=>!error.message.includes('private-body'));
});
test('stream bytes split inside UTF-8 characters preserve final text and metadata',async()=>{
  const raw=': keepalive\r\n\r\ndata: '+JSON.stringify({choices:[{index:0,delta:{content:'中文😀'},finish_reason:'stop'}]})+'\r\n\r\ndata: {"choices":[],"usage":{"total_tokens":3}}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes=new TextEncoder().encode(raw);
  const body=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
  const result=await executeChatRequest({url:'https://relay.test/v1/chat/completions',headers:{},body:{}},{fetchImpl:async()=>new Response(body,{headers:{'Content-Type':'text/event-stream; charset=utf-8'}})});
  assert.deepEqual(result,{content:'中文😀',finishReason:'stop',usage:{total_tokens:3}});
});
test('a failed length-parameter retry retains the budget and never issues a third request',async()=>{
  const bodies=[];
  await assert.rejects(executeChatRequest({url:'https://relay.test/v1/chat/completions',headers:{},body:{max_tokens:128}},{fetchImpl:async(_url,init)=>{
    bodies.push(JSON.parse(init.body));
    return Response.json({error:{param:'max_tokens',code:'unsupported_parameter'}},{status:422});
  }}),/HTTP 422/);
  assert.deepEqual(bodies,[{max_tokens:128},{max_completion_tokens:128}]);
});
test('overlarge model bodies cancel the reader rather than accumulating unlimited output',async()=>{
  let cancelled=false;
  const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
  await assert.rejects(executeChatRequest({url:'https://relay.test',headers:{},body:{}},{fetchImpl:async()=>new Response(body)}),/8 MiB/);
  assert.equal(cancelled,true);
});
test('invalid JSON is reported without quoting upstream content or credentials',async()=>{
  await assert.rejects(executeChatRequest({url:'https://relay.test',headers:{},body:{}},{fetchImpl:async()=>new Response('<html>secret-key upstream message</html>')}),error=>error.message==='模型返回了无效 JSON');
});
