import { expect, it } from 'vitest';
import { inferDocumentTitle, fallbackDocumentTitle } from '../src/pdf/documentTitle';
import type { TextLine } from '../src/pdf/textmodel';
const line = (text: string, h: number, y: number): TextLine => ({ pageIndex: 0, text, h, y, x: 120, xEnd: 480 });
it('chooses the large upper title over an email extracted first', () => {
  expect(inferDocumentTitle([line('reader@example.test', 10, 650), line('Google Research', 10, 680), line('Attention Is All You Need', 20, 730), line('arXiv:1706.03762', 23, 700)], 792)).toBe('Attention Is All You Need');
});
it('joins multiline titles in vertical order and ignores body headings', () => {
  expect(inferDocumentTitle([line('Understanding generalization', 19, 720), line('in large language models', 19, 695), line('A larger footer body heading', 24, 200)], 800)).toBe('Understanding generalization in large language models');
  expect(fallbackDocumentTitle('reader@example.test\nhttps://example.com\nA Research Paper Title')).toBe('A Research Paper Title');
});
