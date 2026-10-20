/** Additive-only schema. IDB upgrade transaction rolls everything back on failure. */
export const DB_VERSION = 2;
export const LEGACY_STORES = ['docs', 'folders', 'blobs', 'annotations', 'chats', 'cache', 'usage', 'readingState'] as const;
export const STORE_NAMES = [...LEGACY_STORES, 'regions', 'formulaRevisions', 'tasks', 'requestLedger'] as const;

/** Preserve every legacy field/rectangle; no reliable PDF coordinate conversion without page transforms. */
export function markLegacyAnchor<T extends { anchor?: unknown }>(record: T): T {
  if (record.anchor !== undefined) return record;
  return { ...record, anchor: { coordinateSpace: 'legacy-normalized', status: 'legacy-unverified' } };
}
export function upgradeSchema(db: IDBDatabase, tx: IDBTransaction): void {
  const store = (name: string, keyPath: string) => db.objectStoreNames.contains(name)
    ? tx.objectStore(name) : db.createObjectStore(name, { keyPath });
  const index = (os: IDBObjectStore, name: string, keyPath: string) => {
    if (!os.indexNames.contains(name)) os.createIndex(name, keyPath);
  };
  const docs = store('docs', 'docId');
  index(docs, 'byLastOpened', 'lastOpenedAt'); index(docs, 'byFolder', 'folderId');
  store('folders', 'folderId'); store('blobs', 'docId');
  const annotations = store('annotations', 'id'); index(annotations, 'byDoc', 'docId');
  store('chats', 'key');
  index(store('cache', 'key'), 'byCreated', 'createdAt');
  store('usage', 'date'); store('readingState', 'docId');
  index(store('regions', 'id'), 'byDoc', 'docId');
  const formulas = store('formulaRevisions', 'id');
  index(formulas, 'byDoc', 'docId'); index(formulas, 'byAsset', 'assetId');
  index(store('tasks', 'id'), 'byDoc', 'docId');
  index(store('requestLedger', 'id'), 'byDay', 'dayKey');
  const cursor = annotations.openCursor();
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) return;
    if (current.value.anchor === undefined) current.update(markLegacyAnchor(current.value));
    current.continue();
  };
}
