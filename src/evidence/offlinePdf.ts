import { idbGet, idbGetAll, type DocRecord, type BlobRecord } from '../shared/idb';
import { sha256Hex } from '../shared/hash';
export class AmbiguousStoredPdfError extends Error { constructor(){super('该地址曾对应多份不同字节的PDF，请从文献库明确选择本地版本');this.name='AmbiguousStoredPdfError';} }
export async function findStoredPdfForUrl(url: string, expectedDocId?: string, dependencies: {
  listDocuments?:()=>Promise<DocRecord[]>; readBlob?:(id:string)=>Promise<BlobRecord|undefined>;
} = {}): Promise<{record:DocRecord;bytes:ArrayBuffer;source:'verified-local-copy'}|null> {
  const docs=await (dependencies.listDocuments??(()=>idbGetAll('docs')))();
  const candidates=docs.filter(doc=>(doc.url===url||doc.sources?.includes(url))&&(!expectedDocId||doc.docId===expectedDocId));
  if(!candidates.length)return null;
  if(new Set(candidates.map(doc=>doc.docId)).size!==1)throw new AmbiguousStoredPdfError();
  const record=candidates[0];const stored=await (dependencies.readBlob??(id=>idbGet('blobs',id)))(record.docId);
  if(!stored)return null;
  if(stored.docId!==record.docId||!record.docId.startsWith('b:')||`b:${await sha256Hex(stored.bytes)}`!==record.docId)throw new Error('本地PDF字节与文献指纹不一致，未自动打开或迁移批注');
  return{record,bytes:stored.bytes.slice(0),source:'verified-local-copy'};
}
