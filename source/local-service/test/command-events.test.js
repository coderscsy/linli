import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createCommandEvents} from '../lyrics/command-events.js';
test('command notifications arrive immediately, remain bounded, and shutdown closes streams',async()=>{
 const events=createCommandEvents();
 const server=createServer((req,res)=>events.subscribe(req,res,'player',{}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const clients=[];
 try {
  for(let index=0;index<3;index++){
   const response=await fetch(`http://127.0.0.1:${server.address().port}/`);
   const reader=response.body.getReader();await reader.read();clients.push(reader);
  }
  assert.equal((await clients[0].read()).done,true,'superseded streams are closed, not accumulated');
  const received=clients[2].read();events.notify('player');
  const result=await received;assert.match(new TextDecoder().decode(result.value),/data: change/);
  events.close();assert.equal((await clients[2].read()).done,true);
 } finally {events.close();for(const reader of clients)await reader.cancel().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
