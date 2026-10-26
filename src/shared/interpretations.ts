/** Local reading history. Persist content, never provider settings or request bodies. */
import {idbGet,idbGetAll,idbPut,type TaskRecord} from './idb';
import {copyResultSources,type ResultSourceReference} from './savedResults';
import type {SelectionSnapshot} from '../pdf/selectionModel';
export interface InterpretationTurn {question:string;answer:string;sources:ResultSourceReference[];cacheKey:string}
export interface Interpretation extends TaskRecord {
 docId:string; snapshot:SelectionSnapshot; context:string; sourceId:string;
 contextQuads:NonNullable<SelectionSnapshot['pdfRegions']>; turns:InterpretationTurn[];
}
export async function interpretationId(docId:string,snapshot:SelectionSnapshot):Promise<string>{
 const bytes=new TextEncoder().encode(JSON.stringify([docId,snapshot.text,snapshot.pageIndex,snapshot.pdfRegions??snapshot.pageBoxes]));
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return 'interpretation:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function loadInterpretation(id:string):Promise<Interpretation|undefined>{
 const row=await idbGet('tasks',id);return row?.id.startsWith('interpretation:')?row as Interpretation:undefined;
}
export async function listInterpretations(docId:string):Promise<Interpretation[]>{
 return (await idbGetAll('tasks')).filter((r):r is Interpretation=>r.id.startsWith('interpretation:')&&r.docId===docId).sort((a,b)=>b.updatedAt-a.updatedAt);
}
export async function saveInterpretation(input:Pick<Interpretation,'id'|'docId'|'snapshot'|'context'|'contextQuads'|'sourceId'|'turns'>):Promise<void>{
 const s=input.snapshot;
 const record:Interpretation={id:input.id,docId:input.docId,status:'completed',snapshotHash:input.id,updatedAt:Date.now(),
 snapshot:structuredClone({docId:input.docId,text:s.text,pageIndex:s.pageIndex,pageBoxes:s.pageBoxes,firstRect:s.firstRect,pdfRegions:s.pdfRegions}),
 context:input.context,contextQuads:structuredClone(input.contextQuads),sourceId:input.sourceId,
 turns:input.turns.map(t=>({question:t.question,answer:t.answer,cacheKey:t.cacheKey,sources:copyResultSources(t.sources)}))};
 await idbPut('tasks',record);
}
