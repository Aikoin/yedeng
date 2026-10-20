import { describe, expect, it } from 'vitest';
import { clientRectToPdfQuad, pdfQuadToClientRect, pdfToViewport, viewportToPdf } from '../src/pdf/geometry';

// Canonical PDF.js viewport transforms for CropBox [20,30,620,830].
// These expected mappings independently check Y inversion, rotation and crop offset.
function viewport(rotation: number, scale: number) {
  const transforms: Record<number, number[]> = {
    0: [1, 0, 0, -1, -20, 830],
    90: [0, 1, 1, 0, -30, -20],
    180: [-1, 0, 0, 1, 620, -30],
    270: [0, -1, -1, 0, 830, 620],
  };
  return { width: (rotation % 180 ? 800 : 600) * scale,
    height: (rotation % 180 ? 600 : 800) * scale,
    transform: transforms[rotation].map((n) => n * scale) };
}
describe('PDF durable geometry', () => {
  for (const rotation of [0, 90, 180, 270]) {
    for (const scale of [0.5, 1, 2, 4]) {
      it(`preserves CropBox and quad at ${rotation} degrees and scale ${scale}`, () => {
        const v = viewport(rotation, scale);
        const pdfPoint = { x: 120, y: 230 };
        const expected: Record<number, number[]> = { 0: [100, 600], 90: [200, 100], 180: [500, 200], 270: [600, 500] };
        const css = pdfToViewport(pdfPoint, v);
        expect(css.x).toBeCloseTo(expected[rotation][0] * scale, 10);
        expect(css.y).toBeCloseTo(expected[rotation][1] * scale, 10);
        expect(viewportToPdf(css, v)).toEqual(pdfPoint);
        // DOM offset + additional CSS scaling; device pixel ratio deliberately absent.
        const box = { left: 137, top: -245, width: v.width * 0.8, height: v.height * 0.8 };
        const selected = { left: box.left + 20, top: box.top + 40, width: 100, height: 60 };
        const quad = clientRectToPdfQuad(selected, box, v);
        const restored = pdfQuadToClientRect(quad, box, v);
        for (const key of ['left', 'top', 'width', 'height'] as const) expect(restored[key]).toBeCloseTo(selected[key], 9);
        // Persist once, project into a different zoom/scroll position.
        const v2 = viewport(rotation, scale * 2);
        const box2 = { left: 30, top: 70, width: box.width * 2, height: box.height * 2 };
        const target = pdfQuadToClientRect(quad, box2, v2);
        expect(target.left).toBeCloseTo(70, 9);
        expect(target.top).toBeCloseTo(150, 9);
        expect(target.width).toBeCloseTo(200, 9);
      });
    }
  }
  it('rejects singular matrices and zero-sized pages instead of saving corrupt anchors', () => {
    expect(() => viewportToPdf({ x: 0, y: 0 }, { width: 1, height: 1, transform: [0, 0, 0, 0, 0, 0] })).toThrow();
    expect(() => clientRectToPdfQuad({ left: 0, top: 0, width: 2, height: 2 }, { left: 0, top: 0, width: 0, height: 1 }, viewport(0, 1))).toThrow();
  });
});
