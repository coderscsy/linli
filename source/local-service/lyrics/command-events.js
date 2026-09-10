// Only notifications are pushed; consumers still fetch/validate the latest command.
export function createCommandEvents() {
 const clients=new Map([['lyrics',new Set()],['player',new Set()],['library',new Set()]]);let closed=false;
 return {
  subscribe(req,res,topic,headers) {
   const group=clients.get(topic);
   if(closed||!group){res.writeHead(503,headers);res.end();return;}
   while(group.size>=2){const previous=group.values().next().value;group.delete(previous);previous.end();}
   res.writeHead(200,{...headers,'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
   group.add(res);res.on('close',()=>group.delete(res));
   res.write('retry: 3000\ndata: ready\n\n');
  },
  notify(topic,notification=null) {
   const frame=notification?.type==='library-removed'
    ? 'event: library-removed\ndata: '+JSON.stringify({ids:notification.ids,counts:notification.counts})+'\n\n'
    : notification?.type==='library-changed' ? 'event: library-changed\ndata: {}\n\n' : 'data: change\n\n';
   for(const res of clients.get(topic)||[]){
    if(res.destroyed||res.writableLength>4096){res.destroy();continue;}
    res.write(frame);
   }
  },
  close(){closed=true;for(const group of clients.values()){for(const res of group)res.end();group.clear();}}
 };
}
