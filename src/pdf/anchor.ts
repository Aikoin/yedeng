/** 纯函数：选区 → 归一化矩形、矩形合并、引文回找。 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageBoxes {
  pageIndex: number;
  rects: NormRect[];
}

/** 把若干 client 矩形换算成相对页面容器的归一化矩形（0..1），跨页时按页拆分 */
export function normalizeBoxes(
  boxes: Box[],
  pageRects: { pageIndex: number; box: Box }[]
): PageBoxes[] {
  const byPage = new Map<number, NormRect[]>();
  for (const rect of boxes) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    for (const page of pageRects) {
      const overlapX = Math.max(
        0,
        Math.min(rect.left + rect.width, page.box.left + page.box.width) - Math.max(rect.left, page.box.left)
      );
      const overlapY = Math.max(
        0,
        Math.min(rect.top + rect.height, page.box.top + page.box.height) - Math.max(rect.top, page.box.top)
      );
      if (overlapX <= 0 || overlapY <= 0) continue;
      const x = (Math.max(rect.left, page.box.left) - page.box.left) / page.box.width;
      const y = (Math.max(rect.top, page.box.top) - page.box.top) / page.box.height;
      const w = overlapX / page.box.width;
      const h = overlapY / page.box.height;
      const list = byPage.get(page.pageIndex) ?? [];
      list.push({
        x: clamp01(x),
        y: clamp01(y),
        w: clamp01(w),
        h: clamp01(h),
      });
      byPage.set(page.pageIndex, list);
    }
  }
  return Array.from(byPage.entries())
    .map(([pageIndex, rects]) => ({ pageIndex, rects: mergeRects(rects) }))
    .filter((p) => p.rects.length > 0);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 合并同一行内相邻/重叠的矩形，避免每个字一个方块 */
export function mergeRects(rects: NormRect[], tol = 0.004): NormRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: NormRect[] = [];
  for (const rect of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      Math.abs(last.y - rect.y) <= Math.max(last.h, rect.h) * 0.5 &&
      rect.x <= last.x + last.w + tol
    ) {
      const right = Math.max(last.x + last.w, rect.x + rect.w);
      const bottom = Math.max(last.y + last.h, rect.y + rect.h);
      last.x = Math.min(last.x, rect.x);
      last.y = Math.min(last.y, rect.y);
      last.w = right - last.x;
      last.h = bottom - last.y;
      continue;
    }
    out.push({ ...rect });
  }
  return out;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Only a unique complete quote is a candidate; never fall back to the first repeated prefix. */
export function findQuotePage(pages: { pageIndex: number; text: string }[], quote: string): number | null {
  const needle = normalizeText(quote);
  if (needle.length < 4) return null;
  let candidate: number | null = null;
  for (const page of pages) {
    const text = normalizeText(page.text);
    const start = text.indexOf(needle);
    if (start < 0) continue;
    if (candidate !== null || text.indexOf(needle, start + 1) >= 0) return null;
    candidate = page.pageIndex;
  }
  return candidate;
}

/** Preserve available surrounding text, refusing to guess which duplicate occurrence was selected. */
export function quoteContext(text: string, quote: string): { prefix: string; suffix: string } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const needle = quote.replace(/\s+/g, ' ').trim();
  const start = normalized.indexOf(needle);
  if (!needle || start < 0 || normalized.indexOf(needle, start + 1) >= 0) return { prefix: '', suffix: '' };
  return { prefix: normalized.slice(Math.max(0, start - 32), start), suffix: normalized.slice(start + needle.length, start + needle.length + 32) };
}

/**
 * 选中范围扩展成完整句子：向前找句末标点，向后补到句末（含标点）。
 * 用于"解释/翻译"时给模型一个完整句子而不是半截。
 */
export function expandToSentence(fullText: string, start: number, end: number): string {
  const terminators = /[.!?。！？;；]/;
  let s = Math.max(0, Math.min(start, fullText.length));
  let e = Math.max(s, Math.min(end, fullText.length));
  while (s > 0 && !terminators.test(fullText[s - 1])) s--;
  while (e < fullText.length && !terminators.test(fullText[e])) e++;
  if (e < fullText.length) e += 1; // 把句末标点也包含进来
  const sentence = fullText.slice(s, e).trim();
  return sentence.length >= 2 ? sentence : fullText.slice(start, end).trim();
}
