import type { PdfQuad } from '../pdf/geometry';
import { upgradeSchema, DB_VERSION, STORE_NAMES } from './migrations';

/** IndexedDB：原库原位增量升级，品牌改名不改变数据库名。 */

export interface DocRecord {
  docId: string;
  url: string;
  /** Exact sources for byte-identical documents; never merge by title. */
  sources?: string[];
  fileName?: string;
  title: string;
  authors: string;
  numPages: number;
  sizeBytes: number;
  addedAt: number;
  lastOpenedAt: number;
  folderId: string | null;
  favorite: boolean;
  thumb?: string;
  /** 是否已在本地留存 PDF 字节 */
  stored: boolean;
  policy?: 'deny_all_ai' | 'allowed_to_configured_provider';
  policyVersion?: number;
}

export interface FolderRecord {
  folderId: string;
  name: string;
  createdAt: number;
}

export interface BlobRecord {
  docId: string;
  bytes: ArrayBuffer;
}

export type AnnotationKind = 'highlight' | 'underline' | 'note';

export type AnnotationAnchor =
  | { coordinateSpace: 'legacy-normalized'; status: 'legacy-unverified' }
  | { coordinateSpace: 'pdf-user-space'; status: 'captured'; regions: { pageIndex: number; quads: PdfQuad[] }[] }; 

export interface AnnotationRecord {
  id: string;
  docId: string;
  kind: AnnotationKind;
  color: 1 | 2 | 3;
  pageIndex: number;
  /** 相对页面宽高的归一化矩形（0..1） */
  rects: { x: number; y: number; w: number; h: number }[];
  quote: string;
  /** 选中文本前后各 32 字，用于锚点漂移时重新定位 */
  prefix: string;
  suffix: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
  /** 旧矩形不能在缺少页面变换时猜测转换。 */
  anchor?: AnnotationAnchor;
  /** A cross-page selection is one logical annotation, with one note and revision. */
  logicalId?: string;
  revision?: number;
}

export interface ChatRecord {
  key: string;
  docId: string;
  messages: { role: 'user' | 'assistant'; content: string; at: number; error?: string }[];
  updatedAt: number;
}

export interface CacheRecord {
  key: string;
  value: string;
  createdAt: number;
}

export interface UsageRecord {
  /** YYYY-MM-DD */
  date: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export interface RegionSegment {
  id: string; pageIndex: number; quad: PdfQuad; order: number; cropBlobId: string;
  cropBlob: Blob; hash: string; width: number; height: number; rotation: number;
}

export interface ReadingStateRecord {
  docId: string;
  lastPage: number;
  zoom: number;
  pinnedAssetIds?: string[];
  activeAssetId?: string | null;
  updatedAt: number;
}

/** G0 增量数据合同；后续模块可扩充字段，不自动生成识别结果。 */
export interface RegionRecord {
  /** Soft deletion hides a saved crop while preserving formula history and undo. */
  deletedAt?: number;
  id: string;
  docId: string;
  kind: 'figure' | 'table' | 'formula' | 'region';
  fragments: { pageIndex: number; pdfRect: [number, number, number, number]; rotation: number }[];
  segments?: RegionSegment[];
  assetVersion?: number;
  caption?: string;
  quote?: string;
  contentHash?: string;
  updatedAt?: number;
  createdAt: number;
}
export type FormulaRevisionRecord = import('../formula/model').FormulaStoredRecord;
export interface TaskRecord {
  id: string;
  docId: string | null;
  cacheKey?: string;
  taskId?: string;
  leaseOwner?: string;
  leaseUntil?: number;
  resultText?: string;
  status: 'prepared' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  snapshotHash: string;
  updatedAt: number;
}
export interface RequestLedgerRecord {
  /** 唯一尝试 ID；不是按日覆盖的聚合值。 */
  id: string;
  dayKey: string;
  taskId: string;
  docId: string | null;
  attemptedAt: number;
}

export interface StoreTypes {
  docs: DocRecord;
  folders: FolderRecord;
  blobs: BlobRecord;
  annotations: AnnotationRecord;
  chats: ChatRecord;
  cache: CacheRecord;
  usage: UsageRecord;
  readingState: ReadingStateRecord;
  regions: RegionRecord;
  formulaRevisions: FormulaRevisionRecord;
  tasks: TaskRecord;
  requestLedger: RequestLedgerRecord;
}

export type StoreName = keyof StoreTypes;

export const DB_NAME = 'moonlight-lite';
export { DB_VERSION };

/** 可注入独立测试库；生产默认始终使用原数据库名。 */
export function createDatabase(options: { name?: string; factory?: IDBFactory } = {}) {
  let dbPromise: Promise<IDBDatabase> | null = null;
  let connection: IDBDatabase | null = null;
  const name = options.name ?? DB_NAME;
  function close() {
    connection?.close();
    connection = null;
    dbPromise = null;
  }
  function open(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const req = (options.factory ?? indexedDB).open(name, DB_VERSION);
      let abandoned = false;
      req.onupgradeneeded = () => {
        // A rejected blocked open must never upgrade later when the blocker closes.
        if (abandoned) { req.transaction?.abort(); return; }
        try { upgradeSchema(req.result, req.transaction!); }
        catch (error) { req.transaction?.abort(); reject(error); }
      };
      req.onblocked = () => {
        abandoned = true;
        reject(new Error('数据库升级被其他页面阻止，请关闭旧版阅读器后重试；原数据未清除'));
      };
      req.onsuccess = () => {
        const db = req.result;
        if (abandoned) { db.close(); return; }
        connection = db;
        db.onversionchange = close;
        db.onclose = close;
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
    });
    dbPromise = pending;
    void pending.catch(() => { if (dbPromise === pending) dbPromise = null; });
    return pending;
  }
  async function request<T>(store: StoreName, mode: IDBTransactionMode, issue: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    return commitRequest(db, store, mode, issue);
  }
  return { open, close, request };
}

