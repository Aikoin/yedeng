import { describe, expect, it } from 'vitest';
import { expandToSentence, findQuotePage, mergeRects, normalizeBoxes, normalizeText } from '../src/pdf/anchor';

describe('mergeRects', () => {
  it('同一行相邻矩形合并成一个', () => {
    const merged = mergeRects([
      { x: 0.1, y: 0.2, w: 0.1, h: 0.02 },
      { x: 0.2, y: 0.2, w: 0.1, h: 0.02 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].w).toBeCloseTo(0.2, 5);
  });

  it('不同行不合并', () => {
    const merged = mergeRects([
      { x: 0.1, y: 0.2, w: 0.1, h: 0.02 },
      { x: 0.1, y: 0.3, w: 0.1, h: 0.02 },
    ]);
    expect(merged).toHaveLength(2);
  });
});

describe('normalizeBoxes', () => {
  const pages = [
    { pageIndex: 0, box: { left: 100, top: 100, width: 600, height: 800 } },
    { pageIndex: 1, box: { left: 100, top: 950, width: 600, height: 800 } },
  ];

  it('把 client 矩形换算成页面内归一化坐标', () => {
    const result = normalizeBoxes([{ left: 250, top: 300, width: 300, height: 20 }], pages);
    expect(result).toHaveLength(1);
    expect(result[0].pageIndex).toBe(0);
    expect(result[0].rects[0].x).toBeCloseTo(0.25, 3);
    expect(result[0].rects[0].y).toBeCloseTo(0.25, 3);
    expect(result[0].rects[0].w).toBeCloseTo(0.5, 3);
  });

  it('跨页选择会按页拆开', () => {
    const result = normalizeBoxes([{ left: 200, top: 800, width: 200, height: 400 }], pages);
    const pageIndexes = result.map((r) => r.pageIndex).sort();
    expect(pageIndexes).toEqual([0, 1]);
  });

  it('完全落在页面外的矩形被丢弃', () => {
    expect(normalizeBoxes([{ left: 0, top: 0, width: 10, height: 10 }], pages)).toHaveLength(0);
  });
});

describe('findQuotePage', () => {
  const pages = [
    { pageIndex: 0, text: 'Abstract  We propose a new method.' },
    { pageIndex: 1, text: 'Experiments show 28.4 BLEU on WMT 2014.' },
  ];

  it('按引文定位页码', () => {
    expect(findQuotePage(pages, '28.4 BLEU')).toBe(1);
  });

  it('忽略空白差异', () => {
    expect(findQuotePage(pages, 'we  propose\na new method')).toBe(0);
  });

  it('找不到时返回 null', () => {
    expect(findQuotePage(pages, '完全不存在的句子内容')).toBeNull();
  });
});

describe('expandToSentence', () => {
  it('把半截选区扩展到完整句子', () => {
    const text = 'First sentence here. Second one is longer! Third.';
    const start = text.indexOf('Second');
    const end = start + 'Second one'.length;
    expect(expandToSentence(text, start, end)).toBe('Second one is longer!');
  });
});

describe('normalizeText', () => {
  it('压缩空白并转小写', () => {
    expect(normalizeText('  Hello\n\n  World ')).toBe('hello world');
  });
});

describe('ambiguous quote recovery', () => {
  it('refuses repeated quotes across pages and within a single page', () => {
    expect(findQuotePage([{ pageIndex: 0, text: 'same quoted text' }, { pageIndex: 1, text: 'same quoted text' }], 'quoted text')).toBeNull();
    expect(findQuotePage([{ pageIndex: 0, text: 'quoted text then quoted text' }], 'quoted text')).toBeNull();
  });
  it('never matches only the first 24 characters of a changed quote', () => {
    expect(findQuotePage([{ pageIndex: 0, text: 'This is a sufficiently long shared prefix but a different ending' }],
      'This is a sufficiently long shared prefix with a new ending')).toBeNull();
  });
});
