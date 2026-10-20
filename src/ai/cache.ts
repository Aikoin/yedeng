/** AI 结果缓存：同一输入不重复烧 token。键包含提示词版本与模型，改提示词/换模型自动失效。 */
import { idbGet, idbPut, idbPurgeOldCache, type CacheRecord } from '../shared/idb';
import { sha256Hex } from '../shared/hash';
import { PROMPT_VERSION } from './prompts';
import type { Settings } from '../shared/settings';

export interface CacheContext {
  feature: string;
  providerId: string;
  model: string;
  /** 输入内容的稳定表示（例如 messages JSON 或片段数组） */
  payload: string;
}

export async function makeCacheKey(ctx: CacheContext): Promise<string> {
  return sha256Hex([PROMPT_VERSION, ctx.feature, ctx.providerId, ctx.model, ctx.payload].join('\u0000'));
}

export async function readCache(settings: Settings, key: string): Promise<string | null> {
  if (!settings.cache.enabled) return null;
  const record = await idbGet('cache', key);
  if (!record) return null;
  if (settings.cache.ttlDays > 0) {
    const ageMs = Date.now() - record.createdAt;
    if (ageMs > settings.cache.ttlDays * 24 * 3600 * 1000) return null;
  }
  return record.value;
}

export async function writeCache(settings: Settings, key: string, value: string): Promise<void> {
  if (!settings.cache.enabled || !value) return;
  const record: CacheRecord = { key, value, createdAt: Date.now() };
  await idbPut('cache', record);
}

/** 清理过期缓存（0 = 永不过期，仅清理超大条数） */
export async function purgeCacheIfNeeded(settings: Settings, maxEntries = 2000): Promise<void> {
  if (settings.cache.ttlDays > 0) {
    const cut = Date.now() - settings.cache.ttlDays * 24 * 3600 * 1000;
    await idbPurgeOldCache(cut);
  } else {
    // 不设 TTL 时，按创建时间淘汰较早的一半，避免无限增长
    const { idbCount } = await import('../shared/idb');
    const count = await idbCount('cache');
    if (count > maxEntries) {
      const all = await import('../shared/idb').then((m) => m.idbGetAll('cache'));
      const sorted = all.sort((a, b) => a.createdAt - b.createdAt);
      const { idbDelete } = await import('../shared/idb');
      for (const record of sorted.slice(0, Math.floor(sorted.length / 2))) {
        await idbDelete('cache', record.key);
      }
    }
  }
}
