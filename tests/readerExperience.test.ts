import {describe,it,expect} from 'vitest';
import {parseOverview} from '../src/ai/overview';
import {looksLikeFormula} from '../src/pdf/mathSelection';
import {mergeSettings} from '../src/shared/settings';
describe('reader overview response contract',()=>{
 it('parses one response for two UI outputs, allowing fenced JSON without duplicating chips',()=>{
  expect(parseOverview('```json\n{"summary":"### 问题\\n有依据[E1]","keywords":["注意力","注意力"]}\n```')).toEqual({summary:'### 问题\n有依据[E1]',keywords:['注意力']});
 });
 it('rejects missing, oversized or malformed outputs instead of showing transport JSON as an answer',()=>{
  for(const text of ['partial JSON','{}','{"summary":"ok","keywords":[{}]}',JSON.stringify({summary:'x'.repeat(6001),keywords:[]})])expect(()=>parseOverview(text)).toThrow();
 });
 it('defaults old settings to automatic overview and preserves a user opt-out',()=>{
  expect(mergeSettings({}).reading?.autoOverview).toBe(true);expect(mergeSettings({reading:{autoOverview:false}}).reading?.autoOverview).toBe(false);
 });
});
describe('formula selection routing',()=>{
 it('recognizes a display function equation even with only equals and square-root glyphs',()=>expect(looksLikeFormula('Attention(Q,K,V) = softmax(QKT/√dk)V (1)')).toBe(true));
 it('uses a crop for a display equation with reordered math glyphs',()=>expect(looksLikeFormula('L(θ) = − E x∼ρ(x),y∼π(y|x) [∑ log πθ(yt | x,y<t)]')).toBe(true));
 it('keeps prose with inline mathematics in the ordinary explanation flow',()=>expect(looksLikeFormula('Note that optimizing the objective above is equivalent to minimizing the divergence to the policy, namely, E πθ = ∑ log π.')).toBe(false));
 it('does not classify an ordinary short sentence as mathematics',()=>expect(looksLikeFormula('The encoder is composed of a stack of six identical layers.')).toBe(false));
});
