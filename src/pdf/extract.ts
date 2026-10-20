/**
 * 全文档文本抽取 + 章节切分 + 检索分块。
 * 章节优先用 PDF 自带大纲；没有大纲则用标题启发式；再不行按每 3 页切。
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OutlineEntry } from './loader';
import {
  buildLines,
  buildParagraphs,
  isHeadingLine,
  medianLineHeight,
  type RawItem,
  type TextLine,
  type TextParagraph,
} from './textmodel';
import type { Chunk } from './bm25';

export interface PageText {
  pageIndex: number;
  width: number;
  height: number;
  lines: TextLine[];
  paragraphs: TextParagraph[];
  text: string;
}

export interface Section {
  title: string;
  pageIndex: number;
  endPageIndex: number;
  level: number;
  text: string;
}

export interface DocText {
  pages: PageText[];
  sections: Section[];
  documentText: string;
  /** 用于 3 行摘要：摘要+引言（头部） */
  headText: string;
  /** 用于 3 行摘要：结论（尾部） */
  tailText: string;
  hasText: boolean;
}

export async function extractPageText(
  doc: PDFDocumentProxy,
  pageIndex: number
): Promise<PageText> {
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ includeMarkedContent: true });
  const items = (content.items as unknown as RawItem[]).filter((i) => typeof i.str === 'string');
  const lines = buildLines(items, pageIndex);
  const paragraphs = buildParagraphs(lines, pageIndex, viewport.width);
  const text = paragraphs.map((p) => p.text).join('\n');
  // PDFPageProxy is shared with the visible reader. Only the viewer owns cleanup.
  return {
    pageIndex,
    width: viewport.width,
    height: viewport.height,
    lines,
    paragraphs,
    text,
  };
}

export async function extractDocument(
  doc: PDFDocumentProxy,
  outline: OutlineEntry[],
  onProgress?: (done: number, total: number) => void
): Promise<DocText> {
  const pages: PageText[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    pages.push(await extractPageText(doc, i));
    onProgress?.(i + 1, doc.numPages);
  }

  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  const hasText = totalChars > 200;

  const sections = buildSections(pages, outline);
  const documentText = pages
    .map((p) => `【第 ${p.pageIndex + 1} 页】\n${p.text}`)
    .join('\n\n');

  const headText = pages
    .slice(0, Math.min(3, pages.length))
    .map((p) => p.text)
    .join('\n')
    .slice(0, 12000);

  const tailCount = Math.min(3, Math.max(1, Math.floor(pages.length / 6)));
  const tailText = pages
    .slice(Math.max(0, pages.length - tailCount))
    .map((p) => p.text)
    .join('\n')
    .slice(0, 8000);

  return { pages, sections, documentText, headText, tailText, hasText };
}

/** 章节切分：大纲 → 标题启发式 → 每 3 页兜底 */
export function buildSections(pages: PageText[], outline: OutlineEntry[]): Section[] {
  if (outline.length >= 2) return sectionsFromOutline(pages, outline);

  const bodyHeight = medianLineHeight(pages.flatMap((p) => p.lines));
  const headings: OutlineEntry[] = [];
  for (const page of pages) {
    for (const line of page.lines) {
      if (isHeadingLine(line, bodyHeight)) {
        headings.push({ title: line.text.trim(), pageIndex: page.pageIndex, level: 0 });
      }
    }
  }
  if (headings.length >= 2) return sectionsFromOutline(pages, headings);

  // 兜底：每 3 页一节
  const fallback: Section[] = [];
  for (let start = 0; start < pages.length; start += 3) {
    const end = Math.min(pages.length - 1, start + 2);
    fallback.push({
      title: `第 ${start + 1}-${end + 1} 页`,
      pageIndex: start,
      endPageIndex: end,
      level: 0,
      text: pages
        .slice(start, end + 1)
        .map((p) => p.text)
        .join('\n'),
    });
  }
  return fallback;
}

function sectionsFromOutline(pages: PageText[], outline: OutlineEntry[]): Section[] {
  const sorted = [...outline].sort((a, b) => a.pageIndex - b.pageIndex);
  return sorted.map((entry, i) => {
    const next = sorted[i + 1];
    const endPageIndex = next ? Math.max(entry.pageIndex, next.pageIndex) : pages.length - 1;
    const text = pages
      .slice(entry.pageIndex, endPageIndex + 1)
      .map((p) => p.text)
      .join('\n');
    return {
      title: entry.title,
      pageIndex: entry.pageIndex,
      endPageIndex,
      level: entry.level,
      text,
    };
  });
}

/** 全文问答的检索分块：按段落聚合到约 1200 字，带 150 字重叠；超长段落单独切 */
export function buildChunks(docText: DocText, maxLen = 1200, overlap = 150): Chunk[] {
  const chunks: Chunk[] = [];
  const sectionOf = (pageIndex: number): string => {
    let title = '';
    for (const section of docText.sections) {
      if (section.pageIndex <= pageIndex) title = section.title;
      else break;
    }
    return title;
  };

  let buffer = '';
  let bufferPage = 0;
  const flush = () => {
    const text = buffer.trim();
    if (text.length < 40) {
      buffer = '';
      return;
    }
    chunks.push({
      id: `c${chunks.length}`,
      pageIndex: bufferPage,
      sectionTitle: sectionOf(bufferPage),
      text,
    });
    buffer = text.slice(Math.max(0, text.length - overlap));
  };

  for (const page of docText.pages) {
    for (const para of page.paragraphs) {
      const piece = para.text;
      if (piece.length > maxLen) {
        flush();
        for (let i = 0; i < piece.length; i += maxLen - overlap) {
          chunks.push({
            id: `c${chunks.length}`,
            pageIndex: page.pageIndex,
            sectionTitle: sectionOf(page.pageIndex),
            text: piece.slice(i, i + maxLen),
          });
        }
        buffer = '';
        continue;
      }
      if (buffer.length === 0) bufferPage = page.pageIndex;
      if (buffer.length + piece.length > maxLen) flush();
      buffer += (buffer ? '\n' : '') + piece;
    }
  }
  flush();
  return chunks;
}

/** 取某页的纯文本（用于模型上下文） */
export function pageText(docText: DocText, pageIndex: number): string {
  return docText.pages[pageIndex]?.text ?? '';
}
