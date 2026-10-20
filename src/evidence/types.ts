import type { PdfQuad } from '../pdf/geometry';
export interface EvidenceAttachment {
  id: string; docId: string; kind: 'text' | 'image'; label: string; pageIndices: number[];
  text?: string; image?: string;
  sourceQuads?: { pageIndex: number; quads: PdfQuad[] }[];
  assetId?: string; assetVersion?: number;
}
export function immutableEvidence(items: readonly EvidenceAttachment[]): readonly EvidenceAttachment[] {
  const copy = structuredClone(items);
  const freeze = (value: unknown): void => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(copy); return copy;
}
export function reorderEvidence<T>(items: readonly T[], from: number, to: number): T[] {
  if (![from, to].every(index => Number.isInteger(index) && index >= 0 && index < items.length)) throw new Error('无效的证据顺序');
  const result = [...items]; const [item] = result.splice(from, 1); result.splice(to, 0, item); return result;
}
