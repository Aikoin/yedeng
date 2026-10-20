import { describe, expect, it } from 'vitest';
import {
  buildLines,
  buildParagraphs,
  isHeadingLine,
  medianLineHeight,
  orderLines,
  type RawItem,
} from '../src/pdf/textmodel';

/** 造一个文字项：x,y 为 PDF 坐标（y 向上），h 为字号 */
function item(str: string, x: number, y: number, h = 10, hasEOL = false, width?: number): RawItem {
  return {
    str,
    transform: [h, 0, 0, h, x, y],
    width: width ?? str.length * h * 0.5,
    height: h,
    hasEOL,
  };
}

describe('buildLines', () => {
  it('同一行的相邻片段会拼接，并按空隙补空格', () => {
    const lines = buildLines([
      item('Deep', 10, 700, 10, false, 20),
      item('learning', 34, 700, 10, false, 30),
      item('works', 100, 700, 10),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Deep learning works');
  });

  it('hasEOL 结束当前行', () => {
    const lines = buildLines([
      item('第一行', 10, 700, 12, true),
      item('第二行', 10, 680, 12, true),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['第一行', '第二行']);
  });

  it('换行位置（y 不同）会断开', () => {
    const lines = buildLines([item('A', 10, 700, 10), item('B', 10, 685, 10)]);
    expect(lines).toHaveLength(2);
  });

  it('忽略空字符串项', () => {
    expect(buildLines([item('', 0, 0)])).toHaveLength(0);
  });
});

describe('buildParagraphs', () => {
  const lines = buildLines([
    item('This is the abstract of the paper and it spans one line.', 50, 700, 10, true),
    item('It continues on a second line with small gap.', 50, 688, 10, true),
    item('1 Introduction', 50, 640, 14, true),
    item('Deep learning changed everything in vision.', 50, 620, 10, true),
    item('Another sentence right below.', 50, 608, 10, true),
  ]);

  it('相邻行合成段落，大间距与编号行另起一段', () => {
    const paragraphs = buildParagraphs(lines, 0, 612);
    expect(paragraphs.length).toBe(3);
    expect(paragraphs[0].text).toContain('abstract');
    expect(paragraphs[1].text).toBe('1 Introduction');
    expect(paragraphs[2].text).toContain('Deep learning changed');
  });

  it('保留页码与纵向范围', () => {
    const paragraphs = buildParagraphs(lines, 3, 612);
    expect(paragraphs.every((p) => p.pageIndex === 3)).toBe(true);
    expect(paragraphs[0].yTop).toBeGreaterThan(paragraphs[0].yBottom);
  });
});

describe('orderLines', () => {
  it('双栏论文按左栏读完再读右栏', () => {
    const left = buildLines([item('L1', 50, 700, 10, true), item('L2', 50, 680, 10, true), item('L3', 50, 660, 10, true)]);
    const right = buildLines([
      item('R1', 330, 700, 10, true),
      item('R2', 330, 680, 10, true),
      item('R3', 330, 660, 10, true),
    ]);
    const columns = orderLines([...right, ...left], 612);
    expect(columns).toHaveLength(2);
    expect(columns[0].map((l) => l.text)).toEqual(['L1', 'L2', 'L3']);
    expect(columns[1].map((l) => l.text)).toEqual(['R1', 'R2', 'R3']);
  });
});

describe('isHeadingLine', () => {
  it('识别常见章节标题', () => {
    expect(isHeadingLine({ pageIndex: 0, text: '3 Method', x: 0, xEnd: 10, y: 0, h: 12 }, 10)).toBe(true);
    expect(isHeadingLine({ pageIndex: 0, text: 'Introduction', x: 0, xEnd: 10, y: 0, h: 11 }, 10)).toBe(true);
    expect(
      isHeadingLine(
        { pageIndex: 0, text: 'We train the model for 100 epochs on 8 GPUs.', x: 0, xEnd: 10, y: 0, h: 10 },
        10
      )
    ).toBe(false);
  });
});

describe('medianLineHeight', () => {
  it('返回中位字号', () => {
    const lines = buildLines([item('a', 0, 100, 8), item('b', 0, 90, 10), item('c', 0, 80, 20)]);
    expect(medianLineHeight(lines)).toBe(10);
  });
});
