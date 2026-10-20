import { describe, expect, it } from 'vitest';
import { buildIndex, search, tokenize, type Chunk } from '../src/pdf/bm25';

const chunks: Chunk[] = [
  { id: 'c0', pageIndex: 0, sectionTitle: 'Abstract', text: 'We propose a transformer architecture for machine translation.' },
  { id: 'c1', pageIndex: 2, sectionTitle: 'Method', text: 'The encoder is composed of six identical layers with multi-head attention.' },
  { id: 'c2', pageIndex: 5, sectionTitle: 'Experiments', text: 'We evaluate on WMT 2014 English-to-German and reach 28.4 BLEU.' },
  { id: 'c3', pageIndex: 7, sectionTitle: '结论', text: '本文提出的注意力机制可以显著提升翻译质量，并减少训练时间。' },
];

describe('tokenize', () => {
  it('英文转小写并按词切', () => {
    expect(tokenize('Multi-Head Attention')).toContain('attention');
    expect(tokenize('BLEU, 28.4')).toContain('bleu');
  });

  it('中文按二元组切，保证无分词器也能召回', () => {
    const tokens = tokenize('注意力机制');
    expect(tokens).toContain('注意');
    expect(tokens).toContain('意力');
    expect(tokens).toContain('机制');
  });
});

describe('bm25 search', () => {
  const index = buildIndex(chunks);

  it('按关键词命中正确章节', () => {
    const hits = search(index, 'multi-head attention layers', 2);
    expect(hits[0].chunk.id).toBe('c1');
  });

  it('支持中文查询', () => {
    const hits = search(index, '注意力机制 翻译', 2);
    expect(hits[0].chunk.id).toBe('c3');
  });

  it('无关键词时不返回结果', () => {
    expect(search(index, 'zzzzzz', 3)).toHaveLength(0);
  });

  it('结果按分数降序', () => {
    const hits = search(index, 'translation BLEU WMT', 3);
    expect(hits.length).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
  });
});
