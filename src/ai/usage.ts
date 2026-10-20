/** 用量统计与每日上限：把"烧钱"这件事变得可见可控。 */
import { idbGet, idbPut, type UsageRecord } from '../shared/idb';
import type { Settings } from '../shared/settings';
import type { TokenUsage } from './types';
import { AiError } from './types';

export function todayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 粗估 token：中英混排约 3.2 字符/token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}

export async function getUsage(date = todayKey()): Promise<UsageRecord> {
  return (await idbGet('usage', date)) ?? { date, requests: 0, promptTokens: 0, completionTokens: 0 };
}

export async function bumpUsage(promptChars: number, completionChars: number, usage?: TokenUsage): Promise<void> {
  const date = todayKey();
  const record = await getUsage(date);
  record.requests += 1;
  record.promptTokens += usage?.promptTokens ?? Math.ceil(promptChars / 3.2);
  record.completionTokens += usage?.completionTokens ?? Math.ceil(completionChars / 3.2);
  await idbPut('usage', record);
}

/** 每次请求前调用；超限直接抛错，避免用户无感知烧钱 */
export async function assertWithinLimit(settings: Settings): Promise<void> {
  const limit = settings.limits.requestsPerDay;
  if (!limit || limit <= 0) return;
  const record = await getUsage();
  if (record.requests >= limit) {
    throw new AiError(`已达今日请求上限（${limit} 次），可在设置页调整或明天再用`, {
      hint: '设置 → 数据 → 每日请求上限',
    });
  }
}
