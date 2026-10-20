import { describe, expect, it, vi } from 'vitest';
import { assertAttemptAvailable, AttemptLimitError, createAttemptLedger, localDayKey } from '../src/ai/attemptLedger';

describe('attempt local day and limits', () => {
  it('uses the installation timezone across UTC midnight, including DST regions', () => {
    expect(localDayKey(Date.parse('2026-10-16T17:30:00Z'), 'Asia/Shanghai')).toBe('2026-10-17');
    expect(localDayKey(Date.parse('2026-10-16T01:30:00Z'), 'America/Los_Angeles')).toBe('2026-10-15');
    expect(localDayKey(Date.parse('2026-03-08T09:59:00Z'), 'America/Los_Angeles')).toBe('2026-03-08');
    expect(localDayKey(Date.parse('2026-03-08T10:01:00Z'), 'America/Los_Angeles')).toBe('2026-03-08');
  });
  it('treats zero as no requests and null as unlimited', () => {
    expect(() => assertAttemptAvailable(0, 0, '2026-10-16')).toThrow(AttemptLimitError);
    expect(() => assertAttemptAvailable(3, 3, '2026-10-16')).toThrow(AttemptLimitError);
    expect(() => assertAttemptAvailable(2, 3, '2026-10-16')).not.toThrow();
    expect(() => assertAttemptAvailable(100_000, null, '2026-10-16')).not.toThrow();
  });
  it('rejects invalid policy before touching the DB', async () => {
    const openDatabase = vi.fn();
    const ledger = createAttemptLedger({ openDatabase });
    for (const limit of [-1, .5, NaN]) {
      await expect(ledger.reserve({ docId: 'a', taskId: 'b', timeZone: 'Asia/Shanghai', limit })).rejects.toThrow();
    }
    expect(openDatabase).not.toHaveBeenCalled();
  });
  it('does nothing merely by creating a ledger (cache and preparation have no implicit reserve)', () => {
    const openDatabase = vi.fn();
    const ledger = createAttemptLedger({ openDatabase });
    expect(ledger.reserve).toBeTypeOf('function');
    expect(openDatabase).not.toHaveBeenCalled();
  });
});
