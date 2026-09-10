// Database-only removal. Media, lyric bindings and name corrections are retained.
export function removeLibrarySongs({db,store,ids,onRemoved}) {
 const fail=message=>{throw Object.assign(new Error(message),{status:400});};
 if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some(id=>typeof id!=='string'||!id.trim()||id.length>200))fail('请选择要移除的作品（最多 1000 首）');
 const selected=[...new Set(ids)];
 const songs=selected.map(id=>store.getUserSong(id,{includeRemoved:true}));
 if(songs.some(song=>!song||song.jobId||song.sourceKind==='upload'))fail('作品不存在或不是可移除的已导入作品');
 let removed=0;
 db.exec('BEGIN IMMEDIATE');
 try{
  for(const id of selected){
   if(store.removeUserSong(id))removed++;
   db.prepare('DELETE FROM playlist_items WHERE item_type=3 AND item_id=?').run(id);
  }
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 onRemoved(selected);
 return {ids:selected,removed,filesDeleted:false};
}
