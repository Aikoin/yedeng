import {validatePdfBytes} from './validateBytes';
import { pdfRenderScheduler } from './renderScheduler';
/**
 * pdf.js 加载层：字节获取、文档打开、元信息/大纲解析。
 * 注意 MV3 CSP：不使用 eval；wasm/cmaps/字体全部走本地资源（见 scripts/copy-pdfjs.mjs）。
 */
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import { log } from '../shared/logger';
import { buildLines, type RawItem } from './textmodel';
import { inferDocumentTitle, fallbackDocumentTitle } from './documentTitle';

let workerReady = false;

function ensureWorker(): void {
  if (workerReady) return;
  GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdfjs/pdf.worker.min.mjs');
  workerReady = true;
}

function pdfResources() {
  return {
    cMapUrl: chrome.runtime.getURL('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('pdfjs/standard_fonts/'),
    wasmUrl: chrome.runtime.getURL('pdfjs/wasm/'),
    iccUrl: chrome.runtime.getURL('pdfjs/iccs/'),
  };
}

export interface FetchProgress {
  loaded: number;
  total: number;
}

/**
 * 直连取 PDF 字节。
 * 用扩展页发请求可绕过 CORS（host_permissions），并携带 Cookie（credentials: include）。
 * 但跨站请求不会带上 SameSite=Lax/Strict 的 Cookie，付费墙站点仍可能 403 —— 见 README。
 */
export async function fetchPdfBytes(
  url: string,
  onProgress?: (p: FetchProgress) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    signal,
  });
  if (!res.ok) {
    throw new Error(`下载 PDF 失败：HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!res.body) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.({ loaded, total });
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export interface LoadHandlers {
  onPassword?: (submit: (password: string) => void, wrong: boolean) => void;
  onProgress?: (percent: number) => void;
}

export function loadDocument(bytes: ArrayBuffer, handlers: LoadHandlers = {}): PDFDocumentLoadingTask {
  validatePdfBytes(bytes);
  ensureWorker();
  const task = getDocument({
    data: bytes,
    ...pdfResources(),
    useWasm: true,
    // 关闭字体/函数求值以外的网络兜底，全部使用本地资源
    disableAutoFetch: false,
    disableStream: false,
  });
  if (handlers.onPassword) {
    const cb = handlers.onPassword;
    task.onPassword = (updatePassword: (pw: string) => void, reason: number) => {
      // reason: 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD
      cb(updatePassword, reason === 2);
    };
  }
  if (handlers.onProgress) {
    const cb = handlers.onProgress;
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      cb(total > 0 ? Math.round((loaded / total) * 100) : 0);
    };
  }
  return task;
}

export interface OutlineEntry {
  title: string;
  pageIndex: number;
  level: number;
}

export interface DocInfo {
  title: string;
  authors: string;
  numPages: number;
  outline: OutlineEntry[];
}

async function resolveDestPage(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    let target = dest;
    if (typeof target === 'string') target = await doc.getDestination(target);
    if (!Array.isArray(target) || target.length === 0) return null;
    const ref = target[0];
    if (typeof ref === 'number') return ref;
    if (ref && typeof ref === 'object') return await doc.getPageIndex(ref as never);
    return null;
  } catch (err) {
    log.debug('解析大纲目标失败', err);
    return null;
  }
}

export async function extractOutline(doc: PDFDocumentProxy): Promise<OutlineEntry[]> {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline || outline.length === 0) return [];
  const entries: OutlineEntry[] = [];

  const walk = async (items: typeof outline, level: number): Promise<void> => {
    for (const item of items) {
      const pageIndex = await resolveDestPage(doc, item.dest);
      if (pageIndex !== null) entries.push({ title: item.title.trim(), pageIndex, level });
      if (item.items && item.items.length > 0) await walk(item.items, level + 1);
    }
  };

  await walk(outline, 0);
  return entries.sort((a, b) => a.pageIndex - b.pageIndex);
}

export async function readDocInfo(doc: PDFDocumentProxy, firstPageText: string): Promise<DocInfo> {
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  let title = typeof info.Title === 'string' ? info.Title.trim() : '';
  const authors = typeof info.Author === 'string' ? info.Author.trim() : '';

  if (!title || title.length < 3 || /^untitled/i.test(title)) {
    try {
      const page = await doc.getPage(1);
      const content = await page.getTextContent();
      const items = content.items.filter((item) => 'str' in item) as unknown as RawItem[];
      const lines = buildLines(items, 0);
      const box = page.view;
      // Do not cleanup the shared page proxy while the reader may be rendering it.
      title = inferDocumentTitle(lines, box[3] - box[1]) ?? fallbackDocumentTitle(firstPageText);
    } catch {
      title = fallbackDocumentTitle(firstPageText);
    }
  }

  return {
    title,
    authors,
    numPages: doc.numPages,
    outline: await extractOutline(doc),
  };
}

/** 渲染缩略图（首页小图，用于文献库卡片） */
export async function renderThumbnail(doc: PDFDocumentProxy, pageNumber = 1, targetWidth = 240): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const release = await pdfRenderScheduler.acquire(page);
  try {
  const base = page.getViewport({ scale: 1 });
  const scale = targetWidth / base.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/jpeg', 0.7);
  } finally { release(); }
}
