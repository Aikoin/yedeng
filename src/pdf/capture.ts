import { pdfRenderScheduler } from './renderScheduler';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfToViewport, type PdfQuad, type ViewportGeometry } from './geometry';

export function captureBounds(viewport: ViewportGeometry, quad: PdfQuad): {left:number;top:number;width:number;height:number} {
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 || quad.length !== 4 || quad.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('裁图页面或坐标无效');
  const points = quad.map(p => pdfToViewport(p, viewport));
  const left = Math.max(0, Math.floor(Math.min(...points.map(p => p.x))));
  const top = Math.max(0, Math.floor(Math.min(...points.map(p => p.y))));
  const right = Math.min(Math.ceil(viewport.width), Math.ceil(Math.max(...points.map(p => p.x))));
  const bottom = Math.min(Math.ceil(viewport.height), Math.ceil(Math.max(...points.map(p => p.y))));
  const width = right - left, height = bottom - top;
  if (width < 4 || height < 4) throw new Error('框选区域过小或超出页面');
  if (width * height > 4_000_000 || Math.max(width, height) > 2400) throw new Error('裁图超过4MP或最长边2400px，请缩小区域或分片');
  return {left,top,width,height};
}

export async function capturePdfRegion(doc: PDFDocumentProxy, pageIndex: number, quad: PdfQuad): Promise<{ image: string; width: number; height: number }> {
  const page = await doc.getPage(pageIndex + 1);
  const release = await pdfRenderScheduler.acquire(page);
  try {
  const base = page.getViewport({ scale: 2 });
  const {left,top,width,height} = captureBounds(base,quad);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('无法创建裁图画布');
  await page.render({ canvas, canvasContext: ctx, viewport: base, transform: [1, 0, 0, 1, -left, -top], background: '#fff' }).promise;
  return { image: canvas.toDataURL('image/png'), width, height };
  } finally { release(); }
}
