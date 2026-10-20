import type { TextLine } from './textmodel';

function titleCandidate(text: string): boolean {
  const value = text.trim();
  return value.length >= 8 && value.length <= 220 && /[\p{L}]/u.test(value)
    && !/@|https?:|www\.|arxiv:|doi:|^abstract\b|^preprint\b|^references\b|^\d+(?:\.\d+)*\s/u.test(value.toLowerCase())
    && !/university|institute of|department of|@|copyright|all rights reserved/i.test(value);
}
/** Font size and upper-page position, rather than text extraction reading order. */
export function inferDocumentTitle(lines: TextLine[], pageHeight: number): string | null {
  const candidates = lines.filter((line) => titleCandidate(line.text) && line.y >= pageHeight * 0.35 && line.y <= pageHeight * 0.98);
  if (!candidates.length) return null;
  const lead = [...candidates].sort((a, b) => b.h - a.h || b.y - a.y)[0];
  const sameGroup = candidates.filter((line) => Math.abs(line.h - lead.h) <= Math.max(0.6, lead.h * 0.08)
    && Math.abs(line.y - lead.y) <= lead.h * 3.2)
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const title = sameGroup.map((line) => line.text.trim()).join(' ').replace(/\s+/g, ' ');
  return title.length <= 280 ? title : lead.text.trim();
}
export function fallbackDocumentTitle(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(titleCandidate) ?? '未命名论文';
}
