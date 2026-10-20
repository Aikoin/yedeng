/** PDF user-space is the durable coordinate system. DPR belongs only to rasterization. */
export interface PdfPoint { x: number; y: number }
export type PdfQuad = readonly [PdfPoint, PdfPoint, PdfPoint, PdfPoint];
export interface ViewportGeometry {
  width: number;
  height: number;
  transform: readonly number[];
}
export interface ClientBox { left: number; top: number; width: number; height: number }

function matrix(viewport: ViewportGeometry): readonly number[] {
  const m = viewport.transform;
  if (m.length !== 6 || !m.every(Number.isFinite) || Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) {
    throw new Error('Invalid PDF viewport transform');
  }
  return m;
}
export function pdfToViewport(point: PdfPoint, viewport: ViewportGeometry): PdfPoint {
  const [a, b, c, d, e, f] = matrix(viewport);
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}
export function viewportToPdf(point: PdfPoint, viewport: ViewportGeometry): PdfPoint {
  const [a, b, c, d, e, f] = matrix(viewport);
  const det = a * d - b * c;
  const x = point.x - e;
  const y = point.y - f;
  return { x: (d * x - c * y) / det, y: (-b * x + a * y) / det };
}
/** DOM coordinates are CSS pixels, even when the backing canvas uses DPR 2. */
export function clientRectToPdfQuad(rect: ClientBox, pageBox: ClientBox, viewport: ViewportGeometry): PdfQuad {
  if (pageBox.width <= 0 || pageBox.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    throw new Error('Cannot map an empty page');
  }
  const convert = (x: number, y: number) => viewportToPdf({
    x: (x - pageBox.left) * viewport.width / pageBox.width,
    y: (y - pageBox.top) * viewport.height / pageBox.height,
  }, viewport);
  return [convert(rect.left, rect.top), convert(rect.left + rect.width, rect.top),
    convert(rect.left + rect.width, rect.top + rect.height), convert(rect.left, rect.top + rect.height)];
}
export function pdfQuadToClientRect(quad: PdfQuad, pageBox: ClientBox, viewport: ViewportGeometry): ClientBox {
  if (viewport.width <= 0 || viewport.height <= 0) throw new Error('Cannot map an empty viewport');
  const points = quad.map((point) => {
    const p = pdfToViewport(point, viewport);
    return { x: pageBox.left + p.x * pageBox.width / viewport.width,
      y: pageBox.top + p.y * pageBox.height / viewport.height };
  });
  const left = Math.min(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y));
  return { left, top, width: Math.max(...points.map((p) => p.x)) - left,
    height: Math.max(...points.map((p) => p.y)) - top };
}