/** 请求成功只代表已排入事务；只有 complete 才能向调用方报告保存成功。 */
export function commitRequest<T>(db: IDBDatabase, store: StoreName, mode: IDBTransactionMode,
  issue: (os: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    let result: T;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已中止'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'));
    try {
      const req = issue(transaction.objectStore(store));
      req.onsuccess = () => { result = req.result; };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });
}
const defaultDatabase = createDatabase();
export const openDb = defaultDatabase.open;

export async function idbPut<S extends StoreName>(store: S, value: StoreTypes[S]): Promise<void> {
  await defaultDatabase.request(store, 'readwrite', os => os.put(value));
}
export async function idbGet<S extends StoreName>(store: S, key: IDBValidKey): Promise<StoreTypes[S] | undefined> {
  return defaultDatabase.request(store, 'readonly', os => os.get(key));
}
export async function idbDelete<S extends StoreName>(store: S, key: IDBValidKey): Promise<void> {
  await defaultDatabase.request(store, 'readwrite', os => os.delete(key));
}
export async function idbGetAll<S extends StoreName>(store: S): Promise<StoreTypes[S][]> {
  return defaultDatabase.request(store, 'readonly', os => os.getAll());
}
export async function idbGetByIndex<S extends StoreName>(store: S, index: string,
  query: IDBValidKey | IDBKeyRange): Promise<StoreTypes[S][]> {
  return defaultDatabase.request(store, 'readonly', os => os.index(index).getAll(query));
}
export async function idbClear(store: StoreName): Promise<void> {
  await defaultDatabase.request(store, 'readwrite', os => os.clear());
}
export async function idbCount(store: StoreName): Promise<number> {
  return defaultDatabase.request(store, 'readonly', os => os.count());
}
export async function idbPurgeOldCache(cut: number): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('cache', 'readwrite');
    let count = 0;
    const req = transaction.objectStore('cache').index('byCreated').openCursor(IDBKeyRange.upperBound(cut));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { cursor.delete(); count++; cursor.continue(); }
    };
    transaction.oncomplete = () => resolve(count);
    transaction.onabort = () => reject(transaction.error ?? new Error('缓存清理中止'));
    transaction.onerror = () => reject(transaction.error ?? new Error('缓存清理失败'));
  });
}
/** 一次事务清空全部数据，避免失败时只清一部分；包含 v2 新 stores。 */
export async function idbWipeAll(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([...STORE_NAMES], 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('清空数据中止'));
    transaction.onerror = () => reject(transaction.error ?? new Error('清空数据失败'));
    for (const name of STORE_NAMES) transaction.objectStore(name).clear();
  });
}

export class AnnotationConflictError extends Error {
  constructor(public readonly expectedRevision: number, public readonly actualRevision: number, action: 'save' | 'delete') {
    super(action === 'delete'
      ? '批注已被其他页面修改，本次未删除。请刷新批注后核对。'
      : '批注已被其他页面修改，本次未保存。草稿已保留，请刷新批注后核对。');
    this.name = 'AnnotationConflictError';
  }
}

