/** Durable local answers contain result text + source references, never request bodies or credentials. */
import {idbGetAll,idbPut,type TaskRecord} from './idb';
import type {PdfQuad} from '../pdf/geometry';
export interface ResultSourceReference {id:string;label:string;pageIndices:number[];sourceQuads?:{pageIndex:number;quads:PdfQuad[]}[];assetId?:string;assetVersion?:number}
export interface SavedResult extends TaskRecord {status:'completed';resultText:string;action:string;sources:ResultSourceReference[];sourceRevision?:string}
export function copyResultSources(sources:readonly ResultSourceReference[]):ResultSourceReference[]{
 if(sources.length>128)throw new Error('来源引用数量超过本地保存上限');
 return sources.map(source=>({id:source.id,label:source.label,pageIndices:[...source.pageIndices],...(source.sourceQuads?{sourceQuads:structuredClone(source.sourceQuads)}:{}),...(source.assetId?{assetId:source.assetId}:{}),...(source.assetVersion!==undefined?{assetVersion:source.assetVersion}:{})}));
}
export async function saveCompletedResult(input:{cacheKey:string;docId:string;action:string;snapshotHash:string;resultText:string;sourceRevision?:string;sources?:readonly ResultSourceReference[]}):Promise<void>{
 const record:SavedResult={id:`saved-result:${input.cacheKey}`,cacheKey:input.cacheKey,docId:input.docId,status:'completed',snapshotHash:input.snapshotHash,updatedAt:Date.now(),action:input.action,resultText:input.resultText,sources:copyResultSources(input.sources??[]),...(input.sourceRevision?{sourceRevision:input.sourceRevision}:{})};
 await idbPut('tasks',record);
}
export async function listSavedResults(docId:string):Promise<SavedResult[]>{
 const records=await idbGetAll('tasks');return records.filter((record):record is SavedResult=>record.id.startsWith('saved-result:')&&record.docId===docId&&record.status==='completed'&&typeof record.resultText==='string').sort((a,b)=>b.updatedAt-a.updatedAt);
}
