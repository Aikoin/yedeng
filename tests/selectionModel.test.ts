import { describe, expect, it } from 'vitest';
import { pageIndexFromNode, snapshotSelection } from '../src/pdf/selectionModel';
function node(type: number, parent: Node | null, page: string | null = null): Node {
  return { nodeType: type, parentNode: parent, getAttribute: () => page } as unknown as Node;
}
describe('selection model', () => {
  it('walks Text → span → PDF page instead of requiring an Element start', () => {
    const page = node(1, null, '2');
    expect(pageIndexFromNode(node(3, node(1, page)))).toBe(2);
    expect(pageIndexFromNode(page)).toBe(2);
    expect(pageIndexFromNode(node(3, null))).toBe(-1);
  });
  it('rejects empty, fractional and malformed page attributes', () => {
    for (const value of ['', 'bad', '-1', '1.5']) expect(pageIndexFromNode(node(1, null, value))).toBe(-1);
  });
  it('deep copies and freezes cross-page geometry before toolbar interaction', () => {
    const input = { text: 'definition', pageIndex: 0, pageBoxes: [
      { pageIndex: 0, rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.1 }] },
      { pageIndex: 1, rects: [{ x: 0.2, y: 0.1, w: 0.2, h: 0.1 }] },
    ], firstRect: { left: 10, top: 20, width: 30, height: 5 } };
    const saved = snapshotSelection(input);
    input.text = 'another task';
    input.pageBoxes[0].rects[0].x = 0.9;
    expect(saved.text).toBe('definition');
    expect(saved.pageBoxes[0].rects[0].x).toBe(0.1);
    expect(saved.pageBoxes).toHaveLength(2);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.pageBoxes[0].rects[0])).toBe(true);
  });
  it('detaches PDF quads from the selection source', () => {
    const point = { x: 20, y: 30 };
    const quad: import('../src/pdf/geometry').PdfQuad = [point, { x: 40, y: 30 }, { x: 40, y: 50 }, { x: 20, y: 50 }];
    const saved = snapshotSelection({ text: 'x', pageIndex: 0, pageBoxes: [],
      firstRect: { left: 0, top: 0, width: 1, height: 1 }, pdfRegions: [{ pageIndex: 0, quads: [quad] }] });
    point.x = 999;
    expect(saved.pdfRegions?.[0].quads[0][0].x).toBe(20);
    expect(Object.isFrozen(saved.pdfRegions?.[0].quads[0][0])).toBe(true);
  });

});

describe('selection session binding', () => {
  it('keeps a viewer session but rejects another document or reopening the same bytes', async () => {
    const { selectionSessionMatches } = await import('../src/pdf/selectionModel');
    const viewer = {}, saved = { docId: 'paper-a', viewer };
    expect(selectionSessionMatches(saved, { docId: 'paper-a', viewer })).toBe(true);
    expect(selectionSessionMatches(saved, { docId: 'paper-b', viewer })).toBe(false);
    expect(selectionSessionMatches(saved, { docId: 'paper-a', viewer: {} })).toBe(false);
    expect(selectionSessionMatches(saved, { docId: 'paper-a', viewer: null })).toBe(false);
    expect(selectionSessionMatches(null, { docId: 'paper-a', viewer })).toBe(false);
  });
});

describe('text-only selection geometry', () => {
  it('clips each text node, ignores page/ancestor boxes and excludes non-text-layer content', async () => {
    const { selectedTextRects } = await import('../src/pdf/selectionModel');
    const makeText = (data: string, top: number, inside = true) => ({ data, length: data.length, top,
      parentElement: { closest: (selector: string) => selector === '.textLayer' && inside ? {} : null } });
    const first = makeText('0123456789', 100), second = makeText('abcdefghij', 900);
    const outside = makeText('note pin text', 300, false), empty = makeText('   ', 400);
    const nodes = [first, outside, empty, second]; let cursor = 0;
    const root = { ownerDocument: { createTreeWalker: () => ({ nextNode: () => nodes[cursor++] ?? null }),
      createRange: () => { let selected: typeof first, start = 0, end = 0; return {
        setStart: (node: typeof first, offset: number) => { selected = node; start = offset; },
        setEnd: (_node: typeof first, offset: number) => { end = offset; },
        getClientRects: () => [{ left: 20 + start * 10, top: selected.top, width: (end - start) * 10, height: 12 }],
      }; },
    } } as unknown as Element;
    const range = { startContainer: first, startOffset: 3, endContainer: second, endOffset: 4,
      intersectsNode: () => true,
      getClientRects: () => { throw new Error('Must not measure ancestor/page boxes'); },
    } as unknown as Range;
    expect(selectedTextRects(range, root)).toEqual([
      { left: 50, top: 100, width: 70, height: 12 }, { left: 20, top: 900, width: 40, height: 12 },
    ]);
  });
});
