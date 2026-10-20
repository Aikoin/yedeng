/** Local extractive context selection. No summarizing model, embedding upload, or full-paper fallback. */
import type { PageText } from '../pdf/extract';
import type { PdfQuad } from '../pdf/geometry';
export interface ContextRegion { pageIndex: number; quads: readonly PdfQuad[] }
export interface SelectionContextInput {
  selectedText: string;
  regions: readonly ContextRegion[];
  pages: readonly PageText[];
  title?: string;
  sectionTitle?: string;
  /** Hard budget for optional context only. The user's selection is never silently cut. */
  maxContextChars?: number;
}
export interface ContextExcerpt { id: string; pageIndex: number; kind: 'paragraph' | 'neighbor'; text: string }
export interface CompressedSelectionContext {
  selection: string;
  title: string;
  sectionTitle: string;
  excerpts: ContextExcerpt[];
  notes: string[];
  contextChars: number;
  strategy: 'local-extractive-v1';
}
const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim();
function intersects(quad: PdfQuad, paragraph: PageText['paragraphs'][number]): boolean {
  const x = quad.map(p => p.x), y = quad.map(p => p.y);
  const left = Math.max(Math.min(...x), paragraph.x), right = Math.min(Math.max(...x), paragraph.xEnd);
  const bottom = Math.max(Math.min(...y), paragraph.yBottom), top = Math.min(Math.max(...y), paragraph.yTop);
  return right > left && top > bottom;
}
export function compressSelectionContext(input: SelectionContextInput): CompressedSelectionContext {
  if (!input.selectedText.trim()) throw new Error('请先选择要解释的文字');
  if (input.selectedText.length > 16000) throw new Error('选中文字超过16000字符，请缩小选区；不会自动截断原文');
  const budget = input.maxContextChars ?? 3600;
  if (!Number.isInteger(budget) || budget < 0 || budget > 12000) throw new Error('无效上下文预算');
  const result: CompressedSelectionContext = { selection: input.selectedText, title: (input.title ?? '').slice(0,300),
    sectionTitle: (input.sectionTitle ?? '').slice(0,200), excerpts: [], notes: [], contextChars: 0, strategy: 'local-extractive-v1' };
  const selected = normalized(input.selectedText), pageIndexes = [...new Set(input.regions.map(r => r.pageIndex))];
  const candidates: ContextExcerpt[] = [];
  for (const pageIndex of pageIndexes) {
    const page = input.pages.find(p => p.pageIndex === pageIndex);
    if (!page) { result.notes.push(`PDF ${pageIndex+1} 文字尚未提取，未自动补充上下文`); continue; }
    const quads = input.regions.filter(r => r.pageIndex === pageIndex).flatMap(r => [...r.quads]);
    let indexes = page.paragraphs.map((p,i) => ({p,i})).filter(({p}) => quads.some(q => intersects(q,p))).map(({i}) => i);
    if (!indexes.length) {
      // Text-only fallback is safe only when the complete selection has one unique match.
      const matches = page.paragraphs.map((p,i) => ({p,i})).filter(({p}) => normalized(p.text).includes(selected));
      if (matches.length === 1) indexes = [matches[0].i];
      else { result.notes.push(`PDF ${pageIndex+1} 段落位置${matches.length > 1 ? '有歧义' : '未确定'}，未猜测上下文`); continue; }
    }
    const own = [...new Set(indexes)].sort((a,b) => a-b);
    for (const i of own) candidates.push({ id:`p${pageIndex}:${i}`, pageIndex, kind:'paragraph', text:page.paragraphs[i].text });
    for (const i of [...new Set([own[0]-1,own[own.length-1]+1])]) {
      if (i >= 0 && i < page.paragraphs.length && !own.includes(i)) candidates.push({ id:`p${pageIndex}:${i}`, pageIndex, kind:'neighbor', text:page.paragraphs[i].text });
    }
  }
  const seen = new Set<string>([selected]);
  // Prioritize all selected paragraphs across pages before neighboring paragraphs.
  candidates.sort((a,b) => Number(a.kind==='neighbor')-Number(b.kind==='neighbor'));
  let omitted = 0;
  for (const candidate of candidates) {
    const text = normalized(candidate.text);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    if (result.contextChars + candidate.text.length > budget) { omitted++; continue; }
    result.excerpts.push(candidate); result.contextChars += candidate.text.length;
  }
  if (omitted) result.notes.push(`${omitted} 段上下文因${budget}字符预算未附加；未裁断段落或公式，可手动补证据`);
  if (!result.excerpts.length) result.notes.push('本次只使用选中文字与手动附件；条件不足时应补证据');
  return result;
}
/** This text is visible in the preparation panel and is exactly what may enter the snapshot. */
export function formatSelectionContext(result: CompressedSelectionContext): string {
  return [result.title ? `论文：${result.title}` : '', result.sectionTitle ? `章节：${result.sectionTitle}` : '',
    ...result.excerpts.map(e => `[${e.kind==='paragraph'?'选区所在段':'相邻段'} · PDF ${e.pageIndex+1} · ${e.id}]\n${e.text}`),
    ...result.notes.map(n => `[材料范围] ${n}`)].filter(Boolean).join('\n\n');
}
