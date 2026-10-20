/** 阅读器的全局状态与共享工具（各 UI 模块都从这里取数据，避免循环依赖）。 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildIndex, search, type Bm25Index, type Chunk } from '../pdf/bm25';
import type { DocText, Section } from '../pdf/extract';
import type { DocInfo } from '../pdf/loader';
import type { PdfViewer } from '../pdf/renderer';
import type { AnnotationRecord } from '../shared/idb';
import { type Settings } from '../shared/settings';
import { toast } from '../shared/toast';
import type { PaperContext } from '../ai/prompts';

export interface ViewerState {
  settings: Settings;
  srcUrl: string;
  docId: string;
  info: DocInfo;
  doc: PDFDocumentProxy | null;
  viewer: PdfViewer | null;
  docText: DocText | null;
  chunks: Chunk[];
  index: Bm25Index | null;
  annotations: AnnotationRecord[];
  lastColor: 1 | 2 | 3;
  selection: { text: string; pageIndex: number } | null;
}

export const state: ViewerState = {
  settings: {} as Settings,
  srcUrl: '',
  docId: '',
  info: { title: '未命名论文', authors: '', numPages: 0, outline: [] },
  doc: null,
  viewer: null,
  docText: null,
  chunks: [],
  index: null,
  annotations: [],
  lastColor: 1,
  selection: null,
};

export function currentPageIndex(): number {
  return state.viewer?.currentPageIndex() ?? 0;
}

export function sectionAt(pageIndex: number): Section | null {
  if (!state.docText) return null;
  let found: Section | null = null;
  for (const section of state.docText.sections) {
    if (section.pageIndex <= pageIndex) found = section;
    else break;
  }
  return found;
}

export function sectionTitleAt(pageIndex: number): string {
  return sectionAt(pageIndex)?.title ?? '';
}

/** 在指定页里按文本片段找段落（选区/光标用） */
export function findParagraph(pageIndex: number, snippet: string): { index: number; text: string } | null {
  const page = state.docText?.pages[pageIndex];
  if (!page) return null;
  const needle = snippet.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (needle.length < 3) return null;
  const found = page.paragraphs.findIndex((p) => p.text.replace(/\s+/g, ' ').includes(needle));
  if (found < 0) return null;
  return { index: found, text: page.paragraphs[found].text };
}

/** 构造模型需要的论文上下文 */
export function paperContext(pageIndex: number, selectedText?: string): PaperContext {
  const ctx: PaperContext = {
    title: state.info.title,
    authors: state.info.authors || undefined,
    sectionTitle: sectionTitleAt(pageIndex) || undefined,
    pageNumber: pageIndex + 1,
  };
  const page = state.docText?.pages[pageIndex];
  if (!page) return ctx;
  if (selectedText) {
    const para = findParagraph(pageIndex, selectedText);
    if (para) {
      ctx.paragraph = para.text;
      const before = page.paragraphs[para.index - 1]?.text;
      const after = page.paragraphs[para.index + 1]?.text;
      ctx.surroundings = [before, after].filter(Boolean).join('\n').slice(0, 1200) || undefined;
    }
  } else {
    ctx.paragraph = page.paragraphs[0]?.text;
  }
  return ctx;
}

/** 用于对话：检索相关片段（BM25 top-k），并补上标题/摘要 */
export function retrieve(question: string, k = 6): Chunk[] {
  if (!state.index || state.chunks.length === 0) {
    return state.chunks.slice(0, k);
  }
  const hits = search(state.index, question, k).map((s) => s.chunk);
  if (hits.length >= 2) return hits;
  // 检索不到时给开头几段兜底
  const fallback = state.chunks.slice(0, k - hits.length);
  return [...hits, ...fallback].slice(0, k);
}

export function rebuildIndex(): void {
  if (!state.docText) return;
  state.index = buildIndex(state.chunks);
}

/** 未配置 API 时统一引导 */
export function requireConfigured(): boolean {
  toast('请从选中文字或图表进入材料准备区，核对后再发送。', 'info', 2800);
  return false;
}

/** 页码引用点击跳转 */
export function jumpToPage(pageIndex: number): void {
  state.viewer?.scrollToPage(pageIndex, true);
}
