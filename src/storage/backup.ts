/** Local portable backup. No settings/credentials, transport state or automatic network work. */
import { openDb, type StoreName } from '../shared/idb';
import { STORE_NAMES, DB_VERSION, markLegacyAnchor } from '../shared/migrations';
import { sha256Hex } from '../shared/hash';
export const MAX_BACKUP_BYTES=220*1024*1024;
const MAX_BYTES=MAX_BACKUP_BYTES;
const KEYS:Record<StoreName,string>={docs:'docId',folders:'folderId',blobs:'docId',annotations:'id',chats:'key',cache:'key',usage:'date',readingState:'docId',regions:'id',formulaRevisions:'id',tasks:'id',requestLedger:'id'};
type Row=Record<string,unknown>;
type Rows=Record<StoreName,Row[]>;
interface Binary {sha256:string;kind:'blob'|'buffer';type:string}
interface Resource {sha256:string;bytes:number;type:string;base64:string}
export interface Backup {format:'yedeng-local-backup';schemaVersion:1;databaseVersion:number;createdAt:string;mode:'full'|'light';manifest:{counts:Record<string,number>;resources:number;omittedPdfDocIds:string[];omittedStores:string[];credentialsIncluded:false;urlsSanitized:number};records:Record<string,unknown[]>;resources:Record<string,Resource>;digest:string}
export interface RestorePlan {digest:string;rows:Rows;summary:{counts:Record<string,number>;resources:number;forcedDeny:number;pdfsRequiringRelink:number};}
export function sanitizeSourceUrl(value:string):string {
 if(!value)return '';
 try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol))return '';u.username='';u.password='';u.search='';u.hash='';return u.href;}catch{return '';}
}
export function portableRecord(value:unknown,counts={urls:0}):unknown {
 if(Array.isArray(value))return value.map(v=>portableRecord(v,counts));
 if(value instanceof Blob||value instanceof ArrayBuffer)return value;
 if(value&&typeof value==='object'){
  const result:Row={};for(const [key,item]of Object.entries(value)){
   if(item===undefined)continue;
   if(/^(?:apiKey|authorization|password|access_token|refresh_token|leaseOwner|leaseUntil)$/i.test(key))continue;
   if((key==='url'||key==='baseUrl')&&typeof item==='string'){const safe=sanitizeSourceUrl(item);if(safe!==item)counts.urls++;result[key]=safe;}
   else if(key==='sources'&&Array.isArray(item))result[key]=item.filter(v=>typeof v==='string').map(v=>{const safe=sanitizeSourceUrl(v);if(safe!==v)counts.urls++;return safe;}).filter(Boolean);
   else result[key]=portableRecord(item,counts);
  }return result;
 }return value;
}
function b64(bytes:Uint8Array):string {let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(text);}
function unb64(text:string):Uint8Array {if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))throw new Error('资源编码无效');return Uint8Array.from(atob(text),v=>v.charCodeAt(0));}
function stable(value:unknown):string {if(value===undefined)return 'null';if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(stable).join(',')+']';return '{'+Object.keys(value).filter(k=>(value as Row)[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+stable((value as Row)[k])).join(',')+'}';}
function approximateSize(value:unknown):number {if(value instanceof Blob)return value.size;if(value instanceof ArrayBuffer)return value.byteLength;if(typeof value==='string')return value.length*2;if(Array.isArray(value))return value.reduce((n,v)=>n+approximateSize(v),0);if(value&&typeof value==='object')return Object.values(value).reduce<number>((n,v)=>n+approximateSize(v),0);return 16;}
async function allRows(db:IDBDatabase,includePdf=true,scopeDocId?:string):Promise<Rows>{return new Promise((resolve,reject)=>{
 const names=STORE_NAMES.filter(name=>name!=='cache'&&(includePdf||name!=='blobs')&&(!db.objectStoreNames||db.objectStoreNames.contains(name))),rows=Object.fromEntries(STORE_NAMES.map(name=>[name,[]]))as unknown as Rows;
 const tx=db.transaction([...names],'readonly');let size=0,failure:unknown;
 tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(failure??tx.error);tx.onerror=()=>{failure??=tx.error;};
 for(const name of names){const store=tx.objectStore(name);if(!store.openCursor){const req=store.getAll();Object.defineProperty(rows,name,{get:()=>req.result});continue;}
  const req=store.openCursor();req.onsuccess=()=>{const cursor=req.result;if(!cursor)return;const row=cursor.value as Row;if(scopeDocId&&name!=='folders'&&row.docId!==scopeDocId){cursor.continue();return;}if(name!=='tasks'||String(row.id).startsWith('saved-result:')&&row.status==='completed'){
   size+=approximateSize(row);if(size>MAX_BYTES*.65){failure=new Error('本次备份材料过大，请改用轻量备份；数据库未修改');tx.abort();return;}rows[name].push(row);
  }cursor.continue();};
 }
 });}
async function encode(value:unknown,resources:Record<string,Resource>):Promise<unknown>{
 if(value instanceof Blob||value instanceof ArrayBuffer){const bytes=new Uint8Array(value instanceof Blob?await value.arrayBuffer():value),hash=await sha256Hex(bytes),type=value instanceof Blob?value.type:'application/octet-stream';resources[hash]??={sha256:hash,bytes:bytes.length,type,base64:b64(bytes)};return{$yedengBinary:{sha256:hash,kind:value instanceof Blob?'blob':'buffer',type} satisfies Binary};}
 if(Array.isArray(value))return Promise.all(value.map(v=>encode(v,resources)));
 if(value&&typeof value==='object'){const result:Row={};for(const[k,v]of Object.entries(value))if(v!==undefined)result[k]=await encode(v,resources);return result;}return value;
}
function decode(value:unknown,resources:Map<string,Uint8Array>):unknown{
 if(Array.isArray(value))return value.map(v=>decode(v,resources));
 if(value&&typeof value==='object'){
  const row=value as Row;
  if('$yedengBinary'in row){if(Object.keys(row).length!==1)throw new Error('二进制标记结构无效');const item=row.$yedengBinary as Binary;const bytes=resources.get(item.sha256);if(!bytes||!['blob','buffer'].includes(item.kind))throw new Error('缺少二进制资源');return item.kind==='blob'?new Blob([bytes.slice().buffer],{type:item.type}):bytes.slice().buffer;}
  const result=Object.create(null)as Row;for(const[k,v]of Object.entries(row)){if(['__proto__','prototype','constructor'].includes(k))throw new Error('不接受危险对象键');result[k]=decode(v,resources);}return result;
 }return value;
}
export async function createBackup(mode:'full'|'light',db?:IDBDatabase,scopeDocId?:string):Promise<Backup>{
 const rows=await allRows(db??await openDb(),mode==='full',scopeDocId),resources:Record<string,Resource>={},records:Record<string,unknown[]>={},urls={urls:0},omittedPdfDocIds=mode==='light'?rows.docs.filter(r=>r.stored).map(r=>String(r.docId)):[];
 for(const name of STORE_NAMES){let values=rows[name];if(name==='cache')values=[];if(name==='blobs'&&mode==='light')values=[];if(name==='tasks')values=values.filter(v=>String(v.id).startsWith('saved-result:')&&v.status==='completed');
  records[name]=await Promise.all(values.map(v=>encode(portableRecord(v,urls),resources)));
 }
 const base={format:'yedeng-local-backup' as const,schemaVersion:1 as const,databaseVersion:db?.version??DB_VERSION,createdAt:new Date().toISOString(),mode,manifest:{counts:Object.fromEntries(Object.entries(records).map(([k,v])=>[k,v.length])),resources:Object.keys(resources).length,omittedPdfDocIds,omittedStores:['cache','active request drafts and execution leases','settings and API keys'],credentialsIncluded:false as const,urlsSanitized:urls.urls},records,resources};
 const backup={...base,digest:await sha256Hex(stable(base))};if(new TextEncoder().encode(JSON.stringify(backup)).length>MAX_BYTES)throw new Error('备份超过220MiB，请使用轻量备份或分批留存文献');return backup;
}
function validateRows(rows:Rows):void{
 for(const name of STORE_NAMES){const seen=new Set<string>();for(const row of rows[name]){if(!row||typeof row!=='object'||typeof row[KEYS[name]]!=='string'||!row[KEYS[name]])throw new Error(`数据缺少稳定ID：${name}`);const key=String(row[KEYS[name]]);if(seen.has(key))throw new Error(`备份内ID重复：${name}`);seen.add(key);}}
 const docs=new Set(rows.docs.map(r=>r.docId)),regions=new Map(rows.regions.map(r=>[r.id,r])),formulas=new Map(rows.formulaRevisions.map(r=>[r.id,r]));
 for(const name of ['annotations','blobs','chats','readingState','regions','formulaRevisions']as const)for(const row of rows[name])if(!docs.has(row.docId))throw new Error(`缺少文献关联：${name}`);
 for(const row of rows.blobs)if(!(row.bytes instanceof ArrayBuffer)||!String(row.docId).startsWith('b:'))throw new Error('PDF留存缺少可靠字节指纹');
 for(const row of rows.readingState){for(const id of [...(Array.isArray(row.pinnedAssetIds)?row.pinnedAssetIds:[]),...(row.activeAssetId?[row.activeAssetId]:[])])if(regions.get(id)?.docId!==row.docId)throw new Error('阅读位置引用了缺失或其他文献的原图');}
 for(const row of rows.tasks)if(row.docId!==null&&!docs.has(row.docId))throw new Error('完成结果缺少文献关联');
 for(const row of rows.tasks)if(!String(row.id).startsWith('saved-result:')||row.status!=='completed'||typeof row.resultText!=='string')throw new Error('备份包含可运行请求，已拒绝恢复');
 for(const row of rows.formulaRevisions){if(!['head','source','review','candidate','explanation'].includes(String(row.kind)))throw new Error('未知公式记录');if(formulas.get(row.formulaId)?.kind!=='head'||formulas.get(row.formulaId)?.docId!==row.docId)throw new Error('缺少同文献公式head');if(['head','candidate','review','explanation'].includes(String(row.kind))){const source=formulas.get(row.sourceRevisionId);if(source?.kind!=='source'||source.docId!==row.docId||source.formulaId!==row.formulaId)throw new Error('缺少同公式的来源修订');}if(row.kind==='source'){
  if(!Array.isArray(row.segments)||!row.segments.length||row.segments.length>8)throw new Error('公式原图片段无效');for(const s of row.segments as Row[]){const asset=regions.get(s.assetId);if(!asset||asset.docId!==row.docId)throw new Error('缺少同文献公式原图');}
 }}
}
const verifiedPlans=new WeakMap<RestorePlan,Rows>();
export async function prepareRestore(text:string):Promise<RestorePlan>{
 if(new TextEncoder().encode(text).length>MAX_BYTES)throw new Error('备份超过220MiB');const backup=JSON.parse(text)as Backup;
 if(backup.format!=='yedeng-local-backup'||backup.schemaVersion!==1||backup.databaseVersion>DB_VERSION||!backup.records||!backup.resources)throw new Error('不支持的备份版本');
 const {digest,...base}=backup;if(typeof digest!=='string'||await sha256Hex(stable(base))!==digest)throw new Error('备份manifest校验失败；未写入任何数据');
 if(backup.manifest.resources!==Object.keys(backup.resources).length)throw new Error('资源计数不一致');
 const decoded=new Map<string,Uint8Array>();let bytes=0;
 for(const[key,r]of Object.entries(backup.resources)){const data=unb64(r.base64);bytes+=data.length;if(bytes>MAX_BYTES||r.sha256!==key||r.bytes!==data.length||await sha256Hex(data)!==key)throw new Error('二进制资源大小或hash不符');decoded.set(key,data);}
 const rows=Object.create(null)as Rows;for(const name of STORE_NAMES){const values=backup.records[name];if(!Array.isArray(values)||values.length>100000||backup.manifest.counts[name]!==values.length)throw new Error('记录计数不一致');rows[name]=values.map(v=>decode(v,decoded)as Row);}
 if(Object.keys(backup.records).some(name=>!STORE_NAMES.includes(name as StoreName)))throw new Error('备份包含未知store');
 validateRows(rows);
 for(const row of rows.blobs)if(new TextDecoder().decode((row.bytes as ArrayBuffer).slice(0,5))!=='%PDF-'||await sha256Hex(row.bytes as ArrayBuffer)!==String(row.docId).slice(2))throw new Error('PDF字节与文献指纹不符');
 for(const row of [...rows.regions,...rows.formulaRevisions]){if(!Array.isArray(row.segments))continue;for(const segment of row.segments as Row[]){if(!(segment.cropBlob instanceof Blob)||segment.cropBlob.type!=='image/png'||await sha256Hex(await segment.cropBlob.arrayBuffer())!==segment.hash)throw new Error('原图字节与声明hash不符');}}
 let forcedDeny=0;for(const row of rows.docs){if(row.policy!=='deny_all_ai')forcedDeny++;row.policy='deny_all_ai';row.policyVersion=Number(row.policyVersion??0)+1;row.stored=rows.blobs.some(blob=>blob.docId===row.docId);}
 for(const row of rows.annotations)Object.assign(row,markLegacyAnchor(row));
 for(const name of STORE_NAMES)for(const row of rows[name])if(stable(portableRecord(row))!==stable(row))throw new Error('备份含未净化凭据字段或来源地址');
 const plan={digest,rows,summary:{counts:Object.fromEntries(STORE_NAMES.map(name=>[name,rows[name].length])),resources:decoded.size,forcedDeny,pdfsRequiringRelink:rows.docs.filter(row=>!row.stored).length}};verifiedPlans.set(plan,structuredClone(rows));return plan;
}
const authorizedPlans=new WeakSet<RestorePlan>();
/** UI calls only after showing the plan; mutations re-check current records in the write transaction. */
export function approveRestore(plan:RestorePlan):RestorePlan {if(!verifiedPlans.has(plan))throw new Error('未通过校验的恢复计划');authorizedPlans.add(plan);return plan;}
export async function commitRestore(plan:RestorePlan,db?:IDBDatabase):Promise<void>{
 if(!authorizedPlans.delete(plan))throw new Error('请先查看恢复预览并明确确认');
 const verified=verifiedPlans.get(plan);if(!verified)throw new Error('恢复计划已失效');const incoming=structuredClone(verified),database=db??await openDb();validateRows(incoming);
 await new Promise<void>((resolve,reject)=>{const tx=database.transaction([...STORE_NAMES],'readwrite');let failure:unknown;const requests=STORE_NAMES.map(name=>[name,tx.objectStore(name).getAll()]as const);let left=requests.length;
 tx.oncomplete=()=>resolve();tx.onabort=()=>reject(failure??tx.error??new Error('恢复已回滚'));tx.onerror=()=>{failure??=tx.error;};
 for(const[,req]of requests)req.onsuccess=()=>{if(--left)return;try{
  for(const[name,read]of requests){const existing=new Map((read.result as Row[]).map(row=>[String(row[KEYS[name]]),row]));for(const row of incoming[name]){
   const key=String(row[KEYS[name]]),current=existing.get(key);let value=row;
   if(current){if(name==='docs')value={...current,policy:'deny_all_ai',policyVersion:Math.max(Number(current.policyVersion??0),Number(row.policyVersion??0))+1,stored:!!current.stored||!!row.stored};
    else if(name==='usage')value={...current,requests:Math.max(Number(current.requests??0),Number(row.requests??0)),promptTokens:Math.max(Number(current.promptTokens??0),Number(row.promptTokens??0)),completionTokens:Math.max(Number(current.completionTokens??0),Number(row.completionTokens??0))};
    else if(['blobs','regions','formulaRevisions'].includes(name)||stable(current)!==stable(row)){throw new Error(`存在不同内容的相同ID，未覆盖：${name}`);}else continue;
   }tx.objectStore(name).put(value);
  }}
 }catch(error){failure=error;tx.abort();}};
 });
}