/** Read/check/write share the same store lock; callers never overwrite a record from stale UI state. */
async function mutateAnnotation<T>(id: string, change: (current: AnnotationRecord | undefined) => { value: AnnotationRecord | null; result: T },
  database?: IDBDatabase): Promise<T> {
  const db = database ?? await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction('annotations', 'readwrite');
    const store = transaction.objectStore('annotations');
    let result: T;
    let failure: unknown;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('批注事务中止，未保存'));
    transaction.onerror = () => { failure ??= transaction.error ?? new Error('批注事务失败，未保存'); };
    const request = store.get(id) as IDBRequest<AnnotationRecord | undefined>;
    request.onsuccess = () => {
      try {
        const changed = change(request.result);
        result = changed.result;
        if (changed.value) store.put(changed.value);
        else store.delete(id);
      } catch (error) { failure = error; transaction.abort(); }
    };
  });
}

export async function idbUpdateAnnotation(id: string, docId: string, expectedRevision: number,
  changes: Partial<Pick<AnnotationRecord, 'note' | 'color'>>, database?: IDBDatabase): Promise<AnnotationRecord> {
  return mutateAnnotation(id, current => {
    if (!current || current.docId !== docId) throw new Error('批注已删除或不属于当前文献，本次未保存；草稿已保留');
    const actualRevision = current.revision ?? 0;
    // Color-only edits merge into the latest record; a concurrent note must never be overwritten.
    if ('note' in changes && actualRevision !== expectedRevision) throw new AnnotationConflictError(expectedRevision, actualRevision, 'save');
    const updated = { ...current, ...changes, revision: actualRevision + 1, updatedAt: Date.now() };
    return { value: updated, result: updated };
  }, database);
}

export async function idbDeleteAnnotation(id: string, docId: string, expectedRevision: number, database?: IDBDatabase): Promise<void> {
  await mutateAnnotation(id, current => {
    if (!current || current.docId !== docId) throw new Error('批注已删除或不属于当前文献，本次未删除');
    const actualRevision = current.revision ?? 0;
    if (actualRevision !== expectedRevision) throw new AnnotationConflictError(expectedRevision, actualRevision, 'delete');
    return { value: null, result: undefined };
  }, database);
}


/** Preserve references when the scrolling reader saves its current page/zoom. */
export async function idbPatchReadingState(docId: string, patch: Partial<Pick<ReadingStateRecord, 'lastPage' | 'zoom'>>, database?: IDBDatabase): Promise<void> {
  const db = database ?? await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('readingState', 'readwrite'); const store = tx.objectStore('readingState');
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('阅读位置保存中止'));
    tx.onerror = () => reject(tx.error ?? new Error('阅读位置保存失败'));
    const request = store.get(docId) as IDBRequest<ReadingStateRecord | undefined>;
    request.onsuccess = () => store.put({ lastPage: 0, zoom: 1, ...request.result, ...patch, docId, updatedAt: Date.now() });
  });
}

export type DocMetadataPatch = Partial<Omit<DocRecord, 'docId' | 'policy' | 'policyVersion'>>;
/** Policy can only change via its dedicated transaction; metadata never writes a stale policy. */
export async function idbPatchDocRecord(docId: string, patch: DocMetadataPatch, create?: DocRecord, database?: IDBDatabase): Promise<DocRecord> {
  const allowed = new Set(['url','sources','fileName','title','authors','numPages','sizeBytes','addedAt','lastOpenedAt','folderId','favorite','thumb','stored']);
  if (Object.keys(patch).some(key => !allowed.has(key))) throw new Error('文献元数据更新不能修改AI策略、版本或标识');
  if (create && create.docId !== docId) throw new Error('新文献标识不一致');
  const db = database ?? await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('docs', 'readwrite'), store = tx.objectStore('docs');
    let result: DocRecord, failure: unknown;
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(failure ?? tx.error ?? new Error('文献信息保存中止'));
    tx.onerror = () => { failure ??= tx.error ?? new Error('文献信息保存失败'); };
    const req = store.get(docId) as IDBRequest<DocRecord | undefined>;
    req.onsuccess = () => {
      if (!req.result && !create) { failure = new Error('文献已删除，未重新创建或保存元数据'); tx.abort(); return; }
      const base = req.result ?? create!;
      result = { ...base, ...patch, docId };
      if (patch.url) result.sources = [...new Set([...(base.sources ?? []), base.url, patch.url].filter(Boolean))];
      store.put(result);
    };
  });
}
