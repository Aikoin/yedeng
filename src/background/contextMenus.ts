/** Serialize lifecycle events; Chrome persists menus across worker restarts. */
export function menuInstaller(api:Pick<typeof chrome.contextMenus,'removeAll'|'create'>,lastError:()=>string|undefined):()=>Promise<void>{
 let active:Promise<void>|undefined;
 return ()=>{
  if(active)return active;
  const run=async()=>{
   await new Promise<void>((resolve,reject)=>api.removeAll(()=>{const error=lastError();error?reject(new Error(error)):resolve();}));
   for(const item of [
    {id:'ml-open-link',title:'用 页灯 YEDENG 打开这个链接',contexts:['link'] as chrome.contextMenus.CreateProperties['contexts']},
    {id:'ml-open-page',title:'用 页灯 YEDENG 打开当前页',contexts:['page','frame'] as chrome.contextMenus.CreateProperties['contexts']},
   ])await new Promise<void>((resolve,reject)=>api.create(item,()=>{const error=lastError();error?reject(new Error(error)):resolve();}));
  };
  active=run().finally(()=>{active=undefined;});return active;
 };
}
