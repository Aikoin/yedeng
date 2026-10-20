/** G0 primitive only: reservation is not dispatch and does not authorize sending material. */
import { openDb, type RequestLedgerRecord } from '../shared/idb';

export class AttemptLimitError extends Error {
  constructor(public readonly dayKey: string, public readonly limit: number) {
    super(`本机当日请求尝试次数已达上限（${limit}）`);
    this.name = 'AttemptLimitError';
  }
}
/** Caller must persist installation timezone; a UTC date slice is not a local day. */
export function localDayKey(timestamp: number, timeZone: string): string {
  if (!Number.isFinite(timestamp)) throw new Error('Invalid attempt timestamp');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function assertAttemptAvailable(count: number, limit: number | null, dayKey: string): void {
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) throw new Error('尝试次数上限必须为非负整数或 null');
  if (limit !== null && count >= limit) throw new AttemptLimitError(dayKey, limit);
}
class DayRolloverError extends Error {}

export interface AttemptReservation {
  taskId: string;
  docId: string | null;
  /** Persisted installation timezone, not a caller-selected per-request override in production. */
  timeZone: string;
  /** null = explicitly unlimited; zero = no attempts. */
  limit: number | null;
}
export function createAttemptLedger(dependencies: {
  openDatabase?: () => Promise<IDBDatabase>;
  now?: () => number;
  newId?: () => string;
} = {}) {
  /** Invoke immediately before dispatch only; preparation/cache hits must never call reserve. */
  async function reserveOnce(input: AttemptReservation): Promise<RequestLedgerRecord> {
    // Validate before I/O, then sample again after opening (which can wait for an upgrade).
    assertAttemptAvailable(0, input.limit, '');
    const db = await (dependencies.openDatabase ?? openDb)();
    const attemptedAt = (dependencies.now ?? Date.now)();
    const dayKey = localDayKey(attemptedAt, input.timeZone);
    assertAttemptAvailable(0, input.limit, dayKey);
    const record: RequestLedgerRecord = {
      id: (dependencies.newId ?? (() => crypto.randomUUID()))(), dayKey,
      taskId: input.taskId, docId: input.docId, attemptedAt,
    };
    return new Promise<RequestLedgerRecord>((resolve, reject) => {
      // Read count + reserve under one readwrite lock. Other tabs cannot interleave this store.
      const tx = db.transaction('requestLedger', 'readwrite');
      let failure: unknown;
      tx.oncomplete = () => resolve(record);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('尝试槽预留中止'));
      tx.onerror = () => { failure ??= tx.error ?? new Error('尝试槽预留失败'); };
      const store = tx.objectStore('requestLedger');
      const count = store.index('byDay').count(dayKey);
      count.onsuccess = () => {
        try {
          // The transaction may have waited behind another tab across local midnight.
          if (localDayKey((dependencies.now ?? Date.now)(), input.timeZone) !== dayKey) throw new DayRolloverError();
          assertAttemptAvailable(count.result, input.limit, dayKey);
          store.add(record); // Failed/cancelled network work has no refund operation.
        } catch (error) { failure = error; tx.abort(); }
      };
    });
  }
  async function reserve(input: AttemptReservation): Promise<RequestLedgerRecord> {
    // Abort before adding if local day changed while waiting; never write a slot to yesterday.
    for (let retry = 0; retry < 3; retry++) {
      try { return await reserveOnce(input); }
      catch (error) { if (!(error instanceof DayRolloverError)) throw error; }
    }
    throw new Error('本地日期持续变化，未预留请求，请稍后重试');
  }
  return { reserve };
}
