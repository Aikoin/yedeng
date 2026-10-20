import { describe, it, expect } from 'vitest';
import { markLegacyAnchor, LEGACY_STORES, STORE_NAMES } from '../src/shared/migrations';
import { commitRequest, DB_NAME } from '../src/shared/idb';
import { migrationFixture } from './fixtures/migration-v1';

describe('v1 additive migration contract', () => {
  it('retains original database identity and all old stores', () => {
    expect(DB_NAME).toBe('moonlight-lite');
    for (const name of LEGACY_STORES) expect(STORE_NAMES).toContain(name);
    expect(new Set(STORE_NAMES).size).toBe(12);
  });
  it('preserves legacy rectangles and every field without inventing PDF coordinates', () => {
    for (const original of migrationFixture.annotations!) {
      const migrated = markLegacyAnchor(original);
      const { anchor, ...rest } = migrated;
      expect(rest).toEqual(original);
      expect(anchor).toEqual({ coordinateSpace: 'legacy-normalized', status: 'legacy-unverified' });
      expect(migrated).not.toBe(original);
    }
  });
  it('is idempotent and preserves already verified/future anchors', () => {
    const original = { id: 'a', anchor: { coordinateSpace: 'pdf', status: 'verified' } };
    expect(markLegacyAnchor(original)).toBe(original);
    const migrated = markLegacyAnchor(migrationFixture.annotations![0]!);
    expect(markLegacyAnchor(migrated)).toBe(migrated);
  });
});

function controlledTransaction() {
  const request = { result: 17 } as IDBRequest<number>;
  const transaction = {
    error: null,
    objectStore: () => ({}),
    abort: () => transaction.onabort?.(),
    oncomplete: undefined as (() => void) | undefined,
    onabort: undefined as (() => void) | undefined,
    onerror: undefined as (() => void) | undefined,
  };
  const db = { transaction: () => transaction } as unknown as IDBDatabase;
  return { request, transaction, promise: commitRequest(db, 'docs', 'readwrite', () => request) };
}
describe('transaction completion semantics', () => {
  it('does not report request success as committed until transaction completes', async () => {
    const fixture = controlledTransaction();
    let settled = false;
    void fixture.promise.then(() => { settled = true; });
    fixture.request.onsuccess?.call(fixture.request, {} as Event);
    await Promise.resolve();
    expect(settled).toBe(false);
    fixture.transaction.oncomplete?.();
    await expect(fixture.promise).resolves.toBe(17);
  });
  it('rejects abort even after successful request', async () => {
    const fixture = controlledTransaction();
    fixture.request.onsuccess?.call(fixture.request, {} as Event);
    fixture.transaction.onabort?.();
    await expect(fixture.promise).rejects.toThrow('事务已中止');
  });
  it('rejects transaction errors', async () => {
    const fixture = controlledTransaction();
    fixture.transaction.onerror?.();
    await expect(fixture.promise).rejects.toThrow('事务失败');
  });
});
