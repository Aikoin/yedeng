import { describe, expect, it } from 'vitest';
import { locateSearchHitInLayer, searchPages, searchTextMap } from '../src/pdf/search';
describe('local paper search', () => {
  it('finds repeated case-insensitive terms with page-local ordinals and source offsets', () => {
    const result = searchPages([{ pageIndex: 3, text: 'Latency and LATENCY matter.' }, { pageIndex: 8, text: 'latency' }], 'latency');
    expect(result.map((hit) => [hit.pageIndex, hit.start, hit.end, hit.ordinal])).toEqual([[3, 0, 7, 0], [3, 12, 19, 1], [8, 0, 7, 0]]);
  });
  it('collapses whitespace and compatibility ligatures without losing original offsets', () => {
    const text = 'The ofﬁce\n  latency';
    const result = searchPages([{ pageIndex: 0, text }], 'office latency');
    expect(text.slice(result[0].start, result[0].end)).toBe('ofﬁce\n  latency');
    expect(searchTextMap('ＡＢＣ')).toMatchObject({ text: 'abc', starts: [0, 1, 2], ends: [1, 2, 3] });
  });
  it('does not search absent/scanned pages, treats literal metacharacters literally and limits work', () => {
    expect(searchPages([{ pageIndex: 1, text: '' }], 'x')).toEqual([]);
    expect(searchPages([{ pageIndex: 0, text: 'a+b a.b a+b' }], 'a+b', 1)).toHaveLength(1);
    expect(searchPages([{ pageIndex: 0, text: 'anything' }], '  ')).toEqual([]);
  });
});


describe('search DOM relocation', () => {
  it('follows source context when extracted paragraph order and DOM order disagree', () => {
    const source = 'Beta softmax is stable. Alpha softmax computes weights.';
    const layer = 'Alpha softmax computes weights. Beta softmax is stable.';
    const sourceHit = searchPages([{pageIndex: 2, text: source}], 'softmax')[0];
    const actual = locateSearchHitInLayer(source, sourceHit, layer, 'softmax');
    expect(actual?.start).toBe(layer.lastIndexOf('softmax'));
  });
  it('does not invent a precise match for repeated indistinguishable contexts', () => {
    const source = 'abc term def';
    const hit = searchPages([{pageIndex: 0, text: source}], 'term')[0];
    expect(locateSearchHitInLayer(source, hit, 'abc term def abc term def', 'term')).toBeNull();
  });
  it('supports a unique compatibility-normalized match and unknown/unavailable layer', () => {
    const hit = searchPages([{pageIndex: 0, text: 'office'}], 'office')[0];
    expect(locateSearchHitInLayer('office', hit, 'ofﬁce', 'office')?.end).toBe(5);
    expect(locateSearchHitInLayer('office', hit, '', 'office')).toBeNull();
  });
});
