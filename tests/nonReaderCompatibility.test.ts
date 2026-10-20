import{describe,expect,it,vi}from'vitest';
import{resolveWelcomeReturn}from'../src/welcome/navigation';
import{modelChoices,importCompatibleSettings}from'../src/options/compatibility';
import{ensureImportRecord}from'../src/library/importRecord';
import{mergeSettings}from'../src/shared/settings';
describe('non-reader entry and existing configuration compatibility',()=>{
 it('returns to the exact extension reader with document position, rejecting null-origin and external redirects',()=>{
  const home='chrome-extension://installation/viewer/index.html';
  expect(resolveWelcomeReturn(`${home}?doc=b%3Aold#page=3`,home)).toBe(`${home}?doc=b%3Aold#page=3`);
  expect(resolveWelcomeReturn('/library/index.html#manage',home)).toBe('chrome-extension://installation/library/index.html#manage');
  for(const raw of ['chrome-extension://another/viewer/index.html','https://installation/viewer/index.html','javascript:alert(1)','chrome-extension://installation/welcome/index.html','chrome-extension://installation/foo/viewer/index.html','https://user:password@installation/viewer/index.html'])expect(resolveWelcomeReturn(raw,home)).toBe(home);
 });
 it('keeps legacy task/vision model names selectable without mutating saved routes',()=>{
  const settings=mergeSettings({providers:[{id:'p',name:'old',baseUrl:'https://old.test/v1',defaultModel:'legacy-default',models:['listed']}],routing:{explain:{providerId:'p',model:'legacy-task'}},visionRoute:{providerId:'p',model:'legacy-vision'}}),before=JSON.stringify(settings);
  expect(modelChoices(settings).map(option=>option.value)).toEqual(['p::legacy-default','p::listed','p::legacy-task','p::legacy-vision']);expect(JSON.stringify(settings)).toBe(before);
 });
 it('key-free import preserves matching local keys and routing but never moves a key to another endpoint',()=>{
  const current=mergeSettings({providers:[{id:'p',baseUrl:'https://old.test/v1',apiKey:'local-only',defaultModel:'old'}],routing:{explain:{providerId:'p',model:'legacy'}}});
  const portable=JSON.parse(JSON.stringify(current));delete portable.providers[0].apiKey;
  const imported=importCompatibleSettings(portable,current);expect(imported.providers[0].apiKey).toBe('local-only');expect(imported.routing).toEqual(current.routing);
  portable.providers[0].baseUrl='https://different.test/v1';expect(importCompatibleSettings(portable,current).providers[0].apiKey).toBe('');expect(current.providers[0].apiKey).toBe('local-only');
 });
});
function fixture(existing?:unknown){
 const request={result:existing,onsuccess:undefined as (()=>void)|undefined},store={get:vi.fn(()=>request),add:vi.fn(),put:vi.fn()},tx={objectStore:()=>store,oncomplete:undefined as (()=>void)|undefined,onabort:undefined as (()=>void)|undefined,onerror:undefined,error:null};
 const db={transaction:vi.fn(()=>tx)} as unknown as IDBDatabase;return{request,store,tx,db};
}
describe('library first-import storage boundary',()=>{
 it('does not overwrite existing title, collection, policy or annotation-associated identity',async()=>{
  const previous={docId:'b:stable',title:'Reader-edited title',favorite:true,folderId:'research',policy:'deny_all_ai',annotationRevision:7};
  const f=fixture(previous),promise=ensureImportRecord('b:stable',{name:'new-name.pdf',size:100},async()=>f.db);await Promise.resolve();f.request.onsuccess?.();f.tx.oncomplete?.();
  await expect(promise).resolves.toBe(true);expect(f.store.put).not.toHaveBeenCalled();expect(f.store.add).not.toHaveBeenCalled();expect(f.request.result).toEqual(previous);expect(f.db.transaction).toHaveBeenCalledWith('docs','readwrite');
 });
 it('creates a first record with add and does not claim success before the transaction commits',async()=>{
  const f=fixture(),promise=ensureImportRecord('b:new',{name:'paper.pdf',size:123},async()=>f.db,()=>1000);let settled=false;void promise.then(()=>{settled=true;});await Promise.resolve();f.request.onsuccess?.();await Promise.resolve();expect(settled).toBe(false);expect(f.store.add).toHaveBeenCalledWith(expect.objectContaining({docId:'b:new',title:'paper',stored:false,sizeBytes:123,addedAt:1000}));f.tx.oncomplete?.();await expect(promise).resolves.toBe(false);
 });
 it('reports a failed import transaction instead of claiming a saved PDF',async()=>{
  const f=fixture(),promise=ensureImportRecord('b:new',{name:'paper.pdf',size:123},async()=>f.db);await Promise.resolve();f.tx.onabort?.();await expect(promise).rejects.toThrow('尚未保存');
 });
});
