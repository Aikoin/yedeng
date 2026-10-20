import {openDb} from '../shared/idb';
/** First import inserts only if absent under the same readwrite lock; existing metadata is authoritative. */
export async function ensureImportRecord(docId:string,file:Pick<File,'name'|'size'>,open:()=>Promise<IDBDatabase>=openDb,now:()=>number=Date.now):Promise<boolean>{
 const db=await open();return new Promise<boolean>((resolve,reject)=>{
  const tx=db.transaction('docs','readwrite'),store=tx.objectStore('docs');let existing=false;
  tx.oncomplete=()=>resolve(existing);tx.onabort=()=>reject(tx.error??new Error('文献尚未保存，请重试'));tx.onerror=()=>{};
  const request=store.get(docId);request.onsuccess=()=>{existing=!!request.result;if(existing)return;const timestamp=now();store.add({docId,url:'',fileName:file.name,title:file.name.replace(/\.pdf$/i,''),authors:'',numPages:0,sizeBytes:file.size,addedAt:timestamp,lastOpenedAt:timestamp,folderId:null,favorite:false,stored:false});};
 });
}
