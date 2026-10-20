import { describe, expect, it, vi } from 'vitest';
import { AnnotationConflictError, idbDeleteAnnotation, idbUpdateAnnotation, type AnnotationRecord } from '../src/shared/idb';
function fixture(revision?: number) {
  const current = { id: 'a', docId: 'doc', note: 'new note', color: 2, revision } as AnnotationRecord;
  const request = { result: current, onsuccess: undefined as (() => void) | undefined };
  const store = { get: () => request, put: vi.fn(), delete: vi.fn() };
  const tx = { objectStore: () => store, error: null, oncomplete: undefined as (() => void) | undefined,
    onabort: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined,
    abort() { tx.onabort?.(); } };
  const database = { transaction: () => tx } as unknown as IDBDatabase;
  return { current, request, store, tx, database };
}
describe('atomic annotation mutation contract', () => {
  it('rejects a stale note save before issuing a put', async () => {
    const f = fixture(3);
    const promise = idbUpdateAnnotation('a', 'doc', 2, { note: 'stale' }, f.database);
    f.request.onsuccess?.();
    await expect(promise).rejects.toBeInstanceOf(AnnotationConflictError);
    expect(f.store.put).not.toHaveBeenCalled();
    expect(f.current.note).toBe('new note');
  });
  it('rejects a stale delete before issuing deletion', async () => {
    const f = fixture(3);
    const promise = idbDeleteAnnotation('a', 'doc', 2, f.database);
    f.request.onsuccess?.();
    await expect(promise).rejects.toBeInstanceOf(AnnotationConflictError);
    expect(f.store.delete).not.toHaveBeenCalled();
  });
  it('merges color into the latest record without reverting its newer note', async () => {
    const f = fixture(3);
    const promise = idbUpdateAnnotation('a', 'doc', 1, { color: 1 }, f.database);
    f.request.onsuccess?.(); f.tx.oncomplete?.();
    await expect(promise).resolves.toMatchObject({ note: 'new note', color: 1, revision: 4 });
  });
  it('accepts legacy revision zero but does not report success before commit', async () => {
    const f = fixture();
    const promise = idbUpdateAnnotation('a', 'doc', 0, { note: 'updated' }, f.database);
    let settled = false; void promise.then(() => { settled = true; });
    f.request.onsuccess?.(); await Promise.resolve(); expect(settled).toBe(false);
    f.tx.oncomplete?.(); await expect(promise).resolves.toMatchObject({ note: 'updated', revision: 1 });
  });
  it('rejects an abort after issuing put and preserves caller object', async () => {
    const f = fixture(3);
    const promise = idbUpdateAnnotation('a', 'doc', 3, { note: 'must not count as saved' }, f.database);
    f.request.onsuccess?.(); f.tx.onabort?.();
    await expect(promise).rejects.toThrow('未保存');
    expect(f.current.note).toBe('new note');
  });
});
