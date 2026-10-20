/** Open an existing DB without requesting a version. Never create or upgrade it. */
export function openExistingDatabase(name='moonlight-lite',factory:IDBFactory=indexedDB):Promise<IDBDatabase>{
 return new Promise((resolve,reject)=>{
  const request=factory.open(name);let abandoned=false;
  request.onupgradeneeded=()=>{abandoned=true;request.transaction?.abort();reject(new Error('当前扩展没有原数据库，已停止；没有创建或升级数据库'));};
  request.onblocked=()=>{abandoned=true;reject(new Error('原库被其他页面占用，请关闭旧阅读器后重试'));};
  request.onerror=()=>reject(request.error??new Error('只读打开失败'));
  request.onsuccess=()=>{const db=request.result;if(abandoned){db.close();return;}db.onversionchange=()=>db.close();resolve(db);};
 });
}
