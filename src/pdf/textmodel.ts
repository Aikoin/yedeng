/**
 * 纯函数：把 pdf.js 的文字项重建成「行 → 段落」。
 * 坐标系为 PDF 用户空间（y 向上），不依赖 DOM，便于单测。
 */

export interface RawItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
  fontName?: string;
}

export interface TextLine {
  pageIndex: number;
  text: string;
  /** 左边界 */
  x: number;
  /** 右边界 */
  xEnd: number;
  /** 基线 y（PDF 坐标，向上为正） */
  y: number;
  /** 行高（字号近似） */
  h: number;
}

export interface TextParagraph {
  pageIndex: number;
  text: string;
  x: number;
  xEnd: number;
  /** 段落顶部（PDF 坐标） */
  yTop: number;
  /** 段落底部（PDF 坐标） */
  yBottom: number;
  lines: TextLine[];
}

function itemX(item: RawItem): number {
  return item.transform[4] ?? 0;
}

function itemY(item: RawItem): number {
  return item.transform[5] ?? 0;
}

function itemH(item: RawItem): number {
  const h = item.height || Math.abs(item.transform[3] ?? 0) || 10;
  return h > 0 ? h : 10;
}

/** 把文字项按基线聚成行（同一行内按 x 递增拼接，按空隙补空格） */
export function buildLines(items: RawItem[], pageIndex = 0): TextLine[] {
  const lines: TextLine[] = [];
  let current: TextLine | null = null;

  for (const item of items) {
    if (item.str === undefined || item.str === null) continue;
    const x = itemX(item);
    const y = itemY(item);
    const h = itemH(item);
    const w = item.width ?? 0;

    const canAppend =
      current !== null &&
      Math.abs(y - current.y) <= Math.max(1.5, 0.4 * h) &&
      x >= current.xEnd - 1.5;

    if (canAppend && current) {
      const gap = x - current.xEnd;
      const needSpace = gap > 0.22 * h && !/\s$/.test(current.text) && !/^\s/.test(item.str);
      current.text += (needSpace ? ' ' : '') + item.str;
      current.xEnd = Math.max(current.xEnd, x + w);
      current.h = Math.max(current.h, h);
    } else {
      current = {
        pageIndex,
        text: item.str,
        x,
        xEnd: x + w,
        y,
        h,
      };
      lines.push(current);
    }

    if (item.hasEOL) current = null;
  }

  return lines.filter((l) => l.text.trim().length > 0);
}

export function medianLineHeight(lines: TextLine[]): number {
  if (lines.length === 0) return 10;
  const heights = lines.map((l) => l.h).sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)] || 10;
}

/**
 * 分列：论文常见单栏/双栏。按行左边界聚类，相邻列起点差超过页宽 15% 视为新列。
 * 返回按阅读顺序（列从左到右，列内从上到下）排好的行。
 */
export function orderLines(lines: TextLine[], pageWidth: number): TextLine[][] {
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => a.x - b.x);
  const columns: TextLine[][] = [];
  let bucket: TextLine[] = [];
  let anchorX = sorted[0].x;
  for (const line of sorted) {
    if (bucket.length > 0 && line.x - anchorX > 0.15 * pageWidth) {
      columns.push(bucket);
      bucket = [];
      anchorX = line.x;
    }
    bucket.push(line);
    anchorX = Math.min(anchorX, line.x);
  }
  if (bucket.length > 0) columns.push(bucket);

  // 太碎的"列"（少于 3 行）合并回前一列，避免图表说明被误判成列
  const merged: TextLine[][] = [];
  for (const col of columns) {
    if (col.length < 3 && merged.length > 0) merged[merged.length - 1].push(...col);
    else merged.push(col);
  }

  return merged.map((col) => col.sort((a, b) => b.y - a.y));
}

/** 行 → 段落：同列内垂直间距接近行高则合并 */
export function buildParagraphs(
  lines: TextLine[],
  pageIndex = 0,
  pageWidth = 612
): TextParagraph[] {
  const columns = orderLines(lines, pageWidth);
  const paragraphs: TextParagraph[] = [];

  for (const column of columns) {
    const mh = medianLineHeight(column);
    let current: TextParagraph | null = null;
    for (const line of column) {
      if (current) {
        const prev = current.lines[current.lines.length - 1];
        const gap = prev.y - line.y;
        const indentJump = Math.abs(line.x - prev.x) > 1.2 * mh;
        const startsNewBlock = /^\s*(\d+(\.\d+)*\.?|[-•*·])\s+\S/.test(line.text);
        const sameBlock = gap < 2.0 * mh && !(indentJump && gap > 1.1 * mh) && !startsNewBlock;
        if (sameBlock) {
          current.text += ` ${line.text}`;
          current.x = Math.min(current.x, line.x);
          current.xEnd = Math.max(current.xEnd, line.xEnd);
          current.yBottom = Math.min(current.yBottom, line.y);
          current.lines.push(line);
          continue;
        }
      }
      current = {
        pageIndex,
        text: line.text,
        x: line.x,
        xEnd: line.xEnd,
        yTop: line.y,
        yBottom: line.y,
        lines: [line],
      };
      paragraphs.push(current);
    }
  }

  return paragraphs
    .map((p) => ({ ...p, text: p.text.replace(/\s+/g, ' ').trim() }))
    .filter((p) => p.text.length > 0);
}

/** 判断某行是否像章节标题（用于没有 PDF 大纲时的兜底切分） */
export function isHeadingLine(line: TextLine, bodyHeight: number): boolean {
  const text = line.text.trim();
  if (text.length === 0 || text.length > 90) return false;
  if (/^(abstract|introduction|related work|background|method|methods|approach|experiments?|results?|discussion|conclusion|conclusions|references|acknowledg)/i.test(text)) {
    return true;
  }
  if (/^(\d+(\.\d+)*|[IVXLC]+)\.?\s+[A-Z]/.test(text) && line.h >= bodyHeight * 0.98) return true;
  return line.h >= bodyHeight * 1.15 && !/[.,;]$/.test(text);
}
