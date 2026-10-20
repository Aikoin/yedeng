import { capturePdfRegion } from '../pdf/capture';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfQuad } from '../pdf/geometry';
import { sha256Hex } from '../shared/hash';
import { openDb, idbGetByIndex, idbGet, idbPut, type RegionRecord, type RegionSegment, type ReadingStateRecord } from '../shared/idb';
import { referenceTransition, type ReferenceAction, type ReferenceState } from './referenceModel';

export function inlinePngBlob(image: string): Blob {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new Error('只接受本地裁图PNG，不允许远端图像');
  const bytes = Uint8Array.from(atob(image.slice(image.indexOf(',') + 1)), char => char.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}
export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}
export async function createRegionAsset(doc: PDFDocumentProxy, docId: string, kind: RegionRecord['kind'], regions: {pageIndex:number;quad:PdfQuad}[], quote = '', caption = ''): Promise<RegionRecord> {
  if (!docId || !regions.length) throw new Error('缺少文献或区域');
  const segments: RegionSegment[] = [];
  for (const [order, region] of regions.entries()) {
    const crop = await capturePdfRegion(doc, region.pageIndex, region.quad);
    const cropBlob = inlinePngBlob(crop.image); const id = crypto.randomUUID();
    segments.push({ id, pageIndex: region.pageIndex, quad: structuredClone(region.quad), order, cropBlobId: id,
      cropBlob, hash: await sha256Hex(await cropBlob.arrayBuffer()), width: crop.width, height: crop.height, rotation: (await doc.getPage(region.pageIndex + 1)).rotate });
  }
  const now = Date.now();
  const record: RegionRecord = { id: crypto.randomUUID(), docId, kind, createdAt: now, updatedAt: now, assetVersion: 1,
    caption, quote, segments, fragments: segments.map(segment => {
      const xs = segment.quad.map(p => p.x), ys = segment.quad.map(p => p.y);
      return { pageIndex: segment.pageIndex, pdfRect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], rotation: segment.rotation };
    }), contentHash: await sha256Hex(segments.map(segment => segment.hash).join(':')) };
  // Blobs and anchors share one record, so transaction failure cannot leave dangling crop references.
  await idbPut('regions', record); return record;
}
export async function loadRegionAssets(docId: string): Promise<RegionRecord[]> {
  return (await idbGetByIndex('regions', 'byDoc', docId)).filter(asset => !asset.deletedAt && !!asset.segments?.length);
}
export async function loadRemovedRegionAssets(docId:string):Promise<RegionRecord[]>{return(await idbGetByIndex('regions','byDoc',docId)).filter(asset=>!!asset.deletedAt&&!!asset.segments?.length);}
export async function loadReferences(docId: string): Promise<ReferenceState> {
  const reading = await idbGet('readingState', docId);
  return { pinnedAssetIds: reading?.pinnedAssetIds ?? [], activeAssetId: reading?.activeAssetId ?? null };
}
export async function changeReferences(docId: string, action: ReferenceAction, database?: IDBDatabase): Promise<ReferenceState> {
  const db = database ?? await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['readingState', 'regions'], 'readwrite');
    let result: ReferenceState; let failure: unknown;
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(failure ?? tx.error ?? new Error('置顶保存中止'));
    tx.onerror = () => { failure ??= tx.error ?? new Error('置顶保存失败'); };
    const store = tx.objectStore('readingState'); const req = store.get(docId) as IDBRequest<ReadingStateRecord | undefined>;
    req.onsuccess = () => {
      const commit = () => {
        try {
          const current = req.result;
          result = referenceTransition({ pinnedAssetIds: current?.pinnedAssetIds ?? [], activeAssetId: current?.activeAssetId ?? null }, action);
          store.put({ lastPage: 0, zoom: 1, ...current, ...result, docId, updatedAt: Date.now() });
        } catch (error) { failure = error; tx.abort(); }
      };
      if (action.type === 'pin' || action.type === 'expand') {
        const asset = tx.objectStore('regions').get(action.assetId) as IDBRequest<RegionRecord | undefined>;
        asset.onsuccess = () => { if (!asset.result || asset.result.deletedAt || asset.result.docId !== docId) { failure = new Error('资源不存在或不属于当前文献'); tx.abort(); } else commit(); };
      } else commit();
    };
  });
}

/** A reversible removal also unpins atomically; embedded formula snapshots remain usable. */
export async function setRegionDeleted(docId:string,assetId:string,deleted:boolean,database?:IDBDatabase):Promise<ReferenceState>{
  const db=database??await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['regions','readingState'],'readwrite');let result:ReferenceState,failure:unknown;
    tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure??tx.error??new Error('图表移除未完成'));tx.onerror=()=>{failure??=tx.error;};
    const regions=tx.objectStore('regions'),reading=tx.objectStore('readingState');
    const asset=regions.get(assetId) as IDBRequest<RegionRecord|undefined>;
    asset.onsuccess=()=>{
      if(!asset.result||asset.result.docId!==docId){failure=new Error('图表不属于当前文献');tx.abort();return;}
      const record={...asset.result};if(deleted)record.deletedAt=Date.now();else delete record.deletedAt;
      record.updatedAt=Date.now();regions.put(record);
      const state=reading.get(docId) as IDBRequest<ReadingStateRecord|undefined>;
      state.onsuccess=()=>{const previous={pinnedAssetIds:state.result?.pinnedAssetIds??[],activeAssetId:state.result?.activeAssetId??null};result=deleted?referenceTransition(previous,{type:'unpin',assetId}):previous;
        reading.put({lastPage:0,zoom:1,...state.result,...result,docId,updatedAt:Date.now()});};
    };
  });
}
