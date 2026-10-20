import type { Box, PageBoxes } from './anchor';
import type { PdfQuad } from './geometry';

/** Structural traversal also handles Text and SVG descendants, without realm-specific instanceof. */
export function pageIndexFromNode(node: Node | null): number {
  for (let current = node; current; current = current.parentNode) {
    if (current.nodeType !== 1) continue;
    const value = (current as Element).getAttribute('data-page');
    if (value === null || value.trim() === '') continue;
    const page = Number(value);
    if (Number.isInteger(page) && page >= 0) return page;
  }
  return -1;
}
export interface SelectionSnapshot {
  docId?: string;
  text: string;
  pageIndex: number;
  pageBoxes: PageBoxes[];
  firstRect: Box;
  /** Page-local PDF user-space geometry, ready for v2 anchoring; legacy rects remain compatible. */
  pdfRegions?: { pageIndex: number; quads: PdfQuad[] }[];
}
/** Copy before freezing: caller-owned live selection/geometry must never become request state. */
export function snapshotSelection(value: SelectionSnapshot): SelectionSnapshot {
  const pageBoxes = value.pageBoxes.map((page) => Object.freeze({
    pageIndex: page.pageIndex,
    rects: Object.freeze(page.rects.map((rect) => Object.freeze({ ...rect }))),
  }));
  const pdfRegions = value.pdfRegions?.map((region) => Object.freeze({
    pageIndex: region.pageIndex,
    quads: Object.freeze(region.quads.map((quad) => Object.freeze(quad.map((point) => Object.freeze({ ...point }))))),
  }));
  return Object.freeze({ ...value, pdfRegions: pdfRegions ? Object.freeze(pdfRegions) : undefined, firstRect: Object.freeze({ ...value.firstRect }),
    pageBoxes: Object.freeze(pageBoxes) }) as unknown as SelectionSnapshot;
}

/** Viewer identity is the session token: reopening identical bytes still creates a new viewer. */
export interface SelectionSession {
  docId: string;
  viewer: object | null;
}
export function selectionSessionMatches(saved: SelectionSession | null, current: SelectionSession): boolean {
  return !!saved && !!saved.docId && !!saved.viewer && saved.docId === current.docId && saved.viewer === current.viewer;
}

/** Range.getClientRects() may include selected Element ancestor boxes (entire PDF pages).
 * Measure only clipped Text-node subranges in PDF.js text layers, never element ranges.
 */
export function selectedTextRects(range: Range, root: Element): Box[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const rects: Box[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data.trim() || !text.parentElement?.closest('.textLayer')
      || text.parentElement.closest('.endOfContent, [role="img"]') || !range.intersectsNode(text)) continue;
    const start = text === range.startContainer ? range.startOffset : 0;
    const end = text === range.endContainer ? range.endOffset : text.length;
    if (start >= end) continue;
    const piece = doc.createRange();
    piece.setStart(text, start); piece.setEnd(text, end);
    for (const rect of Array.from(piece.getClientRects())) {
      if (rect.width > 0 && rect.height > 0) rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
  }
  return rects;
}
