import { openDb, type TaskRecord } from './idb';
export class ExecutionBusyError extends Error {constructor(){super('相同任务正在另一个页面运行，请查看原任务；本次未发送');this.name='ExecutionBusyError';}}
export class ExecutionClaimLostError extends Error {constructor(){super('任务执行权已变化，旧任务结果未覆盖当前记录');this.name='ExecutionClaimLostError';}}
export interface ExecutionClaimInput {cacheKey:string;taskId:string;docId:string|null;snapshotHash:string;leaseOwner:string;leaseMs?:number;explicitRetry?:boolean}
export interface ExecutionToken {cacheKey:string;taskId:string;leaseOwner:string}
export interface ExecutionClaimResult {state:'claimed'|'completed'|'interrupted';record:TaskRecord}
export function createExecutionClaims(deps:{openDatabase?:()=>Promise<IDBDatabase>;now?:()=>number;newId?:()=>string}={}){
 const now=deps.now??Date.now;
 function duration(value?:number){const ms=value??180_000;if(!Number.isFinite(ms)||ms<1000||ms>600_000)throw new Error('执行租期必须在1秒至10分钟之间');return ms;}
 async function mutate<T>(cacheKey:string,operation:(old:TaskRecord|undefined,store:IDBObjectStore)=>T):Promise<T>{if(!cacheKey)throw new Error('缺少任务键');const db=await(deps.openDatabase??openDb)();return new Promise<T>((resolve,reject)=>{const tx=db.transaction('tasks','readwrite'),store=tx.objectStore('tasks');let result:T,failure:unknown;tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure??tx.error??new Error('执行权保存中止'));tx.onerror=()=>{failure??=tx.error;};const req=store.get(`execution:${cacheKey}`) as IDBRequest<TaskRecord|undefined>;req.onsuccess=()=>{try{result=operation(req.result,store);}catch(error){failure=error;tx.abort();}};});}
 function matches(record:TaskRecord|undefined,token:ExecutionToken){return!!record&&record.status==='running'&&record.taskId===token.taskId&&record.leaseOwner===token.leaseOwner;}
 async function claim(input:ExecutionClaimInput):Promise<ExecutionClaimResult>{if(!input.taskId||!input.leaseOwner||!input.snapshotHash)throw new Error('缺少任务或执行会话');const leaseMs=duration(input.leaseMs);return mutate(input.cacheKey,(previous,store)=>{const timestamp=now();if(previous&&previous.docId!==input.docId)throw new Error('执行任务键不属于当前文献');let old=previous;
   if(old?.status==='running'&&(old.leaseUntil??0)>timestamp)throw new ExecutionBusyError();
   if(old?.status==='running'){old={...old,status:'interrupted',leaseUntil:0,updatedAt:timestamp};store.put(old);}
   if(old?.status==='completed'&&!input.explicitRetry)return{state:'completed',record:old};
   if(old&&!input.explicitRetry)return{state:'interrupted',record:old};
   if(old)store.put({...old,id:`execution-history:${input.cacheKey}:${old.taskId??old.id}`});
   const record:TaskRecord={id:`execution:${input.cacheKey}`,cacheKey:input.cacheKey,taskId:input.taskId,docId:input.docId,snapshotHash:input.snapshotHash,leaseOwner:input.leaseOwner,leaseUntil:timestamp+leaseMs,status:'running',updatedAt:timestamp};store.put(record);return{state:'claimed',record};});}
 async function finish(input:ExecutionToken&{status:'completed'|'failed'|'cancelled'|'interrupted';resultText?:string}):Promise<void>{await mutate(input.cacheKey,(record,store)=>{if(!matches(record,input))throw new ExecutionClaimLostError();const updated={...record!,status:input.status,leaseUntil:0,updatedAt:now()};if(input.resultText!==undefined)updated.resultText=input.resultText;store.put(updated);});}
 async function renew(input:ExecutionToken&{leaseMs?:number}):Promise<boolean>{const leaseMs=duration(input.leaseMs);return mutate(input.cacheKey,(record,store)=>{if(!matches(record,input))return false;store.put({...record!,leaseUntil:now()+leaseMs,updatedAt:now()});return true;});}
 return{claim,finish,renew};
}
export const {claim:claimExecution,finish:finishExecution,renew:renewExecution}=createExecutionClaims();
