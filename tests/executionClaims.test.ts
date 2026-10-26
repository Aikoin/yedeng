import {describe,expect,it,vi} from 'vitest';
import {createExecutionClaims,ExecutionBusyError,ExecutionClaimLostError} from '../src/shared/executionClaims';
import type {TaskRecord} from '../src/shared/idb';
function fixture(current?:TaskRecord){const request={result:current,onsuccess:undefined as (()=>void)|undefined};const store={get:()=>request,put:vi.fn()};const tx={objectStore:()=>store,oncomplete:undefined as (()=>void)|undefined,onabort:undefined as (()=>void)|undefined,onerror:undefined,error:null,abort(){tx.onabort?.();}};const db={transaction:()=>tx} as unknown as IDBDatabase;return{request,store,tx,repo:createExecutionClaims({openDatabase:async()=>db,now:()=>2000})};}
const running={id:'execution:key',docId:'doc',cacheKey:'key',taskId:'task1',leaseOwner:'owner1',leaseUntil:3000,status:'running',snapshotHash:'h',updatedAt:1} as TaskRecord;
const input={cacheKey:'key',taskId:'task2',leaseOwner:'owner2',docId:'doc',snapshotHash:'h'};
describe('durable execution claim contract',()=>{
 it('rejects another active owner without writing',async()=>{const f=fixture(running),p=f.repo.claim(input);await Promise.resolve();f.request.onsuccess?.();await expect(p).rejects.toBeInstanceOf(ExecutionBusyError);expect(f.store.put).not.toHaveBeenCalled();});
 it('marks expired work interrupted and does not automatically claim/retry it',async()=>{const f=fixture({...running,leaseUntil:1000}),p=f.repo.claim(input);await Promise.resolve();f.request.onsuccess?.();f.tx.oncomplete?.();await expect(p).resolves.toMatchObject({state:'interrupted',record:{status:'interrupted',taskId:'task1'}});expect(f.store.put).toHaveBeenCalledTimes(1);});
 it('explicit retry preserves prior task while claiming a new owner',async()=>{const f=fixture({...running,status:'interrupted'}),p=f.repo.claim({...input,explicitRetry:true});await Promise.resolve();f.request.onsuccess?.();f.tx.oncomplete?.();await expect(p).resolves.toMatchObject({state:'claimed',record:{taskId:'task2',leaseOwner:'owner2'}});expect(f.store.put.mock.calls[0]?.[0].id).toContain('execution-history:');});
 it('rejects an old worker finish instead of overwriting the current owner',async()=>{const f=fixture(running),p=f.repo.finish({cacheKey:'key',taskId:'obsolete',leaseOwner:'old',status:'completed',resultText:'late'});await Promise.resolve();f.request.onsuccess?.();await expect(p).rejects.toBeInstanceOf(ExecutionClaimLostError);expect(f.store.put).not.toHaveBeenCalled();});
 it('does not report ownership before transaction commit',async()=>{const f=fixture(),p=f.repo.claim(input);let settled=false;void p.then(()=>{settled=true;});await Promise.resolve();f.request.onsuccess?.();await Promise.resolve();expect(settled).toBe(false);f.tx.oncomplete?.();await expect(p).resolves.toMatchObject({state:'claimed'});});
});

it('manual resubmission recovers failed/cancelled/interrupted work but reuses completed results',async()=>{
 for(const status of ['failed','cancelled','interrupted','completed'] as const){
  const f=fixture({...running,status,resultText:status==='completed'?'saved':undefined}),p=f.repo.claim({...input,retryInterrupted:true});
  await Promise.resolve();f.request.onsuccess?.();f.tx.oncomplete?.();
  await expect(p).resolves.toMatchObject({state:status==='completed'?'completed':'claimed'});
  if(status==='completed')expect(f.store.put).not.toHaveBeenCalled();
 }
});
it('manual resubmission cannot steal an active execution',async()=>{
 const f=fixture(running),p=f.repo.claim({...input,retryInterrupted:true});await Promise.resolve();f.request.onsuccess?.();await expect(p).rejects.toBeInstanceOf(ExecutionBusyError);expect(f.store.put).not.toHaveBeenCalled();
});
